import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { deeplEndpoint, deeplTargetCode, staffLangFromDeepl, translationRetryDelaySeconds,
         TRANSLATION_MAX_ATTEMPTS, type StaffTextLang } from '@hotelpms/domain'
import type { TickBreaker } from './breaker.js'

/**
 * Freie Texte des Personals uebersetzen (Aufgabe 18, Baustein 7; 0112).
 *
 * Dieselben drei Schritte wie die Zustellung der Ereignisse und aus
 * demselben Grund: der Aufruf bei DeepL liegt nicht in der Transaktion, die
 * den Auftrag sperrt.
 *
 *   1. beanspruchen   Auftrag sperren, Versuch zaehlen, Frist setzen, Text lesen
 *   2. uebersetzen    ohne Transaktion, je Zielsprache ein Aufruf fuer alle Auftraege
 *   3. vermerken      Uebersetzungen schreiben, Auftrag erledigt oder spaeter
 *
 * Gelesen wird der Text erst in Schritt 1, nicht beim Einreihen: hat die
 * Kraft ihn inzwischen geaendert, geht der neue hinaus. Mitgeschrieben wird
 * sein Fingerabdruck, und gelesen wird eine Uebersetzung nur, solange er
 * zum Text passt.
 */

export interface TranslationResult {
  text: string
  /** Von DeepL erkannte Ausgangssprache, roh (z. B. `RU`). */
  detectedSource: string | null
}

/**
 * Nur diese Fassade, damit ein Test einen Uebersetzer unterschieben kann.
 *
 * Mehrere Texte je Aufruf, eine Zielsprache: so nimmt DeepL sie an
 * (`text` ist ein Feld), und fuenfzig Auftraege sind damit ein Aufruf je
 * Sprache statt fuenfzig (Befund 9). Die Antwort steht in derselben
 * Reihenfolge wie die Texte.
 */
export interface Translator {
  translate(texts: string[], target: StaffTextLang): Promise<TranslationResult[]>
}

/**
 * Ein Fehler mit dem Status des Dienstes, ohne den Text: in `last_error`
 * und im Protokoll soll nie stehen, was die Kraft geschrieben hat.
 */
export class TranslationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'TranslationError'
  }
}

export function createDeeplTranslator(apiKey: string, timeoutMs = 10_000): Translator {
  const url = deeplEndpoint(apiKey)
  return {
    async translate(texts, target) {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `DeepL-Auth-Key ${apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ text: texts, target_lang: deeplTargetCode(target) }),
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch {
        throw new TranslationError('network')
      }
      if (!res.ok) {
        // 456 heisst Kontingent erschoepft -- wie jeder andere Status: spaeter.
        await res.body?.cancel()
        throw new TranslationError(`http_${res.status}`)
      }
      const daten = await res.json() as {
        translations?: Array<{ text?: unknown; detected_source_language?: unknown }>
      }
      const liste = daten.translations
      // Eine Antwort, die nicht Text fuer Text zu den Eingaben passt, ist
      // nicht zuzuordnen -- lieber spaeter noch einmal als falsch zugeordnet.
      if (!Array.isArray(liste) || liste.length !== texts.length) {
        throw new TranslationError('malformed')
      }
      return liste.map(t => {
        if (typeof t.text !== 'string') throw new TranslationError('malformed')
        return {
          text: t.text,
          detectedSource: typeof t.detected_source_language === 'string'
            ? t.detected_source_language : null
        }
      })
    }
  }
}

interface ClaimedJob {
  id: number
  source_kind: string
  source_id: number
  targets: StaffTextLang[]
  attempt: number
  /** `null`, wenn die Quelle fehlt oder keinen Text mehr hat. */
  text: string | null
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<ClaimedJob[]> {
  // Die Notiz der Hausdame nur, solange das Zimmer auf Nacharbeit steht:
  // eine zurueckgenommene Kontrolle braucht keine Uebersetzung mehr.
  const { rows } = await client.query<ClaimedJob>(
    `WITH faellig AS (
       SELECT j.id FROM staff_text_job j
        WHERE j.property_id = $1 AND j.status = 'pending' AND j.next_at <= now()
        ORDER BY j.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), beansprucht AS (
       UPDATE staff_text_job j
          SET attempts = j.attempts + 1, next_at = now() + make_interval(secs => $3)
        WHERE j.id IN (SELECT id FROM faellig)
       RETURNING j.id, j.source_kind, j.source_id, j.targets, j.attempts AS attempt
     )
     SELECT b.id::int, b.source_kind, b.source_id::int, b.targets, b.attempt,
            CASE b.source_kind
              WHEN 'work_entry' THEN (SELECT e.description FROM staff_work_entry e
                                       WHERE e.id = b.source_id AND e.property_id = $1)
              WHEN 'problem' THEN (SELECT m.description FROM maintenance_ticket m
                                    WHERE m.id = b.source_id AND m.property_id = $1)
              WHEN 'inspection_note' THEN (SELECT t.inspection_note FROM housekeeping_task t
                                            WHERE t.id = b.source_id AND t.property_id = $1
                                              AND t.inspection = 'rework')
            END AS text
       FROM beansprucht b
      ORDER BY b.id`,
    [propertyId, batchSize, leaseSeconds])
  return rows
}

type Uebersetzt = { lang: StaffTextLang; text: string; sourceLang: StaffTextLang | null }
type Ergebnis = { ok: Uebersetzt[] } | { error: string }

/*
 * Grenzen eines Aufrufs bei DeepL: hoechstens fuenfzig Texte und 128 KiB
 * Anfrage. Die Bytegrenze mit Abstand, weil der Umschlag (JSON, Anfuehrungs-
 * zeichen, maskierte Zeichen) dazukommt.
 */
const DEEPL_MAX_TEXTE = 50
const DEEPL_MAX_BYTES = 100_000

/** Liegt der Fehler am Dienst, nicht am einzelnen Text? Dann zaehlt er fuer die Sicherung. */
function anbieterFehler(code: string): boolean {
  return code === 'network' || code === 'http_429' || code === 'http_456'
    || /^http_5\d\d$/.test(code)
}

function stapel(jobs: ClaimedJob[]): ClaimedJob[][] {
  const stapel: ClaimedJob[][] = []
  let aktuell: ClaimedJob[] = []
  let bytes = 0
  for (const j of jobs) {
    const n = Buffer.byteLength(j.text!, 'utf8')
    if (aktuell.length > 0 && (aktuell.length >= DEEPL_MAX_TEXTE || bytes + n > DEEPL_MAX_BYTES)) {
      stapel.push(aktuell)
      aktuell = []
      bytes = 0
    }
    aktuell.push(j)
    bytes += n
  }
  if (aktuell.length > 0) stapel.push(aktuell)
  return stapel
}

/**
 * Uebersetzt alle Auftraege mit Text, ein Aufruf je Zielsprache und Stapel.
 *
 * Scheitert ein Aufruf, scheitert er fuer jeden Auftrag darin -- wie
 * bisher, als ein Fehler in einer Zielsprache den ganzen Auftrag in die
 * Wiederholung schickte. Loest die Sicherung aus, bekommen die noch nicht
 * gefragten Auftraege kein Ergebnis und werden zurueckgegeben.
 */
async function uebersetzeAlle(
  translator: Translator, jobs: ClaimedJob[], breaker: TickBreaker | undefined
): Promise<Map<number, Ergebnis>> {
  const ergebnis = new Map<number, Ergebnis>()
  for (const j of jobs) ergebnis.set(j.id, { ok: [] })
  const sprachen = [...new Set(jobs.flatMap(j => j.targets))]

  for (const ziel of sprachen) {
    // Wer schon gescheitert ist, braucht die naechste Sprache nicht mehr.
    const offen = jobs.filter(j => j.targets.includes(ziel) && 'ok' in ergebnis.get(j.id)!)
    for (const s of stapel(offen)) {
      if (breaker?.tripped() === true) {
        for (const j of s) ergebnis.delete(j.id)
        continue
      }
      try {
        const r = await translator.translate(s.map(j => j.text!), ziel)
        breaker?.success()
        for (const [i, j] of s.entries()) {
          const e = ergebnis.get(j.id)
          if (e === undefined || !('ok' in e)) continue
          e.ok.push({ lang: ziel, text: r[i]!.text,
                      sourceLang: staffLangFromDeepl(r[i]!.detectedSource) })
        }
      } catch (e) {
        const code = e instanceof TranslationError ? e.code : 'other'
        if (anbieterFehler(code)) breaker?.failure()
        for (const j of s) if (ergebnis.has(j.id)) ergebnis.set(j.id, { error: code })
      }
    }
  }
  return ergebnis
}

async function record(
  client: PoolClient, propertyId: number, j: ClaimedJob,
  r: Ergebnis | null, baseDelaySeconds: number
): Promise<'done' | 'retrying' | 'failed'> {
  if (r !== null && 'error' in r) {
    const erschoepft = j.attempt >= TRANSLATION_MAX_ATTEMPTS
    await client.query(
      `UPDATE staff_text_job
          SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
              next_at = CASE WHEN $2 THEN now() ELSE now() + make_interval(secs => $3) END,
              last_error = $4
        WHERE id = $1`,
      [j.id, erschoepft, translationRetryDelaySeconds(j.attempt, baseDelaySeconds), r.error])
    return erschoepft ? 'failed' : 'retrying'
  }
  for (const u of r?.ok ?? []) {
    // War der Text schon in der Zielsprache, gibt es nichts danebenzustellen.
    if (u.sourceLang === u.lang) continue
    // Eine Berichtigung von Hand bleibt, solange sie zum selben Text gehoert.
    await client.query(
      `INSERT INTO staff_text_translation (property_id, source_kind, source_id, source_hash,
                                           source_lang, lang, text, origin)
       VALUES ($1, $2, $3, digest($4::text, 'sha256'), $5, $6, left($7, 4000), 'machine')
       ON CONFLICT (source_kind, source_id, lang) DO UPDATE
         SET source_hash = EXCLUDED.source_hash, source_lang = EXCLUDED.source_lang,
             text = EXCLUDED.text, origin = 'machine', updated_by = NULL, updated_at = now()
       WHERE staff_text_translation.origin = 'machine'
          OR staff_text_translation.source_hash <> EXCLUDED.source_hash`,
      [propertyId, j.source_kind, j.source_id, j.text, u.sourceLang, u.lang, u.text])
  }
  await client.query(
    `UPDATE staff_text_job SET status = 'done', last_error = NULL WHERE id = $1`, [j.id])
  return 'done'
}

export interface StaffTranslationResult {
  attempted: number
  done: number
  retrying: number
  failed: number
}

export async function translateStaffTexts(
  pool: Pool, ctx: DbContext, propertyId: number, translator: Translator,
  opts: { batchSize?: number; leaseSeconds?: number; baseDelaySeconds?: number
          /** Sicherung des Dienstes fuer diesen Tick (Befund 9). */
          breaker?: TickBreaker } = {}
): Promise<StaffTranslationResult> {
  const result: StaffTranslationResult = { attempted: 0, done: 0, retrying: 0, failed: 0 }
  if (opts.breaker?.tripped() === true) return result

  const claimed = await withTransaction(pool, ctx, c =>
    claim(c, propertyId, opts.batchSize ?? 50, opts.leaseSeconds ?? 300))
  // Ohne Text ist der Auftrag erledigt, nicht gescheitert: die Quelle ist
  // weg oder leer, und es gibt nichts mehr zu uebersetzen.
  const ohneText = (j: ClaimedJob): boolean => j.text === null || j.text.trim() === ''
  const uebersetzt = await uebersetzeAlle(
    translator, claimed.filter(j => !ohneText(j)), opts.breaker)

  const zurueck: number[] = []
  for (const j of claimed) {
    const r = ohneText(j) ? null : uebersetzt.get(j.id)
    if (r === undefined) { zurueck.push(j.id); continue }
    result.attempted++
    const ausgang = await withTransaction(pool, ctx, c =>
      record(c, propertyId, j, r, opts.baseDelaySeconds ?? 60))
    result[ausgang]++
  }
  if (zurueck.length > 0) {
    // Nicht gefragt, also kein verbrauchter Versuch; faellig im naechsten Tick.
    await withTransaction(pool, ctx, c => c.query(
      `UPDATE staff_text_job SET attempts = attempts - 1, next_at = now()
        WHERE id = ANY($1::bigint[]) AND status = 'pending' AND attempts > 0`, [zurueck]))
  }
  return result
}
