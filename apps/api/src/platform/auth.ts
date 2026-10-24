import { createHash } from 'node:crypto'
import type { Pool } from '@hotelpms/db'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import type { Principal } from './context.js'
import { ANONYMOUS } from './context.js'
import { isSupportLevel, supportPermissions } from './support.js'
import { isPermission, type Permission } from './permissions.js'
import { fremdesNetzMelden } from './maschinennetz.js'

/** Was `principal_user_data` (Migration 0142) liefert, Schluessel kurz gehalten. */
interface PrincipalUserData {
  platformStaff: boolean
  roles: Array<{ l: 'platform' | 'account' | 'property'; a: number | null
                 p: number | null; k: Permission }>
  openAccounts: number[]
  /** [property_id, account_id] aus `user_property_scope`. */
  scope: Array<[number, number]>
  /** [property_id, account_id, permission_key] aus `user_shared_staff_permissions`. */
  shared: Array<[number, number, string]>
}

/** Was `principal_support_data` (Migration 0142) liefert. */
interface SupportData {
  id: number
  accountId: number
  level: string
  properties: number[]
}

/**
 * Laedt die wirksamen Berechtigungen eines Nutzers.
 *
 * Wird **je Anfrage** neu berechnet, nicht bei der Anmeldung -- hier stand
 * lange "bei der Anmeldung berechnet und in der Sitzung gehalten", und das
 * war nie so (Performance-Audit 11.10.2026, Befund 8). Gerade deshalb wirkt
 * eine Sperre, ein Widerruf oder eine entzogene Rolle mit der naechsten
 * Anfrage. Ein Zwischenspeicher im Prozess wuerde das aufweichen und ist
 * bewusst nicht gebaut; stattdessen kostet es nur noch eine Runde.
 *
 * Die Anmeldung je Anfrage geht ueber `loadSessionPrincipal`; diese
 * Fassung bleibt fuer Aufrufer, die nur eine Benutzer-ID haben.
 */
export async function loadPrincipal(pool: Pool, userId: number): Promise<Principal> {
  const r = await pool.query<{ d: PrincipalUserData | null }>(
    `SELECT principal_user_data($1) AS d`, [userId])
  return principalAus(userId, r.rows[0]?.d ?? null)
}

/**
 * Baut das Principal aus der Antwort von `principal_user_data`.
 *
 * Die Datenbank liefert nur, was gilt (Zugriffsbereich, Sperren); welche
 * Rolle damit in welchem Account wirkt, steht hier, mit den Gruenden.
 */
function principalAus(userId: number, d: PrincipalUserData | null): Principal {
  // Unbekannt oder nicht aktiv (eingeladen, deaktiviert): anonym.
  if (d === null) return ANONYMOUS

  /*
   * Welche Accounts dieses Nutzers ueberhaupt noch offen sind.
   *
   * Ein gesperrter Kunde (`account.status`) soll nicht weiterarbeiten, als
   * waere nichts -- und bis Migration 0038 tat er genau das: die Spalte
   * gab es seit 0002, gelesen hat sie niemand. Eine Account-Rolle bringt
   * ihren Account hier **direkt** mit, auch ohne Haus; ohne diese Liste
   * bliebe die Sperre auf halbem Weg stehen.
   *
   * Ueber eine SECURITY-DEFINER-Funktion, weil `account` eine erzwungene
   * Zeilenrichtlinie traegt und hier noch kein Kontext gesetzt ist -- die
   * Falle aus den Migrationen 0014, 0018 und 0032.
   */
  const offeneAccounts = new Set(d.openAccounts)

  /*
   * Zugriffsbereich aufloesen.
   *
   * Das ist ein Henne-Ei-Problem: um zu wissen, welche Haeuser jemand
   * sehen darf, muss einmal etwas gelesen werden, das die
   * Zeilenrichtlinie noch nicht freigibt. Zwei fruehere Abfragen taten das
   * mit leerem Kontext und bekamen deshalb **nichts** zurueck. Die Folge
   * war, dass eine Account-Rolle auf gar kein Haus wirkte und eine
   * Property-Rolle ihren Account nicht mitbrachte, sodass die Rezeption
   * keine Gastprofile sah (Migration 0018).
   *
   * Jetzt eine SECURITY-DEFINER-Funktion, die nur fuer diesen einen Nutzer
   * antwortet und nur Kennungen liefert -- und die seit Migration 0038
   * auch am Zustand des Kunden endet. Sie entscheidet mit, welche Rolle
   * ueberhaupt noch wirkt.
   */
  const offeneHaeuser = new Set(d.scope.map(([p]) => p))

  const accountIds = new Set<number>()
  const accountPermissionsByAccount = new Map<number, Set<Permission>>()
  const propertyAccounts = new Map<number, number>()
  const platformPermissions = new Set<Permission>()
  const permissionsByProperty = new Map<number, Set<Permission>>()

  for (const r of d.roles) {
    if (r.l === 'platform') platformPermissions.add(r.k)
    else if (r.l === 'account' && r.a !== null) {
      // Rollen an einem gesperrten Account wirken nicht. Auch die Rechte
      // nicht: sie gelten in diesem Modell ueber alle Accounts des
      // Nutzers zugleich, und ein gesperrter darf keine mitbringen.
      if (!offeneAccounts.has(r.a)) continue
      accountIds.add(r.a)
      let set = accountPermissionsByAccount.get(r.a)
      if (!set) { set = new Set(); accountPermissionsByAccount.set(r.a, set) }
      set.add(r.k)
    } else if (r.l === 'property' && r.p !== null) {
      /*
       * Dieselbe Sperre eine Ebene tiefer. Eine Property-Rolle wirkte
       * bisher unabhaengig vom Zugriffsbereich -- ein gesperrter Kunde
       * haette seine Rezeption also weiterarbeiten lassen, waehrend die
       * Account-Ebene schon zu war. Was der Zugriffsbereich nicht nennt,
       * traegt hier auch keine Rechte.
       */
      if (!offeneHaeuser.has(r.p)) continue
      let set = permissionsByProperty.get(r.p)
      if (!set) { set = new Set(); permissionsByProperty.set(r.p, set) }
      set.add(r.k)
    }
  }

  for (const [propertyId, accountId] of d.scope) {
    accountIds.add(accountId)
    propertyAccounts.set(propertyId, accountId)
    if (!permissionsByProperty.has(propertyId)) {
      permissionsByProperty.set(propertyId, new Set())
    }
  }

  /*
   * Betrieb mit gemeinsamem Personal (Migration 0116): eine Rolle
   * Reinigung, Kueche oder Hausdame in einem Haus wirkt in allen Haeusern
   * des Betriebs. Die Funktion prueft dieselben Sperren wie der
   * Zugriffsbereich; was sie liefert, ist also offen.
   */
  for (const [propertyId, accountId, key] of d.shared) {
    if (!isPermission(key)) continue
    accountIds.add(accountId)
    propertyAccounts.set(propertyId, accountId)
    let set = permissionsByProperty.get(propertyId)
    if (!set) { set = new Set(); permissionsByProperty.set(propertyId, set) }
    set.add(key)
  }

  /*
   * Was in **jedem** Account des Nutzers auf Betriebsebene gilt. Wer nur
   * einen Account hat -- der Normalfall --, bekommt genau seine
   * Account-Rechte; wer in einem zweiten Betrieb nur eine Hausrolle hat,
   * bekommt hier nichts, und seine Inhaberrechte wirken nur noch im
   * eigenen Betrieb (Befund K1, Sicherheitsaudit 2026-10-11).
   */
  const accountPermissions = new Set<Permission>()
  const [erster, ...weitere] = [...accountIds]
  for (const perm of (erster === undefined ? [] : accountPermissionsByAccount.get(erster) ?? [])) {
    if (weitere.every(a => accountPermissionsByAccount.get(a)?.has(perm))) {
      accountPermissions.add(perm)
    }
  }

  return {
    userId,
    clientKey: `user:${userId}`,
    isPlatformStaff: d.platformStaff,
    accountIds: [...accountIds],
    permissionsByProperty,
    accountPermissions,
    accountPermissionsByAccount,
    propertyAccounts,
    platformPermissions,
    supportSessionId: null,
    // Wer die Sitzung eroeffnet hat, weiss nur der Aufrufer dieser
    // Funktion; hier steht bewusst die handelnde Person selbst.
    sessionUserId: userId,
    terminalDeviceId: null
  }
}

/**
 * Woher eine Sitzung kommt: Browser mit Cookie oder die eigene App mit Token
 * (Migration 0191). Eine Sitzung traegt nur auf ihrem eigenen Weg.
 */
export type SessionClient = 'web' | 'app'

/**
 * Woran die API ein Token der App von einem Maschinentoken unterscheidet.
 * Beide kommen als `Bearer`. Der Anfang waehlt nur, wo zuerst gesucht wird;
 * er beweist nichts -- die Art prueft `session_principal`. Ein
 * Maschinentoken ist reines base64url und beginnt nur aus Zufall so (eins
 * zu sechzehn Millionen); traegt es als Sitzung nicht, wird es deshalb
 * noch als Maschinentoken gesucht, statt dass ein Client grundlos abgewiesen
 * wird.
 */
export const APP_TOKEN_PREFIX = 'sga_'

/**
 * Die Herkuenfte der App (Capacitor): iOS liefert ihre Seiten unter
 * `capacitor://localhost`, Android unter `https://localhost`. Nur ihnen
 * antwortet die API mit CORS-Kopfzeilen, und nie mit Cookies: die App
 * schickt ihr Token selbst, ein Browser von dort hat keines.
 */
export const APP_ORIGINS: ReadonlySet<string> =
  new Set(['capacitor://localhost', 'https://localhost'])

/**
 * Principal aus einer Sitzung (Cookie oder App-Token), in **einer** Runde zur Datenbank
 * (`session_principal`, Migration 0142).
 *
 * Vorher waren es rund zehn: Sitzung lesen, `loadPrincipal` als eigene
 * Transaktion mit fuenf Abfragen, fuer Plattformpersonal zwei weitere
 * Transaktionen fuer die Support-Sitzung, dann last_seen_at -- je Anfrage,
 * auch beim Abfragetakt des Terminals, und nichts davon im Abfragezaehler
 * (Performance-Audit 11.10.2026, Befund 8). Die Regeln sind dieselben: die
 * Funktion ruft dieselben Bausteine, und zusammengesetzt wird hier wie in
 * `loadPrincipal` und `applySupportSession`.
 *
 * `null`, wenn die Sitzung unbekannt, widerrufen oder abgelaufen ist.
 */
export async function loadSessionPrincipal(
  pool: Pool, sessionId: string, client: SessionClient
): Promise<Principal | null> {
  const r = await pool.query<{ session_user_id: number; effective_user_id: number
                               principal: PrincipalUserData | null
                               support: SupportData | null; via_passkey: boolean }>(
    `SELECT * FROM session_principal($1, $2)`, [sessionId, client])
  const row = r.rows[0]
  if (row === undefined) return null
  // Arbeitsplatz-PIN wechselt die handelnde Person, ohne Neuanmeldung.
  let principal = principalAus(row.effective_user_id, row.principal)
  /*
   * Plattformrechte nur mit Passkey (Migration 0211, Bedrohungsanalyse
   * 23.10.2026, A3). Ein Plattformkonto erreicht jeden Kunden, und sein
   * Kennwort ist das lohnendste Ziel jeder nachgebauten Anmeldeseite. Mit
   * Kennwort angemeldet, bleibt die Sitzung brauchbar -- fuer den ersten
   * Passkey --, aber ohne Plattformrechte; die Support-Sitzung liefert
   * `session_principal` dann schon gar nicht.
   */
  if (principal.isPlatformStaff && !row.via_passkey) {
    principal = { ...principal, platformPermissions: new Set() }
  }
  principal = mitSupport(principal, row.support)
  // Wer sich angemeldet hat, bleibt bekannt, auch wenn gerade jemand
  // anderes handelt: die Oberflaeche zeigt den Wechsel damit an.
  return { ...principal, sessionUserId: row.session_user_id,
           viaPasskey: row.via_passkey }
}

/**
 * Ein Token ist ein Kennwort und liegt deshalb nur als Hash. SHA-256 genuegt,
 * anders als beim Nutzerkennwort: das Token sind 32 zufaellige Byte, es gibt
 * nichts zu raten, und eine langsame Ableitung je Anfrage waere teuer ohne
 * Gewinn.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

interface TokenRow {
  id: number
  account_id: number
  scopes: string[]
  property_ids: string[]
  public_ref: string
  client_status: string
}

/**
 * Principal aus einem Maschinentoken (Aufgabe 2, Dokument 16).
 *
 * Derselbe Berechtigungskatalog wie fuer Menschen: ein Scope **ist** ein
 * Berechtigungsschluessel (Grundsatz 1, Dokument 14). Es gibt keinen zweiten
 * Rechteweg und deshalb auch keine zweite Pruefung -- `registerRoute` sieht
 * keinen Unterschied zwischen Mensch und Maschine.
 */
export async function loadPrincipalFromToken(
  pool: Pool, token: string, origin: string | null = null
): Promise<Principal> {
  return withTransaction(pool, SYSTEM_CONTEXT, async client => {
    /*
     * Ueber eine SECURITY-DEFINER-Funktion, weil `oauth_client` eine
     * Zeilenrichtlinie traegt und der Mandant hier noch nicht feststeht --
     * er ergibt sich ja erst aus dem Token (Migration 0023, wie 0018).
     */
    const r = await client.query<TokenRow>(
      `SELECT * FROM oauth_token_principal($1, $2::inet)`, [hashToken(token), origin || null])

    if (r.rowCount === 0) return ANONYMOUS
    const row = r.rows[0]!
    /*
     * Gueltiges Token aus einem Netz, das der Betrieb fuer diesen Zugang
     * nicht nennt (Migration 0212): das Token ist abgeflossen. Anonym wie
     * jedes ungueltige, und gemeldet.
     */
    if (row.client_status === 'origin_denied') {
      await fremdesNetzMelden(pool, Number(row.account_id), row.public_ref, origin, 'request')
      return ANONYMOUS
    }
    if (row.client_status !== 'active') return ANONYMOUS

    // Leere Liste bedeutet alle aktiven Haeuser des Accounts. Die Aufloesung
    // geschieht hier und nicht bei der Ausgabe, damit ein spaeter angelegtes
    // Haus ohne neues Token erreichbar ist.
    const haeuser = row.property_ids.length > 0
      ? row.property_ids.map(Number)
      : (await client.query<{ id: number }>(
          `SELECT id FROM oauth_account_properties($1)`,
          [row.account_id])).rows.map(p => Number(p.id))

    const scopes = row.scopes.filter(isPermission)
    const permissionsByProperty = new Map<number, Set<Permission>>()
    for (const p of haeuser) permissionsByProperty.set(p, new Set(scopes))

    return {
      userId: null,
      // Eigener Schluessel je Client: sonst stoerte ein Client die Idempotenz
      // eines anderen (S2, Dokument 12).
      clientKey: `client:${row.public_ref}`,
      isPlatformStaff: false,
      accountIds: [Number(row.account_id)],
      permissionsByProperty,
      /*
       * Bewusst leer. `can()` prueft accountPermissions zuerst und laesst sie
       * auf **alle** Haeuser des Accounts wirken. Ein Client, der auf zwei von
       * zwanzig Haeusern eingeschraenkt ist, bekaeme darueber die anderen
       * achtzehn dazu -- die Einschraenkung waere wirkungslos.
       */
      accountPermissions: new Set(),
      accountPermissionsByAccount: new Map(),
      propertyAccounts: new Map(haeuser.map(h => [h, Number(row.account_id)])),
      platformPermissions: new Set(),
      supportSessionId: null,
      sessionUserId: null,
      terminalDeviceId: null
    }
  })
}

/**
 * Name des Geraetecookies am Gaesteterminal (Dokument 31).
 *
 * Ein Cookie und kein Token im JavaScript, aus demselben Grund wie bei der
 * Sitzung (lib/api.ts): `httpOnly` haelt es von jedem eingeschleusten
 * Skript fern, und ein Geheimnis, das am Touchscreen eines Gastes ein Jahr
 * lang liegt, ist genau das, wonach ein solches Skript suchte. Gesetzt wird
 * es auf den Pfad `/v1/terminal` -- der Browser schickt es damit an keine
 * andere Route, auch nicht versehentlich.
 */
export const DEVICE_COOKIE = 'hp_terminal'

/**
 * Principal eines gekoppelten Gaesteterminals.
 *
 * Gebaut wie der Maschinenzugang: dasselbe Principal, derselbe
 * Berechtigungskatalog, dieselbe Pruefung in `registerRoute`. Nur schmaler
 * -- **ein** Haus, **ein** Recht (`terminal:device`), kein Benutzer, keine
 * Account-Rechte. Dazu die Haeuser desselben Accounts, die das Geraet
 * ueber eine Freigabe mitnutzen (Migration 0103), mit demselben einen Recht. Was es darueber hinaus erreicht, entscheiden die
 * Geraeterouten, und die lesen nur den eigenen Auftrag.
 */
export async function loadPrincipalFromDevice(pool: Pool, secret: string): Promise<Principal> {
  return withTransaction(pool, SYSTEM_CONTEXT, async client => {
    const r = await client.query<{
      device_id: string; device_ref: string; property_id: string; account_id: string
      shared_property_ids: string[] }>(
      `SELECT * FROM terminal_device_principal($1)`, [hashToken(secret)])
    if (r.rowCount === 0) return ANONYMOUS
    const row = r.rows[0]!
    const haus = Number(row.property_id)
    const nurGeraet = (): Set<Permission> => new Set<Permission>(['terminal:device'])
    return {
      userId: null,
      // Eigener Schluessel: zaehlt als ausgewiesen, nicht als anonym -- ein
      // Terminal fragt alle zwei Sekunden, ohne Pause (rateLimit.ts).
      // Und eigener Schluessel fuer die Idempotenz, wie beim Client.
      clientKey: `device:${row.device_ref}`,
      isPlatformStaff: false,
      accountIds: [Number(row.account_id)],
      // Das eigene Haus **zuerst**: `geraetVon` liest es als Master, aus dem
      // Seiten, Diashow und Wachzeit kommen. Dahinter die Haeuser, die das
      // Geraet ueber eine gueltige Freigabe mitnutzen (Migration 0103) --
      // nur damit die Zeilenrichtlinie deren Auftraege durchlaesst.
      permissionsByProperty: new Map([
        [haus, nurGeraet()],
        ...row.shared_property_ids.map(id => [Number(id), nurGeraet()] as const)]),
      // Bewusst leer, aus demselben Grund wie beim Maschinentoken: was hier
      // stuende, wirkte auf alle Haeuser des Accounts.
      accountPermissions: new Set(),
      accountPermissionsByAccount: new Map(),
      propertyAccounts: new Map([haus, ...row.shared_property_ids.map(Number)]
        .map(h => [h, Number(row.account_id)])),
      platformPermissions: new Set(),
      supportSessionId: null,
      sessionUserId: null,
      terminalDeviceId: Number(row.device_id)
    }
  })
}

/**
 * Plattformpersonal sieht Kundendaten ausschliesslich ueber eine vom Kunden
 * freigegebene, befristete Support-Sitzung. Ohne sie bleibt der
 * Mandantenkontext leer, und die Zeilenrichtlinie liefert nichts.
 */
export async function applySupportSession(
  pool: Pool, principal: Principal
): Promise<Principal> {
  if (!principal.isPlatformStaff || principal.userId === null) return principal
  const r = await pool.query<{ d: SupportData | null }>(
    `SELECT principal_support_data($1) AS d`, [principal.userId])
  return mitSupport(principal, r.rows[0]?.d ?? null)
}

/**
 * Die Support-Sitzung auf ein Principal anwenden. `session` ist die Antwort
 * von `principal_support_data` (Migration 0142): die zuletzt freigegebene,
 * nicht widerrufene, nicht abgelaufene Sitzung mit den aktiven Haeusern
 * ihres Kunden, oder null.
 */
function mitSupport(principal: Principal, session: SupportData | null): Principal {
  if (!principal.isPlatformStaff || principal.userId === null) return principal

  if (session === null) {
    // Kein Zugriff auf Fachdaten. Plattformrechte bleiben erhalten.
    return { ...principal, accountIds: [], permissionsByProperty: new Map(),
             propertyAccounts: new Map() }
  }

  /*
   * Die Haeuser kommen ueber eine SECURITY-DEFINER-Funktion, nicht direkt
   * aus `property`.
   *
   * Hier stand `SELECT id FROM property WHERE account_id = $1` unter
   * SYSTEM_CONTEXT -- also mit leeren app_property_ids(), waehrend die
   * Tabelle eine erzwungene Zeilenrichtlinie ueber genau diese Liste traegt.
   * Die Abfrage lieferte null Zeilen, und eine freigegebene Support-Sitzung
   * bekam kein einziges Haus. Dieselbe Falle wie in den Migrationen 0014 und
   * 0018 (Migration 0032).
   */
  /*
   * Die Rechte der freigegebenen Stufe, nicht die des Kunden.
   *
   * Hier stand einmal eine leere Menge, waehrend der Kommentar daneben "die
   * Rechte einer Hoteldirektion" versprach -- eine freigegebene Sitzung
   * bekam damit auf jeder Fachroute 403, und der Test dazu pruefte nur, dass
   * der Mandantenkontext gesetzt ist. Was eine Stufe umfasst und was keine
   * je umfasst, steht in support.ts, jedes Weggelassene mit seinem Grund.
   */
  const rechte = isSupportLevel(session.level)
    ? supportPermissions(session.level)
    // Ein unbekannter Wert ist kein Anlass zu raten. Die Pruefbedingung der
    // Spalte laesst ihn nicht zu; kaeme er doch, ist nichts die richtige
    // Antwort.
    : new Set<Permission>()

  const permissionsByProperty = new Map<number, Set<Permission>>()
  for (const p of session.properties) permissionsByProperty.set(p, new Set(rechte))

  return {
    ...principal,
    accountIds: [session.accountId],
    permissionsByProperty,
    /*
     * Bewusst leer, aus demselben Grund wie beim Maschinentoken oben: `can()`
     * prueft accountPermissions zuerst und laesst sie auf **alle** Haeuser
     * wirken, ohne je nach einer Property zu fragen. Die Rechte der Sitzung
     * gehoeren deshalb je Haus eingetragen -- sonst wuerde jede spaetere
     * Einschraenkung auf einzelne Haeuser wirkungslos, und die Trennung
     * zwischen "sehen" und "aendern" haengt an derselben Stelle.
     */
    accountPermissions: new Set(),
    accountPermissionsByAccount: new Map(),
    propertyAccounts: new Map(session.properties.map(p => [p, session.accountId])),
    supportSessionId: session.id
  }
}
