import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { withTransaction, type PoolClient } from '@hotelpms/db'
import { isIsoDate, nightsBetween, eachNight, preisJeNacht } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { emitEvent } from '../platform/events.js'
import {
  authenticateChannel, channelContext, type ChannelPrincipal
} from '../platform/channelAuth.js'
import { isTrainingProperty } from '../platform/training.js'
import { personenAngabe, type Personen } from './reservations.js'

/*
 * Kanalbuchungen aus einem fuehrenden Umsystem (Migration 0092).
 *
 * **Wofuer.** Das Adminpanel fuehrt das Gaestehaus: es holt die Buchungen
 * aus RoomCloud, vergibt die Zimmer selbst und meldet die Verfuegbarkeit an
 * RoomCloud. StayGrid zeigt sie im Kalender. `POST /v1/channel/ari/bookings`
 * konnte nur anlegen; ein Umsystem, das umbucht, braucht Aendern und
 * Stornieren, und zwar so, dass ein wiederholter Lauf nichts doppelt tut.
 *
 * **Warum der ganze Stand je Aufruf und nicht Aenderungen.** Das Adminpanel
 * teilt Aufenthalte beim Umoptimieren in Abschnitte mit Zimmerwechsel und
 * legt dabei Zeilen an und loescht sie; eine stabile Kennung hat nur die
 * Buchung als Ganzes. Jeder PUT nennt deshalb alle Abschnitte, und StayGrid
 * gleicht seine Reservierungen daran ab. Ein verlorener oder doppelter
 * Aufruf schadet so nicht: der naechste stellt denselben Stand her.
 *
 * **Warum nie abgelehnt wird, weil voll ist.** Das Zimmer ist verkauft,
 * bevor StayGrid davon hoert. Eine Absage aenderte daran nichts, nur fehlte
 * die Buchung danach im Kalender. Gebunden wird trotzdem, damit der Zaehler
 * stimmt, und die Reservierung traegt den Konflikt (`channel_conflict`).
 *
 * **Wem die Buchung gehoert.** Aendert die Rezeption sie in StayGrid, gehoert
 * sie ab dann StayGrid (Trigger in 0092), und ein Push aendert nichts mehr:
 * er antwortet `kept_local`. Sonst ueberschriebe der naechste Lauf still, was
 * jemand am Tresen bewusst getan hat. Das Umsystem sieht den Wechsel in der
 * Reservierungsliste (`channelOwner`) und haelt die Buchung bei sich fest.
 */

/** Wie bei `change-stay`: ein Aufenthalt, kein Dauermietvertrag. */
const MAX_SEGMENT_NIGHTS = 400
/** Fuenf Zimmer, mehrfach umgezogen; zwanzig Abschnitte sind reichlich. */
const MAX_SEGMENTS = 20
const REF_MUSTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

interface PushSegment {
  roomCode: string
  arrival: string
  departure: string
  adults?: number
  children?: number
  guestCount?: number
}

interface PushBody {
  segments: PushSegment[]
  /** Gesamtpreis der Buchung in Cent, einmal, nicht je Abschnitt. */
  totalCent?: number
  /** Ursprung beim Umsystem, etwa `Booking.com` oder `E-Mail`. */
  channelCode?: string
  guest?: { firstName?: string; lastName: string; email?: string; phone?: string }
  notes?: string
  /** Stand der Quelle. Ein aelterer als der zuletzt angenommene wird ignoriert. */
  sourceUpdatedAt?: string
}

interface Abschnitt {
  roomCode: string
  resourceId: number
  categoryId: number
  arrival: string
  departure: string
  personen: Personen
}

interface Bestehend {
  id: number
  public_ref: string
  status: string
  arrival: string
  departure: string
  resource_id: number | null
  category_id: number
}

const LEBEND = new Set(['Optional', 'Confirmed', 'InHouse', 'CheckedOut'])
const BINDEND = new Set(['Optional', 'Confirmed', 'InHouse'])

function refLesen(roh: string): string {
  if (!REF_MUSTER.test(roh)) throw Errors.validation({ externalReference: ['field.invalid'] })
  return roh
}

function zeitpunktLesen(roh: unknown, feld: string): string | null {
  if (roh === undefined || roh === null) return null
  if (typeof roh !== 'string' || Number.isNaN(Date.parse(roh))) {
    throw Errors.validation({ [feld]: ['field.isoTimestamp'] })
  }
  return new Date(roh).toISOString()
}

function rumpfLesen(roh: unknown): PushBody & { quelle: string | null } {
  const body = (roh ?? {}) as PushBody
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw Errors.validation({ segments: ['field.required'] })
  }
  if (body.segments.length > MAX_SEGMENTS) {
    throw Errors.validation({ segments: ['field.maxValue'] }, { max: MAX_SEGMENTS })
  }
  body.segments.forEach((s, i) => {
    if (typeof s?.roomCode !== 'string' || s.roomCode.trim() === '') {
      throw Errors.validation({ [`segments.${i}.roomCode`]: ['field.required'] })
    }
    if (!isIsoDate(s.arrival) || !isIsoDate(s.departure)) {
      throw Errors.validation({ [`segments.${i}.arrival`]: ['field.isoDate'] })
    }
    const n = nightsBetween(s.arrival, s.departure)
    if (n <= 0) throw Errors.validation({ [`segments.${i}.departure`]: ['field.afterArrival'] })
    if (n > MAX_SEGMENT_NIGHTS) {
      throw Errors.validation({ [`segments.${i}.departure`]: ['field.stayTooLong'] },
        { max: MAX_SEGMENT_NIGHTS })
    }
  })
  if (body.totalCent !== undefined
      && (!Number.isSafeInteger(body.totalCent) || body.totalCent < 0)) {
    throw Errors.validation({ totalCent: ['field.nonNegativeInteger'] })
  }
  if (body.channelCode !== undefined
      && (typeof body.channelCode !== 'string' || body.channelCode.length > 50)) {
    throw Errors.validation({ channelCode: ['field.invalid'] })
  }
  if (body.guest !== undefined && (typeof body.guest?.lastName !== 'string'
      || body.guest.lastName.trim() === '')) {
    throw Errors.validation({ 'guest.lastName': ['field.required'] })
  }
  return { ...body, quelle: zeitpunktLesen(body.sourceUpdatedAt, 'sourceUpdatedAt') }
}

/**
 * Pruefsumme ueber das, was die Belegung ausmacht: Zimmer, Tage, Personen,
 * Preis. Gastdaten gehoeren nicht hinein -- die Summe steht im
 * Audit-Protokoll (siehe 0092).
 */
function pruefsumme(body: PushBody): string {
  const teile = body.segments
    .map(s => [s.roomCode.trim(), s.arrival, s.departure,
               s.adults ?? null, s.children ?? null, s.guestCount ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256')
    .update(JSON.stringify({ s: teile, t: body.totalCent ?? null }))
    .digest('hex')
}

async function abschnitteAufloesen(
  client: PoolClient, propertyId: number, segments: PushSegment[]
): Promise<Abschnitt[]> {
  const codes = [...new Set(segments.map(s => s.roomCode.trim()))]
  const { rows } = await client.query<{ id: number; code: string; category_id: number }>(
    `SELECT r.id, r.code, r.category_id FROM resource r
       JOIN resource_category c ON c.id = r.category_id AND c.active
      WHERE r.property_id = $1 AND r.active AND r.code = ANY($2::text[])`,
    [propertyId, codes])
  const nachCode = new Map(rows.map(r => [r.code, r]))
  return segments.map((s, i) => {
    const z = nachCode.get(s.roomCode.trim())
    if (z === undefined) {
      throw Errors.validation({ [`segments.${i}.roomCode`]: ['field.unknownRoom'] })
    }
    return {
      roomCode: z.code, resourceId: z.id, categoryId: z.category_id,
      arrival: s.arrival, departure: s.departure, personen: personenAngabe(s)
    }
  })
}

async function trainingSperre(client: PoolClient, propertyId: number): Promise<void> {
  if (await isTrainingProperty(client, propertyId)) {
    throw Errors.unprocessable('training.noChannel')
  }
}

/** Kennzeichnet die Transaktion als Push, damit der Trigger aus 0092 schweigt. */
async function alsPush(client: PoolClient, p: ChannelPrincipal): Promise<void> {
  await client.query(`SELECT set_config('app.channel_push', $1, true)`,
    [String(p.connectionId)])
}

async function binden(
  client: PoolClient, propertyId: number, a: { categoryId: number; arrival: string
                                               departure: string }
): Promise<boolean> {
  const r = await client.query<{ e: string | null }>(
    `SELECT inventory_reserve_force($1,$2,$3::date,$4::date,1) AS e`,
    [propertyId, a.categoryId, a.arrival, a.departure])
  const e = r.rows[0]!.e
  if (e === 'not_materialized') throw Errors.notMaterialized()
  return e === 'over'
}

async function freigeben(
  client: PoolClient, propertyId: number, r: Bestehend
): Promise<void> {
  await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
    [propertyId, r.category_id, r.arrival, r.departure])
}

/**
 * Welche bestehende Reservierung welchen Abschnitt traegt.
 *
 * Erst was genau passt, dann dasselbe Zimmer mit ueberlappenden Tagen, dann
 * irgendeine. So behalten Reservierungen ihre Nummer, wenn das Umsystem nur
 * umzieht oder verlaengert, und eine Nummer, die die Rezeption schon auf
 * einen Zettel geschrieben hat, verschwindet nicht bei jedem Optimierungslauf.
 *
 * Abgereiste Aufenthalte werden nur genau zugeordnet; ein angereister nur,
 * wenn die Anreise bleibt -- sie ist geschehen.
 */
function zuordnen(
  soll: Abschnitt[], ist: Bestehend[]
): { paare: Array<[Abschnitt, Bestehend]>; neu: Abschnitt[]; uebrig: Bestehend[] } {
  const frei = new Set(ist)
  const offen = new Set(soll)
  const paare: Array<[Abschnitt, Bestehend]> = []
  const nimm = (a: Abschnitt, r: Bestehend) => {
    paare.push([a, r]); offen.delete(a); frei.delete(r)
  }
  const darf = (a: Abschnitt, r: Bestehend) =>
    r.status !== 'CheckedOut' && (r.status !== 'InHouse' || r.arrival === a.arrival)

  for (const a of [...offen]) {
    const r = [...frei].find(x => x.resource_id === a.resourceId
      && x.arrival === a.arrival && x.departure === a.departure)
    if (r) nimm(a, r)
  }
  for (const a of [...offen]) {
    const r = [...frei].find(x => x.resource_id === a.resourceId && darf(a, x)
      && x.arrival < a.departure && x.departure > a.arrival)
    if (r) nimm(a, r)
  }
  for (const a of [...offen]) {
    const r = [...frei].find(x => darf(a, x))
    if (r) nimm(a, r)
  }
  return { paare, neu: [...offen], uebrig: [...frei] }
}

async function gastAnlegen(
  client: PoolClient, p: ChannelPrincipal, guest: PushBody['guest']
): Promise<number | null> {
  if (guest === undefined) return null
  const g = await client.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, phone)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.accountId, guest.lastName.trim(), guest.firstName ?? null,
     guest.email ?? null, guest.phone ?? null])
  return g.rows[0]!.id
}

/**
 * Preise aller Naechte der Buchung aus dem Gesamtpreis.
 *
 * Wie bei `change-stay`: eine gebuchte Nacht hat einen Beleg und bleibt.
 * Der Gesamtpreis meint den ganzen Aufenthalt einschliesslich ihrer;
 * aufgeteilt wird, was nach ihnen uebrig ist, auf die ungebuchten Naechte
 * aller Abschnitte in ihrer Reihenfolge.
 */
async function naechteSchreiben(
  client: PoolClient, propertyId: number, totalCent: number,
  traeger: Array<{ reservationId: number; arrival: string; departure: string }>
): Promise<void> {
  const ids = traeger.map(t => t.reservationId)
  await client.query(
    `DELETE FROM reservation_night WHERE reservation_id = ANY($1::bigint[]) AND NOT posted`,
    [ids])
  const gebucht = await client.query<{ reservation_id: number; date: string; price_cent: string }>(
    `SELECT reservation_id, date::text, price_cent FROM reservation_night
      WHERE reservation_id = ANY($1::bigint[])`, [ids])
  const schonDa = new Set(gebucht.rows.map(g => `${g.reservation_id}/${g.date}`))
  const summeGebucht = gebucht.rows.reduce((s, g) => s + Number(g.price_cent), 0)

  const offen: Array<{ reservationId: number; date: string }> = []
  for (const t of traeger) {
    for (const d of eachNight(t.arrival, t.departure)) {
      if (!schonDa.has(`${t.reservationId}/${d}`)) offen.push({ reservationId: t.reservationId, date: d })
    }
  }
  if (offen.length === 0) return
  const preise = preisJeNacht(Math.max(0, totalCent - summeGebucht), offen.length)
  // Eine Anweisung fuer alle Naechte (Performanceaudit).
  await client.query(
    `INSERT INTO reservation_night (reservation_id, property_id, date, price_cent)
     SELECT x.rid, $1, x.date, x.price
       FROM unnest($2::bigint[], $3::date[], $4::bigint[]) AS x(rid, date, price)`,
    [propertyId, offen.map(o => o.reservationId), offen.map(o => o.date), preise])
}

/**
 * Konflikte neu setzen: Gruppe ueberbucht (beim Binden erkannt) oder im
 * Zimmer liegt an einem der Tage schon jemand.
 */
async function konflikteSetzen(
  client: PoolClient, ids: number[], ueberbucht: Set<number>
): Promise<Map<number, string | null>> {
  const zimmer = await client.query<{ id: number }>(
    `SELECT r.id FROM reservation r
      WHERE r.id = ANY($1::bigint[]) AND r.resource_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM reservation o
                     WHERE o.resource_id = r.resource_id AND o.id <> r.id
                       AND o.status IN ('Confirmed','InHouse')
                       AND o.arrival < r.departure AND o.departure > r.arrival)`,
    [ids])
  const imZimmer = new Set(zimmer.rows.map(z => z.id))
  const ergebnis = new Map<number, string | null>(ids.map(id => [id,
    imZimmer.has(id) ? 'room' : ueberbucht.has(id) ? 'inventory' : null]))
  await client.query(
    `UPDATE reservation r SET channel_conflict = x.k
       FROM unnest($1::bigint[], $2::text[]) AS x(id, k)
      WHERE r.id = x.id AND r.channel_conflict IS DISTINCT FROM x.k`,
    [ids, ids.map(id => ergebnis.get(id) ?? null)])
  return ergebnis
}

interface BuchungZeile {
  id: number
  public_ref: string
  channel_connection_id: number | null
  channel_owner: string | null
  source_updated_at: string | null
  source_hash: string | null
  booker_guest_id: number | null
}

async function buchungSperren(
  client: PoolClient, propertyId: number, ref: string
): Promise<BuchungZeile | null> {
  const b = await client.query<BuchungZeile>(
    `SELECT id, public_ref, channel_connection_id, channel_owner,
            source_updated_at::text, source_hash, booker_guest_id
       FROM booking WHERE property_id = $1 AND external_reference = $2 FOR UPDATE`,
    [propertyId, ref])
  return b.rows[0] ?? null
}

/** Nur der Zugang, der die Buchung gebracht hat, darf sie aendern. */
function eigeneBuchung(b: BuchungZeile, p: ChannelPrincipal): void {
  if (b.channel_connection_id !== p.connectionId) {
    throw Errors.conflict('channel.referenceForeign')
  }
}

export function channelPushRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/channel/ari/bookings/:externalReference',
    // Wie die uebrigen Kanalrouten: abgesichert durch das Verbindungstoken.
    permission: null,
    summary: 'Kanalbuchung anlegen oder auf den Stand der Quelle bringen',
    handler: async (req, reply) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const ref = refLesen((req.params as { externalReference: string }).externalReference)
      const body = rumpfLesen(req.body)
      const hash = pruefsumme(body)
      const propertyId = principal.propertyId

      const ergebnis = await withTransaction(req.pool, channelContext(principal), async client => {
        await alsPush(client, principal)
        await trainingSperre(client, propertyId)
        const soll = await abschnitteAufloesen(client, propertyId, body.segments)

        let buchung = await buchungSperren(client, propertyId, ref)
        let angelegt = false
        if (buchung === null) {
          const guestId = await gastAnlegen(client, principal, body.guest)
          const ins = await client.query<{ id: number }>(
            `INSERT INTO booking (property_id, source, channel_code, external_reference,
                                  booker_guest_id, channel_connection_id, channel_owner)
             VALUES ($1,'channel',$2,$3,$4,$5,'source')
             ON CONFLICT (property_id, external_reference) WHERE external_reference IS NOT NULL
             DO NOTHING RETURNING id`,
            [propertyId, body.channelCode ?? principal.provider, ref, guestId,
             principal.connectionId])
          // Ein zweiter Aufruf mit derselben Nummer laeuft gerade: der Anbieter
          // stellt spaeter noch einmal zu, dann ist der erste fertig.
          if (ins.rowCount === 0) throw Errors.conflict('channel.referenceInFlight')
          buchung = (await buchungSperren(client, propertyId, ref))!
          angelegt = true
        }
        eigeneBuchung(buchung, principal)

        if (buchung.channel_owner === 'local') {
          // Die Rezeption fuehrt die Buchung. Sagt die Quelle jetzt etwas
          // anderes als beim letzten Push, muss das jemand sehen.
          const anders = buchung.source_hash !== hash
          if (anders) {
            await client.query(
              `UPDATE booking SET source_hash = $2, source_changed_at = now() WHERE id = $1`,
              [buchung.id, hash])
          }
          return { status: 'kept_local' as const, bookingRef: buchung.public_ref,
                   sourceChanged: anders }
        }

        if (!angelegt && body.quelle !== null && buchung.source_updated_at !== null
            && Date.parse(body.quelle) < Date.parse(buchung.source_updated_at)) {
          return { status: 'stale' as const, bookingRef: buchung.public_ref }
        }

        const ist = (await client.query<Bestehend>(
          `SELECT id, public_ref, status, arrival::text, departure::text,
                  resource_id, category_id
             FROM reservation WHERE booking_id = $1 ORDER BY arrival, id FOR UPDATE`,
          [buchung.id])).rows
        const lebend = ist.filter(r => LEBEND.has(r.status))

        if (!angelegt && buchung.source_hash === hash && lebend.length === soll.length) {
          await client.query(
            `UPDATE booking SET source_updated_at = COALESCE($2::timestamptz, source_updated_at)
              WHERE id = $1`, [buchung.id, body.quelle])
          return { status: 'unchanged' as const, bookingRef: buchung.public_ref }
        }

        const { paare, neu, uebrig } = zuordnen(soll, lebend)
        const ueberbucht = new Set<number>()
        const traeger: Array<{ reservationId: number; reservationRef: string; roomCode: string
                                arrival: string; departure: string }> = []

        // Erst freigeben, was wegfaellt oder umzieht, dann binden: sonst
        // zaehlte ein Umzug innerhalb der Buchung als Ueberbuchung.
        const stornieren = uebrig.filter(r => BINDEND.has(r.status) && r.status !== 'InHouse')
        for (const r of stornieren) await freigeben(client, propertyId, r)
        const umziehen = paare.filter(([a, r]) => a.arrival !== r.arrival
          || a.departure !== r.departure || a.categoryId !== r.category_id)
        for (const [, r] of umziehen) {
          if (BINDEND.has(r.status)) await freigeben(client, propertyId, r)
        }

        if (stornieren.length > 0) {
          await client.query(
            `UPDATE reservation SET status = 'Canceled', canceled_at = now(),
                    channel_conflict = NULL, updated_at = now()
              WHERE id = ANY($1::bigint[])`, [stornieren.map(r => r.id)])
        }

        for (const [a, r] of paare) {
          if (umziehen.some(([, x]) => x === r) && BINDEND.has(r.status)) {
            if (await binden(client, propertyId, a)) ueberbucht.add(r.id)
          }
          await client.query(
            `UPDATE reservation
                SET arrival = $2::date, departure = $3::date, category_id = $4,
                    resource_id = $5, guest_count = $6, adults = $7, children = $8,
                    notes = COALESCE($9, notes), updated_at = now()
              WHERE id = $1`,
            [r.id, a.arrival, a.departure, a.categoryId, a.resourceId,
             a.personen.guestCount, a.personen.adults, a.personen.children,
             body.notes ?? null])
          traeger.push({ reservationId: r.id, reservationRef: r.public_ref,
                         roomCode: a.roomCode, arrival: a.arrival, departure: a.departure })
        }

        for (const a of neu) {
          const voll = await binden(client, propertyId, a)
          const res = await client.query<{ id: number; public_ref: string }>(
            `INSERT INTO reservation
               (property_id, booking_id, category_id, resource_id, arrival, departure,
                status, primary_guest_id, notes, guest_count, adults, children)
             VALUES ($1,$2,$3,$4,$5::date,$6::date,'Confirmed',$7,$8,$9,$10,$11)
             RETURNING id, public_ref`,
            [propertyId, buchung.id, a.categoryId, a.resourceId, a.arrival, a.departure,
             buchung.booker_guest_id, body.notes ?? null,
             a.personen.guestCount, a.personen.adults, a.personen.children])
          const id = res.rows[0]!.id
          if (voll) ueberbucht.add(id)
          if (buchung.booker_guest_id !== null) {
            await client.query(
              `INSERT INTO reservation_occupant (property_id, reservation_id, guest_id, is_primary)
               VALUES ($1,$2,$3,true)`, [propertyId, id, buchung.booker_guest_id])
          }
          await client.query(
            `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
             VALUES ($1,$2,$3,'guest')`, [propertyId, id, buchung.booker_guest_id])
          traeger.push({ reservationId: id, reservationRef: res.rows[0]!.public_ref,
                         roomCode: a.roomCode, arrival: a.arrival, departure: a.departure })
        }

        await naechteSchreiben(client, propertyId, body.totalCent ?? 0, traeger)
        const konflikte = await konflikteSetzen(client, traeger.map(t => t.reservationId),
          ueberbucht)

        await client.query(
          `UPDATE booking
              SET channel_code = $2, channel_owner = 'source', source_hash = $3,
                  source_updated_at = COALESCE($4::timestamptz, source_updated_at),
                  source_canceled_at = NULL
            WHERE id = $1`,
          [buchung.id, body.channelCode ?? principal.provider, hash, body.quelle])

        // Ein Ereignis je beruehrter Reservierung, wie an der Rezeption.
        const neuIds = new Set(traeger.slice(paare.length).map(t => t.reservationId))
        for (const t of traeger) {
          await emitEvent(client, propertyId,
            neuIds.has(t.reservationId) ? 'reservation.created' : 'reservation.changed', {
              reservationRef: t.reservationRef, bookingRef: buchung.public_ref,
              arrival: t.arrival, departure: t.departure, source: 'channel',
              externalReference: ref })
        }
        for (const r of stornieren) {
          await emitEvent(client, propertyId, 'reservation.canceled', {
            reservationRef: r.public_ref, bookingRef: buchung.public_ref, status: 'Canceled',
            arrival: r.arrival, departure: r.departure })
        }

        return {
          status: angelegt ? 'created' as const : 'updated' as const,
          bookingRef: buchung.public_ref,
          reservations: traeger.map(t => ({
            reservationRef: t.reservationRef, roomCode: t.roomCode,
            arrival: t.arrival, departure: t.departure,
            conflict: konflikte.get(t.reservationId) ?? null
          })),
          // Angereiste oder abgereiste Aufenthalte, die die Quelle nicht mehr
          // nennt, bleiben: ein Gast, der im Zimmer schlaeft, wird nicht
          // durch einen Push storniert.
          keptStays: uebrig.filter(r => !stornieren.includes(r)).map(r => r.public_ref)
        }
      })

      reply.status(ergebnis.status === 'created' ? 201 : 200)
      return ergebnis
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/channel/ari/bookings/:externalReference/cancel',
    permission: null,
    summary: 'Kanalbuchung stornieren',
    handler: async (req) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const ref = refLesen((req.params as { externalReference: string }).externalReference)
      const quelle = zeitpunktLesen((req.body as { sourceUpdatedAt?: unknown } | undefined)
        ?.sourceUpdatedAt, 'sourceUpdatedAt')
      const propertyId = principal.propertyId

      return withTransaction(req.pool, channelContext(principal), async client => {
        await alsPush(client, principal)
        await trainingSperre(client, propertyId)
        const buchung = await buchungSperren(client, propertyId, ref)
        if (buchung === null) throw Errors.notFound('res.booking')
        eigeneBuchung(buchung, principal)

        if (buchung.channel_owner === 'local') {
          // Wie beim Adminpanel eine angepasste Zeile: wer in StayGrid
          // umgebucht hat, hat einen Gast im Kopf. Die Absage der Quelle
          // wird vermerkt, nicht vollzogen.
          await client.query(
            `UPDATE booking SET source_canceled_at = COALESCE(source_canceled_at, now())
              WHERE id = $1`, [buchung.id])
          return { status: 'kept_local' as const, bookingRef: buchung.public_ref }
        }
        if (quelle !== null && buchung.source_updated_at !== null
            && Date.parse(quelle) < Date.parse(buchung.source_updated_at)) {
          return { status: 'stale' as const, bookingRef: buchung.public_ref }
        }

        const ist = (await client.query<Bestehend>(
          `SELECT id, public_ref, status, arrival::text, departure::text,
                  resource_id, category_id
             FROM reservation WHERE booking_id = $1 ORDER BY arrival, id FOR UPDATE`,
          [buchung.id])).rows
        const stornieren = ist.filter(r => r.status === 'Optional' || r.status === 'Confirmed')
        const bleiben = ist.filter(r => r.status === 'InHouse' || r.status === 'CheckedOut')

        for (const r of stornieren) await freigeben(client, propertyId, r)
        if (stornieren.length > 0) {
          await client.query(
            `UPDATE reservation SET status = 'Canceled', canceled_at = now(),
                    channel_conflict = NULL, updated_at = now()
              WHERE id = ANY($1::bigint[])`, [stornieren.map(r => r.id)])
        }
        // Der Hash gehoert zum letzten Stand; ein spaeterer PUT derselben
        // Abschnitte soll die Buchung wiederbeleben, nicht "unchanged" sagen.
        await client.query(
          `UPDATE booking SET source_hash = NULL, source_canceled_at = now(),
                  source_updated_at = COALESCE($2::timestamptz, source_updated_at)
            WHERE id = $1`, [buchung.id, quelle])
        for (const r of stornieren) {
          await emitEvent(client, propertyId, 'reservation.canceled', {
            reservationRef: r.public_ref, bookingRef: buchung.public_ref, status: 'Canceled',
            arrival: r.arrival, departure: r.departure })
        }

        return {
          status: stornieren.length > 0 ? 'canceled' as const : 'already_canceled' as const,
          bookingRef: buchung.public_ref,
          keptStays: bleiben.map(r => r.public_ref)
        }
      })
    }
  })
}
