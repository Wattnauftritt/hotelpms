import { createHash } from 'node:crypto'
import { isIsoDate, nightsBetween, eachNight, addDays } from './dates.js'
import { preisJeNacht } from './groupPrice.js'
import { roomSortAuto, roomSortMarkDue, roomSortSetting, roomSortToday, roomSortLock,
         MAX_SORT_DAYS } from './roomSortRun.js'
import { DomainError } from './domainError.js'
import { personenPruefen, type Personen } from './personen.js'
import { enqueueEvents } from './events.js'

/*
 * Kanalbuchungen aus einem fuehrenden Umsystem (Migration 0092).
 *
 * **Zwei Wege herein, ein Abgleich.** Ein Umsystem schickt die Buchung per
 * PUT an die API (`routes/channelPush.ts`); einen Channel Manager, den
 * StayGrid selbst anspricht, fragt der Worker ab (`jobs/channelSync.ts`,
 * Migration 0198). Beide landen hier, damit Schutzregeln, Preisaufteilung
 * und Konflikte nicht zweimal gebaut werden und auseinanderlaufen.
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
 * Ebenso geschuetzt ist eine Buchung, an der jemand angereist ist
 * (`kept_checked_in`): der Gast ist da. Sonst ist die Quelle Herr, auch
 * ueber Stornos (Sven, 05.10.2026).
 *
 * **Wer das Zimmer vergibt.** Bisher das Umsystem: jeder Abschnitt nannte
 * sein Zimmer. Seit Sven entschieden hat, dass StayGrid im Gaestehaus die
 * Zimmer vergibt (07.10.2026, Thread "Zimmer-Sortierung"), darf ein
 * Abschnitt ohne Zimmer kommen, nur mit seiner Gruppe. Steht das Haus auf
 * "automatisch sortieren", gilt ein mitgeschicktes Zimmer gar nicht mehr:
 * StayGrid behaelt das bisherige, solange es frei ist, und sortiert am Ende
 * des Aufrufs. Der Schalter ist die Einstellung des Hauses und nicht der
 * Rumpf -- so gibt es keinen Tag, an dem beide vergeben oder keiner, und das
 * Adminpanel darf weiter Zimmer schicken, bis es umgestellt ist.
 *
 * **Wie weit der Push sortiert.** Nur die Umgebung der eigenen Buchung
 * (`sortierFenster`), nicht mehr ein ganzes Jahr: der Jahreslauf sperrte
 * jeden Aufenthalt des Jahres und rechnete auf dem einen Faden der API,
 * solange jede andere Anfrage wartete (Performance-Audit 11.10.2026,
 * Befund 6). Das Zimmer selbst muss aber in der Antwort stehen -- so ist
 * der Push vereinbart (`reservations[].roomCode`, Plan "Zimmer sortieren"
 * 3.6: "sofort im selben Aufruf"). Das Jahr sortiert danach der Worker,
 * gebuendelt (`room_sort_due`, Migration 0141).
 */

/**
 * Was die Fachlogik vom Datenbank-Client braucht. Wie `RoomSortSqlClient`:
 * die Domaene haengt nicht an `@hotelpms/db`, und ein `PoolClient` passt.
 */
export interface KanalClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]
                                                         rowCount?: number | null }>
}

async function abfrage<T>(
  client: KanalClient, text: string, values?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const r = await client.query(text, values)
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
}

/**
 * Wer die Buchung bringt: ein Zugang mit Token (das Adminpanel, ein
 * Umsystem) oder ein Kanaladapter, den StayGrid selbst betreibt (0198).
 * Fuer den Abgleich ist das dasselbe -- eine Buchung gehoert dem Zugang,
 * der sie gebracht hat.
 */
export interface KanalZugang {
  connectionId: number
  propertyId: number
  accountId: number
  provider: string
}

const sortierSperre = roomSortLock

async function isTrainingProperty(client: KanalClient, propertyId: number): Promise<boolean> {
  const { rows } = await abfrage<{ is_training: boolean }>(client,
    `SELECT is_training FROM property WHERE id = $1`, [propertyId])
  return rows[0]?.is_training ?? false
}

async function vergibtSelbst(client: KanalClient, propertyId: number): Promise<boolean> {
  return (await roomSortSetting(client, propertyId)).mode === 'auto'
}

/**
 * Tage vor und nach der Buchung, die der Push mitsortiert. Wer in diesen
 * Tagen liegt, darf weichen, damit der neue Gast ein durchgehendes Zimmer
 * bekommt; zwei Wochen reichen fuer die Aufenthalte, die ihn umgeben.
 */
const SORTIER_RAND_TAGE = 14

/** Wie bei `change-stay`: ein Aufenthalt, kein Dauermietvertrag. */
const MAX_SEGMENT_NIGHTS = 400
/** Fuenf Zimmer, mehrfach umgezogen; zwanzig Abschnitte sind reichlich. */
const MAX_SEGMENTS = 20
const REF_MUSTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface KanalSegment {
  /** Wunsch der Quelle; gilt nicht, wenn StayGrid im Haus selbst vergibt. */
  roomCode?: string
  /** Die Gruppe, wenn kein Zimmer mitkommt. Entfaellt, wenn das Haus nur eine hat. */
  categoryCode?: string
  arrival: string
  departure: string
  adults?: number
  children?: number
  guestCount?: number
  /**
   * Preis dieses Abschnitts in Cent (Migration 0160), wenn die Quelle ihn je
   * Zimmer kennt. Entweder an jedem Abschnitt oder an keinem.
   */
  totalCent?: number
}

export interface KanalRumpf {
  segments: KanalSegment[]
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
  resourceId: number | null
  categoryId: number
  arrival: string
  departure: string
  personen: Personen
  totalCent: number | null
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

export function kanalRefPruefen(roh: string): string {
  if (!REF_MUSTER.test(roh)) throw DomainError.validation({ externalReference: ['field.invalid'] })
  return roh
}

export function kanalZeitpunktPruefen(roh: unknown, feld: string): string | null {
  if (roh === undefined || roh === null) return null
  if (typeof roh !== 'string' || Number.isNaN(Date.parse(roh))) {
    throw DomainError.validation({ [feld]: ['field.isoTimestamp'] })
  }
  return new Date(roh).toISOString()
}

export function kanalRumpfPruefen(roh: unknown): KanalRumpf & { quelle: string | null } {
  const body = (roh ?? {}) as KanalRumpf
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw DomainError.validation({ segments: ['field.required'] })
  }
  if (body.segments.length > MAX_SEGMENTS) {
    throw DomainError.validation({ segments: ['field.maxValue'] }, { max: MAX_SEGMENTS })
  }
  body.segments.forEach((s, i) => {
    if (s?.roomCode !== undefined && (typeof s.roomCode !== 'string' || s.roomCode.trim() === '')) {
      throw DomainError.validation({ [`segments.${i}.roomCode`]: ['field.invalid'] })
    }
    if (s?.categoryCode !== undefined
        && (typeof s.categoryCode !== 'string' || s.categoryCode.trim() === '')) {
      throw DomainError.validation({ [`segments.${i}.categoryCode`]: ['field.invalid'] })
    }
    if (!isIsoDate(s.arrival) || !isIsoDate(s.departure)) {
      throw DomainError.validation({ [`segments.${i}.arrival`]: ['field.isoDate'] })
    }
    const n = nightsBetween(s.arrival, s.departure)
    if (n <= 0) throw DomainError.validation({ [`segments.${i}.departure`]: ['field.afterArrival'] })
    if (n > MAX_SEGMENT_NIGHTS) {
      throw DomainError.validation({ [`segments.${i}.departure`]: ['field.stayTooLong'] },
        { max: MAX_SEGMENT_NIGHTS })
    }
  })
  if (body.totalCent !== undefined
      && (!Number.isSafeInteger(body.totalCent) || body.totalCent < 0)) {
    throw DomainError.validation({ totalCent: ['field.nonNegativeInteger'] })
  }
  /*
   * Preis je Abschnitt: an jedem oder an keinem. Mit einem Teil davon
   * wuesste niemand, was die uebrigen kosten; und eine Summe daneben, die
   * etwas anderes sagt, waeren zwei Preise fuer eine Buchung.
   */
  const jeAbschnitt = body.segments.map(s => s.totalCent)
  jeAbschnitt.forEach((t, i) => {
    if (t !== undefined && (!Number.isSafeInteger(t) || t < 0)) {
      throw DomainError.validation({ [`segments.${i}.totalCent`]: ['field.nonNegativeInteger'] })
    }
  })
  const mit = jeAbschnitt.filter(t => t !== undefined).length
  if (mit > 0 && mit < jeAbschnitt.length) {
    const i = jeAbschnitt.findIndex(t => t === undefined)
    throw DomainError.validation({ [`segments.${i}.totalCent`]: ['field.required'] })
  }
  if (mit > 0 && body.totalCent !== undefined
      && jeAbschnitt.reduce<number>((a, t) => a + t!, 0) !== body.totalCent) {
    throw DomainError.validation({ totalCent: ['field.invalid'] })
  }
  if (body.channelCode !== undefined
      && (typeof body.channelCode !== 'string' || body.channelCode.length > 50)) {
    throw DomainError.validation({ channelCode: ['field.invalid'] })
  }
  if (body.guest !== undefined && (typeof body.guest?.lastName !== 'string'
      || body.guest.lastName.trim() === '')) {
    throw DomainError.validation({ 'guest.lastName': ['field.required'] })
  }
  return { ...body, quelle: kanalZeitpunktPruefen(body.sourceUpdatedAt, 'sourceUpdatedAt') }
}

/**
 * Pruefsumme ueber das, was die Belegung ausmacht: Zimmer, Tage, Personen,
 * Preis. Gastdaten gehoeren nicht hinein -- die Summe steht im
 * Audit-Protokoll (siehe 0092).
 */
function pruefsumme(body: KanalRumpf): string {
  const teile = body.segments
    .map(s => [s.roomCode?.trim() ?? null, s.categoryCode?.trim() ?? null, s.arrival, s.departure,
               s.adults ?? null, s.children ?? null, s.guestCount ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  /*
   * Preise je Abschnitt nur, wenn es sie gibt: sonst bekaeme jede bestehende
   * Buchung mit diesem Deploy eine andere Summe, und jede von der Rezeption
   * gefuehrte stuende als "Quelle hat sich geaendert" da.
   */
  const jeAbschnitt = body.segments.some(s => s.totalCent !== undefined)
    ? body.segments
        .map(s => [s.roomCode?.trim() ?? null, s.categoryCode?.trim() ?? null, s.arrival,
                   s.departure, s.totalCent ?? null])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : undefined
  return createHash('sha256')
    .update(JSON.stringify({ s: teile, t: body.totalCent ?? null, p: jeAbschnitt }))
    .digest('hex')
}

/**
 * Zimmer und Gruppe der Abschnitte.
 *
 * Ein Abschnitt ohne Zimmer braucht seine Gruppe: aus `categoryCode`, oder
 * die einzige des Hauses. Im Gaestehaus mit fuenf gleichen Doppelzimmern
 * (Sven, 07.10.2026) schickt das Adminpanel dann gar nichts dazu. Ein
 * unbekanntes Zimmer bleibt ein Fehler, auch wenn StayGrid selbst vergibt:
 * es heisst, dass Quelle und Stammdaten auseinanderlaufen, und das soll
 * auffallen, statt still eine andere Gruppe zu treffen.
 */
async function abschnitteAufloesen(
  client: KanalClient, propertyId: number, segments: KanalSegment[], selbst: boolean
): Promise<Abschnitt[]> {
  const codes = [...new Set(segments.flatMap(s => s.roomCode === undefined ? [] : [s.roomCode.trim()]))]
  const { rows } = await abfrage<{ id: number; code: string; category_id: number }>(client,
    `SELECT r.id, r.code, r.category_id FROM resource r
       JOIN resource_category c ON c.id = r.category_id AND c.active
      WHERE r.property_id = $1 AND r.active AND r.code = ANY($2::text[])`,
    [propertyId, codes])
  const nachCode = new Map(rows.map(r => [r.code, r]))
  const gruppen = (await abfrage<{ id: number; code: string }>(client,
    `SELECT id, code FROM resource_category WHERE property_id = $1 AND active`,
    [propertyId])).rows
  const gruppeNachCode = new Map(gruppen.map(g => [g.code, Number(g.id)]))
  return segments.map((s, i) => {
    const personen = personenPruefen(s)
    if (s.roomCode !== undefined) {
      const z = nachCode.get(s.roomCode.trim())
      if (z === undefined) {
        throw DomainError.validation({ [`segments.${i}.roomCode`]: ['field.unknownRoom'] })
      }
      return {
        resourceId: selbst ? null : Number(z.id),
        categoryId: Number(z.category_id), arrival: s.arrival, departure: s.departure, personen,
        totalCent: s.totalCent ?? null
      }
    }
    let categoryId: number | undefined
    if (s.categoryCode !== undefined) {
      categoryId = gruppeNachCode.get(s.categoryCode.trim())
      if (categoryId === undefined) {
        throw DomainError.validation({ [`segments.${i}.categoryCode`]: ['field.unknownCategory'] })
      }
    } else if (gruppen.length === 1) {
      categoryId = Number(gruppen[0]!.id)
    } else {
      throw DomainError.validation({ [`segments.${i}.roomCode`]: ['field.required'] })
    }
    return { resourceId: null, categoryId, arrival: s.arrival,
             departure: s.departure, personen, totalCent: s.totalCent ?? null }
  })
}

async function trainingSperre(client: KanalClient, propertyId: number): Promise<void> {
  if (await isTrainingProperty(client, propertyId)) {
    throw new DomainError('unprocessable', 'training.noChannel')
  }
}

/** Kennzeichnet die Transaktion als Push, damit der Trigger aus 0092 schweigt. */
async function alsPush(client: KanalClient, p: KanalZugang): Promise<void> {
  await client.query(`SELECT set_config('app.channel_push', $1, true)`,
    [String(p.connectionId)])
}

async function binden(
  client: KanalClient, propertyId: number, a: { categoryId: number; arrival: string
                                               departure: string }
): Promise<boolean> {
  const r = await abfrage<{ e: string | null }>(client,
    `SELECT inventory_reserve_force($1,$2,$3::date,$4::date,1) AS e`,
    [propertyId, a.categoryId, a.arrival, a.departure])
  const e = r.rows[0]!.e
  if (e === 'not_materialized') throw new DomainError('notMaterialized', null)
  return e === 'over'
}

async function freigeben(
  client: KanalClient, propertyId: number, r: Bestehend
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

  // Ohne Zimmer im Abschnitt zaehlen nur die Tage: StayGrid hat es vergeben.
  const zimmerPasst = (a: Abschnitt, r: Bestehend) =>
    a.resourceId === null ? r.category_id === a.categoryId : r.resource_id === a.resourceId
  for (const a of [...offen]) {
    const r = [...frei].find(x => zimmerPasst(a, x)
      && x.arrival === a.arrival && x.departure === a.departure)
    if (r) nimm(a, r)
  }
  for (const a of [...offen]) {
    const r = [...frei].find(x => zimmerPasst(a, x) && darf(a, x)
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
  client: KanalClient, p: KanalZugang, guest: KanalRumpf['guest']
): Promise<number | null> {
  if (guest === undefined) return null
  const g = await abfrage<{ id: number }>(client,
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
 *
 * Kennt die Quelle den Preis je Zimmer (`segments[].totalCent`, 0160), gilt
 * dieselbe Rechnung je Abschnitt: sonst kostete im Zimmerwechsel vom
 * Einzel- ins Doppelzimmer jede Nacht den Durchschnitt, und die Rechnung
 * stimmte nur in der Summe.
 */
async function naechteSchreiben(
  client: KanalClient, propertyId: number, totalCent: number,
  traeger: Array<{ reservationId: number; arrival: string; departure: string
                   totalCent: number | null }>
): Promise<void> {
  const ids = traeger.map(t => t.reservationId)
  await client.query(
    `DELETE FROM reservation_night WHERE reservation_id = ANY($1::bigint[]) AND NOT posted`,
    [ids])
  const gebucht = await abfrage<{ reservation_id: number; date: string; price_cent: string }>(client,
    `SELECT reservation_id, date::text, price_cent FROM reservation_night
      WHERE reservation_id = ANY($1::bigint[])`, [ids])
  const schonDa = new Set(gebucht.rows.map(g => `${g.reservation_id}/${g.date}`))
  const gebuchtVon = (rid: number | null) => gebucht.rows
    .filter(g => rid === null || Number(g.reservation_id) === rid)
    .reduce((s, g) => s + Number(g.price_cent), 0)

  const offenVon = (t: typeof traeger[number]) => eachNight(t.arrival, t.departure)
    .filter(d => !schonDa.has(`${t.reservationId}/${d}`))
    .map(date => ({ reservationId: t.reservationId, date }))
  const offen: Array<{ reservationId: number; date: string }> = []
  const preise: number[] = []
  if (traeger.length > 0 && traeger.every(t => t.totalCent !== null)) {
    for (const t of traeger) {
      const o = offenVon(t)
      if (o.length === 0) continue
      offen.push(...o)
      preise.push(...preisJeNacht(Math.max(0, t.totalCent! - gebuchtVon(t.reservationId)), o.length))
    }
  } else {
    offen.push(...traeger.flatMap(offenVon))
    if (offen.length > 0) {
      preise.push(...preisJeNacht(Math.max(0, totalCent - gebuchtVon(null)), offen.length))
    }
  }
  if (offen.length === 0) return
  // Eine Anweisung fuer alle Naechte (Performanceaudit).
  await client.query(
    `INSERT INTO reservation_night (reservation_id, property_id, date, price_cent)
     SELECT x.rid, $1, x.date, x.price
       FROM unnest($2::bigint[], $3::date[], $4::bigint[]) AS x(rid, date, price)`,
    [propertyId, offen.map(o => o.reservationId), offen.map(o => o.date), preise])
}

/**
 * Welche Abschnitte in ein Zimmer wollen, in dem an einem ihrer Tage schon
 * ein Gast einer **anderen** Buchung liegt.
 *
 * Diese Abschnitte kommen in die Ablage, nicht in das Zimmer (Sven,
 * 10.10.2026: "Buchungen die ueberbelegt sind muessen im Band ueber dem
 * Kalender landen"). Bisher lagen sie im belegten Zimmer, mit einem
 * Konfliktvermerk am Balken -- und im Plan genau unter dem anderen Balken.
 * Gesehen hat sie niemand; gezaehlt hat der Bestand sie trotzdem, und die
 * Rezeption bekam "ausgebucht" fuer ein Haus, in dem ein Zimmer leer
 * aussah. Das Zimmer, das die Quelle wollte, bleibt vermerkt
 * (`channel_wanted_resource_id`); wird es frei, legt `wartendePlatzieren`
 * die Buchung dorthin.
 */
async function besetzteAbschnitte(
  client: KanalClient, bookingId: number, abschnitte: Abschnitt[]
): Promise<Set<Abschnitt>> {
  abschnitte = abschnitte.filter(a => a.resourceId !== null)
  if (abschnitte.length === 0) return new Set()
  const r = await abfrage<{ i: string }>(client,
    `SELECT x.i FROM unnest($2::bigint[], $3::date[], $4::date[])
                      WITH ORDINALITY AS x(res, von, bis, i)
      WHERE EXISTS (SELECT 1 FROM reservation o
                     WHERE o.resource_id = x.res AND o.booking_id <> $1
                       AND o.status IN ('Confirmed','InHouse')
                       AND o.arrival < x.bis AND o.departure > x.von)`,
    [bookingId, abschnitte.map(a => a.resourceId), abschnitte.map(a => a.arrival),
     abschnitte.map(a => a.departure)])
  return new Set(r.rows.map(z => abschnitte[Number(z.i) - 1]!))
}

/**
 * Wartende aus der Ablage in ihr Zimmer legen, sobald es frei ist.
 *
 * Das Umsystem schiebt Gaeste um, und meist kommt der Push, der ein Zimmer
 * frei macht, nach dem, der hinein will. Ohne diesen Schritt bliebe die
 * Buchung in der Ablage, bis die Quelle sie zufaellig noch einmal schickt.
 * Einzeln und der Reihe nach: zwei Wartende auf dasselbe Zimmer duerfen
 * nicht in derselben Anweisung beide hinein. Nur Buchungen, die noch der
 * Quelle gehoeren; was die Rezeption angefasst hat, legt sie selbst.
 */
async function wartendePlatzieren(client: KanalClient, propertyId: number): Promise<void> {
  const wartend = await abfrage<{ id: number }>(client,
    `SELECT r.id FROM reservation r JOIN booking b ON b.id = r.booking_id
      WHERE r.property_id = $1 AND r.resource_id IS NULL
        AND r.channel_wanted_resource_id IS NOT NULL
        AND r.status IN ('Optional','Confirmed') AND b.channel_owner = 'source'
      ORDER BY r.arrival, r.id`, [propertyId])
  for (const w of wartend.rows) {
    await client.query(
      `UPDATE reservation r
          SET resource_id = r.channel_wanted_resource_id,
              channel_wanted_resource_id = NULL,
              channel_conflict = CASE WHEN r.channel_conflict = 'room' THEN NULL
                                      ELSE r.channel_conflict END,
              updated_at = now()
        WHERE r.id = $1
          AND EXISTS (SELECT 1 FROM resource z
                       WHERE z.id = r.channel_wanted_resource_id AND z.active)
          AND NOT EXISTS (SELECT 1 FROM reservation o
                           WHERE o.resource_id = r.channel_wanted_resource_id
                             AND o.id <> r.id AND o.status IN ('Confirmed','InHouse')
                             AND o.arrival < r.departure AND o.departure > r.arrival)
          AND NOT EXISTS (SELECT 1 FROM maintenance_block m
                           WHERE m.resource_id = r.channel_wanted_resource_id
                             AND m.kind = 'out_of_order'
                             AND m.from_date < r.departure AND m.to_date > r.arrival)`,
      [w.id])
  }
}

/**
 * Konflikte neu setzen: Gruppe ueberbucht (beim Binden erkannt) oder im
 * Zimmer liegt an einem der Tage schon jemand -- dann liegt die Buchung in
 * der Ablage und wartet auf ihr Zimmer.
 */
async function konflikteSetzen(
  client: KanalClient, ids: number[], ueberbucht: Set<number>
): Promise<Map<number, string | null>> {
  const zimmer = await abfrage<{ id: number }>(client,
    `SELECT r.id FROM reservation r
      WHERE r.id = ANY($1::bigint[])
        AND (r.channel_wanted_resource_id IS NOT NULL
         OR r.resource_id IS NOT NULL AND EXISTS (SELECT 1 FROM reservation o
                     WHERE o.resource_id = r.resource_id AND o.id <> r.id
                       AND o.status IN ('Confirmed','InHouse')
                       AND o.arrival < r.departure AND o.departure > r.arrival))`,
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

/**
 * Zimmer der eigenen Aufenthalte loesen, die nach dem Push belegt oder
 * gesperrt waeren. Nur, wenn StayGrid selbst vergibt: dann ist das Zimmer
 * kein Wunsch der Quelle, auf den eine Buchung warten koennte, und der
 * Sortierer legt sie gleich danach neu. Ohne diesen Schritt saehe er eine
 * Doppelbelegung und liesse die ganze Gruppe liegen.
 */
async function zimmerFreiMachen(client: KanalClient, ids: number[]): Promise<void> {
  await client.query(
    `UPDATE reservation r SET resource_id = NULL, updated_at = now()
      WHERE r.id = ANY($1::bigint[]) AND r.resource_id IS NOT NULL
        AND (EXISTS (SELECT 1 FROM reservation o
                      WHERE o.resource_id = r.resource_id AND o.id <> r.id
                        AND o.status IN ('Optional','Confirmed','InHouse')
                        AND o.arrival < r.departure AND o.departure > r.arrival)
             OR EXISTS (SELECT 1 FROM maintenance_block m
                         WHERE m.resource_id = r.resource_id AND m.kind = 'out_of_order'
                           AND m.from_date < r.departure AND m.to_date > r.arrival))`,
    [ids])
}

/** Das Zimmer, in dem jeder Aufenthalt am Ende liegt (nach dem Sortieren). */
async function zimmerCodes(client: KanalClient, ids: number[]): Promise<Map<number, string>> {
  const r = await abfrage<{ id: number; code: string }>(client,
    `SELECT r.id, u.code FROM reservation r JOIN resource u ON u.id = r.resource_id
      WHERE r.id = ANY($1::bigint[])`, [ids])
  return new Map(r.rows.map(x => [Number(x.id), x.code]))
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
  client: KanalClient, propertyId: number, ref: string
): Promise<BuchungZeile | null> {
  const b = await abfrage<BuchungZeile>(client,
    `SELECT id, public_ref, channel_connection_id, channel_owner,
            source_updated_at::text, source_hash, booker_guest_id
       FROM booking WHERE property_id = $1 AND external_reference = $2 FOR UPDATE`,
    [propertyId, ref])
  return b.rows[0] ?? null
}

/**
 * Ob an der Buchung schon jemand angereist ist.
 *
 * Dann aendert die Quelle sie nicht mehr (Sven, 05.10.2026): der Gast ist
 * da, und ein Storno oder eine Umbuchung im Portal aendert daran nichts. Das
 * gilt fuer die ganze Buchung, nicht nur fuer den angereisten Abschnitt --
 * ein Folgeabschnitt mit Zimmerwechsel gehoert zum selben Gast. Seit 0088
 * checkt der Nachtlauf eine Anreise mit Zimmer selbst ein; der Schutz greift
 * damit spaetestens in der ersten Nacht.
 */
async function angereist(client: KanalClient, bookingId: number): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM reservation
      WHERE booking_id = $1 AND status IN ('InHouse','CheckedOut') LIMIT 1`, [bookingId])
  return (r.rowCount ?? 0) > 0
}

/** Nur der Zugang, der die Buchung gebracht hat, darf sie aendern. */
function eigeneBuchung(b: BuchungZeile, p: KanalZugang): void {
  if (b.channel_connection_id !== p.connectionId) {
    throw new DomainError('conflict', 'channel.referenceForeign')
  }
}

/**
 * Der Zeitraum, den ein Push selbst sortiert: seine Aufenthalte ab dem
 * Geschaeftstag, mit `SORTIER_RAND_TAGE` davor und danach, hoechstens so
 * lang wie ein Lauf am Knopf (`MAX_SORT_DAYS`). Ist schon die Buchung
 * laenger, sortiert der Push nicht selbst; das Zimmer vergibt dann der
 * Worker im naechsten Lauf, und bis dahin liegt sie in der Ablage. Eine
 * Gaestehausbuchung ueber zwei Monate ist die Ausnahme, und ihretwegen ein
 * Jahr in der Anfrage zu sortieren war genau der Fehler.
 */
function sortierFenster(
  traeger: Array<{ arrival: string; departure: string }>, heute: string
): { from: string; to: string } | null {
  if (traeger.length === 0) return null
  const bis = traeger.reduce((m, t) => t.departure > m ? t.departure : m, traeger[0]!.departure)
  if (bis <= heute) return null
  const erste = traeger.reduce((m, t) => t.arrival < m ? t.arrival : m, traeger[0]!.arrival)
  const von = erste > heute ? erste : heute
  const mitRand = { from: addDays(von, -SORTIER_RAND_TAGE) > heute
                      ? addDays(von, -SORTIER_RAND_TAGE) : heute,
                    to: addDays(bis, SORTIER_RAND_TAGE) }
  if (nightsBetween(mitRand.from, mitRand.to) <= MAX_SORT_DAYS) return mitRand
  return nightsBetween(von, bis) <= MAX_SORT_DAYS ? { from: von, to: bis } : null
}


export type KanalSetzenErgebnis =
  | { status: 'kept_local' | 'kept_checked_in'; bookingRef: string; sourceChanged: boolean }
  | { status: 'stale' | 'unchanged'; bookingRef: string }
  | { status: 'created' | 'updated'; bookingRef: string
      reservations: Array<{ reservationRef: string; roomCode: string | null; arrival: string
                            departure: string; conflict: string | null }>
      keptStays: string[] }

/**
 * Buchung anlegen oder auf den Stand der Quelle bringen. Laeuft in der
 * Transaktion des Aufrufers, im Kontext des Hauses. Wirft `DomainError`
 * und, wenn der Sortierer ein Zimmer nicht bekommt, `RoomSortRoomTakenError`.
 */
export async function kanalBuchungSetzen(
  client: KanalClient, zugang: KanalZugang, ref: string,
  body: KanalRumpf & { quelle: string | null }
): Promise<KanalSetzenErgebnis> {
  const hash = pruefsumme(body)
  const propertyId = zugang.propertyId
  await alsPush(client, zugang)
  await trainingSperre(client, propertyId)
  await sortierSperre(client, propertyId)
  // Einmal gelesen und durchgereicht: bisher fragte der Push die
  // Einstellung dreimal und den Geschaeftstag zweimal (Befund 14).
  const einstellung = await roomSortSetting(client, propertyId)
  const selbst = einstellung.mode === 'auto'
  const soll = await abschnitteAufloesen(client, propertyId, body.segments, selbst)

  let buchung = await buchungSperren(client, propertyId, ref)
  let angelegt = false
  if (buchung === null) {
    const guestId = await gastAnlegen(client, zugang, body.guest)
    const ins = await abfrage<{ id: number }>(client,
      `INSERT INTO booking (property_id, source, channel_code, external_reference,
                            booker_guest_id, channel_connection_id, channel_owner)
       VALUES ($1,'channel',$2,$3,$4,$5,'source')
       ON CONFLICT (property_id, external_reference) WHERE external_reference IS NOT NULL
       DO NOTHING RETURNING id`,
      [propertyId, body.channelCode ?? zugang.provider, ref, guestId,
       zugang.connectionId])
    // Ein zweiter Aufruf mit derselben Nummer laeuft gerade: der Anbieter
    // stellt spaeter noch einmal zu, dann ist der erste fertig.
    if (ins.rowCount === 0) throw new DomainError('conflict', 'channel.referenceInFlight')
    buchung = (await buchungSperren(client, propertyId, ref))!
    angelegt = true
  }
  eigeneBuchung(buchung, zugang)

  // Die Rezeption fuehrt die Buchung, oder der Gast ist schon da. In
  // beiden Faellen aendert der Push nichts; sagt die Quelle jetzt etwas
  // anderes als beim letzten Push, muss das jemand sehen.
  const lokal = buchung.channel_owner === 'local'
  if (lokal || (!angelegt && await angereist(client, buchung.id))) {
    const anders = buchung.source_hash !== hash
    if (anders) {
      await client.query(
        `UPDATE booking SET source_hash = $2, source_changed_at = now() WHERE id = $1`,
        [buchung.id, hash])
    }
    return { status: lokal ? 'kept_local' as const : 'kept_checked_in' as const,
             bookingRef: buchung.public_ref, sourceChanged: anders }
  }

  if (!angelegt && body.quelle !== null && buchung.source_updated_at !== null
      && Date.parse(body.quelle) < Date.parse(buchung.source_updated_at)) {
    return { status: 'stale' as const, bookingRef: buchung.public_ref }
  }

  const ist = (await abfrage<Bestehend>(client,
    `SELECT id, public_ref, status, arrival::text, departure::text,
            resource_id, category_id
       FROM reservation WHERE booking_id = $1 ORDER BY arrival, id FOR UPDATE`,
    [buchung.id])).rows
  const lebend = ist.filter(r => LEBEND.has(r.status))

  if (!angelegt && buchung.source_hash === hash && lebend.length === soll.length) {
    await wartendePlatzieren(client, propertyId)
    await client.query(
      `UPDATE booking SET source_updated_at = COALESCE($2::timestamptz, source_updated_at)
        WHERE id = $1`, [buchung.id, body.quelle])
    return { status: 'unchanged' as const, bookingRef: buchung.public_ref }
  }

  const { paare, neu, uebrig } = zuordnen(soll, lebend)
  const besetzt = await besetzteAbschnitte(client, buchung.id, soll)
  // Vergibt StayGrid selbst, behaelt ein Aufenthalt sein Zimmer, solange
  // die Gruppe bleibt; ob es fuer die neuen Tage frei ist, klaert
  // `zimmerFreiMachen`, und wohin er dann kommt, der Sortierer.
  const zimmerFuer = (a: Abschnitt, r?: Bestehend) =>
    a.resourceId === null
      ? (r !== undefined && r.category_id === a.categoryId ? r.resource_id : null)
      : besetzt.has(a) ? null : a.resourceId
  const wartetAuf = (a: Abschnitt) => besetzt.has(a) ? a.resourceId : null
  const ueberbucht = new Set<number>()
  const traeger: Array<{ reservationId: number; reservationRef: string
                          arrival: string; departure: string
                          totalCent: number | null }> = []

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
              notes = COALESCE($9, notes), channel_wanted_resource_id = $10,
              updated_at = now()
        WHERE id = $1`,
      [r.id, a.arrival, a.departure, a.categoryId, zimmerFuer(a, r),
       a.personen.guestCount, a.personen.adults, a.personen.children,
       body.notes ?? null, wartetAuf(a)])
    traeger.push({ reservationId: r.id, reservationRef: r.public_ref,
                   arrival: a.arrival, departure: a.departure, totalCent: a.totalCent })
  }

  for (const a of neu) {
    const voll = await binden(client, propertyId, a)
    const res = await abfrage<{ id: number; public_ref: string }>(client,
      `INSERT INTO reservation
         (property_id, booking_id, category_id, resource_id, arrival, departure,
          status, primary_guest_id, notes, guest_count, adults, children,
          channel_wanted_resource_id)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,'Confirmed',$7,$8,$9,$10,$11,$12)
       RETURNING id, public_ref`,
      [propertyId, buchung.id, a.categoryId, zimmerFuer(a), a.arrival, a.departure,
       buchung.booker_guest_id, body.notes ?? null,
       a.personen.guestCount, a.personen.adults, a.personen.children, wartetAuf(a)])
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
                   arrival: a.arrival, departure: a.departure, totalCent: a.totalCent })
  }

  await naechteSchreiben(client, propertyId,
    body.totalCent ?? body.segments.reduce((t, x) => t + (x.totalCent ?? 0), 0), traeger)
  const ids = traeger.map(t => t.reservationId)
  if (selbst) {
    await zimmerFreiMachen(client, ids)
    const heute = await roomSortToday(client, propertyId)
    const fenster = sortierFenster(traeger, heute)
    if (fenster !== null) {
      await roomSortAuto(client, propertyId, fenster.from, fenster.to,
        { setting: einstellung, today: heute })
    }
    // Was der Push um sich herum nicht sortiert, sortiert der Worker.
    await roomSortMarkDue(client, propertyId)
  }
  const konflikte = await konflikteSetzen(client, ids, ueberbucht)
  const endZimmer = await zimmerCodes(client, ids)

  await client.query(
    `UPDATE booking
        SET channel_code = $2, channel_owner = 'source', source_hash = $3,
            source_updated_at = COALESCE($4::timestamptz, source_updated_at),
            source_canceled_at = NULL
      WHERE id = $1`,
    [buchung.id, body.channelCode ?? zugang.provider, hash, body.quelle])

  // Was dieser Push frei gemacht hat, bekommt ein Wartender.
  await wartendePlatzieren(client, propertyId)

  // Ein Ereignis je beruehrter Reservierung, wie an der Rezeption --
  // je Art eine Anweisung, nicht eine je Zeile (Befund 6). Erst die
  // geaenderten, dann die neuen, dann die stornierten: die
  // Reihenfolge, in der sie bisher einzeln hinausgingen.
  const ereignis = (t: typeof traeger[number]) => ({
    reservationRef: t.reservationRef, bookingRef: buchung.public_ref,
    arrival: t.arrival, departure: t.departure, source: 'channel',
    externalReference: ref })
  await enqueueEvents(client, propertyId, 'reservation.changed',
    traeger.slice(0, paare.length).map(ereignis))
  await enqueueEvents(client, propertyId, 'reservation.created',
    traeger.slice(paare.length).map(ereignis))
  await enqueueEvents(client, propertyId, 'reservation.canceled', stornieren.map(r => ({
    reservationRef: r.public_ref, bookingRef: buchung.public_ref, status: 'Canceled',
    arrival: r.arrival, departure: r.departure })))

  return {
    status: angelegt ? 'created' as const : 'updated' as const,
    bookingRef: buchung.public_ref,
    reservations: traeger.map(t => ({
      reservationRef: t.reservationRef, roomCode: endZimmer.get(t.reservationId) ?? null,
      arrival: t.arrival, departure: t.departure,
      conflict: konflikte.get(t.reservationId) ?? null
    })),
    // Angereiste oder abgereiste Aufenthalte, die die Quelle nicht mehr
    // nennt, bleiben: ein Gast, der im Zimmer schlaeft, wird nicht
    // durch einen Push storniert.
    keptStays: uebrig.filter(r => !stornieren.includes(r)).map(r => r.public_ref)
  }
}

export type KanalStornoErgebnis =
  | { status: 'kept_local' | 'kept_checked_in' | 'stale'; bookingRef: string }
  | { status: 'canceled' | 'already_canceled'; bookingRef: string; keptStays: string[] }

/** Kanalbuchung stornieren, mit denselben Schutzregeln wie beim Setzen. */
export async function kanalBuchungStornieren(
  client: KanalClient, zugang: KanalZugang, ref: string, quelle: string | null
): Promise<KanalStornoErgebnis> {
  const propertyId = zugang.propertyId
  await alsPush(client, zugang)
  await trainingSperre(client, propertyId)
  await sortierSperre(client, propertyId)
  const buchung = await buchungSperren(client, propertyId, ref)
  if (buchung === null) throw new DomainError('notFound', 'res.booking')
  eigeneBuchung(buchung, zugang)

  // Wie beim Adminpanel eine angepasste Zeile: wer in StayGrid
  // umgebucht hat, hat einen Gast im Kopf, und ein angereister Gast ist
  // da. Die Absage der Quelle wird vermerkt, nicht vollzogen.
  const lokal = buchung.channel_owner === 'local'
  if (lokal || await angereist(client, buchung.id)) {
    await client.query(
      `UPDATE booking SET source_canceled_at = COALESCE(source_canceled_at, now())
        WHERE id = $1`, [buchung.id])
    return { status: lokal ? 'kept_local' as const : 'kept_checked_in' as const,
             bookingRef: buchung.public_ref }
  }
  if (quelle !== null && buchung.source_updated_at !== null
      && Date.parse(quelle) < Date.parse(buchung.source_updated_at)) {
    return { status: 'stale' as const, bookingRef: buchung.public_ref }
  }

  const ist = (await abfrage<Bestehend>(client,
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
  await wartendePlatzieren(client, propertyId)
  // Ein frei gewordenes Zimmer kann einem anderen Gast besser passen.
  // Das sortiert der Worker; die Antwort auf ein Storno nennt kein
  // Zimmer, also muss der Aufruf darauf nicht warten (Befund 6).
  if (stornieren.length > 0 && await vergibtSelbst(client, propertyId)) {
    await roomSortMarkDue(client, propertyId)
  }
  // Der Hash gehoert zum letzten Stand; ein spaeterer PUT derselben
  // Abschnitte soll die Buchung wiederbeleben, nicht "unchanged" sagen.
  await client.query(
    `UPDATE booking SET source_hash = NULL,
            source_updated_at = COALESCE($2::timestamptz, source_updated_at)
      WHERE id = $1`, [buchung.id, quelle])
  await enqueueEvents(client, propertyId, 'reservation.canceled', stornieren.map(r => ({
    reservationRef: r.public_ref, bookingRef: buchung.public_ref, status: 'Canceled',
    arrival: r.arrival, departure: r.departure })))

  return {
    status: stornieren.length > 0 ? 'canceled' as const : 'already_canceled' as const,
    bookingRef: buchung.public_ref,
    keptStays: bleiben.map(r => r.public_ref)
  }
}
