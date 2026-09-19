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

/**
 * Ausweisnummern nach der Jahresfrist entfernen (§ 30 Abs. 2 und 4 BMG).
 *
 * **Warum das nicht in `purgeRegistrations` steckt.** Die Nummer stand nie
 * auf dem Meldeschein, sondern am Gastprofil -- `registration` zu loeschen
 * liess sie unberuehrt liegen, und zwar unbegrenzt. Der einzige Weg, sie
 * loszuwerden, war die Anonymisierung auf Antrag des Gastes; seit die
 * Abgabenfrist des Hauses davorsteht, waere das bis zu sieben Jahre lang
 * kein Weg mehr gewesen.
 *
 * Das Gaesteverzeichnis, fuer das die lange Frist gilt, braucht die Nummer
 * nicht -- es fuehrt Name, Anschrift, Zeitraum, Naechte, Satz und Betrag.
 * Beide Fristen koennen deshalb nebeneinander gelten, und genau das tun sie
 * jetzt.
 *
 * Laeuft je Property wie die uebrigen Pflegejobs, wirkt aber je **Account**:
 * ein Gast, der auch im Schwesterhaus wohnte, haette sonst eine spaetere
 * Abreise, die dieser Lauf nicht saehe. Ein zweiter Aufruf fuer dasselbe
 * Haus findet nichts mehr und kostet einen Indexzugriff.
 */
export async function purgeGuestDocuments(client: PoolClient): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT guest_document_purge() AS n`)
  return r.rows[0]?.n ?? 0
}

/**
 * Aufgeschobene Loeschungen vollenden (Art. 17 DSGVO).
 *
 * Wer Loeschung verlangt, waehrend die Aufbewahrung des
 * Gaestebeitragsnachweises noch laeuft, bekommt sie sofort so weit, wie der
 * Nachweis sie zulaesst -- Name und Anschrift bleiben. Der Rest faellt
 * hier, sobald die Frist abgelaufen ist.
 *
 * **Warum das ein Job ist und kein Vermerk in einer Liste.** Zwischen
 * Antrag und Frist liegen Jahre. Bis dahin hat niemand mehr eine
 * Wiedervorlage, und die Loeschung unterbliebe -- nicht aus Absicht,
 * sondern weil sich niemand erinnert.
 */
export async function completeGuestErasures(client: PoolClient): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT guest_erasure_complete() AS n`)
  return r.rows[0]?.n ?? 0
}

/**
 * Gastdaten im Postausgang altern lassen.
 *
 * Eine Zustellung ist kein Buchungsbeleg: die Rechnung selbst liegt in
 * `invoice_document` und unterliegt dort der achtjaehrigen Aufbewahrung. Was
 * im Postausgang steht, ist eine Adresse und ein Anschreiben, und dafuer gibt
 * es nach ein paar Wochen keinen Zweck mehr -- nur noch ein Risiko.
 *
 * Entfernt werden deshalb Empfaenger und Rumpf, nicht die Zeile: die Frage
 * "ist die Rechnung rausgegangen" kann noch Jahre spaeter kommen, und sie
 * laesst sich ohne Gastdaten beantworten.
 */
export async function redactOldEmails(
  client: PoolClient, propertyId: number, days = 90
): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT email_redact_old($1,$2) AS n`, [propertyId, days])
  return r.rows[0]?.n ?? 0
}

/**
 * Abgelaufene Sitzungen, Idempotenzschluessel und Einmaltoken aufraeumen.
 *
 * Die Token mit derselben Nachlauffrist wie die Sitzungen, und aus einem
 * eigenen Grund: eine Woche nach Ablauf laesst sich die Frage "wurde die
 * Einladung angenommen" noch beantworten, danach interessiert sie niemanden
 * mehr (Migration 0030).
 */
export async function purgeExpired(client: PoolClient): Promise<number> {
  const s = await client.query(
    `DELETE FROM user_session WHERE absolute_expires_at < now() - interval '7 days'`)
  const i = await client.query(`DELETE FROM idempotency_key WHERE expires_at < now()`)
  const t = await client.query<{ n: number }>(`SELECT auth_token_cleanup() AS n`)
  /*
   * Fehlversuche je Herkunft (H3, Dokument 25). Sieben Tage, nicht die
   * Sperrdauer: der Zaehler soll einen zweiten Anlauf am naechsten Tag noch
   * sehen. Ohne dieses Aufraeumen waechst die Tabelle mit jeder Adresse, von
   * der je ein Tippfehler kam, und das ist im Mobilnetz jede zweite.
   */
  const f = await client.query(
    `DELETE FROM login_failure WHERE last_failure_at < now() - interval '7 days'`)
  return (s.rowCount ?? 0) + (i.rowCount ?? 0) + (t.rows[0]?.n ?? 0) + (f.rowCount ?? 0)
}

/**
 * Alarm bei ausgefallenem Nachtlauf.
 *
 * Der schlimmste Ausfall ist der stille. Laeuft der Nachtlauf nicht, faellt
 * es tagelang niemandem auf: die Rezeption bucht weiter, nur die Logis fehlt
 * auf den Folios, und beim Check-out steht ein zu kleiner Betrag. Bemerkt
 * wird es dann vom Gast, nicht vom Betrieb.
 *
 * Erkannt wird es am offenen Geschaeftstag: liegt er mehr als einen Tag
 * hinter dem heutigen Geschaeftsdatum, hat mindestens ein Lauf gefehlt.
 */
export interface NightAuditLag {
  propertyId: number
  propertyName: string
  openDate: string | null
  daysBehind: number
}

export async function overdueNightAudits(
  client: PoolClient, toleranceDays = 1
): Promise<NightAuditLag[]> {
  const r = await client.query<NightAuditLag>(
    `SELECT p.id AS "propertyId", p.name AS "propertyName",
            bd.date::text AS "openDate",
            (current_date - bd.date)::int AS "daysBehind"
       FROM property p
       LEFT JOIN LATERAL (
         SELECT date FROM business_day b
          WHERE b.property_id = p.id AND b.status = 'open'
          ORDER BY date LIMIT 1
       ) bd ON true
      WHERE p.status = 'active'
        AND (bd.date IS NULL OR current_date - bd.date > $1)
      ORDER BY bd.date NULLS FIRST`,
    [toleranceDays])
  return r.rows
}
