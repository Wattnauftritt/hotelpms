import type { Permission } from './permissions.js'
import { Errors } from './errors.js'

/**
 * Was der Server ueber den Aufrufer weiss.
 * Der Mandantenkontext kommt ausschliesslich hierher, nie aus Pfad, Query
 * oder Rumpf. Eine Route nimmt eine Property-ID entgegen, prueft sie aber
 * gegen diesen Kontext (S1, Dokument 12).
 */
export interface Principal {
  userId: number | null
  clientKey: string
  isPlatformStaff: boolean
  accountIds: number[]
  /** Berechtigungen je Property. Schluessel ist die Property-ID. */
  permissionsByProperty: Map<number, Set<Permission>>
  /**
   * Berechtigungen, die in **jedem** Account des Aufrufers gelten.
   *
   * Hier stand bisher die Vereinigung aller Account-Rollen, und `can()` liess
   * sie auf jedes Haus wirken. Wer Inhaber im eigenen Betrieb war und in
   * einem fremden Betrieb nur Rezeption, war damit auch dort Inhaber -- bis
   * hin zum Vergeben der Inhaberrolle an sich selbst (Sicherheitsaudit
   * 2026-10-11, Befund K1). Was nur in einem Account gilt, steht in
   * `accountPermissionsByAccount`. Bei einem einzigen Account sind beide gleich.
   */
  accountPermissions: Set<Permission>
  /** Account-Rollen je Account. Wirken nur auf Haeuser dieses Accounts. */
  accountPermissionsByAccount: Map<number, Set<Permission>>
  /** Zu welchem Account ein Haus aus `permissionsByProperty` gehoert. */
  propertyAccounts: Map<number, number>
  platformPermissions: Set<Permission>
  supportSessionId: number | null
  /**
   * Wer sich angemeldet hat, falls das jemand anderes ist als `userId`.
   *
   * Am geteilten Rezeptionsrechner wechselt der Arbeitsplatz-PIN die
   * handelnde Person, ohne dass sich jemand neu anmeldet. `userId` ist dann
   * die handelnde Person -- sie entscheidet ueber Rechte und steht im
   * Protokoll --, waehrend hier steht, auf wessen Sitzung das laeuft. Die
   * Oberflaeche zeigt damit an, dass gerade nicht der Angemeldete arbeitet;
   * ohne diesen Hinweis bucht irgendwann jemand unter fremdem Namen weiter,
   * weil er den Wechsel vergessen hat.
   */
  sessionUserId: number | null
  /**
   * Ein gekoppeltes Gaesteterminal (Migration 0071), sonst null.
   *
   * Ein Geraet ist kein Benutzer und kein Maschinenzugang: es steht an der
   * Rezeption, und davor steht ein Gast. Es traegt genau ein Recht,
   * `terminal:device`, in genau einem Haus -- und seine Routen pruefen
   * zusaetzlich, dass dieses Feld gesetzt ist, damit das Recht allein nie
   * genuegt.
   */
  terminalDeviceId: number | null
}

export const ANONYMOUS: Principal = {
  userId: null,
  clientKey: 'anonymous',
  isPlatformStaff: false,
  accountIds: [],
  permissionsByProperty: new Map(),
  accountPermissions: new Set(),
  accountPermissionsByAccount: new Map(),
  propertyAccounts: new Map(),
  platformPermissions: new Set(),
  supportSessionId: null,
  sessionUserId: null,
  terminalDeviceId: null
}

export function propertyIds(p: Principal): number[] {
  return [...p.permissionsByProperty.keys()]
}

/** Wirksame Berechtigungen fuer eine Property: Account-Rollen plus Property-Rolle. */
export function can(p: Principal, permission: Permission, property?: number): boolean {
  if (p.accountPermissions.has(permission)) return true
  if (p.platformPermissions.has(permission)) return true
  if (property === undefined) {
    for (const set of p.permissionsByProperty.values()) {
      if (set.has(permission)) return true
    }
    for (const set of p.accountPermissionsByAccount.values()) {
      if (set.has(permission)) return true
    }
    return false
  }
  if (p.permissionsByProperty.get(property)?.has(permission)) return true
  // Eine Account-Rolle wirkt nur auf die Haeuser ihres eigenen Accounts.
  const account = p.propertyAccounts.get(property)
  return account !== undefined
    && (p.accountPermissionsByAccount.get(account)?.has(permission) ?? false)
}

/**
 * Ob das Recht aus einer Rolle **auf Betriebsebene** in diesem Account kommt.
 * Eine Hausrolle genuegt hier nicht: was ein ganzes Unternehmen betrifft
 * (Zugaenge fuer alle Haeuser, Inhaber anfassen), darf nicht an einem
 * einzelnen Haus haengen.
 */
export function accountRight(p: Principal, permission: Permission, account: number): boolean {
  return p.accountPermissions.has(permission)
    || p.platformPermissions.has(permission)
    || (p.accountPermissionsByAccount.get(account)?.has(permission) ?? false)
}

/** Ob das Recht in diesem Account besteht, auf Betriebsebene oder in einem seiner Haeuser. */
export function canInAccount(p: Principal, permission: Permission, account: number): boolean {
  if (accountRight(p, permission, account)) return true
  for (const [property, set] of p.permissionsByProperty) {
    if (p.propertyAccounts.get(property) === account && set.has(permission)) return true
  }
  return false
}

/**
 * Die Accounts, in denen das Recht besteht -- fuer Listen und Suchen ueber
 * Tabellen, deren Zeilenrichtlinie nur nach Account filtert (Gast, Firma,
 * Abonnements). Die Richtlinie laesst jeden Account des Kontexts durch, also
 * auch den, in dem der Aufrufer nur putzt (Sicherheitsaudit 2026-10-19, H1).
 */
export function accountsWith(p: Principal, permission: Permission): number[] {
  return p.accountIds.filter(a => canInAccount(p, permission, a))
}

export function hasProperty(p: Principal, property: number): boolean {
  return p.permissionsByProperty.has(property)
}

/**
 * Der einzige Account, in dem dieser Aufrufer schreiben darf.
 * Wer mehrere Accounts sieht, muss ihn angeben; sonst landet der Datensatz im
 * falschen Mandanten und die Zeilenrichtlinie bemerkt es nicht, weil beide
 * im Kontext stehen.
 *
 * Das Recht der Route prueft `registerRoute` nur "irgendwo". Hier wird es
 * fuer **diesen** Account geprueft: sonst genuegte das Recht im eigenen
 * Betrieb fuer den fremden, in dem man nur eine Hausrolle hat.
 */
export function accountFor(
  p: Principal, given: number | undefined, permission: Permission
): number {
  let account: number
  if (given !== undefined) {
    if (!p.accountIds.includes(given)) {
      throw Errors.forbidden('access.accountOutOfScope')
    }
    account = given
  } else if (p.accountIds.length === 1) {
    account = p.accountIds[0]!
  } else {
    throw Errors.validation({ accountId: ['field.requiredWithManyAccounts'] })
  }
  if (!canInAccount(p, permission, account)) {
    throw Errors.forbidden('access.missingPermission', { permission })
  }
  return account
}
