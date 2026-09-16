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
  /** Accountweite Berechtigungen, wirken auf alle Properties des Accounts. */
  accountPermissions: Set<Permission>
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
}

export const ANONYMOUS: Principal = {
  userId: null,
  clientKey: 'anonymous',
  isPlatformStaff: false,
  accountIds: [],
  permissionsByProperty: new Map(),
  accountPermissions: new Set(),
  platformPermissions: new Set(),
  supportSessionId: null,
  sessionUserId: null
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
    return false
  }
  return p.permissionsByProperty.get(property)?.has(permission) ?? false
}

export function hasProperty(p: Principal, property: number): boolean {
  return p.permissionsByProperty.has(property)
}

/**
 * Der einzige Account, in dem dieser Aufrufer schreiben darf.
 * Wer mehrere Accounts sieht, muss ihn angeben; sonst landet der Datensatz im
 * falschen Mandanten und die Zeilenrichtlinie bemerkt es nicht, weil beide
 * im Kontext stehen.
 */
export function accountFor(p: Principal, given: number | undefined): number {
  if (given !== undefined) {
    if (!p.accountIds.includes(given)) {
      throw Errors.forbidden('access.accountOutOfScope')
    }
    return given
  }
  if (p.accountIds.length === 1) return p.accountIds[0]!
  throw Errors.validation({ accountId: ['field.requiredWithManyAccounts'] })
}
