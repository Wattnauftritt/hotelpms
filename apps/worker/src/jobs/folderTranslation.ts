import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { FOLDER_TRANSLATION_LANGS, folderTextFromDeeplXml, folderTextLines,
         folderTextToDeeplXml, translationRetryDelaySeconds, TRANSLATION_MAX_ATTEMPTS,
         type FolderTranslationLang } from '@hotelpms/domain'
import type { TickBreaker } from './breaker.js'
import { TranslationError, type Translator } from './staffTranslation.js'

/**
 * Hausseiten der Gaestemappe uebersetzen (Migration 0144).
 *
 * Dieselben drei Schritte wie bei den Texten des Personals: der Aufruf bei
 * DeepL liegt nicht in der Transaktion, die den Auftrag haelt.
 *
 *   1. beanspruchen   faellige Seiten und Sprachen finden, Frist setzen, Text lesen
 *   2. uebersetzen    ohne Transaktion, je Sprache ein Aufruf fuer alle Seiten
 *   3. vermerken      Uebersetzung schreiben oder spaeter noch einmal
 *
 * Faellig ist eine Sprache, deren Uebersetzung nicht zum Fingerabdruck der
 * deutschen Fassung passt -- es gibt keine Warteschlange, die jemand fuellen
 * muesste. Gelesen und gestempelt wird die deutsche Fassung in Schritt 1:
 * aendert sie jemand waehrenddessen, passt das Ergebnis nicht mehr und die
 * Seite ist im naechsten Tick wieder faellig.
 */

interface Faellig {
  content_id: number
  lang: FolderTranslationLang
  title: string
  body: string
  hash: string
  attempt: number
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<Faellig[]> {
  const { rows } = await client.query<Faellig>(
    `WITH faellig AS (
       SELECT c.id AS content_id, l.lang, c.title, c.body,
              terminal_content_hash(c.title, c.body) AS hash
         FROM terminal_content c
         JOIN guest_folder_setting s ON s.property_id = c.property_id AND s.enabled
        CROSS JOIN unnest($2::text[]) AS l(lang)
         LEFT JOIN terminal_content_translation t
                ON t.content_id = c.id AND t.lang = l.lang
        WHERE c.property_id = $1 AND c.folder_position IS NOT NULL AND c.archived_at IS NULL
          AND t.source_hash IS DISTINCT FROM terminal_content_hash(c.title, c.body)
          AND (t.next_at IS NULL OR t.next_at <= now())
          -- Nach dem letzten Versuch bleibt die Fassung deutsch, bis jemand
          -- sie aendert oder von Hand uebersetzt.
          AND (t.pending_hash IS DISTINCT FROM terminal_content_hash(c.title, c.body)
               OR t.attempts < $5)
        ORDER BY c.folder_position, c.id, l.lang
        LIMIT $3
        FOR UPDATE OF c SKIP LOCKED
     ), beansprucht AS (
       INSERT INTO terminal_content_translation
              (content_id, property_id, lang, pending_hash, attempts, next_at)
       SELECT content_id, $1, lang, hash, 1, now() + make_interval(secs => $4)
         FROM faellig
       ON CONFLICT (content_id, lang) DO UPDATE SET
         attempts = CASE WHEN terminal_content_translation.pending_hash = EXCLUDED.pending_hash
                         THEN terminal_content_translation.attempts + 1 ELSE 1 END,
         pending_hash = EXCLUDED.pending_hash, next_at = EXCLUDED.next_at
       RETURNING content_id, lang, attempts
     )
     SELECT f.content_id::int, f.lang, f.title, f.body, encode(f.hash, 'hex') AS hash,
            b.attempts AS attempt
       FROM faellig f JOIN beansprucht b USING (content_id, lang)
      ORDER BY f.lang, f.content_id`,
    [propertyId, FOLDER_TRANSLATION_LANGS, batchSize, leaseSeconds, TRANSLATION_MAX_ATTEMPTS])
  return rows
}

type Ergebnis = { title: string; body: string } | { error: string }

/** Hoechstens fuenfzig Texte je Aufruf; eine Seite sind zwei (Titel, Text). */
const SEITEN_JE_AUFRUF = 25
const BYTES_JE_AUFRUF = 100_000

function anbieterFehler(code: string): boolean {
  return code === 'network' || code === 'http_429' || code === 'http_456'
    || /^http_5\d\d$/.test(code)
}

function stapel(seiten: Faellig[]): Faellig[][] {
  const stapel: Faellig[][] = []
  let aktuell: Faellig[] = []
  let bytes = 0
  for (const s of seiten) {
    // Grob nach oben geschaetzt: das XML um jede Zeile kommt dazu.
    const n = 2 * Buffer.byteLength(s.title + s.body, 'utf8') + 20 * folderTextLines(s.body)
    if (aktuell.length > 0 && (aktuell.length >= SEITEN_JE_AUFRUF || bytes + n > BYTES_JE_AUFRUF)) {
      stapel.push(aktuell)
      aktuell = []
      bytes = 0
    }
    aktuell.push(s)
    bytes += n
  }
  if (aktuell.length > 0) stapel.push(aktuell)
  return stapel
}

async function uebersetzeAlle(
  translator: Translator, seiten: Faellig[], breaker: TickBreaker | undefined
): Promise<Map<Faellig, Ergebnis>> {
  const ergebnis = new Map<Faellig, Ergebnis>()
  for (const lang of FOLDER_TRANSLATION_LANGS) {
    for (const s of stapel(seiten.filter(x => x.lang === lang))) {
      if (breaker?.tripped() === true) continue
      try {
        const texte = s.flatMap(x => [folderTextToDeeplXml(x.title), folderTextToDeeplXml(x.body)])
        const r = await translator.translate(texte, lang, { source: 'de', xml: true })
        breaker?.success()
        for (const [i, x] of s.entries()) {
          const titel = folderTextFromDeeplXml(r[2 * i]!.text, 1)
          const text = folderTextFromDeeplXml(r[2 * i + 1]!.text, folderTextLines(x.body))
          ergebnis.set(x, titel === null || text === null || titel.trim() === ''
            ? { error: 'malformed' }
            : { title: titel.trim(), body: text })
        }
      } catch (e) {
        const code = e instanceof TranslationError ? e.code : 'other'
        if (anbieterFehler(code)) breaker?.failure()
        for (const x of s) ergebnis.set(x, { error: code })
      }
    }
  }
  return ergebnis
}

async function record(
  client: PoolClient, s: Faellig, r: Ergebnis, baseDelaySeconds: number
): Promise<'done' | 'retrying' | 'failed'> {
  if ('error' in r) {
    // Nur fuer die Fassung, die wir hatten; wer inzwischen neu beansprucht
    // hat, fuehrt seinen eigenen Zaehler.
    await client.query(
      `UPDATE terminal_content_translation
          SET next_at = now() + make_interval(secs => $4), last_error = $5
        WHERE content_id = $1 AND lang = $2 AND pending_hash = decode($3, 'hex')`,
      [s.content_id, s.lang, s.hash,
       translationRetryDelaySeconds(s.attempt, baseDelaySeconds), r.error])
    return s.attempt >= TRANSLATION_MAX_ATTEMPTS ? 'failed' : 'retrying'
  }
  // Eine Uebersetzung von Hand zur selben Fassung bleibt stehen: wer sie
  // waehrend des Aufrufs gespeichert hat, wusste es besser als DeepL.
  await client.query(
    `UPDATE terminal_content_translation
        SET title = left($4, 300), body = left($5, 10000), source_hash = pending_hash,
            origin = 'machine', updated_by = NULL, updated_at = now(),
            attempts = 0, next_at = NULL, last_error = NULL
      WHERE content_id = $1 AND lang = $2 AND pending_hash = decode($3, 'hex')
        AND (origin IS DISTINCT FROM 'manual' OR source_hash IS DISTINCT FROM pending_hash)`,
    [s.content_id, s.lang, s.hash, r.title, r.body])
  return 'done'
}

export interface FolderTranslationResult {
  attempted: number
  done: number
  retrying: number
  failed: number
}

export async function translateFolderPages(
  pool: Pool, ctx: DbContext, propertyId: number, translator: Translator,
  opts: { batchSize?: number; leaseSeconds?: number; baseDelaySeconds?: number
          breaker?: TickBreaker } = {}
): Promise<FolderTranslationResult> {
  const result: FolderTranslationResult = { attempted: 0, done: 0, retrying: 0, failed: 0 }
  if (opts.breaker?.tripped() === true) return result

  const claimed = await withTransaction(pool, ctx, c =>
    claim(c, propertyId, opts.batchSize ?? 60, opts.leaseSeconds ?? 300))
  if (claimed.length === 0) return result
  const uebersetzt = await uebersetzeAlle(translator, claimed, opts.breaker)

  const zurueck: Faellig[] = []
  for (const s of claimed) {
    const r = uebersetzt.get(s)
    if (r === undefined) { zurueck.push(s); continue }
    result.attempted++
    result[await withTransaction(pool, ctx, c =>
      record(c, s, r, opts.baseDelaySeconds ?? 60))]++
  }
  if (zurueck.length > 0) {
    // Nicht gefragt, also kein verbrauchter Versuch; faellig im naechsten Tick.
    await withTransaction(pool, ctx, c => c.query(
      `UPDATE terminal_content_translation t
          SET attempts = t.attempts - 1, next_at = now()
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS z(content_id, lang, hash)
        WHERE t.content_id = z.content_id AND t.lang = z.lang
          AND t.pending_hash = decode(z.hash, 'hex') AND t.attempts > 0`,
      [zurueck.map(s => s.content_id), zurueck.map(s => s.lang), zurueck.map(s => s.hash)]))
  }
  return result
}
