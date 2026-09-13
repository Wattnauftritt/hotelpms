import type { PoolClient } from '@hotelpms/db'

/**
 * Taegliche Pflegearbeiten. Alle idempotent.
 */

/** Partitionen des Audit-Logs zwoelf Monate im Voraus (P2, Dokument 12). */
export async function ensureAuditPartitions(client: PoolClient): Promise<number> {
  const r = await client.query<{ audit_log_ensure_partitions: number }>(
    `SELECT audit_log_ensure_partitions(12)`)
  return r.rows[0]!.audit_log_ensure_partitions
}

/**
 * Alarm, wenn die Default-Partition Zeilen enthaelt: dann wurde eine
 * Monatspartition zu spaet angelegt.
 */
export async function auditDefaultPartitionRows(client: PoolClient): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log_default`)
  return r.rows[0]!.n
}

/** Rollierender Horizont von 24 Monaten fuer inventory_day (P1, Dokument 12). */
export async function materializeInventory(
  client: PoolClient, propertyId: number, months = 24
): Promise<number> {
  const r = await client.query<{ inventory_materialize: number }>(
    `SELECT inventory_materialize($1, current_date,
            (current_date + ($2 || ' months')::interval)::date)`,
    [propertyId, months])
  return r.rows[0]!.inventory_materialize
}

/**
 * Rechnet die Zaehler gegen die Reservierungen nach.
 * Ein stiller Zaehlerfehler ist das Schlimmste, was einem Bestandssystem
 * passieren kann, deshalb laeuft dieser Abgleich taeglich.
 */
export interface InventoryDrift {
  categoryId: number
  date: string
  counted: number
  stored: number
}

export async function reconcileInventory(
  client: PoolClient, propertyId: number
): Promise<InventoryDrift[]> {
  const r = await client.query<InventoryDrift>(
    `WITH gezaehlt AS (
       SELECT r.category_id, d.day::date AS date, count(*)::int AS counted
         FROM reservation r
         CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d(day)
        WHERE r.property_id = $1
          AND r.status IN ('Optional','Confirmed','InHouse')
          AND d.day >= current_date
        GROUP BY r.category_id, d.day
     )
     SELECT i.category_id AS "categoryId", i.date::text AS date,
            COALESCE(g.counted, 0) AS counted, i.sold AS stored
       FROM inventory_day i
       LEFT JOIN gezaehlt g ON g.category_id = i.category_id AND g.date = i.date
      WHERE i.property_id = $1 AND i.category_id <> 0 AND i.date >= current_date
        AND i.sold IS DISTINCT FROM COALESCE(g.counted, 0)
      ORDER BY i.date, i.category_id
      LIMIT 100`, [propertyId])
  return r.rows
}

/**
 * Meldescheine nach Ablauf der Jahresfrist vernichten (§ 30 BMG).
 * Laeuft je Property, nicht ueber alle: der Worker arbeitet im Kontext genau
 * einer Property, damit die Zeilenrichtlinie auch fuer ihn greift.
 */
export async function purgeRegistrations(
  client: PoolClient, propertyId: number
): Promise<number> {
  const r = await client.query(
    `DELETE FROM registration WHERE property_id = $1 AND destroy_after < current_date`,
    [propertyId])
  return r.rowCount ?? 0
}

/** Abgelaufene Sitzungen und Idempotenzschluessel aufraeumen. */
export async function purgeExpired(client: PoolClient): Promise<number> {
  const s = await client.query(
    `DELETE FROM user_session WHERE absolute_expires_at < now() - interval '7 days'`)
  const i = await client.query(`DELETE FROM idempotency_key WHERE expires_at < now()`)
  return (s.rowCount ?? 0) + (i.rowCount ?? 0)
}
