import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { webhookSignature, webhookDelivered, webhookRetryDelaySeconds,
         WEBHOOK_MAX_ATTEMPTS, WEBHOOK_HEADERS, checkWebhookTargetUrl,
         checkResolvedAddress, classifyDeliveryError,
         type Cidr, type WebhookFailureKind } from '@hotelpms/domain'
import { renderMessage } from '@hotelpms/contracts'

/**
 * Zustellung ausgehender Ereignisse (Aufgabe 4, Dokument 16).
 *
 * Laeuft je Property im Kontext genau dieser Property, wie der Nachtlauf und
 * aus demselben Grund: ohne BYPASSRLS schraenkt die Zeilenrichtlinie auch den
 * Worker ein, und ein Programmfehler hier kann keine fremden Mandanten
 * beruehren.
 *
 * Drei Schritte, und die Aufteilung hat einen Grund: der Netzaufruf darf
 * nicht in der Transaktion liegen, die die Zeile sperrt. Ein Empfaenger, der
 * zehn Sekunden braucht, haelt sonst eine Sperre zehn Sekunden.
 *
 *   1. beanspruchen   Transaktion, Sperre, Versuchszaehler hoch, Frist setzen
 *   2. zustellen      ohne Transaktion, ueber HTTP
 *   3. vermerken      Transaktion, Ergebnis und Versuchsprotokoll
 *
 * Die Frist aus Schritt 1 ist der Grund, warum ein Absturz zwischen 2 und 3
 * nicht zum Stillstand fuehrt: nach ihrem Ablauf ist die Zustellung wieder
 * faellig. Zugestellt wird damit mindestens einmal, nicht genau einmal --
 * deshalb traegt jedes Ereignis eine Kennung, an der der Empfaenger eine
 * Wiederholung erkennt.
 */

interface ClaimedDelivery {
  id: number
  subscription_id: number
  event_type: string
  event_ref: string
  payload: unknown
  attempt: number
  url: string
  signing_secret: string
}

interface AttemptResult {
  statusCode: number | null
  /**
   * Die Art des Fehlers, nicht sein Text (Befund B1).
   *
   * Der Rohtext von Node nennt Adresse und Port und unterscheidet abgelehnt,
   * gefiltert und beantwortet. Er landete bisher in `webhook_delivery_attempt`
   * und wurde ueber die Schnittstelle wieder herausgegeben -- zusammen mit
   * einem frei waehlbaren Ziel ist das ein Portscan mit unserer Hilfe.
   */
  kind: WebhookFailureKind | null
  durationMs: number
}

export interface WebhookDeliveryResult {
  attempted: number
  delivered: number
  /** Fehlgeschlagen, aber es steht noch ein Versuch aus. */
  retrying: number
  /** Endgueltig aufgegeben. */
  failed: number
  /** Abonnements, die dieser Lauf stillgelegt hat. */
  disabled: number
}

type Ausgang = 'delivered' | 'retrying' | 'failed'

export interface WebhookDeliveryOptions {
  batchSize?: number
  /** Wie lange eine beanspruchte Zustellung fuer andere gesperrt bleibt. */
  leaseSeconds?: number
  requestTimeoutMs?: number
  /** Grundabstand der Wiederholung, der sich mit jedem Versuch verdoppelt. */
  baseDelaySeconds?: number
  /**
   * Netze, in die trotz Sperrliste zugestellt werden darf, aus
   * `WEBHOOK_ALLOWED_PRIVATE_CIDRS`. Leer in jeder gehosteten Installation.
   */
  allowedCidrs?: readonly Cidr[]
}

async function claim(
  client: PoolClient, propertyId: number, batchSize: number, leaseSeconds: number
): Promise<ClaimedDelivery[]> {
  /*
   * Der Versuchszaehler steigt hier, nicht erst beim Vermerken. Unter der
   * Zeilensperre ist die Nummer damit eindeutig vergeben, und ein Versuch,
   * dessen Ergebnis durch einen Absturz verloren geht, zaehlt trotzdem --
   * abgeschickt wurde er ja moeglicherweise.
   */
  const { rows } = await client.query<ClaimedDelivery>(
    `WITH faellig AS (
       SELECT d.id
         FROM webhook_delivery d
         JOIN webhook_subscription s ON s.id = d.subscription_id AND s.status = 'active'
        WHERE d.property_id = $1 AND d.status = 'pending' AND d.next_attempt_at <= now()
        ORDER BY d.id
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED
     ), beansprucht AS (
       UPDATE webhook_delivery d
          SET attempts = d.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $3)
        WHERE d.id IN (SELECT id FROM faellig)
       RETURNING d.id, d.subscription_id, d.event_type, d.event_ref,
                 d.payload, d.attempts AS attempt
     )
     SELECT b.*, s.url, s.signing_secret
       FROM beansprucht b
       JOIN webhook_subscription s ON s.id = b.subscription_id
      ORDER BY b.id`,
    [propertyId, batchSize, leaseSeconds])
  return rows
}

/**
 * Aufgeloeste Adresse, an die genau diese Zustellung gehen darf.
 *
 * `null` heisst: das Ziel ist nicht ansprechbar, und zwar nicht, weil der
 * Empfaenger streikt, sondern weil wir es nicht ansprechen.
 */
type Ziel = { address: string; family: number } | null

/**
 * Loest den Namen auf und haelt **jede** Antwort gegen die Sperrliste.
 *
 * Jede, nicht nur die erste: ein Name, der zugleich eine oeffentliche und
 * eine innere Adresse zurueckgibt, ist entweder falsch eingerichtet oder ein
 * Angriff, und sich die brauchbare herauszusuchen hiesse, beim naechsten
 * Verbindungsaufbau doch die andere zu erwischen. Steht im URL schon eine
 * Adresse, ist sie beim statischen Pruefen bereits geprueft worden.
 */
async function resolveTarget(
  url: URL, literal: string | null, allowed: readonly Cidr[]
): Promise<Ziel> {
  if (literal !== null) {
    return { address: literal, family: literal.includes(':') ? 6 : 4 }
  }
  const antworten = await dnsLookup(url.hostname, { all: true, verbatim: true })
  if (antworten.length === 0) return null
  for (const a of antworten) {
    if (checkResolvedAddress(url.protocol, a.address, allowed) !== null) return null
  }
  return { address: antworten[0]!.address, family: antworten[0]!.family }
}

/**
 * Verbindet auf genau die geprueft Adresse.
 *
 * Das ist der Kern der Absicherung und der Grund, warum hier `node:https`
 * statt `fetch` steht: `lookup` bekommt der Verbindungsaufbau mitgegeben und
 * gibt die Adresse zurueck, die wir eben geprueft haben, statt ein zweites
 * Mal zu fragen. Ohne das liegt zwischen Pruefung und Verbindung eine zweite
 * Aufloesung, und wer die Zone besitzt, laesst die erste nach draussen und
 * die zweite auf `127.0.0.1` zeigen (DNS-Rebinding).
 *
 * Der zweite Grund: `node:https` folgt keiner Umleitung. `fetch` tut es von
 * sich aus, und damit fuehrt ein sauberes oeffentliches Ziel per `302` genau
 * dorthin, wo die Pruefung es nicht haben wollte.
 */
function sendRequest(
  url: URL, ziel: { address: string; family: number },
  headers: Record<string, string>, body: string, timeoutMs: number
): Promise<number> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<number>((resolve, reject) => {
    let req: ClientRequest
    try {
      req = transport(url, {
        method: 'POST',
        headers,
        // Kein gemeinsamer Verbindungspool: eine wiederverwendete Verbindung
        // haengt an einer frueher aufgeloesten Adresse und macht die
        // Bindung an `lookup` wertlos.
        agent: false,
        lookup: (_name, opts, cb: (
          err: NodeJS.ErrnoException | null,
          address: string | { address: string; family: number }[],
          family?: number
        ) => void) => {
          if ((opts as { all?: boolean }).all === true) cb(null, [ziel])
          else cb(null, ziel.address, ziel.family)
        }
      }, res => {
        // Der Rumpf der Antwort interessiert nicht, muss aber gelesen werden,
        // sonst bleibt die Verbindung offen, bis die Frist sie abraeumt.
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
        res.on('error', reject)
      })
    } catch (e) {
      reject(e)
      return
    }
    // Eine Frist ueber den ganzen Vorgang, nicht nur ueber das Stillstehen
    // der Verbindung: ein Empfaenger, der endlos langsam Bytes schickt, soll
    // die Warteschlange nicht anhalten.
    const frist = setTimeout(() => {
      const e: NodeJS.ErrnoException = new Error('Zeitueberschreitung')
      e.code = 'ETIMEDOUT'
      req.destroy(e)
    }, timeoutMs)
    req.on('error', e => { clearTimeout(frist); reject(e) })
    req.on('close', () => clearTimeout(frist))
    req.end(body)
  })
}

async function send(
  d: ClaimedDelivery, timeoutMs: number, allowed: readonly Cidr[]
): Promise<AttemptResult> {
  const body = JSON.stringify(d.payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const begonnen = Date.now()
  const dauer = (): number => Date.now() - begonnen

  /*
   * Geprueft wird hier noch einmal, obwohl die Route beim Anlegen schon
   * geprueft hat (Befund B1). Nicht aus Misstrauen gegen die Route, sondern
   * weil sich die Antwort des DNS zwischen Anlegen und Zustellen aendert --
   * das ist der einzige Zeitpunkt, an dem die Pruefung etwas wert ist.
   */
  const geprueft = checkWebhookTargetUrl(d.url, allowed)
  if ('problem' in geprueft) {
    return { statusCode: null, kind: 'blockedTarget', durationMs: dauer() }
  }

  let ziel: Ziel
  try {
    ziel = await resolveTarget(
      geprueft.target.url, geprueft.target.literalAddress, allowed)
  } catch (e) {
    return { statusCode: null, kind: classifyDeliveryError(e), durationMs: dauer() }
  }
  if (ziel === null) {
    return { statusCode: null, kind: 'blockedTarget', durationMs: dauer() }
  }

  try {
    const status = await sendRequest(geprueft.target.url, ziel, {
      'content-type': 'application/json',
      [WEBHOOK_HEADERS.event]: d.event_type,
      [WEBHOOK_HEADERS.delivery]: d.event_ref,
      [WEBHOOK_HEADERS.timestamp]: String(timestamp),
      [WEBHOOK_HEADERS.signature]: webhookSignature(d.signing_secret, timestamp, body)
    }, body, timeoutMs)
    // Eine Umleitung wird nicht verfolgt und zaehlt damit wie jede andere
    // Antwort ausserhalb der 2xx: nicht zugestellt.
    return {
      statusCode: status,
      kind: webhookDelivered(status) ? null : 'httpStatus',
      durationMs: dauer()
    }
  } catch (e) {
    // Zeitueberschreitung, Namensaufloesung, abgelehnte Verbindung: aus Sicht
    // der Wiederholung dasselbe wie eine 500.
    return { statusCode: null, kind: classifyDeliveryError(e), durationMs: dauer() }
  }
}

async function record(
  client: PoolClient, propertyId: number,
  d: ClaimedDelivery, r: AttemptResult, baseDelaySeconds: number
): Promise<{ ausgang: Ausgang; stillgelegt: boolean }> {
  await client.query(
    `INSERT INTO webhook_delivery_attempt
       (delivery_id, property_id, attempt, status_code, error, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [d.id, propertyId, d.attempt, r.statusCode, r.kind, r.durationMs])

  if (r.statusCode !== null && webhookDelivered(r.statusCode)) {
    await client.query(
      `UPDATE webhook_delivery
          SET status = 'delivered', delivered_at = now(),
              last_status_code = $2, last_error = NULL
        WHERE id = $1`, [d.id, r.statusCode])
    return { ausgang: 'delivered', stillgelegt: false }
  }

  const erschoepft = d.attempt >= WEBHOOK_MAX_ATTEMPTS
  // Ist der letzte Versuch verbraucht, steht keine Wiederholung mehr an. Die
  // Frist aus dem Beanspruchen stehen zu lassen, zeigte im Protokoll einen
  // Termin an, den niemand wahrnimmt.
  await client.query(
    `UPDATE webhook_delivery
        SET status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN $4 THEN now()
                                   ELSE now() + make_interval(secs => $5) END,
            last_status_code = $2, last_error = $3
      WHERE id = $1`,
    [d.id, r.statusCode, r.kind, erschoepft,
     webhookRetryDelaySeconds(d.attempt, baseDelaySeconds)])

  if (!erschoepft) return { ausgang: 'retrying', stillgelegt: false }

  /*
   * Stilllegung. Ein Empfaenger, der auch nach der letzten Wiederholung nicht
   * annimmt, ist nicht ueberlastet, sondern kaputt oder abgeschaltet. Weiter
   * zuzustellen hiesse, eine wachsende Warteschlange gegen eine Wand zu
   * fahren; der Grund steht an der Zeile, damit die Frage "warum kommt nichts
   * mehr an" ohne Protokollsuche zu beantworten ist.
   */
  // Der Grund ist ein Satz, kein Fehlercode: hier steht die Art aus dem
  // Katalog, nicht mehr die Meldung von Node mit Adresse und Port darin.
  const grund = renderMessage(`webhookError.${r.kind ?? 'other'}`, 'de')
  const stillgelegt = await client.query(
    `UPDATE webhook_subscription
        SET status = 'disabled', disabled_at = now(), disabled_reason = $2
      WHERE id = $1 AND status = 'active'`,
    [d.subscription_id,
     `Zustellung ${d.event_ref} nach ${d.attempt} Versuchen aufgegeben: ${grund}`])
  // Hat eine andere Zustellung desselben Abonnements es schon stillgelegt,
  // aendert das hier nichts mehr und soll auch nicht noch einmal zaehlen.
  return { ausgang: 'failed', stillgelegt: stillgelegt.rowCount === 1 }
}

export async function deliverWebhooks(
  pool: Pool, ctx: DbContext, propertyId: number, opts: WebhookDeliveryOptions = {}
): Promise<WebhookDeliveryResult> {
  const batchSize = opts.batchSize ?? 50
  const leaseSeconds = opts.leaseSeconds ?? 300
  const timeoutMs = opts.requestTimeoutMs ?? 10_000
  const baseDelaySeconds = opts.baseDelaySeconds ?? 60
  const allowed = opts.allowedCidrs ?? []

  const claimed = await withTransaction(pool, ctx, c =>
    claim(c, propertyId, batchSize, leaseSeconds))
  const result: WebhookDeliveryResult = {
    attempted: claimed.length, delivered: 0, retrying: 0, failed: 0, disabled: 0 }

  for (const d of claimed) {
    const versuch = await send(d, timeoutMs, allowed)
    const { ausgang, stillgelegt } = await withTransaction(pool, ctx, c =>
      record(c, propertyId, d, versuch, baseDelaySeconds))
    result[ausgang]++
    if (stillgelegt) result.disabled++
  }
  return result
}
