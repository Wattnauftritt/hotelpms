import { withTransaction, SYSTEM_CONTEXT, type Pool, type PoolClient } from '@hotelpms/db'

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
 * Protokollpartitionen jenseits der Aufbewahrungsfrist entfernen
 * (Befund 3, Dokument 26).
 *
 * Das Gegenstueck zu `ensureAuditPartitions`. Ohne es wuchs das Protokoll
 * unbegrenzt -- zwoelf Monate Vorlauf, aber nichts, was je wieder
 * verschwindet. Art. 5 Abs. 1 lit. e verlangt eine Frist, und "so lange wie
 * die Platte reicht" ist keine.
 *
 * Zehn Jahre, weil das der laengsten handels- und steuerrechtlichen Frist
 * entspricht: laenger als der Beleg, auf den sich ein Eintrag bezieht, muss
 * das Protokoll nicht leben. Die Zahl steht in der Datenbankfunktion und
 * nicht hier -- sie gehoert zur Aufbewahrungsregel, nicht zum Job.
 */
export async function dropOldAuditPartitions(client: PoolClient): Promise<number> {
  const r = await client.query<{ audit_log_drop_old_partitions: number }>(
    `SELECT audit_log_drop_old_partitions()`)
  return r.rows[0]!.audit_log_drop_old_partitions
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
 * Nur das Ende des Horizonts nachziehen (Befund 14).
 *
 * Der volle Lauf prueft 24 Monate je Kategorie -- bei 250 Zimmern rund
 * 180 000 Proben und eine Kapazitaetsrechnung ueber den ganzen Zeitraum --,
 * und das alle fuenf Minuten, obwohl je Tag genau ein neuer Tag am Ende
 * dazukommt. Die Kapazitaet halten die Trigger auf Zimmer und Sperrungen
 * ohnehin aktuell (0013); der volle Lauf ist das Sicherheitsnetz und laeuft
 * deshalb einmal am Tag (worker.ts).
 *
 * Gesucht wird je aktiver Kategorie -- und der Haussummenzeile -- der
 * letzte materialisierte Tag. Fehlt einer Kategorie der heutige Tag, ist
 * sie neu: dann ab heute, und das ist dieselbe Arbeit wie der volle Lauf.
 * Eine Kategorie ohne Zeilen kann sonst bis zum naechsten Morgen nicht
 * gebucht werden (`not_materialized`), denn auf resource_category liegt
 * kein Trigger.
 */
export async function materializeInventoryTail(
  client: PoolClient, propertyId: number, months = 24
): Promise<number> {
  const r = await client.query<{ von: string | null; bis: string }>(
    `WITH cats AS (
       SELECT id FROM resource_category WHERE property_id = $1 AND active
       UNION ALL SELECT 0
     )
     SELECT min(CASE
                  WHEN NOT EXISTS (SELECT 1 FROM inventory_day i
                                    WHERE i.property_id = $1 AND i.category_id = c.id
                                      AND i.date = current_date)
                  THEN current_date
                  ELSE (SELECT max(i.date) FROM inventory_day i
                         WHERE i.property_id = $1 AND i.category_id = c.id) + 1
                END)::text AS von,
            (current_date + ($2 || ' months')::interval)::date::text AS bis
       FROM cats c`,
    [propertyId, months])
  const { von, bis } = r.rows[0]!
  if (von === null || von >= bis) return 0
  const m = await client.query<{ inventory_materialize: number }>(
    `SELECT inventory_materialize($1, $2::date, $3::date)`, [propertyId, von, bis])
  return m.rows[0]!.inventory_materialize
}

/**
 * Rechnet die Zaehler gegen die Reservierungen nach.
 * Ein stiller Zaehlerfehler ist das Schlimmste, was einem Bestandssystem
 * passieren kann, deshalb laeuft dieser Abgleich regelmaessig -- stuendlich,
 * nicht in jedem Tick (worker.ts): ein Zaehler, der abweicht, weicht auch
 * in einer Stunde noch ab, und der Alarm kommt frueh genug.
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
       -- Je Gruppe des Zimmers, ohne Zimmer der gebuchten (Migration 0120).
       SELECT category_id, date, n AS counted
         FROM inventory_sold_expected($1, current_date)
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
  /*
   * Freischaltungen der Gaestemappe (0147). Nach dem Abreisetag oeffnet
   * keine mehr etwas; eine Woche Abstand, damit die Rezeption eine Frage
   * zum letzten Aufenthalt noch nachsehen kann. Danach ist die Zeile nur
   * noch eine Spur davon, welches Telefon zu welchem Gast gehoerte.
   */
  const m = await client.query(
    `DELETE FROM guest_folder_session WHERE expires_on < current_date - 7`)
  const z = await client.query(
    `DELETE FROM guest_folder_unlock_failure WHERE last_failure_at < now() - interval '1 day'`)
  return (s.rowCount ?? 0) + (i.rowCount ?? 0) + (t.rows[0]?.n ?? 0) + (f.rowCount ?? 0)
    + (m.rowCount ?? 0) + (z.rowCount ?? 0)
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

/**
 * Aufbewahrung der Arbeitstabellen des Workers (Befund 13).
 *
 * Diese Tabellen wuchsen bisher unbegrenzt, und keine davon ist ein
 * Buchungsbeleg: ein Zustellversuch, eine erledigte Uebersetzung, eine
 * gesendete Push-Meldung beantworten Fragen der naechsten Wochen ("ist das
 * rausgegangen, und wenn nein, warum"), nicht der naechsten Jahre. Die
 * Rechnung selbst, ihr Beleg und der Postausgang bleiben unberuehrt.
 *
 * Mandantenuebergreifend und mit der Eigentuemerrolle, wie purgeExpired:
 * unter dem leeren Systemkontext saehe die Anwendungsrolle in jeder dieser
 * Tabellen keine Zeile und meldete trotzdem Erfolg.
 *
 * In Stapeln, jeder in seiner eigenen Transaktion. Der erste Lauf nach dem
 * Einspielen findet die ganze Geschichte vor; in einem Stueck hielte er
 * Sperren und WAL fuer Millionen Zeilen.
 */
export interface RetentionResult {
  webhookDeliveries: number
  emailAttempts: number
  platformEmailBodies: number
  staffTextJobs: number
  staffPushes: number
}

const STAPEL = 5_000
const MAX_STAPEL = 200

async function stapelweise(admin: Pool, sql: string): Promise<number> {
  let summe = 0
  for (let i = 0; i < MAX_STAPEL; i++) {
    const r = await withTransaction(admin, SYSTEM_CONTEXT, c => c.query(sql, [STAPEL]))
    const n = r.rowCount ?? 0
    summe += n
    if (n < STAPEL) break
  }
  return summe
}

export async function purgeRetention(admin: Pool): Promise<RetentionResult> {
  /*
   * Webhook-Zustellungen: erledigte und gescheiterte nach 30 Tagen, die
   * Versuche fallen ueber ON DELETE CASCADE mit. Jede Zeile traegt die volle
   * Nutzlast des Ereignisses; nach einem Monat fragt niemand mehr danach,
   * und der Empfaenger hat sie, oder er hat sie nie gewollt. Offene bleiben,
   * gleich wie alt -- die verschwinden nur durch Zustellen oder Aufgeben.
   */
  const webhookDeliveries = await stapelweise(admin,
    `DELETE FROM webhook_delivery WHERE id IN (
       SELECT id FROM webhook_delivery
        WHERE status <> 'pending' AND occurred_at < now() - interval '30 days'
        LIMIT $1)`)

  /*
   * Versuchsprotokoll der Gastpost nach 90 Tagen -- derselbe Abstand, nach
   * dem email_redact_old Empfaenger und Rumpf entfernt. Im Fehlertext kann
   * die abgelehnte Adresse stehen (Brevo schickt sie zurueck); geschwaerzt
   * wird die Nachricht, aber nicht ihr Versuch, und das hier holt es nach.
   */
  const emailAttempts = await stapelweise(admin,
    `DELETE FROM outbound_email_attempt WHERE id IN (
       SELECT id FROM outbound_email_attempt
        WHERE attempted_at < now() - interval '90 days'
        LIMIT $1)`)

  /*
   * Zugangspost: der Rumpf traegt den Link mit dem Token. Nach Versand oder
   * Aufgeben faellt er sofort (platformEmail.ts); liegen blieb er bei einer
   * Nachricht, die nie hinausging -- ohne BREVO_API_KEY etwa. Nach sieben
   * Tagen ist jedes Token darin abgelaufen (das laengste gilt 48 Stunden),
   * und auth_token_cleanup raeumt zur selben Frist die Tokenzeile ab. Was
   * dann noch offen ist, wird aufgegeben statt spaeter mit leerem Rumpf
   * verschickt. Die Zeile selbst bleibt: das Panel beantwortet aus ihr
   * "ist die Einladung angekommen".
   */
  const platformEmailBodies = await stapelweise(admin,
    `UPDATE platform_email
        SET body_text = '', body_html = NULL,
            status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
            last_error = CASE WHEN status = 'pending' THEN 'expired' ELSE last_error END
      WHERE id IN (SELECT id FROM platform_email
                    WHERE created_at < now() - interval '7 days'
                      AND (body_text <> '' OR body_html IS NOT NULL)
                    LIMIT $1)`)

  // Erledigte Uebersetzungsauftraege: die Uebersetzung steht in
  // staff_text_translation, der Auftrag sagt nichts mehr. Wird der Text
  // geaendert, legt das Einreihen einen neuen an.
  const staffTextJobs = await stapelweise(admin,
    `DELETE FROM staff_text_job WHERE id IN (
       SELECT id FROM staff_text_job
        WHERE status = 'done' AND created_at < now() - interval '30 days'
        LIMIT $1)`)

  /*
   * Push an das Personal: erledigt nach einem Monat weg. Stand bisher in
   * sendStaffPushes und lief damit alle 20 Sekunden je Haus als Scan; es
   * sagt nur noch, wer wann welches Zimmer gemeldet bekam, und das steht im
   * Plan selbst.
   */
  const staffPushes = await stapelweise(admin,
    `DELETE FROM staff_push WHERE id IN (
       SELECT id FROM staff_push
        WHERE status <> 'pending' AND created_at < now() - interval '30 days'
        LIMIT $1)`)

  return { webhookDeliveries, emailAttempts, platformEmailBodies, staffTextJobs, staffPushes }
}
