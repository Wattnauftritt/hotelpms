import type { FastifyInstance } from 'fastify'
import { isIsoDate, nightsBetween, eachNight, preisJeNacht } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Centgenauer Preis einer Reservierung aus einem Umsystem (Migration 0160).
 *
 * Die Rezeption traegt den Gesamtbetrag in ganzen Euro ein; das Umsystem
 * kennt aus der Quellbuchung den Betrag auf den Cent, oft je Nacht. Der
 * Nachtlauf bucht, was in `reservation_night` steht, und die Rechnung zeigt,
 * was er gebucht hat -- der genaue Betrag gehoert also in die Naechte.
 *
 * **Wer gewinnt** (Sven, 13.10.2026). Bis der Preis aus der Quelle kommt,
 * ist der eingetragene eine Schaetzung und wird ersetzt. Was die Rezeption
 * danach aendert, bleibt (`kept_existing`, `changed_locally`). Erkannt wird
 * eine Aenderung daran, dass die Naechte nicht mehr so aussehen, wie dieser
 * Weg sie zuletzt geschrieben hat.
 *
 * **Was nie angefasst wird.** Eine gebuchte Nacht hat einen Beleg; wie bei
 * `change-stay` verteilt sich der Rest auf die offenen. Eine Buchung aus
 * einem Channel-Zugang bringt ihren Preis selbst mit (`channelPush.ts`).
 * Und ein Preis fuer einen anderen Zeitraum ist der Preis eines anderen
 * Aufenthalts: das Umsystem gleicht mit Toleranz ab, und dann soll der
 * Unterschied auffallen, statt still einen falschen Betrag zu verteilen.
 */

type Grund = 'changed_locally' | 'stay_differs' | 'posted' | 'channel_booking'

interface Eingabe {
  source: { system: string; reference: string | null }
  arrival: string
  departure: string
  totalCent: number
  /** Je Nacht, wenn die Quelle es weiss; sonst verteilt StayGrid die Summe. */
  nights: Array<{ date: string; priceCent: number }> | null
}

const SYSTEM_MAX = 40
const REFERENCE_MAX = 100
/** Dieselbe Grenze wie ein Abschnitt im Kanal-Push. */
const MAX_NIGHTS = 400

type Meldung = 'field.required' | 'field.invalid' | 'field.isoDate' | 'field.maxLength'
  | 'field.nonNegativeInteger' | 'field.afterArrival' | 'field.stayTooLong'

const centGueltig = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function pruefen(body: unknown): Eingabe {
  const b = (body ?? {}) as Record<string, unknown>
  const fehler: Record<string, Meldung[]> = {}
  const falsch = (feld: string, m: Meldung) => { (fehler[feld] ??= []).push(m) }

  const s = b.source as Record<string, unknown> | undefined
  let source: Eingabe['source'] | null = null
  if (s === undefined || s === null || typeof s !== 'object') {
    falsch('source', 'field.required')
  } else {
    const system = typeof s.system === 'string' ? s.system.trim() : ''
    if (system === '') falsch('source.system', 'field.required')
    else if (system.length > SYSTEM_MAX) falsch('source.system', 'field.maxLength')
    const reference = s.reference === undefined || s.reference === null ? null
      : typeof s.reference === 'string' ? s.reference.trim() || null : undefined
    if (reference === undefined) falsch('source.reference', 'field.invalid')
    else if (reference !== null && reference.length > REFERENCE_MAX) {
      falsch('source.reference', 'field.maxLength')
    }
    if (system !== '' && reference !== undefined) source = { system, reference }
  }

  const arrival = typeof b.arrival === 'string' && isIsoDate(b.arrival) ? b.arrival : null
  const departure = typeof b.departure === 'string' && isIsoDate(b.departure) ? b.departure : null
  if (arrival === null) falsch('arrival', 'field.isoDate')
  if (departure === null) falsch('departure', 'field.isoDate')
  let naechte: string[] = []
  if (arrival !== null && departure !== null) {
    const n = nightsBetween(arrival, departure)
    if (n <= 0) falsch('departure', 'field.afterArrival')
    else if (n > MAX_NIGHTS) falsch('departure', 'field.stayTooLong')
    else naechte = eachNight(arrival, departure)
  }

  if (!centGueltig(b.totalCent)) falsch('totalCent', 'field.nonNegativeInteger')

  let nights: Eingabe['nights'] = null
  if (b.nights !== undefined && b.nights !== null) {
    if (!Array.isArray(b.nights)) {
      falsch('nights', 'field.invalid')
    } else {
      const roh = b.nights as Array<Record<string, unknown> | null>
      roh.forEach((x, i) => {
        if (typeof x?.date !== 'string' || !isIsoDate(x.date)) falsch(`nights.${i}.date`, 'field.isoDate')
        if (!centGueltig(x?.priceCent)) falsch(`nights.${i}.priceCent`, 'field.nonNegativeInteger')
      })
      if (Object.keys(fehler).length === 0) {
        nights = roh.map(x => ({ date: x!.date as string, priceCent: x!.priceCent as number }))
          .sort((x, y) => x.date.localeCompare(y.date))
        // Jede Nacht des Zeitraums genau einmal, und die Summe ist die Summe:
        // eine Liste, die etwas anderes sagt als `totalCent`, sagt zwei Preise.
        if (nights.length !== naechte.length || nights.some((x, i) => x.date !== naechte[i])) {
          falsch('nights', 'field.invalid')
        } else if (nights.reduce((t, x) => t + x.priceCent, 0) !== b.totalCent) {
          falsch('totalCent', 'field.invalid')
        }
      }
    }
  }

  if (Object.keys(fehler).length > 0 || source === null) throw Errors.validation(fehler)
  return { source, arrival: arrival!, departure: departure!,
           totalCent: b.totalCent as number, nights }
}

type Nacht = [string, number]

function gleich(a: Nacht[], b: Nacht[]): boolean {
  return a.length === b.length && a.every(([d, p], i) => d === b[i]![0] && p === b[i]![1])
}

export function priceImportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/reservations/:reservationRef/price',
    permission: 'reservation:price_import',
    summary: 'Centgenauen Preis aus einem Umsystem uebernehmen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const eingabe = pruefen(req.body)
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number; arrival: string
                                       departure: string; channel_connection_id: number | null }>(
          `SELECT r.id, r.property_id, r.arrival::text, r.departure::text,
                  b.channel_connection_id
             FROM reservation r JOIN booking b ON b.id = r.booking_id
            WHERE r.public_ref = $1 FOR UPDATE OF r`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        // Das Recht im Haus der Reservierung: die Route nimmt keine
        // Property, und `registerRoute` prueft dann nur "irgendwo".
        if (!can(principal, 'reservation:price_import', Number(res.property_id))) {
          throw Errors.forbidden('access.missingPermission',
            { permission: 'reservation:price_import' })
        }
        const ergebnis = await preisSchreiben(client, res, eingabe)
        const summe = await client.query<{ s: string }>(
          `SELECT COALESCE(sum(price_cent), 0) AS s FROM reservation_night
            WHERE reservation_id = $1`, [res.id])
        return { reservationRef, ...ergebnis, totalCent: Number(summe.rows[0]!.s) }
      })
    }
  })
}

async function preisSchreiben(
  client: PoolClient,
  res: { id: number; property_id: number; arrival: string; departure: string
         channel_connection_id: number | null },
  e: Eingabe
): Promise<{ result: 'applied' | 'unchanged' | 'kept_existing'; reason?: Grund
             perNight?: boolean }> {
  if (res.channel_connection_id !== null) {
    return { result: 'kept_existing', reason: 'channel_booking' }
  }
  if (res.arrival !== e.arrival || res.departure !== e.departure) {
    return { result: 'kept_existing', reason: 'stay_differs' }
  }

  const { rows } = await client.query<{ date: string; price_cent: string; posted: boolean }>(
    `SELECT date::text, price_cent, posted FROM reservation_night
      WHERE reservation_id = $1 ORDER BY date`, [res.id])
  const ist: Nacht[] = rows.map(n => [n.date, Number(n.price_cent)])

  const zuletzt = await client.query<{ nights: Nacht[] }>(
    `SELECT nights FROM reservation_external_price WHERE reservation_id = $1`, [res.id])
  if (zuletzt.rowCount !== 0 && !gleich(zuletzt.rows[0]!.nights, ist)) {
    return { result: 'kept_existing', reason: 'changed_locally' }
  }

  /*
   * Je Nacht, solange die gebuchten Naechte schon den Preis der Quelle
   * tragen. Sonst die Summe: der Rest nach den gebuchten verteilt sich auf
   * die offenen, und der Aufenthalt kostet am Ende auf den Cent, was die
   * Quelle sagt, auch wenn eine Nacht schon zum geschaetzten Preis lief.
   */
  const quelle = new Map(e.nights?.map(n => [n.date, n.priceCent]) ?? [])
  const jeNacht = e.nights !== null
    && rows.every(n => !n.posted || Number(n.price_cent) === quelle.get(n.date))
  const offen = rows.filter(n => !n.posted).map(n => n.date)
  let neu: number[]
  if (jeNacht) {
    neu = offen.map(d => quelle.get(d)!)
  } else {
    const rest = e.totalCent - rows.filter(n => n.posted)
      .reduce((s, n) => s + Number(n.price_cent), 0)
    if (rest < 0 || (offen.length === 0 && rest !== 0)) {
      return { result: 'kept_existing', reason: 'posted' }
    }
    neu = offen.length === 0 ? [] : preisJeNacht(rest, offen.length)
  }
  const nachher: Nacht[] = ist.map(([d, p]) => {
    const i = offen.indexOf(d)
    return [d, i < 0 ? p : neu[i]!]
  })

  const anders = !gleich(ist, nachher)
  if (anders) {
    await client.query(
      `UPDATE reservation_night n SET price_cent = x.price
         FROM unnest($2::date[], $3::bigint[]) AS x(date, price)
        WHERE n.reservation_id = $1 AND n.date = x.date AND NOT n.posted`,
      [res.id, offen, neu])
  }
  // Auch ohne Aenderung festhalten: ab jetzt gilt eine Aenderung in
  // StayGrid als bewusst, nicht mehr als Schaetzung.
  await client.query(
    `INSERT INTO reservation_external_price
       (reservation_id, property_id, system, reference, total_cent, per_night, nights)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (reservation_id) DO UPDATE
       SET system = EXCLUDED.system, reference = EXCLUDED.reference,
           total_cent = EXCLUDED.total_cent, per_night = EXCLUDED.per_night,
           nights = EXCLUDED.nights, applied_at = now()
     WHERE (reservation_external_price.system, reservation_external_price.reference,
            reservation_external_price.total_cent, reservation_external_price.per_night,
            reservation_external_price.nights)
           IS DISTINCT FROM (EXCLUDED.system, EXCLUDED.reference, EXCLUDED.total_cent,
                             EXCLUDED.per_night, EXCLUDED.nights)`,
    [res.id, res.property_id, e.source.system, e.source.reference, e.totalCent,
     jeNacht, JSON.stringify(nachher)])
  return { result: anders ? 'applied' : 'unchanged', perNight: jeNacht }
}
