import { createHash } from 'node:crypto'
import type { Pool } from '@hotelpms/db'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import type { Principal } from './context.js'
import { ANONYMOUS } from './context.js'
import { isSupportLevel, supportPermissions } from './support.js'
import { isPermission, type Permission } from './permissions.js'

interface RoleRow {
  level: 'platform' | 'account' | 'property'
  account_id: number | null
  property_id: number | null
  permission_key: Permission
}

/**
 * Laedt die wirksamen Berechtigungen eines Nutzers.
 * Wird bei der Anmeldung berechnet und in der Sitzung gehalten; bei einer
 * Rollenaenderung werden alle Sitzungen des Nutzers ungueltig (Dokument 14).
 */
export async function loadPrincipal(pool: Pool, userId: number): Promise<Principal> {
  return withTransaction(pool, SYSTEM_CONTEXT, async client => {
    const user = await client.query<{ is_platform_staff: boolean; status: string }>(
      `SELECT is_platform_staff, status FROM app_user WHERE id = $1`, [userId])
    if (user.rowCount === 0 || user.rows[0]!.status !== 'active') return ANONYMOUS

    const rows = await client.query<RoleRow>(
      `SELECT 'platform'::text AS level, NULL::bigint AS account_id,
              NULL::bigint AS property_id, rp.permission_key
         FROM user_platform_role upr
         JOIN role_permission rp ON rp.role_id = upr.role_id
        WHERE upr.user_id = $1
        UNION ALL
       SELECT 'account', uar.account_id, NULL, rp.permission_key
         FROM user_account_role uar
         JOIN role_permission rp ON rp.role_id = uar.role_id
        WHERE uar.user_id = $1
        UNION ALL
       SELECT 'property', NULL, upr2.property_id, rp.permission_key
         FROM user_property_role upr2
         JOIN role_permission rp ON rp.role_id = upr2.role_id
        WHERE upr2.user_id = $1`, [userId])

    const accountIds = new Set<number>()
    const accountPermissions = new Set<Permission>()
    const platformPermissions = new Set<Permission>()
    const permissionsByProperty = new Map<number, Set<Permission>>()

    for (const r of rows.rows) {
      if (r.level === 'platform') platformPermissions.add(r.permission_key)
      else if (r.level === 'account' && r.account_id !== null) {
        accountIds.add(r.account_id)
        accountPermissions.add(r.permission_key)
      } else if (r.level === 'property' && r.property_id !== null) {
        let set = permissionsByProperty.get(r.property_id)
        if (!set) { set = new Set(); permissionsByProperty.set(r.property_id, set) }
        set.add(r.permission_key)
      }
    }

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
     * antwortet und nur Kennungen liefert.
     */
    const scope = await client.query<{ property_id: number; account_id: number }>(
      `SELECT property_id, account_id FROM user_property_scope($1)`, [userId])
    for (const s of scope.rows) {
      accountIds.add(s.account_id)
      if (!permissionsByProperty.has(s.property_id)) {
        permissionsByProperty.set(s.property_id, new Set())
      }
    }

    return {
      userId,
      clientKey: `user:${userId}`,
      isPlatformStaff: user.rows[0]!.is_platform_staff,
      accountIds: [...accountIds],
      permissionsByProperty,
      accountPermissions,
      platformPermissions,
      supportSessionId: null
    }
  })
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
export async function loadPrincipalFromToken(pool: Pool, token: string): Promise<Principal> {
  return withTransaction(pool, SYSTEM_CONTEXT, async client => {
    /*
     * Ueber eine SECURITY-DEFINER-Funktion, weil `oauth_client` eine
     * Zeilenrichtlinie traegt und der Mandant hier noch nicht feststeht --
     * er ergibt sich ja erst aus dem Token (Migration 0023, wie 0018).
     */
    const r = await client.query<TokenRow>(
      `SELECT * FROM oauth_token_principal($1)`, [hashToken(token)])

    if (r.rowCount === 0) return ANONYMOUS
    const row = r.rows[0]!
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
      platformPermissions: new Set(),
      supportSessionId: null
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

  const active = await withTransaction(pool, SYSTEM_CONTEXT, client =>
    client.query<{ id: number; account_id: number; level: string }>(
      `SELECT id, account_id, level FROM support_session
        WHERE platform_user_id = $1
          AND granted_at IS NOT NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY granted_at DESC LIMIT 1`, [principal.userId]))

  if (active.rowCount === 0) {
    // Kein Zugriff auf Fachdaten. Plattformrechte bleiben erhalten.
    return { ...principal, accountIds: [], permissionsByProperty: new Map() }
  }

  const session = active.rows[0]!
  /*
   * Ueber eine SECURITY-DEFINER-Funktion, nicht direkt auf `property`.
   *
   * Hier stand `SELECT id FROM property WHERE account_id = $1` unter
   * SYSTEM_CONTEXT -- also mit leeren app_property_ids(), waehrend die
   * Tabelle eine erzwungene Zeilenrichtlinie ueber genau diese Liste traegt.
   * Die Abfrage lieferte null Zeilen, und eine freigegebene Support-Sitzung
   * bekam kein einziges Haus. Dieselbe Falle wie in den Migrationen 0014 und
   * 0018 (Migration 0032).
   */
  const props = await withTransaction(pool, SYSTEM_CONTEXT, client =>
    client.query<{ id: number }>(
      `SELECT id FROM account_active_properties($1)`, [session.account_id]))

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
  for (const p of props.rows) permissionsByProperty.set(p.id, new Set(rechte))

  return {
    ...principal,
    accountIds: [session.account_id],
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
    supportSessionId: session.id
  }
}
