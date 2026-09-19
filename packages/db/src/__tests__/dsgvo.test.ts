import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool,
         makeProperty, makeCategory, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * Was das DSGVO-Audit gefunden hat, und was es nicht wieder finden soll
 * (Dokument 26).
 *
 * Diese Tests sind der Grund, warum die Befunde 1 bis 3 nicht
 * zurueckkommen. Sie pruefen kein Schema und keine Funktionssignatur,
 * sondern das Verhalten: was steht nach einer Loeschung noch da, und wer
 * kann es lesen.
 *
 * Gegen echtes PostgreSQL, weil genau hier die Fachlichkeit liegt: ein
 * Trigger, eine Zeilenrichtlinie und ein Rechtefehler sind in einer
 * gemockten Datenbank alle drei unsichtbar.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let gastId: number
let katId: number

beforeAll(async () => { await ensureSchema(); owner = ownerPool(); app = appPool(10) })
afterAll(async () => { await owner.end(); await app.end() })

/** Kontext setzen und in derselben Transaktion arbeiten. */
type Abfrage = <R extends Record<string, unknown>>(sql: string, p?: unknown[])
  => Promise<{ rows: R[]; rowCount: number | null }>

async function alsMandant<T>(
  pool: Pool, accountId: number, propertyId: number, fn: (q: Abfrage) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('app.account_ids',$1,true),
              set_config('app.property_ids',$2,true),
              set_config('app.user_id','',true)`,
      [String(accountId), String(propertyId)])
    const r = await fn(((sql: string, p?: unknown[]) =>
      client.query(sql, p as never)) as Abfrage)
    await client.query('COMMIT')
    return r
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, phone, birth_date,
                        address_line1, postal_code, city, country, nationality)
     VALUES ($1,'Musterfrau','Hannelore','h.musterfrau@example.de','+49 170 1234567',
             '1968-04-02','Deichstrasse 7','25980','Sylt','DE','DE') RETURNING id`,
    [fx.accountId])
  gastId = g.rows[0]!.id
  katId = await makeCategory(owner, fx.propertyId)
})

describe('Befund 1: die Loeschung schreibt keine Kopie mehr', () => {
  /**
   * Der Kern. Vor Migration 0044 stand nach der Loeschung im Protokoll, was
   * die Loeschung gerade entfernt hatte -- Name, Geburtsdatum, Anschrift --
   * und die Anwendungsrolle konnte es nicht entfernen.
   */
  it('haelt kein Gastfeld im Klartext, nachdem der Gast geloescht wurde', async () => {
    await owner.query(
      `UPDATE guest SET last_name='Anonymisiert', first_name=NULL, email=NULL,
              birth_date=NULL, address_line1=NULL, status='anonymized',
              anonymized_at=now() WHERE id=$1`, [gastId])

    const r = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log
        WHERE table_name='guest' AND action='UPDATE' AND changed ? 'status'
        ORDER BY occurred_at DESC LIMIT 1`)
    const changed = r.rows[0]!.changed
    const alsText = JSON.stringify(changed)

    expect(alsText).not.toContain('Musterfrau')
    expect(alsText).not.toContain('Hannelore')
    expect(alsText).not.toContain('h.musterfrau@example.de')
    expect(alsText).not.toContain('1968-04-02')
    expect(alsText).not.toContain('Deichstrasse')
  })

  /**
   * Redigieren heisst nicht loeschen. Bliebe der Schluessel nicht stehen,
   * waere das Protokoll wertlos -- es soll weiter beantworten, wer wann
   * welches Feld angefasst hat.
   */
  it('laesst nachweisbar, welche Felder geaendert wurden', async () => {
    await owner.query(
      `UPDATE guest SET last_name='Anonymisiert', email=NULL, status='anonymized'
        WHERE id=$1`, [gastId])
    const r = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name='guest' AND action='UPDATE'
        ORDER BY occurred_at DESC LIMIT 1`)
    const keys = Object.keys(r.rows[0]!.changed)
    expect(keys).toContain('last_name')
    expect(keys).toContain('email')
    expect(keys).toContain('status')
    // Und der Statuswechsel selbst steht im Klartext da: er bezeichnet
    // niemanden.
    expect(JSON.stringify(r.rows[0]!.changed)).toContain('anonymized')
  })

  /**
   * Der Meldeschein ist der teure Fall: § 30 Abs. 4 BMG verlangt seine
   * Vernichtung, und genau die Vernichtung legte ihn vorher unbefristet ins
   * Protokoll.
   */
  it('haelt keine Unterschrift, nachdem der Meldeschein vernichtet wurde', async () => {
    const res = await owner.query<{ id: number }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fx.propertyId])
    const r2 = await owner.query<{ id: number }>(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival,
                                departure, status, primary_guest_id)
       VALUES ($1,$2,$3,current_date,current_date+1,'Confirmed',$4) RETURNING id`,
      [fx.propertyId, res.rows[0]!.id, katId, gastId])
    await owner.query(
      `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                 planned_departure, occupant_count, is_foreign,
                                 signature_svg, signed_at, destroy_after)
       VALUES ($1,$2,$3,current_date,current_date+1,1,true,
               '<svg><path d="GEHEIM"/></svg>', now(), current_date+365)`,
      [fx.propertyId, r2.rows[0]!.id, gastId])

    await owner.query(`DELETE FROM registration WHERE guest_id=$1`, [gastId])

    const r = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name='registration' AND action='DELETE'`)
    expect(r.rowCount).toBe(1)
    expect(JSON.stringify(r.rows[0]!.changed)).not.toContain('GEHEIM')
  })

  /**
   * Mitgefunden und mit behoben: ein Kennworthash gehoert in keine Tabelle
   * ohne Frist. Das ist kein Datenschutz-, sondern ein Sicherheitsbefund.
   */
  it('haelt keinen Kennworthash und kein Geheimnis', async () => {
    await owner.query(
      `INSERT INTO app_user (email, display_name, password_hash)
       VALUES ('pruef@test.de','Pruefung','$argon2id$GEHEIMERHASH$xy')`)
    await owner.query(
      `UPDATE app_user SET password_hash='$argon2id$NEUERGEHEIMERHASH$ab'
        WHERE email='pruef@test.de'`)
    const r = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name='app_user'`)
    const alles = r.rows.map(x => JSON.stringify(x.changed)).join(' ')
    expect(alles).not.toContain('GEHEIMERHASH')
    expect(alles).not.toContain('NEUERGEHEIMERHASH')
  })

  /**
   * Die Liste ist Daten, nicht Code -- und ein Feld, das jemand von der
   * Liste nimmt, soll auffallen. Dieser Test ist die Stelle, an der es das
   * tut.
   */
  it('schuetzt die Felder, die das Audit benannt hat', async () => {
    const r = await owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM audit_redaction`)
    const paare = new Set(r.rows.map(x => `${x.table_name}.${x.column_name}`))
    for (const feld of ['guest.last_name', 'guest.email', 'guest.birth_date',
                        'guest.id_document_number_enc', 'guest_property_note.note',
                        'reservation.notes', 'registration.signature_svg',
                        'guest_agreement.signature_svg', 'app_user.password_hash',
                        'app_user.totp_secret_enc', 'app_user.workstation_pin_hash']) {
      expect(paare.has(feld), `${feld} fehlt in audit_redaction`).toBe(true)
    }
  })
})

describe('Befund 1, Altbestand: die Migration redigiert auch eine gefuellte Tabelle', () => {
  /*
   * Der Block aus Migration 0044, der die schon geschriebenen Kopien
   * redigiert, lief in jedem Test gegen ein leeres Protokoll -- und
   * scheiterte auf der Produktivmaschine an trg_append_only, weil dort
   * Zeilen lagen. Hier wird genau dieser Block aus der Datei gelesen und
   * gegen eine Zeile mit Gastdaten ausgefuehrt, mit scharfem Trigger.
   */
  it('setzt den Unveraenderlichkeits-Trigger aus und danach wieder scharf', async () => {
    const datei = readFileSync(
      new URL('../../migrations/0044_audit_redaktion.sql', import.meta.url), 'utf8')
    const block = datei.slice(
      datei.indexOf('-- >>> altbestand'), datei.indexOf('-- <<< altbestand'))
    expect(block).toContain('DO $$')

    // Ohne Mandant: die Zeile bleibt stehen (Haertegrad 1, kein DELETE) und
    // darf keinem spaeteren Test unter dessen Kontext auftauchen.
    await owner.query(
      `INSERT INTO audit_log (account_id, table_name, row_id, row_key, action, changed)
       VALUES (NULL, 'guest', 4711, '{"id":4711}', 'DELETE',
               '{"last_name":"Musterfrau","status":"active"}')`)
    await owner.query(block)

    const r = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name='guest' AND row_id=4711`)
    expect(r.rows[0]!.changed).toEqual({ last_name: '[redigiert]', status: 'active' })

    // Danach ist das Protokoll wieder unveraenderlich -- auf jeder Partition.
    const scharf = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = 'trg_append_only' AND tgenabled <> 'O'
          AND tgrelid::regclass::text LIKE 'audit_log%'`)
    expect(scharf.rows[0]!.n).toBe(0)
    await expect(owner.query(
      `UPDATE audit_log SET action = 'UPDATE' WHERE row_id = 4711`)).rejects.toThrow(/unveraenderlich/)
  })
})

describe('Befund 2: audit_log traegt eine Zeilenrichtlinie', () => {
  it('zeigt der Anwendungsrolle kein fremdes Protokoll', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdes Haus', code: 'FRD' })
    await owner.query(`UPDATE guest SET city='Hamburg' WHERE id=$1`, [gastId])

    const eigen = await alsMandant(app, fx.accountId, fx.propertyId, q =>
      q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE table_name='guest'`))
    expect(eigen.rows[0]!.n).toBeGreaterThan(0)

    const fremdSicht = await alsMandant(app, fremd.accountId, fremd.propertyId, q =>
      q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE table_name='guest'`))
    expect(fremdSicht.rows[0]!.n).toBe(0)
  })

  it('laesst die Anwendungsrolle weiterhin nichts aendern oder loeschen', async () => {
    // Haertegrad 1 bleibt, was er war. Die Richtlinie ersetzt ihn nicht.
    await expect(alsMandant(app, fx.accountId, fx.propertyId, q =>
      q(`DELETE FROM audit_log WHERE table_name='guest'`))).rejects.toThrow()
  })
})

describe('Befund 3: das Protokoll hat eine Frist', () => {
  it('entfernt Partitionen jenseits der Aufbewahrung und nur diese', async () => {
    // Ueber Namen und nicht ueber Anzahlen: `pnpm test` laeuft in einem
    // Prozess gegen eine Datenbank, und eine globale Zaehlung saehe, was
    // andere Tests nebenher anlegen (CLAUDE.md).
    await owner.query(
      `CREATE TABLE IF NOT EXISTS audit_log_2009_01 PARTITION OF audit_log
         FOR VALUES FROM ('2009-01-01') TO ('2009-02-01')`)
    const diesenMonat = 'audit_log_' +
      new Date().toISOString().slice(0, 7).replace('-', '_')

    await owner.query(`SELECT audit_log_drop_old_partitions()`)

    const alt = await owner.query(
      `SELECT 1 FROM pg_class WHERE relname='audit_log_2009_01'`)
    expect(alt.rowCount, 'die alte Partition steht noch').toBe(0)

    // Ein Job, der zu viel entfernt, ist schlimmer als keiner.
    const jung = await owner.query(
      `SELECT 1 FROM pg_class WHERE relname=$1`, [diesenMonat])
    expect(jung.rowCount, 'der laufende Monat wurde mit entfernt').toBe(1)

    // Die Auffangpartition bleibt: sie ist der Alarm, nicht ein Bestand.
    const auffang = await owner.query(
      `SELECT 1 FROM pg_class WHERE relname='audit_log_default'`)
    expect(auffang.rowCount).toBe(1)
  })
})

describe('Befund 5 und 7: die Loeschung erreicht alles', () => {
  it('entfernt die Unterschrift unter den Hausbedingungen', async () => {
    const t = await owner.query<{ id: number }>(
      `INSERT INTO property_terms (property_id, code, version, title, body,
                                   requires_signature, active_from)
       VALUES ($1,'agb',1,'Hausordnung','Text',true,current_date) RETURNING id`,
      [fx.propertyId])
    const b = await owner.query<{ id: number }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fx.propertyId])
    const res = await owner.query<{ id: number }>(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival,
                                departure, status, primary_guest_id)
       VALUES ($1,$2,$3,current_date,current_date+1,'Confirmed',$4) RETURNING id`,
      [fx.propertyId, b.rows[0]!.id, katId, gastId])
    await owner.query(
      `INSERT INTO guest_agreement (property_id, reservation_id, terms_id, guest_id,
                                    signature_svg)
       VALUES ($1,$2,$3,$4,'<svg><path d="UNTERSCHRIFT"/></svg>')`,
      [fx.propertyId, res.rows[0]!.id, t.rows[0]!.id, gastId])

    await alsMandant(owner, fx.accountId, fx.propertyId, q =>
      q(`SELECT guest_erase_one($1)`, [gastId]))

    const r = await owner.query<{ signature_svg: string | null; agreed_at: string }>(
      `SELECT signature_svg, agreed_at::text FROM guest_agreement WHERE guest_id=$1`,
      [gastId])
    // Die Zeile bleibt -- dass zugestimmt wurde, ist der Nachweis.
    expect(r.rowCount).toBe(1)
    expect(r.rows[0]!.agreed_at).not.toBe('')
    // Das Bild der Unterschrift faellt.
    expect(r.rows[0]!.signature_svg).toBeNull()
  })

  it('redigiert die Gastpost sofort, nicht erst nach neunzig Tagen', async () => {
    const b = await owner.query<{ id: number }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fx.propertyId])
    const res = await owner.query<{ id: number }>(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival,
                                departure, status, primary_guest_id)
       VALUES ($1,$2,$3,current_date,current_date+1,'Confirmed',$4) RETURNING id`,
      [fx.propertyId, b.rows[0]!.id, katId, gastId])
    await owner.query(
      `INSERT INTO outbound_email (property_id, kind, to_email, to_name, subject,
                                   body_text, reservation_id, status, created_at)
       VALUES ($1,'reservation_confirmation','h.musterfrau@example.de','Hannelore Musterfrau',
               'Ihre Buchung','Guten Tag Frau Musterfrau, ...',$2,'sent', now())`,
      [fx.propertyId, res.rows[0]!.id])

    await alsMandant(owner, fx.accountId, fx.propertyId, q =>
      q(`SELECT guest_erase_one($1)`, [gastId]))

    const r = await owner.query<{ to_email: string; to_name: string | null;
                                 body_text: string; redacted_at: string | null }>(
      `SELECT to_email, to_name, body_text, redacted_at::text FROM outbound_email`)
    expect(r.rows[0]!.to_email).toBe('entfernt@invalid')
    expect(r.rows[0]!.to_name).toBeNull()
    expect(r.rows[0]!.body_text).toBe('')
    expect(r.rows[0]!.redacted_at).not.toBeNull()
  })

  it('fasst einen Gast aus einem fremden Account nicht an', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremd', code: 'FR2' })
    await alsMandant(owner, fremd.accountId, fremd.propertyId, q =>
      q(`SELECT guest_erase_one($1)`, [gastId]))
    const r = await owner.query<{ last_name: string }>(
      `SELECT last_name FROM guest WHERE id=$1`, [gastId])
    expect(r.rows[0]!.last_name).toBe('Musterfrau')
  })
})

describe('Befund 9: Idempotenzschluessel liegen im Mandanten', () => {
  it('zeigt einen fremden Schluessel nicht', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremd', code: 'FR3' })
    await owner.query(
      `INSERT INTO idempotency_key (client_key, key, request_hash, account_id)
       VALUES ('c1','k1','h1',$1)`, [fx.accountId])

    const eigen = await alsMandant(app, fx.accountId, fx.propertyId, q =>
      q<{ n: number }>(`SELECT count(*)::int AS n FROM idempotency_key`))
    expect(eigen.rows[0]!.n).toBe(1)

    const fremdSicht = await alsMandant(app, fremd.accountId, fremd.propertyId, q =>
      q<{ n: number }>(`SELECT count(*)::int AS n FROM idempotency_key`))
    expect(fremdSicht.rows[0]!.n).toBe(0)
  })
})
