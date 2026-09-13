import type { Permission } from './permissions.js'

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
}

export const ANONYMOUS: Principal = {
  userId: null,
  clientKey: 'anonymous',
  isPlatformStaff: false,
  accountIds: [],
  permissionsByProperty: new Map(),
  accountPermissions: new Set(),
  platformPermissions: new Set(),
  supportSessionId: null
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
