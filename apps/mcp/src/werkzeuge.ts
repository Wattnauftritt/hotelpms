import { MCP_FREIGABE_MINUTEN, MCP_KLARTEXT_ZEILEN } from '@hotelpms/contracts'
import type { Client, Pool, Verbindung } from './db.js'
import { lesend } from './db.js'
import { sqlPruefen, fuersProtokoll, SQL_MAX_ZEILEN } from './sql.js'
import { EINHEITEN, ipKuerzen, pinoZeile, type Einheit, type JournalLeser } from './journal.js'

/**
 * Die Werkzeuge des Claude-Zugangs (Dokument 38).
 *
 * Alle lesen. Jedes laeuft ueber `lesend()` -- Transaktion READ ONLY, nur
 * die geschwaerzten Sichten, fuenf Sekunden je Anweisung -- ausser der
 * Klartext-Anfrage, die eine Zeile in die eigene Tabelle schreibt.
 *
 * Die Antworten sind JSON. Ein Mensch liest sie nicht direkt, Claude schon,
 * und die Struktur macht aus "wie viele, welche, seit wann" eine Antwort
 * statt einer Suche im Fliesstext.
 */

export interface Umgebung {
  pool: Pool
  journal: JournalLeser
}

export interface Ergebnis {
  daten: unknown
  zeilen: number
  haus: number | null
  /** Was ins Protokoll geht, ohne Zeichenketten. */
  detail: string | null
  klartext: boolean
}

export interface Werkzeug {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** Schreibt nur die eigene Anfrage, nichts Fachliches. */
  readOnly: boolean
  ausfuehren(u: Umgebung, v: Verbindung, args: Record<string, unknown>): Promise<Ergebnis>
}

export class Eingabefehler extends Error {}

// ------------------------------------------------------------------ Helfer

async function zeilen<T = Record<string, unknown>>(
  c: Client, sql: string, params: unknown[] = []
): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[]
}

function ganzzahl(v: unknown, name: string, std: number, min: number, max: number): number {
  if (v === undefined || v === null) return std
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new Eingabefehler(`${name} muss eine ganze Zahl von ${min} bis ${max} sein.`)
  }
  return n
}

function hausId(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  return ganzzahl(v, 'haus', 0, 1, Number.MAX_SAFE_INTEGER)
}

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Eingabefehler(`${name} fehlt.`)
  if (v.length > max) throw new Eingabefehler(`${name} ist laenger als ${max} Zeichen.`)
  return v.trim()
}

function zaehle(d: unknown): number {
  if (Array.isArray(d)) return d.length
  if (d !== null && typeof d === 'object') {
    return Object.values(d).reduce<number>((s, x) => s + (Array.isArray(x) ? x.length : 0), 0)
  }
  return 0
}

async function lesen(
  u: Umgebung, v: Verbindung, haus: number | null, detail: string | null,
  arbeit: (c: Client) => Promise<unknown>
): Promise<Ergebnis> {
  const { ergebnis, klartext } = await lesend(u.pool, v, arbeit)
  return { daten: ergebnis, zeilen: zaehle(ergebnis), haus, detail, klartext }
}

const HAUS_SCHEMA = { type: 'integer', minimum: 1,
                      description: 'Nur dieses Haus (property.id). Ohne Angabe: alle.' }

function quantil(werte: number[], q: number): number | null {
  if (werte.length === 0) return null
  const s = [...werte].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

// --------------------------------------------------------------- Werkzeuge

const ueberblick: Werkzeug = {
  name: 'ueberblick',
  title: 'Betriebszustand',
  description: 'Laufender Stand, Migrationen, Haeuser mit Geschaeftstag und Nachtlauf, '
    + 'Warteschlangen (Gastpost, Plattformpost, Push, Webhooks, Belege, Kanalabgleich) und '
    + 'Sicherheitsereignisse der letzten 24 Stunden. Der erste Blick bei jeder Fehlersuche.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v) => lesen(u, v, null, null, async c => ({
    stand: await zeilen(c, `SELECT commit, subject, committed_at, seen_at, is_current
                              FROM release ORDER BY seen_at DESC LIMIT 5`),
    migrationen: (await zeilen(c, `SELECT count(*)::int AS anzahl, max(name) AS letzte,
                                          max(applied_at) AS zuletzt FROM schema_migration`))[0],
    haeuser: await zeilen(c, `
      SELECT p.id, p.code, p.name, p.status, p.is_training, a.public_ref AS betrieb,
             (SELECT max(b.date) FROM business_day b
               WHERE b.property_id = p.id AND b.status = 'open') AS geschaeftstag,
             (SELECT max(n.completed_at) FROM night_audit_step n
               WHERE n.property_id = p.id) AS nachtlauf_zuletzt
        FROM property p JOIN account a ON a.id = p.account_id
       ORDER BY p.id`),
    gastpost: await zeilen(c, `SELECT status, delivery_status, count(*)::int AS anzahl,
                                      min(created_at) AS aelteste
                                 FROM outbound_email WHERE created_at > now() - interval '7 days'
                                GROUP BY 1, 2 ORDER BY 1, 2`),
    plattformpost: await zeilen(c, `SELECT kind, status, count(*)::int AS anzahl
                                      FROM platform_email WHERE created_at > now() - interval '7 days'
                                     GROUP BY 1, 2 ORDER BY 1, 2`),
    push: await zeilen(c, `SELECT kind, status, count(*)::int AS anzahl FROM staff_push
                            WHERE created_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 1, 2`),
    webhooks: await zeilen(c, `SELECT status, count(*)::int AS anzahl, max(occurred_at) AS zuletzt
                                 FROM webhook_delivery WHERE occurred_at > now() - interval '7 days'
                                GROUP BY 1`),
    belege_ohne_dokument: (await zeilen(c, `SELECT count(*)::int AS anzahl,
                                                   max(last_error) AS letzter_fehler
                                              FROM invoice_document_failure`))[0],
    kanalabgleich_24h: await zeilen(c, `SELECT property_id, kind, status, count(*)::int AS anzahl,
                                               max(error_key) AS fehler
                                          FROM channel_sync_log
                                         WHERE started_at > now() - interval '24 hours'
                                         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    ausrollen: await zeilen(c, `SELECT kind, status, target_ref, requested_at, finished_at
                                  FROM deploy_request ORDER BY requested_at DESC LIMIT 3`),
    sicherheit_24h: await zeilen(c, `SELECT kind, count(*)::int AS anzahl FROM security_event
                                      WHERE created_at > now() - interval '24 hours'
                                      GROUP BY 1 ORDER BY 2 DESC`)
  }))
}

const tabellen: Werkzeug = {
  name: 'tabellen',
  title: 'Tabellen und Spalten',
  description: 'Ohne Angabe: alle lesbaren Tabellen mit geschaetzter Zeilenzahl. Mit `tabelle`: '
    + 'deren Spalten, Typ und Einordnung (sichtbar, maskiert = Mailadressen ersetzt, '
    + 'netz = IP gekuerzt, person = geschwaerzt bis zur Freigabe, fehlt = nie lesbar).',
  inputSchema: { type: 'object', properties: {
    tabelle: { type: 'string', description: 'Name der Tabelle, etwa reservation.' } },
    additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const t = a.tabelle === undefined ? null : text(a.tabelle, 'tabelle', 63)
    return lesen(u, v, null, t, async c => {
      if (t === null) {
        return zeilen(c, `
          SELECT v.relname AS tabelle, GREATEST(t.reltuples, 0)::bigint AS zeilen_geschaetzt
            FROM pg_class v JOIN pg_namespace n ON n.oid = v.relnamespace AND n.nspname = 'mcp'
            LEFT JOIN pg_class t ON t.relname = v.relname
             AND t.relnamespace = 'public'::regnamespace
           WHERE v.relkind = 'v' ORDER BY 1`)
      }
      const spalten = await zeilen(c, `
        SELECT s.spalte, s.klasse,
               (SELECT format_type(a.atttypid, NULL) FROM pg_attribute a
                 WHERE a.attrelid = to_regclass('mcp.' || quote_ident($1))
                   AND a.attname = s.spalte) AS typ
          FROM mcp_dienst.spalten() s WHERE s.tabelle = $1`, [t])
      if (spalten.length === 0) throw new Eingabefehler(`Tabelle ${t} gibt es nicht oder sie ist ausgeschlossen.`)
      return spalten
    })
  }
}

const sqlLesen: Werkzeug = {
  name: 'sql_lesen',
  title: 'Lesende SQL-Abfrage',
  description: `Eine SELECT-Abfrage gegen die geschwaerzten Sichten (Tabellennamen wie in der `
    + `Datenbank, etwa reservation, guest, charge). Hoechstens ${SQL_MAX_ZEILEN} Zeilen, `
    + `5 Sekunden, nur lesen. Personenbezogene Spalten erscheinen als [geschwaerzt], solange `
    + `fuer das Haus der Zeile keine Klartext-Freigabe laeuft. Zeichenketten in der Abfrage `
    + `werden im Protokoll ersetzt.`,
  inputSchema: { type: 'object', required: ['sql'], properties: {
    sql: { type: 'string', description: 'Eine Anweisung, beginnend mit SELECT oder WITH.' },
    haus: { ...HAUS_SCHEMA, description: 'Nur fuers Protokoll: um welches Haus es geht.' } },
    additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const sql = sqlPruefen(a.sql)
    return lesen(u, v, hausId(a.haus), fuersProtokoll(sql), async c => {
      const r = await c.query(`SELECT * FROM (${sql}\n) AS abfrage LIMIT ${SQL_MAX_ZEILEN + 1}`)
      const mehr = r.rows.length > SQL_MAX_ZEILEN
      return { spalten: r.fields.map(f => f.name), zeilen: r.rows.slice(0, SQL_MAX_ZEILEN),
               abgeschnitten: mehr }
    }).then(e => ({ ...e,
      zeilen: (e.daten as { zeilen: unknown[] }).zeilen.length }))
  }
}

const sicherheit: Werkzeug = {
  name: 'sicherheit',
  title: 'Sicherheitsereignisse',
  description: 'Sicherheitsereignisse, Mengen je Aufrufer (access_volume) und fehlgeschlagene '
    + 'Anmeldungen im Zeitraum. IP-Adressen gekuerzt, solange keine Freigabe laeuft.',
  inputSchema: { type: 'object', properties: {
    stunden: { type: 'integer', minimum: 1, maximum: 720, default: 24 },
    haus: HAUS_SCHEMA }, additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const h = ganzzahl(a.stunden, 'stunden', 24, 1, 720)
    const haus = hausId(a.haus)
    return lesen(u, v, haus, `stunden=${h}`, async c => ({
      ereignisse: await zeilen(c, `
        SELECT id, created_at, account_id, property_id, kind, actor_kind, actor_user_id,
               actor_ref, origin, detail
          FROM security_event
         WHERE created_at > now() - make_interval(hours => $1)
           AND ($2::bigint IS NULL OR property_id = $2)
         ORDER BY created_at DESC LIMIT 200`, [h, haus]),
      mengen: await zeilen(c, `
        SELECT principal_key, account_id, sum(requests)::int AS anfragen,
               sum(rows_returned)::int AS zeilen, max(hour) AS zuletzt,
               array_agg(DISTINCT origin) AS herkunft
          FROM access_volume
         WHERE hour > now() - make_interval(hours => $1)
         GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 50`, [h]),
      // Je Benutzer und Herkunft ein Zaehler, kein Ereignis je Versuch.
      anmeldefehler: await zeilen(c, `
        SELECT count(*)::int AS zaehler, coalesce(sum(failed_count), 0)::int AS versuche,
               count(*) FILTER (WHERE locked_until > now())::int AS gesperrt
          FROM login_failure
         WHERE last_failure_at > now() - make_interval(hours => $1)`, [h])
    }))
  }
}

const protokoll: Werkzeug = {
  name: 'protokoll',
  title: 'Protokoll der Dienste',
  description: 'Zeilen aus dem Journal von API, Worker und den Betriebsdiensten, juengste zuletzt. '
    + 'Die API schreibt pino-JSON; Gastdaten stehen nicht darin, IP-Adressen werden gekuerzt. '
    + '`muster` ist ein regulaerer Ausdruck fuer journalctl --grep.',
  inputSchema: { type: 'object', properties: {
    einheiten: { type: 'array', items: { type: 'string', enum: [...EINHEITEN] },
                 default: ['hotelpms-api', 'hotelpms-worker'] },
    minuten: { type: 'integer', minimum: 1, maximum: 10080, default: 60 },
    zeilen: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
    muster: { type: 'string', maxLength: 200 } }, additionalProperties: false },
  readOnly: true,
  ausfuehren: async (u, _v, a) => {
    const einheiten = (Array.isArray(a.einheiten) ? a.einheiten : ['hotelpms-api', 'hotelpms-worker'])
    if (!einheiten.every(e => (EINHEITEN as readonly unknown[]).includes(e))) {
      throw new Eingabefehler(`einheiten nur aus: ${EINHEITEN.join(', ')}`)
    }
    const muster = a.muster === undefined ? undefined : text(a.muster, 'muster', 200)
    const z = await u.journal({ einheiten: einheiten as Einheit[],
                                seitMinuten: ganzzahl(a.minuten, 'minuten', 60, 1, 10080),
                                zeilen: ganzzahl(a.zeilen, 'zeilen', 200, 1, 1000), muster })
    // Gekuerzt wird hier und nicht nur im Leser: welcher Leser es auch ist,
    // eine volle IP-Adresse soll nicht hinausgehen.
    const daten = z.map(x => ({ ...x, text: ipKuerzen(x.text) }))
    return { daten, zeilen: z.length, haus: null, klartext: false,
             detail: `einheiten=${einheiten.join(',')}${muster === undefined ? '' : ' muster=…'}` }
  }
}

const konfiguration: Werkzeug = {
  name: 'konfiguration',
  title: 'Konfiguration',
  description: 'Welche Umgebungsvariablen API und Worker beim letzten Start gesetzt hatten '
    + '(nur ja/nein, nie Werte), dazu die wichtigsten Einstellungen von PostgreSQL.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v) => lesen(u, v, null, null, async c => ({
    dienste: await zeilen(c, `SELECT service, name, is_set, reported_at
                                FROM service_config_presence ORDER BY 1, 2`),
    postgresql: await zeilen(c, `
      SELECT name, setting, unit FROM pg_settings
       WHERE name IN ('server_version', 'max_connections', 'shared_buffers', 'work_mem',
                      'effective_cache_size', 'archive_mode', 'wal_level', 'timezone',
                      'shared_preload_libraries', 'statement_timeout',
                      'idle_in_transaction_session_timeout')
       ORDER BY 1`)
  }))
}

const klartextAnfragen: Werkzeug = {
  name: 'klartext_anfragen',
  title: 'Klartext anfragen',
  description: `Bittet Sven um Klartext fuer ein Haus. Er bekommt eine Push-Meldung und einen `
    + `Hinweis im Adminpanel mit einer zweistelligen Abgleichszahl und gibt mit seinem Passkey `
    + `frei. Dann ist das Haus ${MCP_FREIGABE_MINUTEN} Minuten oder ${MCP_KLARTEXT_ZEILEN} `
    + `Zeilen lang im Klartext lesbar. Nur anfragen, wenn die geschwaerzten Daten fuer die `
    + `Fehlersuche wirklich nicht reichen, und den Grund konkret nennen. Die Abgleichszahl `
    + `dem Menschen im Gespraech nennen.`,
  inputSchema: { type: 'object', required: ['haus', 'grund'], properties: {
    haus: { type: 'integer', minimum: 1, description: 'property.id' },
    grund: { type: 'string', minLength: 5, maxLength: 300,
             description: 'Wofuer der Klartext gebraucht wird, konkret.' } },
    additionalProperties: false },
  readOnly: false,
  ausfuehren: async (u, v, a) => {
    const haus = ganzzahl(a.haus, 'haus', 0, 1, Number.MAX_SAFE_INTEGER)
    const grund = text(a.grund, 'grund', 300)
    let r
    try {
      r = await u.pool.query<{ ref: string; abgleich: string; haus: string; betrieb: string }>(
        'SELECT * FROM mcp_dienst.freigabe_anfragen($1, $2, $3)', [v.id, haus, grund])
    } catch (e) {
      const m = (e as { message?: string }).message ?? ''
      if (m === 'mcp_property_unknown') throw new Eingabefehler(`Haus ${haus} gibt es nicht.`)
      if (m === 'mcp_too_many_requests') {
        throw new Eingabefehler('Es sind schon drei Anfragen offen. Erst auf Sven warten.')
      }
      throw e
    }
    const z = r.rows[0]!
    return {
      daten: {
        anfrage: z.ref, abgleichszahl: z.abgleich, haus: z.haus, zustand: 'offen',
        hinweis: `Sag Sven die Abgleichszahl ${z.abgleich}. Er gibt im Adminpanel frei `
          + `(Reiter Claude-Zugang). Danach mit klartext_status pruefen.`
      },
      zeilen: 0, haus, klartext: false, detail: 'grund=…'
    }
  }
}

const klartextStatus: Werkzeug = {
  name: 'klartext_status',
  title: 'Stand der Klartext-Freigaben',
  description: 'Die Anfragen und Freigaben dieser Verbindung: offen, aktiv (bis wann, wie viele '
    + 'Zeilen verbraucht), abgelehnt, beendet, abgelaufen.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  ausfuehren: async (u, v) => {
    const r = await u.pool.query('SELECT * FROM mcp_dienst.freigaben($1)', [v.id])
    return { daten: r.rows, zeilen: 0, haus: null, klartext: false, detail: null }
  }
}

const buchungLebenslauf: Werkzeug = {
  name: 'buchung_lebenslauf',
  title: 'Lebenslauf einer Buchung',
  description: 'Alles zu einer Reservierung in einer Antwort: Reservierung und Buchung, Naechte, '
    + 'Aenderungszeitpunkte, Kanal-Revisionen, Folios mit Buchungen und Zahlungen, Rechnungen '
    + 'und ob ihr Beleg da ist, Gastpost, Webhooks, Meldeschein und Protokoll. `referenz` ist '
    + 'die public_ref oder id der Reservierung, die public_ref der Buchung oder eine '
    + 'Buchungsnummer des Kanals.',
  inputSchema: { type: 'object', required: ['referenz'], properties: {
    referenz: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const ref = text(a.referenz, 'referenz', 80)
    return lesen(u, v, null, 'referenz=…', async c => {
      const res = await zeilen<{ id: string; property_id: string; booking_id: string;
                                 public_ref: string }>(c, `
        SELECT r.* FROM reservation r
          LEFT JOIN booking b ON b.id = r.booking_id
         WHERE r.public_ref = $1 OR b.public_ref = $1
            OR b.channel_booking_number = $1 OR b.external_reference = $1
            OR ($1 ~ '^[0-9]{1,18}$' AND r.id = $1::bigint)
         ORDER BY r.id LIMIT 20`, [ref])
      if (res.length === 0) throw new Eingabefehler(`Keine Reservierung zu ${ref}.`)
      const ids = res.map(r => r.id)
      const buchungen = [...new Set(res.map(r => r.booking_id).filter(Boolean))]
      const refs = [...res.map(r => r.public_ref)]
      const folios = await zeilen<{ id: string }>(c,
        'SELECT * FROM folio WHERE reservation_id = ANY($1::bigint[]) ORDER BY id', [ids])
      const folioIds = folios.map(f => f.id)
      const buchung = await zeilen<{ public_ref: string; external_reference: string | null;
                                     property_id: string }>(c,
        'SELECT * FROM booking WHERE id = ANY($1::bigint[])', [buchungen])
      return {
        reservierungen: res,
        buchung,
        naechte: await zeilen(c, `SELECT reservation_id, min(date) AS von, max(date) AS bis,
                                         count(*)::int AS anzahl, sum(price_cent)::bigint AS summe_cent,
                                         count(*) FILTER (WHERE posted)::int AS gebucht
                                    FROM reservation_night WHERE reservation_id = ANY($1::bigint[])
                                   GROUP BY 1`, [ids]),
        aenderungen: await zeilen(c, `SELECT reservation_id, changed_at FROM reservation_change
                                       WHERE reservation_id = ANY($1::bigint[])
                                       ORDER BY changed_at DESC LIMIT 50`, [ids]),
        kanal_revisionen: await zeilen(c, `
          SELECT * FROM channel_booking_revision cr
           WHERE EXISTS (SELECT 1 FROM booking b WHERE b.id = ANY($1::bigint[])
                          AND b.property_id = cr.property_id
                          AND b.external_reference = cr.external_reference)
           ORDER BY received_at DESC LIMIT 50`, [buchungen]),
        folios,
        buchungen_folio: await zeilen(c, `SELECT * FROM charge WHERE folio_id = ANY($1::bigint[])
                                          ORDER BY business_date, id LIMIT 300`, [folioIds]),
        zahlungen: await zeilen(c, `SELECT * FROM settlement WHERE folio_id = ANY($1::bigint[])
                                     ORDER BY id`, [folioIds]),
        rechnungen: await zeilen(c, `
          SELECT i.id, i.public_ref, i.number, i.kind, i.issued_on, i.totals, i.reverses_id,
                 EXISTS (SELECT 1 FROM invoice_document d WHERE d.invoice_id = i.id) AS beleg_da,
                 (SELECT last_error FROM invoice_document_failure f WHERE f.invoice_id = i.id)
                   AS beleg_fehler
            FROM invoice i WHERE i.folio_id = ANY($1::bigint[]) ORDER BY i.id`, [folioIds]),
        gastpost: await zeilen(c, `
          SELECT id, public_ref, kind, status, delivery_status, delivery_reason, attempts,
                 last_error, created_at, sent_at, to_email
            FROM outbound_email WHERE reservation_id = ANY($1::bigint[]) ORDER BY id`, [ids]),
        webhooks: await zeilen(c, `
          SELECT id, event_type, event_ref, status, attempts, last_status_code, last_error,
                 occurred_at, delivered_at
            FROM webhook_delivery
           WHERE event_ref = ANY($1::text[]) ORDER BY occurred_at LIMIT 100`,
          [[...refs, ...buchung.map(b => b.public_ref)]]),
        meldeschein: await zeilen(c, `SELECT * FROM registration
                                       WHERE reservation_id = ANY($1::bigint[])`, [ids]),
        protokoll: await zeilen(c, `
          SELECT occurred_at, table_name, row_id, action, user_id, changed
            FROM audit_log
           WHERE (table_name = 'reservation' AND row_id = ANY($1::bigint[]))
              OR (table_name = 'booking' AND row_id = ANY($2::bigint[]))
           ORDER BY occurred_at DESC LIMIT 100`, [ids, buchungen])
      }
    })
  }
}

const konsistenz: Werkzeug = {
  name: 'konsistenz',
  title: 'Konsistenzpruefungen',
  description: 'Feste Pruefungen, die Anzahl und bis zu zehn Beispiele liefern: Belegungszaehler '
    + 'gegen Reservierungen, Rechnungen ohne Beleg, offene Salden nach Abreise, doppelte '
    + 'Kurtaxe, haengende Post, ueberfaellige Abreisen, offene Geschaeftstage, gescheiterte '
    + 'Webhooks. Ein Treffer ist ein Hinweis, kein Beweis: Optionen, Teilzimmer und '
    + '"verkaufen als" koennen Belegungsunterschiede erklaeren.',
  inputSchema: { type: 'object', properties: { haus: HAUS_SCHEMA }, additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const haus = hausId(a.haus)
    const pruefung = async (c: Client, sql: string) => {
      const r = await zeilen(c, `WITH treffer AS (${sql})
        SELECT (SELECT count(*)::int FROM treffer) AS anzahl,
               COALESCE((SELECT jsonb_agg(t) FROM (SELECT * FROM treffer LIMIT 10) t), '[]') AS beispiele`,
        [haus])
      return r[0]
    }
    return lesen(u, v, haus, null, async c => ({
      belegung: await pruefung(c, `
        SELECT i.property_id, i.category_id, i.date, i.sold,
               (SELECT count(*)::int FROM reservation r
                 WHERE r.property_id = i.property_id AND r.category_id = i.category_id
                   AND r.status IN ('Optional', 'Confirmed', 'InHouse')
                   AND i.date >= r.arrival AND i.date < r.departure) AS reservierungen
          FROM inventory_day i
         WHERE ($1::bigint IS NULL OR i.property_id = $1)
           AND i.date BETWEEN current_date - 1 AND current_date + 60
           AND i.sold <> (SELECT count(*) FROM reservation r
                           WHERE r.property_id = i.property_id AND r.category_id = i.category_id
                             AND r.status IN ('Optional', 'Confirmed', 'InHouse')
                             AND i.date >= r.arrival AND i.date < r.departure)
         ORDER BY i.date`),
      rechnung_ohne_beleg: await pruefung(c, `
        SELECT i.id, i.property_id, i.number, i.created_at FROM invoice i
         WHERE ($1::bigint IS NULL OR i.property_id = $1)
           AND i.created_at < now() - interval '1 hour'
           AND NOT EXISTS (SELECT 1 FROM invoice_document d WHERE d.invoice_id = i.id)
         ORDER BY i.id DESC`),
      offener_saldo_nach_abreise: await pruefung(c, `
        SELECT f.id AS folio_id, r.id AS reservation_id, r.property_id, r.departure,
               (SELECT COALESCE(sum(gross_cent), 0) FROM charge ch WHERE ch.folio_id = f.id)
             - (SELECT COALESCE(sum(amount_cent), 0) FROM settlement s WHERE s.folio_id = f.id)
               AS saldo_cent
          FROM folio f JOIN reservation r ON r.id = f.reservation_id
         WHERE ($1::bigint IS NULL OR r.property_id = $1)
           AND r.status = 'CheckedOut' AND r.departure < current_date - 2
           AND r.departure > current_date - 120
           AND (SELECT COALESCE(sum(gross_cent), 0) FROM charge ch WHERE ch.folio_id = f.id)
            <> (SELECT COALESCE(sum(amount_cent), 0) FROM settlement s WHERE s.folio_id = f.id)
         ORDER BY r.departure DESC`),
      doppelte_kurtaxe: await pruefung(c, `
        SELECT ch.reservation_id, ch.business_date, ch.tax_rule_id, count(*)::int AS anzahl
          FROM charge ch JOIN tax_rule t ON t.id = ch.tax_rule_id
         WHERE ($1::bigint IS NULL OR ch.property_id = $1)
           AND t.kind IN ('city_tax', 'bed_tax') AND ch.reverses_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = ch.id)
           AND ch.business_date > current_date - 120
         GROUP BY 1, 2, 3 HAVING count(*) > 1
         ORDER BY 2 DESC`),
      haengende_gastpost: await pruefung(c, `
        SELECT id, property_id, kind, attempts, created_at, last_error FROM outbound_email
         WHERE ($1::bigint IS NULL OR property_id = $1)
           AND status = 'pending' AND created_at < now() - interval '1 hour'
         ORDER BY created_at`),
      haengende_plattformpost: await pruefung(c, `
        SELECT id, kind, attempts, created_at, last_error FROM platform_email
         WHERE $1::bigint IS NULL AND status = 'pending' AND created_at < now() - interval '1 hour'
         ORDER BY created_at`),
      ueberfaellige_abreise: await pruefung(c, `
        SELECT r.id, r.property_id, r.departure, r.status FROM reservation r
         WHERE ($1::bigint IS NULL OR r.property_id = $1)
           AND r.status = 'InHouse'
           AND r.departure < (SELECT max(b.date) FROM business_day b
                               WHERE b.property_id = r.property_id AND b.status = 'open')
         ORDER BY r.departure`),
      alter_geschaeftstag: await pruefung(c, `
        SELECT property_id, date FROM business_day
         WHERE ($1::bigint IS NULL OR property_id = $1)
           AND status = 'open' AND date < current_date - 1`),
      webhooks_gescheitert: await pruefung(c, `
        SELECT id, property_id, event_type, attempts, last_status_code, last_error, occurred_at
          FROM webhook_delivery
         WHERE ($1::bigint IS NULL OR property_id = $1)
           AND status = 'failed' AND occurred_at > now() - interval '7 days'
         ORDER BY occurred_at DESC`)
    }))
  }
}

interface Anfrage { zeit: string; url: string | null; methode: string | null
                    status: number | null; ms: number }

/** Aus dem Journal der API die abgeschlossenen Anfragen mit Adresse und Dauer. */
function anfragenAusJournal(texte: string[]): { anfragen: Anfrage[]; warnungen: Record<string, unknown>[]
                                                fehler: number } {
  const urls = new Map<string, { url: string; methode: string }>()
  const anfragen: Anfrage[] = []
  const warnungen: Record<string, unknown>[] = []
  let fehler = 0
  for (const t of texts(texte)) {
    const j = pinoZeile(t)
    if (j === null) continue
    const id = typeof j.reqId === 'string' ? j.reqId : null
    const req = j.req as { url?: string; method?: string } | undefined
    if (id !== null && req?.url !== undefined) urls.set(id, { url: req.url, methode: req.method ?? '' })
    if (typeof j.level === 'number' && j.level >= 50) fehler++
    if (typeof j.responseTime === 'number') {
      const res = j.res as { statusCode?: number } | undefined
      const u = id === null ? undefined : urls.get(id)
      anfragen.push({ zeit: new Date(Number(j.time ?? 0)).toISOString(), url: u?.url ?? null,
                      methode: u?.methode ?? null, status: res?.statusCode ?? null,
                      ms: Math.round(j.responseTime) })
    }
    if (typeof j.anweisungen === 'number') {
      const u = id === null ? undefined : urls.get(id)
      warnungen.push({ zeit: new Date(Number(j.time ?? 0)).toISOString(), url: u?.url ?? null,
                       anweisungen: j.anweisungen, dbMs: j.dbMs, antwortMs: j.antwortMs })
    }
  }
  return { anfragen, warnungen, fehler }
}
function texts(t: string[]): string[] { return t }

/** Die Adresse ohne Kennungen: `/v1/reservations/AB12CD` wird `/v1/reservations/:ref`. */
function pfadmuster(url: string | null): string {
  if (url === null) return '?'
  return url.split('?')[0]!
    .split('/').map(s => /^\d+$/.test(s) ? ':id' : /^[A-Z0-9]{6,}$/.test(s) ? ':ref' : s).join('/')
}

interface Kennzahlen { anfragen: number; fehler_5xx: number; fehler_4xx: number
                     median_ms: number | null; p95_ms: number | null; max_ms: number | null }

function kennzahlen(a: Anfrage[]): Kennzahlen {
  const ms = a.map(x => x.ms)
  return { anfragen: a.length, fehler_5xx: a.filter(x => (x.status ?? 0) >= 500).length,
           fehler_4xx: a.filter(x => (x.status ?? 0) >= 400 && (x.status ?? 0) < 500).length,
           median_ms: quantil(ms, 0.5), p95_ms: quantil(ms, 0.95), max_ms: quantil(ms, 1) }
}

const leistung: Werkzeug = {
  name: 'leistung',
  title: 'Leistung',
  description: 'Langsame Anfragen der API aus dem Journal (je Pfadmuster: Anzahl, Median, p95), '
    + `Anfragen ueber der Schwelle von Datenbankanweisungen (DB_QUERY_WARN), und die teuersten `
    + 'Abfragen aus pg_stat_statements, sofern eingerichtet (Text mit $1 statt Werten).',
  inputSchema: { type: 'object', properties: {
    minuten: { type: 'integer', minimum: 5, maximum: 1440, default: 60 } },
    additionalProperties: false },
  readOnly: true,
  ausfuehren: async (u, v, a) => {
    const min = ganzzahl(a.minuten, 'minuten', 60, 5, 1440)
    const j = await u.journal({ einheiten: ['hotelpms-api'], seitMinuten: min, zeilen: 50_000 })
    const { anfragen, warnungen } = anfragenAusJournal(j.map(z => z.text))
    const gruppen = new Map<string, Anfrage[]>()
    for (const x of anfragen) {
      const k = `${x.methode ?? ''} ${pfadmuster(x.url)}`
      gruppen.set(k, [...(gruppen.get(k) ?? []), x])
    }
    const jePfad = [...gruppen.entries()]
      .map(([pfad, l]) => ({ pfad, ...kennzahlen(l) }))
      .sort((x, y) => Number(y.p95_ms ?? 0) - Number(x.p95_ms ?? 0)).slice(0, 25)
    const r = await lesen(u, v, null, `minuten=${min}`, async c => {
      const da = await zeilen<{ da: boolean }>(c,
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS da`)
      if (da[0]?.da !== true) return { eingerichtet: false }
      return { eingerichtet: true, abfragen: (await zeilen<{ query: string }>(c, `
        SELECT calls, round(total_exec_time)::bigint AS gesamt_ms,
               round(mean_exec_time::numeric, 1) AS mittel_ms, rows, left(query, 600) AS query
          FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15`))
        .map(q => ({ ...q, query: fuersProtokoll(q.query) })) }
    })
    return { ...r, daten: {
      zeitraum_minuten: min, gesamt: kennzahlen(anfragen), je_pfad: jePfad,
      langsamste: [...anfragen].sort((x, y) => y.ms - x.ms).slice(0, 15)
        .map(x => ({ ...x, url: pfadmuster(x.url) })),
      viele_anweisungen: warnungen.slice(-30).map(w => ({ ...w, url: pfadmuster(w.url as string | null) })),
      datenbank: r.daten } }
  }
}

const datenbankZustand: Werkzeug = {
  name: 'datenbank_zustand',
  title: 'Zustand der Datenbank',
  description: 'Groesse der Datenbank und der groessten Tabellen, tote Zeilen und letzter '
    + 'Autovacuum, Verbindungen je Anwendung und Zustand, wartende Sperren, lang laufende '
    + 'Anweisungen, WAL-Archivierung und die letzten Zeilen der Sicherungsdienste.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  ausfuehren: async (u, v) => {
    const r = await lesen(u, v, null, null, async c => ({
      groesse: (await zeilen(c, `SELECT pg_size_pretty(pg_database_size(current_database())) AS datenbank`))[0],
      tabellen: await zeilen(c, `
        SELECT relname AS tabelle, pg_size_pretty(pg_total_relation_size(relid)) AS groesse,
               n_live_tup AS zeilen, n_dead_tup AS tote_zeilen, last_autovacuum, last_autoanalyze
          FROM pg_stat_user_tables WHERE schemaname = 'public'
         ORDER BY pg_total_relation_size(relid) DESC LIMIT 20`),
      verbindungen: await zeilen(c, `
        SELECT application_name, usename, state, count(*)::int AS anzahl,
               max(now() - state_change) AS laengste_im_zustand
          FROM pg_stat_activity WHERE datname = current_database()
         GROUP BY 1, 2, 3 ORDER BY 4 DESC`),
      wartende_sperren: await zeilen(c, `
        SELECT l.locktype, l.mode, l.relation::regclass::text AS relation, a.application_name,
               now() - a.query_start AS wartet_seit
          FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted`),
      lang_laufend: (await zeilen<{ query: string }>(c, `
        SELECT pid, application_name, state, now() - query_start AS dauer, left(query, 300) AS query
          FROM pg_stat_activity
         WHERE datname = current_database() AND state <> 'idle'
           AND query_start < now() - interval '30 seconds' AND pid <> pg_backend_pid()`))
        .map(q => ({ ...q, query: fuersProtokoll(q.query) })),
      archivierung: (await zeilen(c, `SELECT archived_count, last_archived_wal, last_archived_time,
                                             failed_count, last_failed_wal, last_failed_time
                                        FROM pg_stat_archiver`))[0]
    }))
    const sicherung = await u.journal({
      einheiten: ['hotelpms-sicherung', 'hotelpms-einsortieren'], seitMinuten: 2 * 24 * 60, zeilen: 30 })
      .catch(() => [])
    return { ...r, daten: { ...(r.daten as object), sicherung } }
  }
}

const schnittstellen: Werkzeug = {
  name: 'schnittstellen',
  title: 'Schnittstellen',
  description: 'Maschinenzugaenge (etwa das Adminpanel) mit Anfragen und Zeilen je Stunde, '
    + 'Kanalverbindungen (RoomCloud) mit Abgleichen und Fehlern, Preiskalender-Abrufe und '
    + '-Uebertragungen, Webhook-Abos mit Zustellungen.',
  inputSchema: { type: 'object', properties: {
    stunden: { type: 'integer', minimum: 1, maximum: 336, default: 24 }, haus: HAUS_SCHEMA },
    additionalProperties: false },
  readOnly: true,
  ausfuehren: (u, v, a) => {
    const h = ganzzahl(a.stunden, 'stunden', 24, 1, 336)
    const haus = hausId(a.haus)
    return lesen(u, v, haus, `stunden=${h}`, async c => ({
      maschinenzugaenge: await zeilen(c, `
        SELECT oc.public_ref, oc.name, oc.status, oc.scopes, oc.property_ids, oc.allowed_networks,
               (SELECT max(t.created_at) FROM oauth_access_token t WHERE t.client_id = oc.id)
                 AS letztes_token
          FROM oauth_client oc WHERE NOT oc.is_decoy ORDER BY oc.id`),
      abrufe_je_stunde: await zeilen(c, `
        SELECT principal_key, hour, requests, rows_returned, origin
          FROM access_volume
         WHERE principal_key LIKE 'client:%' AND hour > now() - make_interval(hours => $1)
         ORDER BY hour DESC, principal_key LIMIT 300`, [h]),
      kanalverbindungen: await zeilen(c, `
        SELECT id, property_id, provider, kind, name, status, sync_mode, last_error_key
          FROM channel_connection WHERE ($1::bigint IS NULL OR property_id = $1)`, [haus]),
      kanalabgleiche: await zeilen(c, `
        SELECT connection_id, kind, mode, status, count(*)::int AS laeufe,
               sum(items)::int AS posten, sum(differences)::int AS abweichungen,
               max(error_key) AS fehler, max(finished_at) AS zuletzt,
               round(avg(extract(epoch FROM finished_at - started_at))::numeric, 1) AS mittel_s
          FROM channel_sync_log
         WHERE started_at > now() - make_interval(hours => $1)
           AND ($2::bigint IS NULL OR property_id = $2)
         GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`, [h, haus]),
      preiskalender_abrufe: await zeilen(c, `
        SELECT public_ref, property_id, date_from, date_to, status, message, requested_at,
               delivered_at, applied_at, progress_days
          FROM rate_calendar_pull
         WHERE requested_at > now() - make_interval(hours => $1)
           AND ($2::bigint IS NULL OR property_id = $2) ORDER BY requested_at DESC LIMIT 20`, [h, haus]),
      preiskalender_uebertragungen: await zeilen(c, `
        SELECT public_ref, property_id, mode, date_from, date_to, status, message, days,
               requested_at, served_at, finished_at, conflicts
          FROM rate_calendar_push
         WHERE requested_at > now() - make_interval(hours => $1)
           AND ($2::bigint IS NULL OR property_id = $2) ORDER BY requested_at DESC LIMIT 20`, [h, haus]),
      webhooks: await zeilen(c, `
        SELECT s.public_ref, s.url, s.status, s.event_types, s.disabled_reason,
               count(d.id)::int AS zustellungen,
               count(d.id) FILTER (WHERE d.status = 'failed')::int AS gescheitert,
               max(d.delivered_at) AS zuletzt_zugestellt
          FROM webhook_subscription s
          LEFT JOIN webhook_delivery d ON d.subscription_id = s.id
           AND d.occurred_at > now() - make_interval(hours => $1)
         GROUP BY s.id, s.public_ref, s.url, s.status, s.event_types, s.disabled_reason`, [h])
    }))
  }
}

const ausrollenVergleich: Werkzeug = {
  name: 'ausrollen_vergleich',
  title: 'Vorher und nachher eines Ausrollens',
  description: 'Vergleicht die API vor und nach einem Ausrollen: Anfragen, 4xx, 5xx, Fehlerzeilen, '
    + 'Median und p95 der Antwortzeit, je gleich langes Fenster. Ohne `commit` das juengste '
    + 'Ausrollen.',
  inputSchema: { type: 'object', properties: {
    commit: { type: 'string', pattern: '^[0-9a-f]{7,40}$' },
    minuten: { type: 'integer', minimum: 10, maximum: 1440, default: 120 } },
    additionalProperties: false },
  readOnly: true,
  ausfuehren: async (u, v, a) => {
    const min = ganzzahl(a.minuten, 'minuten', 120, 10, 1440)
    const commit = a.commit === undefined ? null : text(a.commit, 'commit', 40)
    if (commit !== null && !/^[0-9a-f]{7,40}$/.test(commit)) throw new Eingabefehler('commit ist kein Hash.')
    const r = await lesen(u, v, null, `commit=${commit ?? 'aktuell'}`, async c => zeilen<{
      commit: string; subject: string | null; seen_at: Date }>(c, `
        SELECT commit, subject, seen_at FROM release
         WHERE ($1::text IS NULL AND is_current) OR ($1::text IS NOT NULL AND commit LIKE $1 || '%')
         ORDER BY seen_at DESC LIMIT 1`, [commit]))
    const rel = (r.daten as { commit: string; subject: string | null; seen_at: Date }[])[0]
    if (rel === undefined) throw new Eingabefehler('Kein passendes Ausrollen gefunden.')
    const t = new Date(rel.seen_at).getTime()
    const iso = (ms: number): string => new Date(ms).toISOString()
    const fenster = async (von: number, bis: number) => {
      const z = await u.journal({ einheiten: ['hotelpms-api'], von: iso(von), bis: iso(bis), zeilen: 50_000 })
      const x = anfragenAusJournal(z.map(y => y.text))
      return { von: iso(von), bis: iso(bis), ...kennzahlen(x.anfragen), fehlerzeilen: x.fehler,
               viele_anweisungen: x.warnungen.length }
    }
    return { ...r, zeilen: 1, daten: {
      ausrollen: { commit: rel.commit, betreff: rel.subject, gesehen: iso(t) },
      vorher: await fenster(t - min * 60_000, t),
      nachher: await fenster(t, Math.min(Date.now(), t + min * 60_000)) } }
  }
}

export const WERKZEUGE: readonly Werkzeug[] = [
  ueberblick, tabellen, sqlLesen, sicherheit, protokoll, konfiguration,
  buchungLebenslauf, konsistenz, leistung, datenbankZustand, schnittstellen, ausrollenVergleich,
  klartextAnfragen, klartextStatus
]
