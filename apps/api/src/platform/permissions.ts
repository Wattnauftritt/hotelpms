/**
 * Berechtigungskatalog nach Dokument 14.
 * Muss mit der Migration 0003 uebereinstimmen; ein Test prueft das.
 */
export const PERMISSIONS = [
  'reservation:read', 'reservation:write', 'reservation:checkin',
  'reservation:override_restriction',
  'guest:read', 'guest:write', 'guest:read_identity', 'guest:export',
  'folio:read', 'folio:post', 'folio:void_own', 'folio:void_any',
  'folio:discount', 'folio:discount_unlimited', 'folio:route',
  'invoice:issue', 'invoice:credit',
  'rate:read', 'rate:write',
  'inventory:read', 'inventory:write',
  'housekeeping:read', 'housekeeping:write', 'maintenance:write',
  'report:operational', 'report:revenue', 'report:export',
  'nightaudit:run',
  // Gastpost (0028): eigenes Recht, weil Hinausschicken etwas anderes ist
  // als Festschreiben -- es verlaesst das Haus und kommt nicht zurueck.
  'email:send',
  'settings:property', 'settings:account', 'user:manage', 'integration:manage',
  'account:contract',
  'platform:accounts', 'platform:support_session', 'platform:billing',
  'platform:operations'
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v)
}
