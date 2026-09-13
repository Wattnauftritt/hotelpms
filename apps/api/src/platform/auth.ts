import type { Pool } from '@hotelpms/db'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import type { Principal } from './context.js'
import { ANONYMOUS } from './context.js'
import type { Permission } from './permissions.js'

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

    // Account-Rollen wirken auf alle Properties des Accounts.
    if (accountIds.size > 0) {
      const props = await client.query<{ id: number; account_id: number }>(
        `SELECT id, account_id FROM property
          WHERE account_id = ANY($1) AND status = 'active'`, [[...accountIds]])
      for (const p of props.rows) {
        if (!permissionsByProperty.has(p.id)) permissionsByProperty.set(p.id, new Set())
      }
    }

    // Properties aus Property-Rollen bringen ihren Account mit, damit
    // accountweite Daten wie Gaesteprofile sichtbar sind (Entscheidung 13).
    const direct = [...permissionsByProperty.keys()]
    if (direct.length > 0) {
      const accs = await client.query<{ account_id: number }>(
        `SELECT DISTINCT account_id FROM property WHERE id = ANY($1)`, [direct])
      for (const a of accs.rows) accountIds.add(a.account_id)
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
 * Plattformpersonal sieht Kundendaten ausschliesslich ueber eine vom Kunden
 * freigegebene, befristete Support-Sitzung. Ohne sie bleibt der
 * Mandantenkontext leer, und die Zeilenrichtlinie liefert nichts.
 */
export async function applySupportSession(
  pool: Pool, principal: Principal
): Promise<Principal> {
  if (!principal.isPlatformStaff || principal.userId === null) return principal

  const active = await withTransaction(pool, SYSTEM_CONTEXT, client =>
    client.query<{ id: number; account_id: number }>(
      `SELECT id, account_id FROM support_session
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
  const props = await withTransaction(pool, SYSTEM_CONTEXT, client =>
    client.query<{ id: number }>(
      `SELECT id FROM property WHERE account_id = $1 AND status = 'active'`,
      [session.account_id]))

  const permissionsByProperty = new Map<number, Set<Permission>>()
  for (const p of props.rows) permissionsByProperty.set(p.id, new Set())

  return {
    ...principal,
    accountIds: [session.account_id],
    permissionsByProperty,
    // Waehrend der Sitzung gelten die Rechte einer Hoteldirektion.
    accountPermissions: new Set(principal.accountPermissions),
    supportSessionId: session.id
  }
}
