import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { onlineCheckinStand } from '../platform/checkin.js'
import { verzichtStand } from '../platform/reinigungsverzicht.js'
import { wuenscheDerReservierung } from '../platform/gastwuensche.js'
import { tagOderOffen } from './cleaningPlan.js'
import { tx } from '../platform/db.js'
import { AppError, Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent, emitEvents } from '../platform/events.js'
import { loadBlock } from './blocks.js'
import { geschaeftstag, rechtImHaus } from './depositRequests.js'
import { applyAction, InvalidTransitionError, eachNight, nightsBetween,
         isIsoDate, occupiesInventory, preisJeNacht, gruppeAufteilen, addDays,
         type ReservationStatus, type ReservationAction,
         type WebhookEventType, personenPruefen, type Personen } from '@hotelpms/domain'
import { alsApiFehler } from '../platform/domainError.js'

export type { Personen }
import { can, type Principal } from '../platform/context.js'
import { gaesteImBetrieb, gastPerRefImBetrieb, ratenplanImHaus } from '../platform/fremdeIds.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Obergrenze der Notiz. Nicht als Schikane, sondern weil ein Freitextfeld
 * ohne Grenze frueher oder spaeter einen Roman enthaelt, den niemand liest
 * und der jede Antwort aufblaeht, in der die Reservierung vorkommt.
 */
const NOTES_MAX_LENGTH = 2000
/*
 * Die Kurznotiz steht auf dem Balken im Belegungsplan. Vierzig Zeichen, und
 * die Grenze ist der Zweck: auf den Balken passt weniger -- bei einer Nacht
 * praktisch nichts --, aber eine Grenze, die exakt der Anzeige folgt, waere
 * bei jeder Schriftgroessenaenderung falsch. Vierzig sagt: ein Merkmal,
 * kein Satz. Dieselbe Zahl steht in der Bedingung der Tabelle (0055).
 */
const SHORT_NOTE_MAX_LENGTH = 40

/**
 * Obergrenze einer Gruppenbuchung.
 *
 * Nicht willkuerlich, sondern die Grenze zwischen zwei Werkzeugen: bis
 * hierher ist eine Reisegruppe eine Buchung mit mehreren Zimmern, darueber
 * gehoert sie in ein Kontingent, das Plaetze haelt, ohne sie schon zu
 * verkaufen. Ausserdem kostet jedes Zimmer eine Reservierung, ein Folio,
 * seine Naechte und ein Ereignis -- eine versehentlich aufgezogene Auswahl
 * ueber ein ganzes Haus waere sonst eine Anfrage, die minutenlang schreibt.
 */
const GRUPPE_MAX_ZIMMER = 50

/**
 * Wie jeder andere Zeitraumparameter hat auch die Aufenthaltsdauer eine
 * Obergrenze (Performanceaudit): eine Nacht wird als eigene Zeile in
 * `reservation_night` angelegt, und ohne Grenze waere eine Buchung ueber
 * `GRUPPE_MAX_ZIMMER` Zimmer und Jahre hinweg eine Anfrage, die
 * zehntausende Zeilen in einer Transaktion schreibt. 400 Tage, damit sich
 * dieselbe Zahl wie beim Preisraster (`rates.ts`) einpraegt.
 */
const MAX_STAY_NIGHTS = 400

/**
 * Personenzahl aus Gesamtzahl oder aus Erwachsenen und Kindern (0076).
 * Die Regel steht in `@hotelpms/domain` (`personenPruefen`), weil der
 * Worker sie fuer abgeholte Kanalbuchungen genauso braucht.
 */
export function personenAngabe(body: {
  guestCount?: number; adults?: number; children?: number
}): Personen {
  return alsApiFehler(() => personenPruefen(body))
}

/** Ein Zimmer einer Gruppenbuchung. */
interface CreateBookingRoom {
  categoryId: number
  resourceId?: number
  /** Preis dieses Zimmers fuer den ganzen Aufenthalt. Siehe Vertrag. */
  totalCent?: number
  /** Abweichende Tage fuer dieses Zimmer. Ohne Angabe die der Buchung. */
  arrival?: string
  departure?: string
  /** Personen in diesem Zimmer. Ohne Angabe die der Buchung. */
  adults?: number
  children?: number
}

interface CreateBooking {
  propertyId: number
  /** Entfaellt, wenn `rooms` die Zimmer einzeln nennt. */
  categoryId?: number
  /**
   * Mehrere Zimmer in **einer** Buchung. Siehe `CreateBooking` im Vertrag;
   * der Zeitraum gilt fuer alle gemeinsam.
   */
  rooms?: CreateBookingRoom[]
  arrival: string
  departure: string
  ratePlanId?: number
  guestId?: number
  /**
   * Wie `guestId`, aber ueber die oeffentliche Referenz. Die Oberflaeche
   * kennt die laufende id nicht -- sie bleibt bewusst innen (C1, Dokument
   * 13) -- und braucht deshalb diesen Weg, um einen in der Gastsuche
   * gefundenen Gast an eine neue Buchung zu haengen.
   */
  guestRef?: string
  occupants?: Array<{ guestId?: number; ageAtArrival?: number; isPrimary?: boolean }>
  /** Verbindlich oder unverbindlich. Ohne Angabe verbindlich, wie bisher. */
  status?: 'Confirmed' | 'Optional'
  optionExpiresAt?: string
  /** Preis je Nacht in Cent, statt des Preises aus dem Ratenplan. */
  priceCent?: number
  /** Preis der ganzen Buchung fuer den ganzen Aufenthalt. Siehe Vertrag. */
  totalCent?: number
  /** Wie viele Personen anreisen. Ohne Angabe gilt die Belegung der Gruppe. */
  guestCount?: number
  /** Erwachsene und Kinder getrennt; `guestCount` ist dann ihre Summe (0076). */
  adults?: number
  children?: number
  /** Merkmal fuer den Balken im Plan. Der Vorgang gehoert in `notes`. */
  shortNote?: string
  /** Ohne Fruehstueck gebucht (0169). */
  breakfastDeclined?: boolean
  /** Bestaetigte Ueberbuchung (`ueberbuchenErlauben`). */
  allowOverbooking?: boolean
  source?: string
  /** Buchungskanal als Freitext, siehe Vertrag. */
  channelCode?: string
  externalReference?: string
  notes?: string
  /** Abruf aus einem Kontingent statt aus dem freien Verkauf. */
  blockRef?: string
  /**
   * Zimmer gleich mit zuweisen.
   *
   * Fuer den Belegungsplan: wer dort ueber Zimmer 101 aufzieht, will die
   * Buchung **in** 101 haben, nicht in irgendeinem Zimmer der Gruppe. Ohne
   * dieses Feld braeuchte es zwei Aufrufe -- buchen, dann zuweisen -- mit
   * einem Fenster dazwischen, in dem ein zweiter Vorgang dasselbe Zimmer
   * belegt. Der Gast haette dann eine Reservierung ohne das Zimmer, das die
   * Rezeption ihm gerade zugesagt hat.
   */
  resourceId?: number
}

/**
 * Darf diese Reservierung in dieses Zimmer?
 *
 * Drei Fragen, und jede einzelne hat einen Grund:
 *
 * **Gehoert das Zimmer zu diesem Haus?** Die Zeilenrichtlinie filtert nach
 * Mandant, nicht nach Haus -- CLAUDE.md, "Bei mehreren Haeusern im Account
 * reicht die Zeilenrichtlinie nicht".
 *
 * Wichtig ist, wann das zuschlaegt, denn es verfuehrt dazu, die Pruefung fuer
 * ueberfluessig zu halten: bei einem Benutzer mit **einem** Haus faengt die
 * Richtlinie es ab, das fremde Zimmer ist fuer ihn nicht sichtbar. Hat er
 * dagegen Zugriff auf **beide** Haeuser -- in einer Kette der Normalfall --,
 * steht es in seinem Kontext, und `assign-unit` nahm es bis hierher an. Die
 * Reservierung in Haus A trug dann ein Zimmer aus Haus B, und der
 * Belegungsplan von Haus A zeigte sie gar nicht mehr, weil das Zimmer dort
 * nicht vorkommt. Zwei Tests halten genau diese Besetzung fest.
 *
 * **Ist es ausser Betrieb?** Out of Order heisst unbelegbar.
 *
 * **Liegt schon jemand darin?** Der Bestandszaehler rechnet je Gruppe, nicht
 * je Zimmer; zwei Reservierungen im selben Zimmer waeren rechnerisch in
 * Ordnung und im Haus ein Streit an der Rezeption.
 *
 * Bewusst **nicht** geprueft wird, ob das Zimmer zur gebuchten Gruppe
 * gehoert. Ein Upgrade ist Alltag: der Gast hat ein Doppelzimmer gebucht und
 * bekommt die Juniorsuite. Abgerechnet wird, was gebucht wurde; wer wirklich
 * die Gruppe wechseln will, nimmt `change-stay`.
 */
export async function assertUnitAssignable(
  client: PoolClient, opts: Omit<ZimmerFrage, 'ord'>
): Promise<void> {
  const [fehler] = await zimmerFehler(client, [{ ...opts, ord: 0 }])
  if (fehler) throw fehler
}

/** Eine Frage an `zimmerFehler`: darf dieser Aufenthalt in dieses Zimmer? */
export interface ZimmerFrage {
  /**
   * Die Stelle in der Reihenfolge des Aufrufers. Sie entscheidet bei
   * `mitVerlegt`, ob ein anderer Aufenthalt derselben Anfrage schon am
   * neuen oder noch am alten Platz steht.
   */
  ord: number
  resourceId: number; propertyId: number; arrival: string; departure: string
  exceptReservationId?: number
  /** Beim Tausch: der andere, der gleichzeitig auszieht. */
  alsoExceptReservationId?: number
}

/** Ein Aufenthalt, den dieselbe Anfrage verlegt (`aufenthalteVerlegen`). */
interface MitVerlegt {
  ord: number; id: number; status: ReservationStatus
  altZimmer: number | null; altAnkunft: string; altAbreise: string
  /** `null`, wenn die Anfrage vor diesem Aufenthalt abbricht. */
  neuZimmer: number | null; neuAnkunft: string | null; neuAbreise: string | null
}

/**
 * Die drei Fragen von `assertUnitAssignable` fuer viele Zimmer in **einer**
 * Anweisung (Performance-Audit 11.10.2026, Abschnitt 14).
 *
 * Eine Gruppe mit fuenfzig Zimmern stellte sie bisher fuenfzigmal, je drei
 * Abfragen. Geantwortet wird je Frage mit dem Fehler, den die einzelne
 * Pruefung zuerst geworfen haette, oder `null`; welcher davon gilt, sagt
 * die Reihenfolge des Aufrufers, nicht diese Funktion.
 *
 * **`mitVerlegt` bildet die alte Schleife nach.** Wer eine Gruppe
 * nacheinander verlegte, sah beim fuenften Zimmer die ersten vier schon am
 * neuen Platz und die uebrigen noch am alten. Genau so wird hier
 * gerechnet: Aufenthalte derselben Anfrage zaehlen mit ihrem Stand **zu
 * diesem Zeitpunkt der Schleife**, alle anderen mit dem der Datenbank.
 * Einfach "die ganze Gruppe ausnehmen" waere grosszuegiger und haette
 * Verschiebungen durchgelassen, die bisher abgewiesen wurden -- zwei
 * Zimmer der Gruppe hintereinander im selben Zimmer etwa.
 */
export async function zimmerFehler(
  client: PoolClient, fragen: readonly ZimmerFrage[],
  mitVerlegt: readonly MitVerlegt[] = []
): Promise<Array<AppError | null>> {
  if (fragen.length === 0) return []
  const { rows } = await client.query<{
    ord: number; property_id: string | null; active: boolean | null
    ausser_betrieb: boolean; belegt: boolean }>(
    `WITH f AS (
       SELECT * FROM unnest($1::int[], $2::bigint[], $3::date[], $4::date[],
                            $5::bigint[], $6::bigint[])
         AS f(ord, resource_id, arrival, departure, ausser1, ausser2)
     ), v AS (
       SELECT * FROM unnest($7::int[], $8::bigint[], $9::text[], $10::bigint[],
                            $11::date[], $12::date[], $13::bigint[], $14::date[], $15::date[])
         AS v(ord, id, status, alt_zimmer, alt_an, alt_ab, neu_zimmer, neu_an, neu_ab)
     )
     SELECT f.ord, res.property_id, res.active,
            EXISTS (SELECT 1 FROM maintenance_block m
                     WHERE m.resource_id = f.resource_id AND m.kind = 'out_of_order'
                       AND m.from_date < f.departure AND m.to_date > f.arrival)
              AS ausser_betrieb,
            -- Je Zimmerabschnitt (0195): wer am Mittwoch aus Zimmer 12
            -- auszieht, belegt es bis Mittwoch und nicht bis zur Abreise.
            EXISTS (SELECT 1 FROM reservation_room_stay r
                     WHERE r.resource_id = f.resource_id
                       AND r.id <> COALESCE(f.ausser1, -1) AND r.id <> COALESCE(f.ausser2, -1)
                       AND r.stay_status IN ('Confirmed','InHouse')
                       AND r.arrival < f.departure AND r.departure > f.arrival
                       AND NOT EXISTS (SELECT 1 FROM v WHERE v.id = r.id))
            OR EXISTS (SELECT 1 FROM v
                        WHERE v.id <> COALESCE(f.ausser1, -1) AND v.id <> COALESCE(f.ausser2, -1)
                          AND v.status IN ('Confirmed','InHouse')
                          AND CASE WHEN v.ord < f.ord
                                   THEN v.neu_zimmer = f.resource_id
                                        AND v.neu_an < f.departure AND v.neu_ab > f.arrival
                                   ELSE v.alt_zimmer = f.resource_id
                                        AND v.alt_an < f.departure AND v.alt_ab > f.arrival
                              END)
              AS belegt
       FROM f LEFT JOIN resource res ON res.id = f.resource_id`,
    [fragen.map(f => f.ord), fragen.map(f => f.resourceId),
     fragen.map(f => f.arrival), fragen.map(f => f.departure),
     fragen.map(f => f.exceptReservationId ?? null),
     fragen.map(f => f.alsoExceptReservationId ?? null),
     mitVerlegt.map(v => v.ord), mitVerlegt.map(v => v.id), mitVerlegt.map(v => v.status),
     mitVerlegt.map(v => v.altZimmer), mitVerlegt.map(v => v.altAnkunft),
     mitVerlegt.map(v => v.altAbreise), mitVerlegt.map(v => v.neuZimmer),
     mitVerlegt.map(v => v.neuAnkunft), mitVerlegt.map(v => v.neuAbreise)])
  const jeOrd = new Map(rows.map(r => [r.ord, r]))
  return fragen.map(f => {
    const r = jeOrd.get(f.ord)!
    if (r.property_id === null || Number(r.property_id) !== f.propertyId) {
      return Errors.notFound('res.room')
    }
    if (!r.active) return Errors.conflict('room.inactive')
    if (r.ausser_betrieb) return Errors.conflict('room.outOfOrder')
    if (r.belegt) return Errors.conflict('room.occupied')
    return null
  })
}

/**
 * Den Hauptgast einer Reservierung setzen -- die Namensliste.
 *
 * **Warum es das braucht.** Ein Bucher nimmt fuenf Zimmer, und die uebrigen
 * Namen stehen bis zum Anreisetag nicht fest; geplant wird deshalb mit
 * seinem Namen, an allen fuenf Balken. Das ist richtig so. Nur blieb es
 * bisher auch dabei: nach dem Anlegen konnte niemand den Gast eines Zimmers
 * mehr aendern -- ausser `channel.ts` fuer Kanalbuchungen. Am Tresen stand
 * dann auf fuenf Meldescheinen derselbe Name, obwohl in vier Zimmern andere
 * Leute schlafen, und § 30 BMG verlangt den tatsaechlichen Gast.
 *
 * **Bis zur Abreise, solange kein Meldeschein widerspricht.** Der
 * Meldeschein ist eine Erklaerung des Gastes ueber sich selbst. Wer den
 * Hauptgast austauschte, waehrend am Zimmer ein Meldeschein auf eine andere
 * Person liegt, liesse eine Unterschrift unter einem fremden Namen stehen;
 * das bleibt abgewiesen. Ohne Meldeschein am Zimmer aber gibt es nichts,
 * dem der Wechsel widerspraeche. Genau das ist der Fall der Gruppe: der
 * Gruppencheck-in (#313) checkt alle Zimmer unter dem Namen des Buchers
 * ein, der Sammelmeldeschein haengt an einem Zimmer, und erst am
 * Abreisetag steht fest, wer wo geschlafen hat -- und das muss auf die
 * Rechnung (Sven, 15.10.2026). Bisher war der Wechsel ab dem Check-in
 * gesperrt, und der Gastname des Zimmers liess sich nur noch im Gastprofil
 * aendern, also fuer alle Zimmer des Buchers zugleich.
 *
 * **Nur ohne Rechnung.** Am Folio haengt der Rechnungsempfaenger. Ist
 * fakturiert, steht der Name auf einem Beleg mit Haertegrad 1, und ihn
 * hier stillschweigend umzuschreiben hiesse, den Beleg zu verfaelschen.
 *
 * Der Mitreisendeneintrag wandert mit. Sonst stuende in
 * `reservation_occupant` weiter der Bucher, und die Personenzahl auf dem
 * Meldeschein zaehlte einen Gast, der gar nicht da ist.
 */
async function setzeHauptgast(
  client: PoolClient,
  res: { id: number; property_id: number; status: ReservationStatus },
  guestRef: string
): Promise<string> {
  if (res.status !== 'Inquired' && res.status !== 'Optional'
      && res.status !== 'Confirmed' && res.status !== 'InHouse') {
    throw Errors.conflict('reservation.guestFixedAfterCheckIn',
      { status: res.status })
  }

  // Im Betrieb des Hauses, nicht nur im Kontext (M4, Sicherheitsaudit
  // 2026-10-11): wer in zwei Betrieben arbeitet, saehe sonst beide Gaeste.
  const guestId = await gastPerRefImBetrieb(client, res.property_id, guestRef)

  const gemeldet = await client.query(
    `SELECT 1 FROM registration
      WHERE reservation_id = $1 AND guest_id <> $2 LIMIT 1`, [res.id, guestId])
  if ((gemeldet.rowCount ?? 0) > 0) {
    throw Errors.conflict('reservation.guestOnRegistration')
  }

  const fakturiert = await client.query(
    `SELECT 1 FROM charge c
      WHERE c.reservation_id = $1 AND c.invoice_id IS NOT NULL LIMIT 1`,
    [res.id])
  if (fakturiert.rowCount && fakturiert.rowCount > 0) {
    throw Errors.conflict('reservation.guestFixedAfterInvoice')
  }

  await client.query(
    `UPDATE reservation SET primary_guest_id = $2, updated_at = now()
      WHERE id = $1`, [res.id, guestId])

  // Das Gastfolio traegt den Rechnungsempfaenger. Ein Firmenfolio bleibt
  // unberuehrt -- dort zahlt die Firma, nicht der Gast im Zimmer.
  await client.query(
    `UPDATE folio SET guest_id = $2
      WHERE reservation_id = $1 AND kind = 'guest'`, [res.id, guestId])

  const haupt = await client.query(
    `UPDATE reservation_occupant SET guest_id = $2
      WHERE reservation_id = $1 AND is_primary`, [res.id, guestId])
  if (haupt.rowCount === 0) {
    // Die Zimmer zwei bis fuenf einer Gruppe haben bewusst keinen Eintrag:
    // den Bucher in jedes zu schreiben zaehlte ihn mehrfach. Jetzt, mit
    // einem eigenen Namen, bekommt das Zimmer seinen.
    await client.query(
      `INSERT INTO reservation_occupant
         (property_id, reservation_id, guest_id, is_primary)
       VALUES ($1,$2,$3,true)`, [res.property_id, res.id, guestId])
  }
  return guestRef
}

/** Die Art der Antwort, wenn eine Zimmergruppe ausgebucht ist. */
const SOLD_OUT = 'urn:staygrid:sold_out'

/** Wann die Personenzahl noch geaendert werden darf: vor und waehrend des Aufenthalts. */
const PERSONEN_AENDERBAR: ReadonlySet<ReservationStatus> =
  new Set(['Inquired', 'Optional', 'Confirmed', 'InHouse'])

/** Uebersetzt den Fehlercode der Inventarfunktion in eine saubere Antwort. */
export function inventoryError(code: string | null): never | void {
  if (code === 'sold_out') throw Errors.soldOut()
  if (code === 'not_materialized') throw Errors.notMaterialized()
  if (code !== null) throw Errors.conflict('inventory.unknownError', { code })
}

/**
 * Bestaetigte Ueberbuchung: `inventory_reserve` bindet in dieser
 * Transaktion ohne Obergrenze (Migration 0093).
 *
 * **Warum die Rezeption das darf.** Wer im vollen Haus umsortiert, legt eine
 * Buchung in die Ablage und traegt in die Luecke eine neue ein. Der Zaehler
 * sieht dann zwei Buchungen in einer Gruppe mit einem Zimmer und sagt nein
 * -- zu Recht, nur weiss die Rezeption, dass die abgelegte gleich
 * woandershin kommt (Sven, 06.10.2026: "eine Warnung anzeigen, aber nicht
 * generell verbieten").
 *
 * **Warum nur auf ausdrueckliche Angabe.** Ohne sie antwortet die Route wie
 * bisher mit `sold_out`, und die Oberflaeche fragt nach. Ein Haus, das
 * stillschweigend ueberbucht, merkt es erst am Gast vor dem Tresen.
 */
export async function ueberbuchenErlauben(
  client: PoolClient, erlaubt: unknown
): Promise<void> {
  if (erlaubt === undefined || erlaubt === false) return
  if (erlaubt !== true) {
    throw Errors.validation({ allowOverbooking: ['field.invalid'] })
  }
  await client.query(`SELECT set_config('app.allow_overbooking', 'on', true)`)
}

export async function priceNights(
  client: PoolClient, ratePlanId: number | undefined, nights: string[]
): Promise<number[]> {
  if (!ratePlanId) return nights.map(() => 0)
  const { rows } = await client.query<{ date: string; price_cent: number[] }>(
    `SELECT date::text, price_cent FROM rate_day
      WHERE rate_plan_id = $1 AND date = ANY($2::date[])`, [ratePlanId, nights])
  const byDate = new Map(rows.map(r => [r.date, r.price_cent]))
  return nights.map(n => byDate.get(n)?.[1] ?? byDate.get(n)?.[0] ?? 0)
}

/**
 * `priceNights` fuer mehrere Aufenthalte in einer Abfrage.
 *
 * Eine Gruppe, die wandert, fragte den Ratenplan bisher einmal je Zimmer --
 * meist denselben Plan fuer dieselben Tage. Die Auswahl je Tag ist dieselbe
 * wie dort, damit beide nicht auseinanderlaufen.
 */
async function preiseJePlan(
  client: PoolClient,
  anfragen: ReadonlyArray<{ ratePlanId: number | undefined; nights: readonly string[] }>
): Promise<number[][]> {
  const mitPlan = anfragen.filter(a => a.ratePlanId)
  if (mitPlan.length === 0) return anfragen.map(a => a.nights.map(() => 0))
  const { rows } = await client.query<{ rate_plan_id: number; date: string
                                        price_cent: number[] }>(
    `SELECT rate_plan_id, date::text, price_cent FROM rate_day
      WHERE rate_plan_id = ANY($1::bigint[]) AND date = ANY($2::date[])`,
    [[...new Set(mitPlan.map(a => a.ratePlanId!))],
     [...new Set(mitPlan.flatMap(a => a.nights))]])
  const jeTag = new Map(rows.map(r => [`${r.rate_plan_id}|${r.date}`, r.price_cent]))
  return anfragen.map(a => a.nights.map(n => {
    if (!a.ratePlanId) return 0
    const p = jeTag.get(`${a.ratePlanId}|${n}`)
    return p?.[1] ?? p?.[0] ?? 0
  }))
}

/**
 * Wie viele Personen je Zimmer der Gruppe -- das Gewicht der Aufteilung.
 *
 * **Die Belegung der Zimmergruppe, nicht die erfasste Personenzahl.** Die
 * steht beim Anlegen einer Gruppe noch gar nicht fest: die Namensliste
 * kommt spaeter, oft erst am Anreisetag. Was feststeht, ist das verkaufte
 * Produkt -- ein Doppelzimmer ist fuer zwei verkauft, auch wenn nur ein
 * Name vorliegt.
 *
 * Eine Abfrage fuer alle Zimmer, und nur dann, wenn ein Gruppenpreis
 * aufzuteilen ist. Je Zimmer eine waere bei fuenfzig Zimmern fuenfzigmal
 * dieselbe Antwort.
 *
 * Eine unbekannte Gruppe zaehlt als eine Person statt zu scheitern: ob sie
 * zum Haus gehoert, prueft `inventory_reserve` gleich danach und mit der
 * besseren Fehlermeldung. Hier waere es eine zweite Pruefung derselben
 * Sache, die beim naechsten Umbau auseinanderlaeuft.
 */
async function personenJeZimmer(
  client: PoolClient, zimmer: ReadonlyArray<{ categoryId: number }>
): Promise<Array<{ personen: number }>> {
  const ids = [...new Set(zimmer.map(z => z.categoryId))]
  const { rows } = await client.query<{ id: number; max_occupancy: number }>(
    `SELECT id, max_occupancy FROM resource_category WHERE id = ANY($1::bigint[])`,
    [ids])
  const belegung = new Map(rows.map(r => [r.id, r.max_occupancy]))
  return zimmer.map(z => ({ personen: belegung.get(z.categoryId) ?? 1 }))
}

/**
 * Den vereinbarten Preis auf die offenen Naechte schreiben.
 *
 * Offen heisst: noch nicht auf dem Folio (`posted`). Eine gebuchte Nacht
 * hat einen Beleg, und der wird gegengebucht, nicht umgeschrieben -- ihr
 * Preis bleibt. Ein Gesamtpreis ist der des ganzen Aufenthalts, und auf
 * die offenen Naechte verteilt wird, was nach den gebuchten uebrig bleibt,
 * mit dem Rest-Cent auf der ersten (`preisJeNacht`, wie beim Anlegen).
 *
 * Eine Anweisung fuer alle Naechte, nicht eine je Nacht.
 */
async function preisVereinbaren(
  client: PoolClient, reservationId: number,
  preis: { priceCent?: number; totalCent?: number }
): Promise<void> {
  const { rows } = await client.query<{ date: string; price_cent: string; posted: boolean }>(
    `SELECT date::text, price_cent, posted FROM reservation_night
      WHERE reservation_id = $1 ORDER BY date`, [reservationId])
  const offen = rows.filter(n => !n.posted).map(n => n.date)
  const gebucht = rows.filter(n => n.posted)
    .reduce((s, n) => s + Number(n.price_cent), 0)

  let neu: number[]
  if (preis.priceCent !== undefined) {
    neu = offen.map(() => preis.priceCent!)
  } else {
    const rest = preis.totalCent! - gebucht
    /*
     * Weniger als das schon Gebuchte laesst sich nicht vereinbaren, ohne
     * einen Beleg zu aendern. Ohne offene Nacht laesst sich auch kein
     * anderer Betrag als der gebuchte verteilen. Beides still zu
     * schlucken hiesse, einen Preis anzuzeigen, der nicht gilt.
     */
    if (rest < 0 || (offen.length === 0 && rest !== 0)) {
      throw Errors.unprocessable('stay.totalBelowPosted')
    }
    neu = offen.length === 0 ? [] : preisJeNacht(rest, offen.length)
  }
  if (offen.length === 0) return
  await client.query(
    `UPDATE reservation_night n SET price_cent = x.price
       FROM unnest($2::date[], $3::bigint[]) AS x(date, price)
      WHERE n.reservation_id = $1 AND n.date = x.date AND NOT n.posted`,
    [reservationId, offen, neu])
}

/**
 * Jede Zustandsaktion hat genau eine Ereignisart. Vollstaendig ueber alle
 * Aktionen des Automaten, nicht nur ueber die heute als Route angebotenen:
 * so entscheidet der Typ die Frage mit, sobald eine weitere hinzukommt,
 * statt sie stillschweigend offen zu lassen.
 */
/**
 * Die Logis und Kurtaxe gebuchter Naechte per Gegenbuchung zuruecknehmen.
 *
 * Erkannt wird, was der Nachtlauf bucht: Logis auf 8300 und Abgaben mit
 * Steuerregel, je an dieser Reservierung und an einem ihrer gebuchten
 * Tage. Minibar, Kasse oder eine Gebuehr bleiben stehen; die hat jemand
 * bewusst gebucht, und ob sie fallen, entscheidet ein Mensch am Folio.
 *
 * Steht eine davon schon auf einer Rechnung, wird abgewiesen: dann ist
 * zuerst die Rechnung zu stornieren, sonst fuehrte die Gegenbuchung ein
 * Folio, dessen Rechnung etwas anderes sagt.
 *
 * Die Naechte verlieren danach ihre Marke `posted`. Kommt der Gast doch
 * noch und wird eingecheckt, bucht der Nachtlauf wieder, was ab dann faellt.
 */
async function gebuchteNaechteGegenbuchen(
  client: PoolClient, reservationId: number, propertyId: number, heute: string,
  userId: number | null
): Promise<void> {
  const offen = await client.query<{ id: number; invoice_id: number | null }>(
    `SELECT c.id, c.invoice_id
       FROM charge c
      WHERE c.reservation_id = $1 AND c.reverses_id IS NULL
        AND (c.revenue_account = '8300' OR c.tax_rule_id IS NOT NULL
             OR c.package_part IS NOT NULL)
        AND c.business_date IN (SELECT date FROM reservation_night
                                 WHERE reservation_id = $1 AND posted)
        AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id)
      ORDER BY c.id`,
    [reservationId])
  if (offen.rows.some(c => c.invoice_id !== null)) {
    throw Errors.unprocessable('stay.noShowInvoiced')
  }
  if (offen.rowCount !== 0) {
    await client.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                           revenue_account, product_id, reservation_id, reverses_id,
                           created_by, package_part)
       SELECT $2, c.folio_id, $3::date, 'Storno ' || c.description || ' (nicht angereist)',
              c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
              c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id, $4,
              c.package_part
         FROM charge c WHERE c.id = ANY($1::bigint[])
        ORDER BY c.id`,
      [offen.rows.map(c => c.id), propertyId, heute, userId])
  }
  await client.query(
    `UPDATE reservation_night SET posted = false WHERE reservation_id = $1 AND posted`,
    [reservationId])
}

const EVENT_FOR_ACTION: Record<ReservationAction, WebhookEventType> = {
  confirm:   'reservation.changed',
  hold:      'reservation.changed',
  check_in:  'reservation.checked_in',
  check_out: 'reservation.checked_out',
  cancel:    'reservation.canceled',
  no_show:   'reservation.changed',
  reinstate: 'reservation.changed',
  // Eine eigene Ereignisart braucht es nicht: das Ereignis ist nur das
  // Signal zum Nachfragen, und die Liste zeigt danach `Confirmed` ohne
  // Check-in-Zeit. Ein neuer Typ kaeme bei keinem bestehenden Abonnement an.
  undo_check_in: 'reservation.changed',
  // Aus demselben Grund; das Ereignis traegt `status: InHouse` und die
  // wiederhergestellte Abreise.
  undo_check_out: 'reservation.changed'
}

/** Was ein Check-out an der Reservierung festhaelt (0094). */
interface CheckoutUndo {
  businessDate: string
  departure: string
  nights: Array<{ date: string; priceCent: number; ratePlanId: number | null }>
}

/** Was ein Aufruf von `change-stay` an einem Aufenthalt aendern will. */
export interface AufenthaltAenderung {
  arrival?: string; departure?: string; categoryId?: number; ratePlanId?: number
  /**
   * Das Zimmer, in dem der Aufenthalt danach liegt.
   *
   * Nicht angegeben heisst "bleibt, wo es ist"; `null` nimmt es ab.
   *
   * **Warum es hier steht und nicht in `assign-unit`.** Ein Balken im
   * Plan laesst sich schraeg ziehen -- anderes Zimmer **und** andere
   * Tage --, und genau dann geht es nicht in zwei Schritten: das
   * Zielzimmer ist an den alten Tagen belegt, die alte Zeile an den
   * neuen. Wer zuerst das eine tut, wird abgewiesen, und wer zuerst das
   * andere tut, auch. Die Luecke, in die der Gast soll, ist nur
   * diagonal erreichbar.
   *
   * Beides in einem Aufruf ist ausserdem das Richtige, nicht nur das
   * Bequeme: zwischen zwei Aufrufen laege ein Zustand, den niemand
   * gewollt hat -- das neue Zimmer an den alten Tagen oder das alte an
   * den neuen --, und schlaegt der zweite fehl, bleibt er stehen.
   */
  resourceId?: number | null
  /**
   * Ein vereinbarter Preis statt des gerechneten: je Nacht **oder** fuer
   * den ganzen Aufenthalt, wie beim Anlegen (`CreateBooking`).
   *
   * Er gilt nur fuer die Naechte, die noch nicht auf dem Folio stehen.
   * Eine gebuchte Nacht hat einen Beleg, und der wird gegengebucht, nicht
   * umgeschrieben. Ein Gesamtpreis meint deshalb den ganzen Aufenthalt
   * **einschliesslich** der gebuchten Naechte -- so steht er auch in der
   * Reservierung --, und aufgeteilt wird nur, was nach ihnen uebrig ist.
   */
  priceCent?: number
  totalCent?: number
}

export interface AufenthaltVerlegt {
  reservationRef: string; arrival: string; departure: string; categoryId: number
  roomAssignmentCleared: boolean; nights: number; removedNights: number
  totalCent: number
}

/**
 * Einen Aufenthalt verlegen: die Rechnung hinter `change-stay`.
 *
 * Die Route daneben ist nur noch die Huelle darum. Zwei Fassungen derselben
 * Rechnung -- eine fuer einzeln, eine fuer die Gruppe -- waeren die
 * zuverlaessigste Art, den Bestandszaehler auseinanderlaufen zu lassen.
 * Deshalb ist der einzelne Aufenthalt eine Gruppe aus einem.
 */
export async function aufenthaltVerlegen(
  client: PoolClient, ref: string, body: AufenthaltAenderung
): Promise<AufenthaltVerlegt> {
  return (await aufenthalteVerlegen(client, [{ ref, body }]))[0]!
}

interface AufenthaltZeile {
  id: number; public_ref: string; property_id: number; category_id: number
  status: ReservationStatus; arrival: string; departure: string
  resource_id: number | null; rate_plan_id: number | null; block_id: number | null
  /** Zimmerwechsel im Aufenthalt (0195); dann das Zimmer und der Beginn des letzten Abschnitts. */
  room_moved: boolean; last_room: number | null; last_from: string | null
}

/** Was nach den Pruefungen ohne Datenbank fuer einen Aufenthalt feststeht. */
interface VerlegungsPlan {
  r: AufenthaltZeile; body: AufenthaltAenderung
  neuAnkunft: string; neuAbreise: string; neuKategorie: number
  zeitraumAnders: boolean; zielZimmer: number | null
}

/**
 * Die Pruefungen eines Aufenthalts, die keine Datenbank brauchen -- in der
 * Reihenfolge, in der sie bisher geworfen haben.
 */
function verlegungPlanen(
  r: AufenthaltZeile | undefined, body: AufenthaltAenderung
): VerlegungsPlan {
  if (r === undefined) throw Errors.notFound('res.reservation')

  if (!occupiesInventory(r.status)) {
    throw Errors.conflict(
      'stay.statusHoldsNoInventory', { status: r.status })
  }

  const neuAnkunft = body.arrival ?? r.arrival
  const neuAbreise = body.departure ?? r.departure
  const neuKategorie = body.categoryId ?? r.category_id
  if (!isIsoDate(neuAnkunft) || !isIsoDate(neuAbreise)) {
    throw Errors.validation({ arrival: ['field.isoDate'] })
  }
  const neueNaechte = nightsBetween(neuAnkunft, neuAbreise)
  if (neueNaechte <= 0) {
    throw Errors.validation({ departure: ['field.afterArrival'] })
  }
  if (neueNaechte > MAX_STAY_NIGHTS) {
    throw Errors.validation({ departure: ['field.stayTooLong'] }, { max: MAX_STAY_NIGHTS })
  }
  // Bei InHouse ist die Anreise geschehen und nicht mehr verschiebbar.
  if (r.status === 'InHouse' && neuAnkunft !== r.arrival) {
    throw Errors.conflict('stay.inHouseArrivalFixed')
  }
  const zeitraumAnders = neuAnkunft !== r.arrival || neuAbreise !== r.departure
  /*
   * Die Buchung wandert, wenn Tage oder gebuchte Gruppe es tun. Wer in
   * der Maske nur den Preis oder das Zimmer aendert, laesst sie liegen --
   * und dann ist auch ein Abruf aus einem Kontingent kein Hindernis. Der
   * Zaehler kann trotzdem wandern, wenn das neue Zimmer in einer anderen
   * Gruppe liegt (unten).
   */
  const bestandAnders = zeitraumAnders || neuKategorie !== r.category_id

  /*
   * Ein Abruf laeuft ueber den Zeitraum seines Kontingents. Waere er
   * verschiebbar, stimmte die Rechnung beim Freigeben des Rests nicht
   * mehr: sie geht ueber den Zeitraum des Kontingents, nicht den der
   * einzelnen Reservierung. Wer anders buchen will, storniert den Abruf
   * und legt eine freie Reservierung an.
   */
  if (r.block_id !== null && bestandAnders) {
    throw Errors.conflict(
      'stay.pickupNotMovable')
  }
  /*
   * **Ein Aufenthalt mit Zimmerwechsel (0195) wandert nur am Ende.**
   *
   * Verlaengern und Kuerzen gehen, die letzten Naechte gehoeren dem
   * letzten Zimmer. Anreise, Gruppe und Zimmer aber haengen an den
   * Abschnitten: eine Anreise einen Tag frueher -- in welches der beiden
   * Zimmer? Eine neue Gruppe -- fuer welchen Teil? Statt zu raten weist die
   * Route ab und nennt den Weg: den Wechsel zuruecknehmen oder ein neuer
   * Wechsel. Als Zimmer gilt das heutige wie das letzte: der Plan schickt
   * das Zimmer des Balkens mit, den man am Ende gezogen hat.
   */
  if (r.room_moved) {
    if (neuAnkunft !== r.arrival) throw Errors.conflict('stay.roomMovedArrivalFixed')
    if (neuKategorie !== r.category_id
        || (body.resourceId !== undefined && body.resourceId !== r.resource_id
            && body.resourceId !== r.last_room)) {
      throw Errors.conflict('stay.roomMovedUseMove')
    }
  }
  /*
   * Das Zimmer danach. Bei einem Kategoriewechsel **ohne** ausdrueckliche
   * Angabe faellt es weg: es gehoerte zur alten Gruppe, und die
   * Hausliste zeigte sonst ein Zimmer der falschen. Wer beim Wechsel ein
   * Zimmer nennt, bekommt es -- das ist der Fall "Gast bleibt laenger,
   * seine Gruppe ist ausgebucht, eine andere hat noch ein Zimmer".
   */
  const zielZimmer = body.resourceId !== undefined
    ? body.resourceId
    : (neuKategorie === r.category_id ? r.resource_id : null)

  // Der angereiste Gast liegt im Zimmer. Die Zeile im Plan zu leeren
  // hiesse, Hausliste und Reinigung auf ein leeres Zimmer zu schicken,
  // in dem jemand schlaeft (dieselbe Regel wie in `assign-unit`).
  if (zielZimmer === null && r.resource_id !== null && r.status === 'InHouse') {
    throw Errors.conflict('stay.inHouseKeepsRoom')
  }
  return { r, body, neuAnkunft, neuAbreise, neuKategorie, zeitraumAnders, zielZimmer }
}

/**
 * Mehrere Aufenthalte verlegen, zusammen und in einer festen Zahl von
 * Anweisungen.
 *
 * **Warum es mehrere sind.** Wer eine Gruppenbuchung in der Zeit
 * verschiebt, verschiebt acht Aufenthalte, und die muessen zusammen
 * gelingen oder zusammen scheitern -- stoesst das fuenfte Zimmer an eine
 * fremde Reservierung, darf nicht die Haelfte der Gruppe eine Woche weiter
 * liegen als die andere. Deshalb nimmt die Funktion den `client` entgegen
 * und oeffnet keine eigene Transaktion: die Klammer setzt der Aufrufer.
 *
 * **Warum nicht mehr je Aufenthalt** (Performance-Audit 11.10.2026,
 * Abschnitt 14). Bisher lief dieselbe Rechnung einmal je Zimmer, rund
 * fuenfzehn Anweisungen jedes Mal; eine Gruppe mit fuenfzig Zimmern kam auf
 * 750. Jetzt ist jeder Schritt eine Anweisung fuer alle.
 *
 * **Dasselbe Ergebnis wie die Schleife**, und das ist der Teil, der Sorgfalt
 * braucht. Die Schleife verlegte Zimmer um Zimmer, und jedes sah die vor
 * ihm schon verlegten. Zwei Stellen haengen davon ab, und beide werden
 * nachgebildet statt vereinfacht:
 *
 * - Ob ein Zimmer frei ist, beantwortet `zimmerFehler` mit den frueheren
 *   Aufenthalten am neuen und den spaeteren am alten Platz.
 * - Der Bestand wandert mit `inventory_move` je Aufenthalt, in der
 *   Reihenfolge der Anfrage, nur in einer Anweisung statt in vielen. Ein
 *   Sammelaufruf, der den Saldo bucht, waere bei voller Gruppe grosszuegiger
 *   -- und an `inventory_day` aendert nur eine Funktion etwas.
 *
 * Gemeldet wird der Fehler, den die Schleife zuerst getroffen haette: der
 * des ersten Aufenthalts, der scheitert, und darin die erste Pruefung.
 * Einzige Ausnahme ist der vereinbarte Preis (`stay.totalBelowPosted`): er
 * wird nach allen Verlegungen geprueft, nicht nach seiner eigenen. Einen
 * Preis gibt nur der einzelne Aufruf mit, die Gruppe nie; bei einem
 * Aufenthalt ist die Reihenfolge dieselbe.
 */
export async function aufenthalteVerlegen(
  client: PoolClient,
  auftraege: ReadonlyArray<{ ref: string; body: AufenthaltAenderung }>
): Promise<AufenthaltVerlegt[]> {
  if (auftraege.length === 0) return []
  if (new Set(auftraege.map(a => a.ref)).size !== auftraege.length) {
    // Die Schleife haette denselben Aufenthalt zweimal verlegt, das zweite
    // Mal vom ersten aus. Kein Aufrufer tut das; nachgebildet wird es nicht.
    throw new Error('aufenthalteVerlegen: derselbe Aufenthalt zweimal')
  }

  /*
   * **Zimmerwechsel (0195): nur einzeln, und ein geplanter Wechsel nach dem
   * neuen Ende faellt weg.** Reist der Gast am Dienstag ab, zieht er am
   * Donnerstag nicht mehr in die Suite -- das gilt fuer den vorzeitigen
   * Check-out wie fuer das Kuerzen von Hand. Ein vollzogener Wechsel bleibt:
   * die Naechte im alten Zimmer hat der Gast geschlafen, und wer davor
   * kuerzen will, nimmt erst den Wechsel zurueck.
   *
   * In der Gruppe nicht: die Gruppenverlegung schiebt alle Zimmer um
   * dieselben Tage, und ein geteilter Aufenthalt wandert nur am Ende.
   */
  const geteilt = await client.query<{ id: number; property_id: number; departure: string }>(
    `SELECT id, property_id, departure::text FROM reservation
      WHERE public_ref = ANY($1::text[]) AND room_moved
      ORDER BY id FOR UPDATE`, [auftraege.map(a => a.ref)])
  if (geteilt.rows.length > 0 && auftraege.length > 1) {
    throw Errors.conflict('stay.roomMovedInGroup')
  }
  const kuerzer = auftraege[0]!.body.departure
  if (geteilt.rows.length > 0 && kuerzer !== undefined && isIsoDate(kuerzer)
      && kuerzer < geteilt.rows[0]!.departure) {
    const g = geteilt.rows[0]!
    const heute = await geschaeftstag(client, g.property_id)
    await client.query(`SELECT reservation_room_trim($1, $2::date, $3::date)`,
                       [g.id, kuerzer, heute])
    const rest = await client.query<{ ab: string | null; datum: string | null }>(
      `SELECT max(from_date)::text AS ab, to_char(max(from_date), 'DD.MM.YYYY') AS datum
         FROM reservation_room_part WHERE reservation_id = $1`, [g.id])
    const ab = rest.rows[0]?.ab ?? null
    if (ab !== null && kuerzer < ab) {
      throw Errors.conflict('stay.roomMovedEndsBefore', { date: rest.rows[0]!.datum! })
    }
  }

  // Gesperrt in der Reihenfolge der ids, wie die Gruppenroute es tut: zwei
  // Vorgaenge, die dieselben Zeilen in verschiedener Reihenfolge sperren,
  // blockieren einander.
  const cur = await client.query<AufenthaltZeile>(
    `SELECT r.id, r.public_ref, r.property_id, r.category_id, r.status, r.arrival::text,
            r.departure::text, r.resource_id, r.rate_plan_id, r.block_id, r.room_moved,
            lp.resource_id AS last_room, lp.from_date::text AS last_from
       FROM reservation r
       LEFT JOIN LATERAL (
              SELECT p.resource_id, p.from_date FROM reservation_room_part p
               WHERE p.reservation_id = r.id AND r.room_moved
               ORDER BY p.from_date DESC LIMIT 1) lp ON true
      WHERE r.public_ref = ANY($1::text[])
      ORDER BY r.id FOR UPDATE OF r`, [auftraege.map(a => a.ref)])
  const nachRef = new Map(cur.rows.map(r => [r.public_ref, r]))

  // Erst alles, was ohne Datenbank feststeht. Was davon zuerst scheitert,
  // gilt erst, wenn kein frueherer Aufenthalt an der Datenbank scheitert.
  const plaene: VerlegungsPlan[] = []
  let planFehler: AppError | null = null
  for (const a of auftraege) {
    try {
      plaene.push(verlegungPlanen(nachRef.get(a.ref), a.body))
    } catch (e) {
      if (!(e instanceof AppError)) throw e
      planFehler = e
      break
    }
  }

  /*
   * Gehoert die neue Gruppe zum Haus, und in welcher Gruppe zaehlt der
   * Aufenthalt vorher und nachher? Eine Anweisung fuer alle.
   *
   * **Gezaehlt wird in der Gruppe des Zimmers** (Migration 0120). Eine
   * Buchung im fremden Zimmer haelt dessen Gruppe, nicht die gebuchte;
   * ohne Zimmer die gebuchte. Der Bestand wird deshalb in genau diesen
   * Gruppen bewegt -- vorher in der des alten Zimmers, danach in der des
   * neuen --, damit die Frage "ist dort Platz?" an der Gruppe gestellt
   * wird, in der der Gast danach liegt. Der Trigger, der das sonst fuer
   * jede Aenderung nachzieht, laesst die Anweisung unten aus.
   */
  const gruppen = plaene.length === 0 ? [] : (await client.query<{
    ord: number; kategorie_ok: boolean; alt: number | null; neu: number | null }>(
    `SELECT x.ord,
            EXISTS (SELECT 1 FROM resource_category c
                     WHERE c.id = x.kategorie AND c.property_id = x.haus) AS kategorie_ok,
            (SELECT category_id FROM resource WHERE id = x.alt) AS alt,
            (SELECT category_id FROM resource WHERE id = x.neu) AS neu
       FROM unnest($1::int[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[])
         AS x(ord, kategorie, haus, alt, neu)
      ORDER BY x.ord`,
    [plaene.map((_, i) => i), plaene.map(p => p.neuKategorie),
     // Ein geteilter Aufenthalt wandert nur am Ende, also in der Gruppe
     // seines letzten Zimmers -- vorher wie nachher.
     plaene.map(p => p.r.property_id),
     plaene.map(p => p.r.room_moved ? p.r.last_room : p.r.resource_id),
     plaene.map(p => p.r.room_moved ? p.r.last_room : p.zielZimmer)])).rows

  /*
   * **Das zugewiesene Zimmer muss im neuen Zeitraum auch frei sein.**
   *
   * Das fehlte hier einmal, und es fiel nicht auf, weil der Bestandszaehler
   * je Zimmergruppe rechnet und nicht je Zimmer: eine Verlaengerung um drei
   * Naechte war rechnerisch in Ordnung, solange die Gruppe noch Platz
   * hatte -- auch wenn in genau diesem Zimmer laengst jemand anders lag.
   * Bemerkt haette es die Rezeption am Anreisetag.
   *
   * Beim Verschieben einer ganzen Gruppe waere das der Normalfall
   * geworden, nicht der Sonderfall: acht Balken wandern ueber den Plan
   * und landen auf dem, was dort schon liegt.
   *
   * Geprueft wird das Zimmer, in dem der Aufenthalt **danach** liegt,
   * und nur dann, wenn sich daran etwas aendert: dieselbe Zeile an
   * denselben Tagen braucht keine Frage.
   */
  const fragen: ZimmerFrage[] = plaene.flatMap((p, i) =>
    // Beim geteilten Aufenthalt nur der letzte Abschnitt: davor liegt er in
    // anderen Zimmern, und die aendern sich nicht.
    p.r.room_moved && p.r.last_room !== null && p.r.last_from !== null
      ? (p.zeitraumAnders && p.neuAbreise > p.r.last_from
          ? [{ ord: i, resourceId: p.r.last_room, propertyId: p.r.property_id,
               arrival: p.r.last_from, departure: p.neuAbreise,
               exceptReservationId: p.r.id }]
          : [])
    : p.zielZimmer !== null && (p.zeitraumAnders || p.zielZimmer !== p.r.resource_id)
      ? [{ ord: i, resourceId: p.zielZimmer, propertyId: p.r.property_id,
           arrival: p.neuAnkunft, departure: p.neuAbreise, exceptReservationId: p.r.id }]
      : [])
  const mitVerlegt: MitVerlegt[] = fragen.length === 0 ? [] : auftraege.flatMap((a, i) => {
    const r = nachRef.get(a.ref)
    if (r === undefined) return []
    const p = plaene[i]
    return [{ ord: i, id: r.id, status: r.status, altZimmer: r.resource_id,
              altAnkunft: r.arrival, altAbreise: r.departure,
              neuZimmer: p?.zielZimmer ?? null, neuAnkunft: p?.neuAnkunft ?? null,
              neuAbreise: p?.neuAbreise ?? null }]
  })
  const zimmerAntwort = new Map<number, AppError | null>()
  ;(await zimmerFehler(client, fragen, mitVerlegt))
    .forEach((f, j) => zimmerAntwort.set(fragen[j]!.ord, f))

  // Der erste Aufenthalt, der an der Datenbank scheitert, und woran.
  let pruefFehler: { i: number; fehler: AppError } | null = null
  for (const [i, p] of plaene.entries()) {
    let f: AppError | null = p.neuKategorie !== p.r.category_id && !gruppen[i]!.kategorie_ok
      ? Errors.notFound('res.category') : null
    // Der Ratenplan aus dem Rumpf gehoert zu diesem Haus, in derselben
    // Reihenfolge wie bisher: nach der Kategorie, vor dem Zimmer. Die
    // Fremdschluesselpruefung sieht an der Zeilenrichtlinie vorbei, und ein
    // Plan des Nachbarhauses setzte sonst still seine Preise ein (M4,
    // Sicherheitsaudit 2026-10-11). Nur wer einen Plan mitschickt, kostet
    // eine Abfrage -- die Gruppenverlegung schickt keinen.
    if (f === null && p.body.ratePlanId !== undefined) {
      try {
        await ratenplanImHaus(client, p.r.property_id, p.body.ratePlanId)
      } catch (e) {
        if (!(e instanceof AppError)) throw e
        f = e
      }
    }
    f ??= zimmerAntwort.get(i) ?? null
    if (f !== null) { pruefFehler = { i, fehler: f }; break }
  }
  // Bis hierher kaeme die Schleife mit dem Bestand.
  const bisBestand = pruefFehler?.i ?? plaene.length

  /*
   * Vorab gebuchte Naechte (0176) fallen nicht still aus dem Aufenthalt.
   * Weggenommen werden unten nur ungebuchte; eine gebuchte Nacht ab heute
   * ausserhalb des neuen Zeitraums stuende danach im Folio, ohne dass der
   * Gast sie schlaeft. Erst zuruecknehmen, dann kuerzen. Gebuchte Naechte
   * vor heute bleiben wie bisher: sie hat der Gast geschlafen.
   */
  if (pruefFehler === null) {
    const voraus = await client.query<{ ab: string }>(
      `SELECT to_char(min(n.date), 'DD.MM.YYYY') AS ab
         FROM unnest($1::bigint[], $2::date[], $3::date[]) AS x(id, arrival, departure)
         JOIN reservation_night n ON n.reservation_id = x.id AND n.posted
                                 AND (n.date < x.arrival OR n.date >= x.departure)
        WHERE n.date >= (SELECT COALESCE(max(b.date), current_date) FROM business_day b
                          WHERE b.property_id = n.property_id)
       HAVING count(*) > 0`,
      [plaene.map(p => p.r.id), plaene.map(p => p.neuAnkunft), plaene.map(p => p.neuAbreise)])
    if (voraus.rowCount !== 0) {
      throw Errors.unprocessable('stay.postedAhead', { date: voraus.rows[0]!.ab })
    }
  }

  /*
   * Mit dem Zimmer dazu: an Tagen, an denen es als andere Kategorie verkauft
   * wird (0197), zaehlt der Aufenthalt dort, nicht in der Gruppe des
   * Zimmers. `inventory_move_by_room` rechnet das je Tag und ist ohne einen
   * solchen Tag `inventory_move`.
   */
  const zaehlt = plaene.map((p, i) => ({
    vorher: gruppen[i]!.alt ?? p.r.category_id,
    danach: gruppen[i]!.neu ?? p.neuKategorie,
    zimmerVorher: p.r.room_moved ? p.r.last_room : p.r.resource_id,
    zimmerDanach: p.r.room_moved ? p.r.last_room : p.zielZimmer
  }))
  const zuBewegen = plaene.slice(0, bisBestand).flatMap((p, i) =>
    // Ein anderes Zimmer derselben Gruppe kann an einem Tag anderswo zaehlen
    // (0197); ohne einen solchen Tag ist der Aufruf ein Nichts.
    p.zeitraumAnders || zaehlt[i]!.vorher !== zaehlt[i]!.danach
      || zaehlt[i]!.zimmerVorher !== zaehlt[i]!.zimmerDanach ? [i] : [])
  if (zuBewegen.length > 0) {
    /*
     * Ein `inventory_move` je Aufenthalt, nacheinander in der Reihenfolge
     * von `unnest` -- dieselben Aufrufe wie in der Schleife, nur in einer
     * Anweisung. Scheitert einer, laufen die folgenden noch mit; ihre
     * Antwort zaehlt nicht, und die Transaktion rollt ohnehin zurueck.
     */
    const inv = await client.query<{ ord: number; e: string | null }>(
      `SELECT x.ord,
              inventory_move_by_room(x.haus, x.vk, x.vz, x.va, x.vd, x.nk, x.nz, x.na, x.nd) AS e
         FROM unnest($1::int[], $2::bigint[], $3::bigint[], $4::date[], $5::date[],
                     $6::bigint[], $7::date[], $8::date[], $9::bigint[], $10::bigint[])
           AS x(ord, haus, vk, va, vd, nk, na, nd, vz, nz)`,
      [zuBewegen, zuBewegen.map(i => plaene[i]!.r.property_id),
       zuBewegen.map(i => zaehlt[i]!.vorher), zuBewegen.map(i => plaene[i]!.r.arrival),
       zuBewegen.map(i => plaene[i]!.r.departure), zuBewegen.map(i => zaehlt[i]!.danach),
       zuBewegen.map(i => plaene[i]!.neuAnkunft), zuBewegen.map(i => plaene[i]!.neuAbreise),
       zuBewegen.map(i => zaehlt[i]!.zimmerVorher), zuBewegen.map(i => zaehlt[i]!.zimmerDanach)])
    const ersterFehler = [...inv.rows].sort((a, b) => a.ord - b.ord).find(x => x.e !== null)
    if (ersterFehler) inventoryError(ersterFehler.e)
  }
  if (pruefFehler !== null) throw pruefFehler.fehler
  if (planFehler !== null) throw planFehler

  const ids = plaene.map(p => p.r.id)

  /*
   * Was eine neue Nacht kostet: der Durchschnitt der Naechte, die der
   * Aufenthalt schon hat (Sven, 05.10.2026).
   *
   * Gemeint ist der Preis, zu dem der Gast gebucht hat -- und der steht in
   * seinen Naechten, nicht im Ratenplan. Der Plan kann sich seit der
   * Buchung geaendert haben, ein Preis kann von Hand vereinbart sein, und
   * eine Buchung aus dem Altsystem hat gar keinen Plan: dort kostete jede
   * neue Nacht null Euro, ohne dass es irgendwo auffiel. Bei gleichen
   * Naechten ist der Schnitt genau dieser Preis.
   *
   * Der Ratenplan gilt nur noch, wo es keinen bisherigen Preis gibt, oder
   * wenn der Aufruf ausdruecklich einen anderen Plan nennt -- dann ist ein
   * neuer Preis gemeint und kein alter.
   *
   * Vor dem Loeschen gerechnet: wer den Aufenthalt ganz verschiebt,
   * behaelt danach keine seiner alten Naechte, und der Preis waere weg.
   */
  const schnitt = await client.query<{ reservation_id: number; p: string }>(
    `SELECT reservation_id, round(avg(price_cent))::bigint AS p
       FROM reservation_night WHERE reservation_id = ANY($1::bigint[])
      GROUP BY reservation_id`, [ids])
  const bisherJeNacht = new Map(schnitt.rows.map(s => [Number(s.reservation_id), Number(s.p)]))

  await client.query(`SELECT set_config('app.inventory_by_room', 'on', true)`)
  await client.query(
    `UPDATE reservation r
        SET arrival = x.arrival, departure = x.departure, category_id = x.category_id,
            rate_plan_id = COALESCE(x.rate_plan_id, r.rate_plan_id),
            resource_id = x.resource_id,
            updated_at = now()
       FROM unnest($1::bigint[], $2::date[], $3::date[], $4::bigint[], $5::bigint[],
                   $6::bigint[])
         AS x(id, arrival, departure, category_id, rate_plan_id, resource_id)
      WHERE r.id = x.id`,
    [ids, plaene.map(p => p.neuAnkunft), plaene.map(p => p.neuAbreise),
     plaene.map(p => p.neuKategorie), plaene.map(p => p.body.ratePlanId ?? null),
     plaene.map(p => p.zielZimmer)])
  await client.query(`SELECT set_config('app.inventory_by_room', '', true)`)

  /*
   * Naechte fortschreiben. Bereits gebuchte Naechte bleiben unberuehrt:
   * an ihnen haengen Belege, und `posted` sagt, dass die Logis schon
   * auf dem Folio steht. Entfernt werden nur ungebuchte Naechte
   * ausserhalb des neuen Zeitraums.
   */
  const entfernt = await client.query<{ reservation_id: number }>(
    `DELETE FROM reservation_night n
      USING unnest($1::bigint[], $2::date[], $3::date[]) AS x(id, arrival, departure)
      WHERE n.reservation_id = x.id AND NOT n.posted
        AND (n.date < x.arrival OR n.date >= x.departure)
      RETURNING n.reservation_id`,
    [ids, plaene.map(p => p.neuAnkunft), plaene.map(p => p.neuAbreise)])
  const entferntJe = new Map<number, number>()
  for (const e of entfernt.rows) {
    const id = Number(e.reservation_id)
    entferntJe.set(id, (entferntJe.get(id) ?? 0) + 1)
  }

  const naechte = plaene.map(p => eachNight(p.neuAnkunft, p.neuAbreise))
  const planIds = plaene.map(p => p.body.ratePlanId ?? p.r.rate_plan_id ?? undefined)
  const ausPlan = plaene.map(p =>
    !(p.body.ratePlanId === undefined && bisherJeNacht.has(p.r.id)))
  const planPreise = await preiseJePlan(client,
    plaene.flatMap((_, i) => ausPlan[i] ? [{ ratePlanId: planIds[i], nights: naechte[i]! }] : []))
  let k = 0
  const preise = plaene.map((p, i) => ausPlan[i]
    ? planPreise[k++]!
    : naechte[i]!.map(() => bisherJeNacht.get(p.r.id)!))
  // Eine Anweisung fuer alle Naechte aller Aufenthalte (Performanceaudit).
  await client.query(
    `INSERT INTO reservation_night
       (reservation_id, property_id, date, rate_plan_id, price_cent)
     SELECT x.reservation_id, x.property_id, x.date, x.rate_plan_id, x.price
       FROM unnest($1::bigint[], $2::bigint[], $3::date[], $4::bigint[], $5::bigint[])
         AS x(reservation_id, property_id, date, rate_plan_id, price)
     ON CONFLICT (reservation_id, date) DO NOTHING`,
    [plaene.flatMap((p, i) => naechte[i]!.map(() => p.r.id)),
     plaene.flatMap((p, i) => naechte[i]!.map(() => p.r.property_id)),
     naechte.flat(),
     plaene.flatMap((_, i) => naechte[i]!.map(() => planIds[i] ?? null)),
     preise.flat()])

  for (const p of plaene) {
    if (p.body.priceCent !== undefined || p.body.totalCent !== undefined) {
      await preisVereinbaren(client, p.r.id,
        { priceCent: p.body.priceCent, totalCent: p.body.totalCent })
    }
  }

  const summe = await client.query<{ reservation_id: number; n: number; total: string }>(
    `SELECT reservation_id, count(*)::int AS n, COALESCE(sum(price_cent),0)::bigint AS total
       FROM reservation_night WHERE reservation_id = ANY($1::bigint[])
      GROUP BY reservation_id`, [ids])
  const summeJe = new Map(summe.rows.map(s =>
    [Number(s.reservation_id), { n: s.n, total: Number(s.total) }]))

  const ergebnis = plaene.map(p => {
    const s = summeJe.get(p.r.id) ?? { n: 0, total: 0 }
    return {
      reservationRef: p.r.public_ref,
      arrival: p.neuAnkunft,
      departure: p.neuAbreise,
      categoryId: p.neuKategorie,
      // Beim Kategoriewechsel faellt die Zimmerzuweisung weg und muss
      // neu erfolgen. Das gehoert in die Antwort, nicht in eine Fussnote.
      roomAssignmentCleared: p.zielZimmer === null && p.r.resource_id !== null,
      nights: s.n,
      removedNights: entferntJe.get(p.r.id) ?? 0,
      totalCent: s.total
    }
  })

  // Ein Ereignis je Aufenthalt, wie bisher, eingereiht in einer Anweisung.
  // Je Haus eine, falls Aufenthalte verschiedener Haeuser zusammenkommen.
  for (const haus of new Set(plaene.map(p => p.r.property_id))) {
    await emitEvents(client, haus, 'reservation.changed',
      plaene.flatMap((p, i) => p.r.property_id !== haus ? [] : [{
        reservationRef: p.r.public_ref, status: p.r.status,
        arrival: p.neuAnkunft, departure: p.neuAbreise,
        categoryId: p.neuKategorie,
        // Das Zimmer gehoert in das Ereignis, seit diese Route es aendern
        // kann: ein Empfaenger, der nur `assign-unit` beachtet, saehe den
        // Umzug sonst nicht.
        resourceId: p.zielZimmer,
        previousArrival: p.r.arrival, previousDeparture: p.r.departure,
        previousCategoryId: p.r.category_id,
        nights: ergebnis[i]!.nights,
        totalCent: ergebnis[i]!.totalCent
      }]))
  }

  return ergebnis
}

export function reservationRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/bookings',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Buchung mit einem oder mehreren Zimmern anlegen',
    handler: async (req, reply) => {
      const body = req.body as CreateBooking
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      if (!isIsoDate(body.arrival) || !isIsoDate(body.departure)) {
        throw Errors.validation({ arrival: ['field.isoDate'] })
      }
      if (body.channelCode !== undefined
          && (typeof body.channelCode !== 'string' || body.channelCode.length > 50)) {
        throw Errors.validation({ channelCode: ['field.invalid'] })
      }
      const naechte = nightsBetween(body.arrival, body.departure)
      if (naechte <= 0) {
        throw Errors.validation({ departure: ['field.afterArrival'] })
      }
      if (naechte > MAX_STAY_NIGHTS) {
        throw Errors.validation({ departure: ['field.stayTooLong'] }, { max: MAX_STAY_NIGHTS })
      }

      /*
       * Eine Option ohne Frist verfaellt nie.
       *
       * Der Nachtlauf sucht `status = 'Optional' AND option_expires_at <
       * ...` (nightAudit.ts). Eine Option ohne Frist faellt durch diese
       * Bedingung und haelt ihren Platz fuer immer -- ohne Fehlermeldung,
       * und in einem vollen Haus ist das genau der Bestand, der fehlt.
       * Deshalb hier Pflicht und nicht mit einer stillen Vorgabe gefuellt:
       * wie lange ein Haus eine Option haelt, weiss das Haus, nicht wir.
       */
      if (body.status === 'Optional') {
        if (body.optionExpiresAt === undefined
            || Number.isNaN(Date.parse(body.optionExpiresAt))) {
          throw Errors.validation({ optionExpiresAt: ['field.requiredForOption'] })
        }
      } else if (body.optionExpiresAt !== undefined) {
        // Eine Frist an einer verbindlichen Buchung waere eine Angabe, die
        // niemand liest und die beim naechsten Statuswechsel plötzlich wirkt.
        throw Errors.validation({ optionExpiresAt: ['field.onlyForOption'] })
      }

      const personen = personenAngabe(body)
      if (body.priceCent !== undefined
          && (!Number.isInteger(body.priceCent) || body.priceCent < 0)) {
        throw Errors.validation({ priceCent: ['field.positiveInteger'] })
      }
      if (body.totalCent !== undefined
          && (!Number.isInteger(body.totalCent) || body.totalCent < 0)) {
        throw Errors.validation({ totalCent: ['field.positiveInteger'] })
      }
      /*
       * Beides zugleich ist keine Angabe, sondern eine Frage.
       *
       * Einen der beiden stillschweigend gewinnen zu lassen waere die
       * bequeme Loesung und die schlechtere: der Anrufer glaubt dann, den
       * anderen gesetzt zu haben, und merkt es erst an der Rechnung. Das
       * gilt fuer die Oberflaeche wie fuer die Schnittstelle -- in der
       * Maske rechnet das eine Feld das andere aus, und gesendet wird
       * genau eines.
       */
      if (body.priceCent !== undefined && body.totalCent !== undefined) {
        throw Errors.validation({ totalCent: ['field.eitherPriceOrTotal'] })
      }
      if (body.shortNote !== undefined
          && body.shortNote.length > SHORT_NOTE_MAX_LENGTH) {
        throw Errors.validation({ shortNote: ['field.maxLength'] },
          { max: SHORT_NOTE_MAX_LENGTH })
      }

      /*
       * Ein Weg fuer beide Faelle.
       *
       * Die Einzelbuchung ist von hier an die Gruppenbuchung mit einem
       * Zimmer. Das ist nicht Sparsamkeit, sondern die Stelle, an der sonst
       * zwei Pfade entstuenden, die auseinanderlaufen: die Zimmerpruefung,
       * die Preisermittlung, das Folio und das Ereignis muessten zweimal
       * dastehen, und die zweite Fassung wuerde beim naechsten Befund
       * vergessen.
       */
      if (body.rooms !== undefined && body.categoryId !== undefined) {
        throw Errors.validation({ rooms: ['field.eitherCategoryOrRooms'] })
      }
      if (body.rooms === undefined && body.categoryId === undefined) {
        throw Errors.validation({ categoryId: ['field.required'] })
      }
      const zimmer: CreateBookingRoom[] = body.rooms
        ?? [{ categoryId: body.categoryId!, resourceId: body.resourceId }]

      if (zimmer.length === 0) throw Errors.validation({ rooms: ['field.atLeastOneRoom'] })
      if (zimmer.length > GRUPPE_MAX_ZIMMER) {
        throw Errors.validation({ rooms: ['field.tooManyRooms'] },
          { max: GRUPPE_MAX_ZIMMER })
      }
      if (zimmer.some(z => !Number.isInteger(z.categoryId))) {
        throw Errors.validation({ categoryId: ['field.required'] })
      }
      // Dasselbe Zimmer zweimal in einer Gruppe waere eine Doppelbelegung,
      // die keine Pruefung spaeter noch abfaengt: `assertUnitAssignable`
      // sieht nur, was in der Datenbank steht, und die zweite Reservierung
      // dieser Anfrage steht dort noch nicht.
      const belegt = zimmer.map(z => z.resourceId).filter(r => r !== undefined)
      if (new Set(belegt).size !== belegt.length) {
        throw Errors.validation({ rooms: ['field.duplicateRoom'] })
      }
      if (zimmer.some(z => z.totalCent !== undefined
                        && (!Number.isInteger(z.totalCent) || z.totalCent < 0))) {
        throw Errors.validation({ rooms: ['field.positiveInteger'] })
      }
      /*
       * Personen je Zimmer. Die Angabe der Buchung gilt fuer jedes Zimmer
       * gleich -- bei einer Gruppe aus Doppel- und Einzelzimmern stimmt sie
       * fuer keines. Die Gruppenmaske fragte bisher gar nicht, und die Gruppe
       * Liedtke stand mit fuenf Zimmern ohne eine Person da (Sven,
       * 08.10.2026). Dieselbe Pruefung wie fuer die Buchung.
       */
      const personenJeZimmerAngabe = zimmer.map(z =>
        z.adults === undefined && z.children === undefined
          ? null
          : personenAngabe({ adults: z.adults, children: z.children }))
      /*
       * Der Zeitraum je Zimmer: was nicht dabeisteht, erbt den der Buchung.
       *
       * **Einmal ausgerechnet und danach nur noch benutzt.** Die Anreise
       * eines Zimmers wird an sechs Stellen gebraucht -- Bestand,
       * Zimmerpruefung, Reservierungszeile, Naechte, Preis, Antwort -- und
       * jedes `?? body.arrival` an einer davon zu vergessen ergaebe eine
       * Buchung, deren Zeile und deren Bestand verschiedene Tage meinen.
       */
      const zeitraeume = zimmer.map(z => ({
        arrival: z.arrival ?? body.arrival,
        departure: z.departure ?? body.departure
      }))
      for (const [i, zr] of zeitraeume.entries()) {
        if (!isIsoDate(zr.arrival) || !isIsoDate(zr.departure)) {
          throw Errors.validation({ rooms: ['field.isoDate'] }, { index: i })
        }
        const n = nightsBetween(zr.arrival, zr.departure)
        if (n <= 0) throw Errors.validation({ rooms: ['field.afterArrival'] }, { index: i })
        if (n > MAX_STAY_NIGHTS) {
          throw Errors.validation({ rooms: ['field.stayTooLong'] }, { max: MAX_STAY_NIGHTS })
        }
      }
      // Preise je Zimmer **und** ein Preis fuer die Buchung waeren zwei
      // Betraege fuer dieselbe Sache. Welcher gilt, gehoert nicht geraten.
      if (zimmer.some(z => z.totalCent !== undefined)
          && (body.priceCent !== undefined || body.totalCent !== undefined)) {
        throw Errors.validation({ rooms: ['field.eitherPriceOrTotal'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        /*
         * Gast, Mitreisende und Ratenplan werden aufgeloest, bevor etwas
         * geschrieben wird (M4, Sicherheitsaudit 2026-10-11). Die
         * Fremdschluesselpruefung liest an der Zeilenrichtlinie vorbei: ein
         * Gast eines anderen Kunden hing sonst an dieser Buchung, und ein
         * Ratenplan des Nachbarhauses setzte seine Preise ein. Fremd und
         * unbekannt bekommen dieselbe Antwort.
         */
        let guestId = body.guestId
        if (body.guestRef !== undefined) {
          guestId = await gastPerRefImBetrieb(client, body.propertyId, body.guestRef)
        }
        await gaesteImBetrieb(client, body.propertyId,
          [guestId, ...(body.occupants ?? []).map(o => o.guestId)])
        await ratenplanImHaus(client, body.propertyId, body.ratePlanId)

        /*
         * Abruf aus einem Kontingent. Der Platz ist dann schon gehalten und
         * wandert nur von `blocked` nach `sold`.
         *
         * Der Zeitraum muss dem des Kontingents genau entsprechen. Das ist
         * eine echte Einschraenkung und hat einen Grund: bei einem Teilabruf
         * saenke `blocked` nur an den belegten Naechten, die Freigabe des
         * Rests am Freigabedatum rechnet aber ueber den ganzen Zeitraum. An
         * den uebrigen Naechten bliebe dann dauerhaft Kontingent gebunden,
         * das niemandem mehr gehoert. Wer abweichend bucht, bucht frei.
         */
        const block = body.blockRef === undefined
          ? null
          : await loadBlock(client, body.blockRef)
        if (block !== null) {
          if (block.property_id !== body.propertyId) throw Errors.notFound('res.block')
          if (block.status !== 'active') {
            throw Errors.conflict('block.notPickable', { status: block.status })
          }
          if (block.picked_up >= block.quantity) {
            throw Errors.conflict('block.fullyPickedUp')
          }
          // Bei einer Gruppe reicht "nicht ganz abgerufen" nicht: es muessen
          // so viele Plaetze frei sein, wie Zimmer gebucht werden. Sonst
          // stiege `picked_up` ueber `quantity`, und der Nachtlauf gaebe am
          // Freigabedatum eine negative Menge frei.
          if (block.picked_up + zimmer.length > block.quantity) {
            throw Errors.conflict('block.notEnoughLeft',
              { left: block.quantity - block.picked_up, quantity: block.quantity })
          }
          if (zimmer.some(z => z.categoryId !== block.category_id)) {
            throw Errors.validation({
              categoryId: ['field.mustMatchBlockCategory'] })
          }
          /*
           * Der Zeitraum muss passen -- und zwar **jeder**, auch der eines
           * einzelnen Zimmers.
           *
           * `picked_up` ist eine Zahl ohne Datum, und die Freigabe des
           * Rests rechnet `quantity - picked_up` ueber den ganzen Zeitraum
           * des Kontingents. Ein Abruf ueber nur einen Teil zaehlte dort
           * voll mit, haette den Platz aber nur an seinen eigenen Tagen
           * verbraucht: an allen uebrigen bliebe dauerhaft Kapazitaet
           * gebunden, die niemandem mehr gehoert und die niemand sieht.
           *
           * Wer fuer ein Zimmer andere Tage braucht, bucht es **frei**.
           * Dieselbe Regel wie beim Verschieben, wo ein Abruf gar nicht
           * beweglich ist (`stay.pickupNotMovable`).
           */
          if (zeitraeume.some(zr => zr.arrival !== block.from_date
                                 || zr.departure !== block.to_date)) {
            throw Errors.unprocessable(
              'block.pickupWholePeriod',
              { from: block.from_date, to: block.to_date })
          }
          /*
           * Erst freigeben, dann binden -- umgekehrt als `inventory_move`,
           * und aus dem umgekehrten Grund: dort haelt noch niemand den Platz,
           * hier haelt ihn das Kontingent bereits. Im vollen Haus schluege
           * ein Binden vor dem Freigeben an der eigenen Reservierung fehl.
           * Ein Fenster entsteht nicht, beides liegt in einer Transaktion.
           */
          await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,$5)`,
            [body.propertyId, block.category_id, block.from_date, block.to_date,
             zimmer.length])
        }

        /*
         * Die Zimmergruppen gehoeren zu diesem Haus.
         *
         * Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus
         * (CLAUDE.md). Bei einem Benutzer mit zwei Haeusern stuende eine
         * fremde Gruppe in seinem Kontext, und die Buchung landete in einem
         * Haus, dessen Belegungsplan sie nie zeigt. Bisher scheiterte das
         * erst an `inventory_reserve` -- mit `not_materialized`, also einer
         * Meldung ueber fehlenden Bestand statt ueber die falsche Gruppe.
         */
        const gruppen = [...new Set(zimmer.map(z => z.categoryId))]
        const bekannt = await client.query<{ id: number }>(
          `SELECT id FROM resource_category
            WHERE id = ANY($1::bigint[]) AND property_id = $2`,
          [gruppen, body.propertyId])
        if (bekannt.rowCount !== gruppen.length) {
          throw Errors.validation({ categoryId: ['field.unknownCategory'] })
        }

        /*
         * Kontingent zuerst binden. Schlaegt das fehl, wird alles
         * zurueckgerollt.
         *
         * Zusammengefasst wird je **(Zimmergruppe, Zeitraum)**, nicht mehr
         * je Zimmergruppe allein: seit ein Zimmer eigene Tage haben darf,
         * waere "acht Doppelzimmer vom 10. bis 12." schlicht falsch, wenn
         * zwei davon bis zum 14. bleiben.
         *
         * Zusammengefasst wird trotzdem, und das ist der Punkt:
         * `inventory_reserve` sperrt die Bestandszeilen des Zeitraums, und
         * acht Aufrufe nacheinander sperrten sie achtmal. Bei einer Gruppe,
         * die geschlossen anreist -- der Normalfall --, bleibt es bei einem
         * Aufruf je Gruppe wie bisher.
         */
        const jeGruppe = new Map<string, { categoryId: number; arrival: string
                                           departure: string; anzahl: number }>()
        for (const [i, z] of zimmer.entries()) {
          const zr = zeitraeume[i]!
          const schluessel = `${z.categoryId}|${zr.arrival}|${zr.departure}`
          const vorhanden = jeGruppe.get(schluessel)
          if (vorhanden) vorhanden.anzahl += 1
          else jeGruppe.set(schluessel, { categoryId: z.categoryId, ...zr, anzahl: 1 })
        }
        await ueberbuchenErlauben(client, body.allowOverbooking)
        for (const g of jeGruppe.values()) {
          const inv = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,$5) AS e`,
            [body.propertyId, g.categoryId, g.arrival, g.departure, g.anzahl])
          inventoryError(inv.rows[0]!.e)
        }

        if (block !== null) {
          await client.query(
            `UPDATE availability_block SET picked_up = picked_up + $2 WHERE id = $1`,
            [block.id, zimmer.length])
        }

        const booking = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO booking (property_id, booker_guest_id, source, external_reference,
                                created_by, channel_code)
           VALUES ($1,$2,$3,$4,$5,NULLIF(btrim($6),'')) RETURNING id, public_ref`,
          [body.propertyId, guestId ?? null, body.source ?? 'direct',
           body.externalReference ?? null, principal.userId, body.channelCode ?? null])

        // Der Ratenplan des Kontingents gilt, wenn keiner genannt ist: eine
        // Gruppe hat ihren Preis vereinbart, und ihn je Abruf erneut
        // eintippen zu lassen, waere die Stelle, an der er abweicht.
        const ratePlanId = body.ratePlanId ?? block?.rate_plan_id ?? undefined

        /*
         * Der Preis haengt am Ratenplan und am Tag, nicht am Zimmer.
         *
         * Gefragt wird deshalb **einmal fuer alle vorkommenden Naechte**
         * und nicht einmal je Zimmer: acht Zimmer derselben Nacht kosten
         * sonst acht Abfragen, die achtmal dieselbe Antwort geben. Seit die
         * Zimmer verschiedene Zeitraeume haben duerfen, ist "alle Naechte"
         * die Vereinigung -- der Ratenplan liefert sie in einem Zug, und
         * jedes Zimmer greift sich daraus seine eigenen heraus.
         */
        const alleNaechte = [...new Set(
          zeitraeume.flatMap(zr => eachNight(zr.arrival, zr.departure)))].sort()
        const naechteJeZimmer = zeitraeume.map(zr => eachNight(zr.arrival, zr.departure))
        /*
         * Ein vereinbarter Preis schlaegt den Ratenplan, und zwar fuer jede
         * Nacht derselbe. Der Ratenplan bleibt trotzdem an der Reservierung
         * stehen: er sagt, unter welcher Bedingung gebucht wurde -- Storno,
         * Verpflegung, Mindestaufenthalt --, und das gilt weiter, auch wenn
         * am Preis gehandelt wurde.
         */
        const preisJeTag = new Map<string, number>()
        if (body.priceCent !== undefined) {
          for (const n of alleNaechte) preisJeTag.set(n, body.priceCent)
        } else {
          const p = await priceNights(client, ratePlanId, alleNaechte)
          alleNaechte.forEach((n, i) => preisJeTag.set(n, p[i] ?? 0))
        }

        /*
         * Der Preis je Zimmer, und erst daraus der Preis je Nacht.
         *
         * Drei Wege fuehren hierher, und sie schliessen einander aus (oben
         * geprueft): ein Betrag je Zimmer, ein Betrag fuer die ganze
         * Gruppe, oder gar keiner -- dann gilt der Ratenplan.
         *
         * Gespeichert wird immer je Nacht. Deshalb faellt jeder Gesamtpreis
         * genau einmal in Naechte auseinander, hier, mit dem Rest-Cent auf
         * der ersten Nacht. Wer stattdessen durch die Naechte teilte und
         * rundete, haette bei drei Naechten und 100,00 EUR dreimal 33,33
         * gespeichert und eine Rechnung ueber 99,99 gedruckt.
         */
        const gruppenTeile = body.totalCent === undefined
          ? null
          : gruppeAufteilen(body.totalCent, await personenJeZimmer(client, zimmer))
        const preiseJeZimmer = zimmer.map((z, i) => {
          const n = naechteJeZimmer[i]!
          if (z.totalCent !== undefined) return preisJeNacht(z.totalCent, n.length)
          if (gruppenTeile !== null) return preisJeNacht(gruppenTeile[i]!, n.length)
          return n.map(tag => preisJeTag.get(tag) ?? 0)
        })
        const summeJeZimmer = preiseJeZimmer.map(p => p.reduce((s, x) => s + x, 0))

        /*
         * Die Zimmer, die mitkommen, werden **vor** dem Anlegen geprueft und
         * in derselben Anweisung gesetzt. Ein zweiter Aufruf danach haette
         * ein Fenster, in dem jemand anders dasselbe Zimmer belegt -- und
         * die Reservierung stuende ohne das Zimmer da, das die Rezeption im
         * Belegungsplan gerade zugesagt hat.
         *
         * Alle in einer Anweisung (Performance-Audit 11.10.2026, Abschnitt
         * 14), und gemeldet wird das **erste** Zimmer der Reihe, wie es die
         * Schleife frueher tat. Dass die Zimmer derselben Gruppe einander
         * dabei nicht sehen, aendert nichts: dasselbe Zimmer zweimal ist
         * oben schon abgewiesen (`field.duplicateRoom`).
         */
        const zimmerFragen: ZimmerFrage[] = zimmer.flatMap((z, i) =>
          z.resourceId === undefined ? [] : [{
            ord: i, resourceId: z.resourceId, propertyId: body.propertyId,
            arrival: zeitraeume[i]!.arrival, departure: zeitraeume[i]!.departure }])
        const zimmerFehlerErster = (await zimmerFehler(client, zimmerFragen))
          .find(f => f !== null)
        if (zimmerFehlerErster) throw zimmerFehlerErster

        /*
         * Alle Reservierungen in einer Anweisung. Die Reihenfolge der
         * Zimmer bleibt die der Anfrage: `ORDER BY ord` vergibt die ids in
         * dieser Reihenfolge, und daran -- nicht an der Reihenfolge von
         * `RETURNING`, die SQL nicht zusagt -- werden sie zugeordnet.
         */
        const jePerson = zimmer.map((_, i) => personenJeZimmerAngabe[i] ?? personen)
        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              option_expires_at, rate_plan_id, primary_guest_id, notes, short_note,
              block_id, resource_id, guest_count, adults, children, created_by,
              breakfast_declined)
           SELECT $1, $2, x.category_id, x.arrival, x.departure, $3::reservation_status,
                  $4::timestamptz, $5::bigint, $6::bigint, $7::text, $8::text,
                  $9::bigint, x.resource_id, x.guest_count, x.adults, x.children, $10::bigint,
                  $18::boolean
             FROM unnest($11::bigint[], $12::date[], $13::date[], $14::bigint[],
                         $15::int[], $16::int[], $17::int[])
                  WITH ORDINALITY AS x(category_id, arrival, departure, resource_id,
                                       guest_count, adults, children, ord)
            ORDER BY x.ord
           RETURNING id, public_ref`,
          [body.propertyId, booking.rows[0]!.id,
           body.status ?? 'Confirmed', body.optionExpiresAt ?? null,
           ratePlanId ?? null, guestId ?? null, body.notes ?? null,
           body.shortNote?.trim() || null, block?.id ?? null, principal.userId,
           zimmer.map(z => z.categoryId),
           zeitraeume.map(zr => zr.arrival), zeitraeume.map(zr => zr.departure),
           zimmer.map(z => z.resourceId ?? null),
           jePerson.map(p => p.guestCount), jePerson.map(p => p.adults),
           jePerson.map(p => p.children), body.breakfastDeclined === true])
        const reservierungen = [...res.rows].sort((a, b) => Number(a.id) - Number(b.id))
        if (reservierungen.length !== zimmer.length) {
          throw new Error('Gruppenbuchung: Zahl der angelegten Reservierungen weicht ab')
        }

        // Eine Anweisung fuer alle Naechte aller Zimmer statt einer je
        // Zimmer: dieselbe Form wie bei `priceNights`.
        await client.query(
          `INSERT INTO reservation_night
             (reservation_id, property_id, date, rate_plan_id, price_cent)
           SELECT x.reservation_id, $1, x.date, $2, x.price
             FROM unnest($3::bigint[], $4::date[], $5::bigint[])
                  AS x(reservation_id, date, price)`,
          [body.propertyId, ratePlanId ?? null,
           reservierungen.flatMap((r, i) => naechteJeZimmer[i]!.map(() => r.id)),
           naechteJeZimmer.flat(), preiseJeZimmer.flat()])

        /*
         * Personen statt Zaehler: noetig fuer Kurtaxe und Meldeschein --
         * und genau deshalb **nur am ersten Zimmer**.
         *
         * Der Gast einer Gruppenbuchung ist der Besteller, nicht der
         * Bewohner von acht Zimmern. Ihn in jedes einzutragen hiesse, ihn
         * achtmal zu zaehlen: die Kurtaxe rechnet je Mitreisendem, und aus
         * einer Person wuerden acht. Die uebrigen Zimmer bleiben ohne
         * Eintrag; `erwarteteSaetze` rechnet dann mit einer Person je
         * Zimmer, was der Wahrheit vor der Namensliste am naechsten kommt.
         */
        const occupants = body.occupants ?? (guestId ? [{ guestId, isPrimary: true }] : [])
        if (occupants.length > 0) {
          await client.query(
            `INSERT INTO reservation_occupant
               (property_id, reservation_id, guest_id, age_at_arrival, is_primary)
             SELECT $1, $2, x.guest_id, x.age, x.is_primary
               FROM unnest($3::bigint[], $4::int[], $5::boolean[])
                    WITH ORDINALITY AS x(guest_id, age, is_primary, ord)
              ORDER BY x.ord`,
            [body.propertyId, reservierungen[0]!.id,
             occupants.map(o => o.guestId ?? null),
             occupants.map(o => o.ageAtArrival ?? null),
             occupants.map(o => o.isPrimary ?? false)])
        }

        await client.query(
          `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
           SELECT $1, x.id, $2, 'guest'
             FROM unnest($3::bigint[]) WITH ORDINALITY AS x(id, ord)
            ORDER BY x.ord`,
          [body.propertyId, guestId ?? null, reservierungen.map(r => r.id)])

        const angelegt = zimmer.map((z, i) => ({
          reservationRef: reservierungen[i]!.public_ref,
          categoryId: z.categoryId,
          resourceId: z.resourceId ?? null,
          // Der Zeitraum steht **je Zimmer** in der Antwort, nicht nur
          // oben: seit er abweichen darf, waere der der Buchung fuer
          // dieses Zimmer nur manchmal richtig, und "manchmal richtig"
          // ist die Sorte Angabe, die niemand prueft.
          arrival: zeitraeume[i]!.arrival,
          departure: zeitraeume[i]!.departure,
          nights: naechteJeZimmer[i]!.length,
          totalCent: summeJeZimmer[i]!
        }))

        const result = {
          bookingRef: booking.rows[0]!.public_ref,
          reservationRef: angelegt[0]!.reservationRef,
          reservations: angelegt,
          /*
           * Oben steht die **Klammer** um die Buchung: die frueheste
           * Anreise und die spaeteste Abreise ihrer Zimmer, nicht die
           * Vorgabe aus dem Aufruf. Weichen Zimmer ab, ist die Vorgabe fuer
           * kein einziges von ihnen die Wahrheit; die Klammer ist fuer alle
           * richtig.
           */
          arrival: zeitraeume.map(zr => zr.arrival).sort()[0]!,
          departure: zeitraeume.map(zr => zr.departure).sort().at(-1)!,
          // Die Naechte des laengsten Zimmers. Eine Summe waere hier
          // irrefuehrend -- sie zaehlte Zimmernaechte, nicht Aufenthalt.
          nights: Math.max(...naechteJeZimmer.map(n => n.length)),
          // Summiert statt hochgerechnet: seit die Zimmer verschiedene
          // Preise tragen koennen, ist "einmal mal Anzahl" falsch -- und
          // zwar um genau den Betrag, um den verhandelt wurde.
          totalCent: summeJeZimmer.reduce((s, x) => s + x, 0)
        }

        /*
         * Ein Ereignis **je Reservierung**, nicht eines je Buchung.
         *
         * Ein Kanalmanager fuehrt seine Zimmer einzeln; ein Ereignis mit
         * acht Referenzen darin muesste er auseinandernehmen, und die
         * bestehenden Empfaenger erwarten `reservationRef` im Singular.
         * `bookingRef` ist in allen acht dasselbe -- daran haengen sie
         * zusammen. Eingereiht werden sie in einer Anweisung.
         */
        await emitEvents(client, body.propertyId, 'reservation.created',
          angelegt.map(a => ({
            reservationRef: a.reservationRef,
            bookingRef: result.bookingRef,
            status: 'Confirmed',
            arrival: body.arrival,
            departure: body.departure,
            categoryId: a.categoryId,
            source: body.source ?? 'direct',
            externalReference: body.externalReference ?? null,
            blockRef: body.blockRef ?? null,
            totalCent: a.totalCent
          })))

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Eine einzelne Reservierung, vollstaendig.
   *
   * Der Belegungsplan ist das Hauptwerkzeug der Rezeption, und wer dort
   * einen Balken anklickt, will alles sehen, was zu diesem Aufenthalt
   * gehoert -- nicht nur das, was auf den Balken passt. Bisher gab es
   * dafuer gar nichts: `GET /v1/reservations/:ref` existierte nicht, und
   * `notes` liess sich nach dem Anlegen weder lesen noch aendern.
   *
   * Ein Aufruf, nicht sechs. Gast, Zimmer, Ratenplan, Naechte mit Preisen,
   * Mitreisende, Folio und Kontingent kommen zusammen; sonst kostet jeder
   * Klick im Plan eine Handvoll Runden.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef',
    permission: 'reservation:read',
    summary: 'Eine Reservierung mit allem, was dazugehoert',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number }>(
          `SELECT r.id, r.property_id AS "_propertyId",
                  r.public_ref            AS "reservationRef",
                  b.public_ref            AS "bookingRef",
                  -- Wie viele Aufenthalte an der Buchung haengen. Das Fenster
                  -- zeigt den Weg zur Gruppenmaske nur, wenn es mehr als
                  -- einer ist: an jeder Einzelbuchung stand "Gruppenbuchung",
                  -- und nach dem KWHotel-Import sah es aus, als waeren alle
                  -- Buchungen zu Gruppen geworden.
                  (SELECT count(*)::int FROM reservation r2
                    WHERE r2.booking_id = r.booking_id) AS "bookingRooms",
                  r.status, r.arrival::text, r.departure::text,
                  r.notes,
                  r.short_note            AS "shortNote",
                  r.guest_count           AS "guestCount",
                  r.adults, r.children,
                  r.category_id           AS "categoryId",
                  c.code                  AS "categoryCode",
                  c.name                  AS "categoryName",
                  r.resource_id           AS "resourceId",
                  r.room_fixed            AS "roomFixed",
                  r.breakfast_declined    AS "breakfastDeclined",
                  u.code                  AS "roomCode",
                  u.floor,
                  r.rate_plan_id          AS "ratePlanId",
                  rp.code                 AS "ratePlanCode",
                  g.public_ref            AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS "guestName",
                  g.email                 AS "guestEmail",
                  g.phone                 AS "guestPhone",
                  -- Die Nummer fuer den Aufenthalt aus dem Meldeformular
                  -- (0123), meist das Handy; die aus dem Profil ist oft das
                  -- Festnetz zu Hause.
                  (SELECT reg.stay_phone FROM registration reg
                    WHERE reg.reservation_id = r.id
                      AND reg.group_registration_id IS NULL) AS "stayPhone",
                  g.language              AS "guestLanguage",
                  co.public_ref           AS "companyRef",
                  co.name                 AS "companyName",
                  bl.public_ref           AS "blockRef",
                  bl.name                 AS "blockName",
                  b.source, b.external_reference AS "externalReference",
                  b.channel_code          AS "channelCode",
                  b.channel_owner         AS "channelOwner",
                  b.source_changed_at     AS "sourceChangedAt",
                  b.source_canceled_at    AS "sourceCanceledAt",
                  r.channel_conflict      AS "channelConflict",
                  r.checked_in_at         AS "checkedInAt",
                  r.checked_out_at        AS "checkedOutAt",
                  r.canceled_at           AS "canceledAt",
                  f.public_ref            AS "folioRef"
             FROM reservation r
             JOIN booking b            ON b.id = r.booking_id
             JOIN resource_category c  ON c.id = r.category_id
             LEFT JOIN resource u      ON u.id = r.resource_id
             LEFT JOIN rate_plan rp    ON rp.id = r.rate_plan_id
             LEFT JOIN guest g         ON g.id = r.primary_guest_id
             LEFT JOIN company co      ON co.id = b.booker_company_id
             LEFT JOIN availability_block bl ON bl.id = r.block_id
             LEFT JOIN folio f         ON f.reservation_id = r.id AND f.kind = 'guest'
            WHERE r.public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const kopf = r.rows[0]! as Record<string, unknown>
        /*
         * Das Recht im Haus des Datensatzes, nicht in irgendeinem: die Pfade
         * mit Reservierung oder Buchung tragen keine Property, `registerRoute`
         * prueft deshalb nur "irgendwo", und die Zeilenrichtlinie laesst jedes
         * Haus durch, in dem der Benutzer irgendeine Rolle hat (Befund H4,
         * Sicherheitsaudit 2026-10-11). Jede solche Route hier prueft das
         * Recht noch einmal, sobald das Haus feststeht.
         */
        rechtImHaus(req.principal as Principal, 'reservation:read', Number(kopf._propertyId))
        /*
         * Mailadresse und Telefon nur mit `guest:read` im Haus der
         * Reservierung (M5, Sicherheitsaudit 2026-10-11). `reservation:read`
         * haben auch Revenue und Maschinenzugaenge, die Kontaktdaten nicht
         * brauchen; die Liste verlangt fuer dieselben Felder dieses Recht
         * schon (reservationList.ts), und das Seitenfenster war der Weg
         * daran vorbei. Name und Referenz bleiben: ohne sie weiss niemand,
         * wessen Buchung er vor sich hat.
         */
        if (!can(req.principal as Principal, 'guest:read', Number(kopf._propertyId))) {
          kopf.guestEmail = null
          kopf.guestPhone = null
          kopf.stayPhone = null
        }

        const naechte = await client.query(
          `SELECT date::text, price_cent AS "priceCent",
                  rate_plan_id AS "ratePlanId", posted
             FROM reservation_night WHERE reservation_id = $1 ORDER BY date`,
          [kopf.id])

        const mitreisende = await client.query(
          `SELECT o.age_at_arrival AS "ageAtArrival", o.is_primary AS "isPrimary",
                  g.public_ref AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name
             FROM reservation_occupant o
             LEFT JOIN guest g ON g.id = o.guest_id
            WHERE o.reservation_id = $1
            ORDER BY o.is_primary DESC, o.id`, [kopf.id])

        // Zimmerwechsel (0195): die Zimmer nacheinander. Leer ohne Wechsel.
        const abschnitte = await client.query<{ from: string }>(
          `SELECT s.resource_id::int AS "resourceId", u.code AS "roomCode",
                  s.arrival::text AS "from", s.departure::text AS "to",
                  (s.status = 'CheckedOut' AND s.stay_status = 'InHouse') AS "movedOut"
             FROM reservation_room_stay s
             LEFT JOIN resource u ON u.id = s.resource_id
            WHERE s.id = $1 AND s.room_moved
            ORDER BY s.arrival`, [kopf.id])

        // Online-Check-in: verschickt, ausgefuellt, Unterschrift offen
        // (Dokument 30). Im selben Aufruf, nicht als zweiter vom Fenster.
        const onlineCheckin = await onlineCheckinStand(client, kopf.id as number,
          req.principal as Principal)
        // Reinigungsverzicht (0115), ebenfalls im selben Aufruf.
        const hausId = Number(kopf._propertyId)
        const geschaeftstag = await tagOderOffen(client, hausId, undefined)
        const cleaningWaiver = await verzichtStand(client, kopf.id as number, hausId,
          geschaeftstag,
          can(req.principal as Principal, 'reservation:checkin', hausId))

        // Freischaltungen der Gaestemappe (0147), ebenfalls im selben Aufruf.
        const mappe = await client.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM guest_folder_session s
                    WHERE s.reservation_id = $1 AND s.revoked_at IS NULL
                      AND s.expires_on >= $3::date)::int AS n
             FROM guest_folder_setting g
            WHERE g.property_id = $2 AND g.enabled`,
          [kopf.id, hausId, geschaeftstag])
        const guestFolder = mappe.rows[0] === undefined ? null
          : { activeSessions: mappe.rows[0].n }
        // Wuensche aus der Mappe (0149), ebenfalls im selben Aufruf.
        const guestRequests = await wuenscheDerReservierung(client, kopf.id as number)

        // Die laufende id bleibt drinnen; nach aussen geht die oeffentliche
        // Referenz (C1, Dokument 13).
        delete kopf.id
        delete kopf._propertyId
        return {
          ...kopf,
          nights: naechte.rows,
          occupants: mitreisende.rows,
          onlineCheckin,
          cleaningWaiver,
          guestFolder,
          guestRequests,
          roomParts: abschnitte.rows,
          // Der letzte Wechsel laesst sich bis zu seinem Tag zuruecknehmen.
          roomMoveUndoable: abschnitte.rows.length > 1
            && ['Optional', 'Confirmed', 'InHouse'].includes(kopf.status as string)
            && abschnitte.rows[abschnitte.rows.length - 1]!.from >= geschaeftstag,
          // Vorab gebucht (0176): eine gebuchte Nacht, die der Gast noch
          // nicht geschlafen hat. Daran haengt der Knopf zum Zuruecknehmen.
          postedAhead: naechte.rows.some(n => {
            const x = n as { date: string; posted: boolean }
            return x.posted && x.date >= geschaeftstag
          }),
          totalCent: naechte.rows.reduce(
            (sum, n) => sum + Number((n as { priceCent: number }).priceCent), 0)
        }
      })
    }
  })

  /**
   * Die Notiz an der Reservierung.
   *
   * Eine eigene Route und kein Feld in `change-stay`: eine Notiz beruehrt
   * weder Bestand noch Preis noch Zustand. Sie durch dieselbe Tuer zu
   * schicken wie eine Verlaengerung hiesse, fuer einen Satz Text den ganzen
   * Apparat aus Inventarbewegung und Neubepreisung anzuwerfen -- und ein
   * Tippfehler in der Notiz koennte an einem vollen Haus scheitern.
   *
   * Notizen sind **kein** Ort fuer Gesundheitsdaten oder aehnlich
   * Heikles. Das steht so in der Maske, nicht nur hier: das Feld ist
   * Freitext und wird nicht durchsucht. Mit der Loeschung des Gastes
   * faellt sie trotzdem (Migration 0129): was in der Maske steht, haelt
   * niemanden davon ab, es doch hineinzuschreiben.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/reservations/:reservationRef',
    permission: 'reservation:write',
    summary: 'Notiz, Hauptgast, Personenzahl oder Zimmer fest einer Reservierung aendern',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = req.body as { notes?: string | null; shortNote?: string | null
                                 guestRef?: string
                                 guestCount?: number; adults?: number; children?: number
                                 roomFixed?: boolean; breakfastDeclined?: boolean }
      /*
       * Die Personenzahl -- vorher nur beim Anlegen zu setzen (Sven,
       * 06.10.2026: "man kann bei bestehenden Buchungen die Personenzahl
       * nicht aendern"). Dieselbe Pruefung wie beim Anlegen, und hier und
       * nicht in `change-stay`: sie bewegt keinen Bestand. Der Preis bleibt,
       * wie er ist; wer fuer die dritte Person mehr nimmt, traegt ihn in
       * derselben Maske ein.
       */
      const personenGeaendert = body.guestCount !== undefined
        || body.adults !== undefined || body.children !== undefined
      const personen = personenGeaendert ? personenAngabe(body) : null
      if (body.roomFixed !== undefined && typeof body.roomFixed !== 'boolean') {
        throw Errors.validation({ roomFixed: ['field.invalid'] })
      }
      if (body.breakfastDeclined !== undefined && typeof body.breakfastDeclined !== 'boolean') {
        throw Errors.validation({ breakfastDeclined: ['field.invalid'] })
      }
      if (body.notes !== undefined && body.notes !== null
          && body.notes.length > NOTES_MAX_LENGTH) {
        throw Errors.validation({ notes: ['field.maxLength'] },
          { max: NOTES_MAX_LENGTH })
      }
      if (body.shortNote !== undefined && body.shortNote !== null
          && body.shortNote.length > SHORT_NOTE_MAX_LENGTH) {
        throw Errors.validation({ shortNote: ['field.maxLength'] },
          { max: SHORT_NOTE_MAX_LENGTH })
      }

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number
                                       status: ReservationStatus }>(
          `SELECT id, property_id, status FROM reservation
            WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        rechtImHaus(req.principal as Principal, 'reservation:write', res.property_id)

        if (body.notes !== undefined) {
          await client.query(
            `UPDATE reservation SET notes = NULLIF($2, ''), updated_at = now()
              WHERE id = $1`, [res.id, body.notes ?? ''])
        }
        if (body.shortNote !== undefined) {
          await client.query(
            `UPDATE reservation SET short_note = NULLIF(btrim($2), ''),
                                    updated_at = now()
              WHERE id = $1`, [res.id, body.shortNote ?? ''])
        }

        /*
         * "Zimmer fest" (Migration 0104): der Sortierer laesst die
         * Reservierung, wo sie ist. Hier und nicht in `assign-unit`: das
         * Schloss bewegt nichts, und ein Stammgast im Wunschzimmer soll es
         * auch bekommen, ohne dass jemand das Zimmer neu waehlt. Kein
         * Vermerk nach 0092 -- der Trigger dort sieht nur Zeitraum, Zimmer,
         * Gruppe und Storno.
         */
        if (body.roomFixed !== undefined) {
          await client.query(
            `UPDATE reservation SET room_fixed = $2, updated_at = now() WHERE id = $1`,
            [res.id, body.roomFixed])
        }

        /*
         * "Ohne Fruehstueck" (0169). Wirkt wie die Regel an Rate und Haus ab
         * der naechsten Nacht; eine gebuchte Nacht teilt niemand um.
         */
        if (body.breakfastDeclined !== undefined) {
          await client.query(
            `UPDATE reservation SET breakfast_declined = $2, updated_at = now() WHERE id = $1`,
            [res.id, body.breakfastDeclined])
        }

        let gastRef: string | null | undefined
        if (body.guestRef !== undefined) {
          gastRef = await setzeHauptgast(client, res, body.guestRef)
        }

        /*
         * Nur solange der Aufenthalt offen ist. Nach der Abreise ist die
         * Kurtaxe gebucht und der Meldeschein abgeschlossen; eine andere
         * Zahl danach stimmte mit keinem von beiden mehr ueberein. Im Haus
         * dagegen ja: es kommt jemand nach, oder einer reist frueher ab.
         */
        if (personen !== null) {
          if (!PERSONEN_AENDERBAR.has(res.status)) {
            throw Errors.conflict('reservation.personsFixed', { status: res.status })
          }
          await client.query(
            `UPDATE reservation SET guest_count = $2, adults = $3, children = $4,
                                    updated_at = now()
              WHERE id = $1`,
            [res.id, personen.guestCount, personen.adults, personen.children])
        }

        /*
         * Auch eine Notiz ist eine Aenderung, die ein Fremdsystem sehen
         * will: sie steht in der Reservierungsliste. Bisher meldete diese
         * Route nichts, und der Abgleich erfuhr davon erst beim naechsten
         * Vollabzug. Der Rumpf nennt nur, **welche** Felder -- den Text
         * holt der Empfaenger ueber die Liste, mit seinem eigenen Recht.
         */
        const geaendert = [
          ...(body.notes !== undefined ? ['notes'] : []),
          ...(body.shortNote !== undefined ? ['shortNote'] : []),
          ...(body.guestRef !== undefined ? ['guest'] : []),
          ...(personen !== null ? ['persons'] : []),
          ...(body.roomFixed !== undefined ? ['roomFixed'] : []),
          ...(body.breakfastDeclined !== undefined ? ['breakfastDeclined'] : [])
        ]
        if (geaendert.length > 0) {
          await emitEvent(client, res.property_id, 'reservation.changed', {
            reservationRef, status: res.status, changed: geaendert
          })
        }

        return {
          reservationRef,
          notes: body.notes ?? null,
          ...(body.shortNote === undefined ? {} : { shortNote: body.shortNote }),
          ...(gastRef === undefined ? {} : { guestRef: gastRef }),
          ...(personen === null ? {} : personen),
          ...(body.roomFixed === undefined ? {} : { roomFixed: body.roomFixed }),
          ...(body.breakfastDeclined === undefined ? {}
            : { breakfastDeclined: body.breakfastDeclined })
        }
      })
    }
  })

  /**
   * Die Gruppe als Vorgang: alle Zimmer einer Buchung auf einmal.
   *
   * **Warum ein eigener Endpunkt und nicht acht Aufrufe.** Eine
   * Reisegruppe ist genau das, was das Datenmodell vorsieht -- eine
   * `booking` mit mehreren `reservation` --, und an der Rezeption wird sie
   * auch als eine behandelt: "die Gruppe Petersen kommt einen Tag spaeter".
   * Wer dafuer acht Aufrufe machen muss, hat nach dem fuenften einen
   * Zustand, den niemand gewollt hat, falls der sechste scheitert.
   *
   * Ein Aufruf je Bildschirm, nicht je Zeile (CLAUDE.md, "Leistung"): die
   * Maske zeigt Zimmer, Zeitraum, Gast und Summe, und das kommt zusammen.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/bookings/:bookingRef',
    permission: 'reservation:read',
    summary: 'Eine Buchung mit allen ihren Zimmern',
    handler: async (req) => {
      const { bookingRef } = req.params as { bookingRef: string }
      return tx(req.pool, req, async client => {
        const b = await client.query<{ id: number }>(
          `SELECT b.id, b.property_id AS "_propertyId",
                  b.public_ref          AS "bookingRef",
                  b.source, b.external_reference AS "externalReference",
                  b.created_at          AS "createdAt",
                  g.public_ref          AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS "guestName",
                  co.public_ref         AS "companyRef",
                  co.name               AS "companyName"
             FROM booking b
             LEFT JOIN guest g   ON g.id = b.booker_guest_id
             LEFT JOIN company co ON co.id = b.booker_company_id
            WHERE b.public_ref = $1`, [bookingRef])
        if (b.rowCount === 0) throw Errors.notFound('res.booking')
        const kopf = b.rows[0]! as Record<string, unknown>
        rechtImHaus(req.principal as Principal, 'reservation:read', Number(kopf._propertyId))
        delete kopf._propertyId

        /*
         * Die Summe je Zimmer kommt als Unterabfrage im Verbund, nicht in
         * einer Schleife ueber die Zimmer. Eine Gruppe darf fuenfzig Zimmer
         * haben, und fuenfzig Abfragen sind der Fehler, den der Endpunkt
         * gerade vermeiden soll.
         */
        const zimmer = await client.query(
          `SELECT r.public_ref      AS "reservationRef",
                  r.status, r.arrival::text, r.departure::text,
                  r.category_id     AS "categoryId",
                  c.code            AS "categoryCode",
                  c.name            AS "categoryName",
                  r.resource_id     AS "resourceId",
                  u.code            AS "roomCode",
                  r.guest_count     AS "guestCount",
                  r.adults, r.children,
                  r.short_note      AS "shortNote",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS "guestName",
                  n.nights, n.total AS "totalCent"
             FROM reservation r
             JOIN resource_category c ON c.id = r.category_id
             LEFT JOIN resource u     ON u.id = r.resource_id
             LEFT JOIN guest g        ON g.id = r.primary_guest_id
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS nights,
                      COALESCE(sum(price_cent),0)::bigint AS total
                 FROM reservation_night WHERE reservation_id = r.id) n ON true
            WHERE r.booking_id = $1
            ORDER BY u.code NULLS LAST, r.id`, [kopf.id])

        // Die laufende id bleibt drinnen (C1, Dokument 13).
        delete kopf.id
        return {
          ...kopf,
          rooms: zimmer.rows.map(z => ({
            ...z, totalCent: Number((z as { totalCent: string }).totalCent) })),
          totalCent: zimmer.rows.reduce(
            (s, z) => s + Number((z as { totalCent: string }).totalCent), 0)
        }
      })
    }
  })

  /**
   * **Zwei Buchungen zu einer zusammenfuehren** (Sven, 15.10.2026).
   *
   * Aus KWHotel kamen Gruppen in zwei Buchungen an: KWHotel setzt die
   * Gruppennummer erst mit dem zweiten Zimmer, und wer beim ersten Import
   * allein war, behielt seine eigene. Ein Neuimport haette das nachgezogen;
   * Sven will stattdessen von Hand verknuepfen, nur wo ihm eine Gruppe
   * auffaellt.
   *
   * **Die ganze Buchung, nicht ein Zimmer.** Haengt eine Gruppe an zwei
   * Buchungen mit je mehreren Zimmern, bliebe beim Herausziehen eines
   * einzelnen wieder eine halbe Gruppe zurueck. Geaendert wird nur, zu
   * welcher Buchung die Zimmer gehoeren: Zeitraum, Zimmer, Preise, Gaeste,
   * Folios und Meldescheine haengen an der Reservierung und bleiben. Die
   * leere Buchung verschwindet; an ihr haengt sonst nichts.
   *
   * **Keine Kanalbuchung.** Ihre Nummer ist die, unter der der Kanal
   * Aenderungen und Stornos schickt. Eine zusammengefuehrte Buchung haette
   * danach zwei Herkuenfte, und die naechste Aenderung des Kanals traefe
   * Zimmer, die er nie verkauft hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/bookings/:bookingRef/merge',
    permission: 'reservation:write',
    summary: 'Die Zimmer einer anderen Buchung in diese uebernehmen',
    handler: async (req) => {
      const { bookingRef } = req.params as { bookingRef: string }
      const body = (req.body ?? {}) as { bookingRef?: unknown }
      if (typeof body.bookingRef !== 'string' || body.bookingRef === '') {
        throw Errors.validation({ bookingRef: ['field.required'] })
      }
      const quelleRef = body.bookingRef
      if (quelleRef === bookingRef) throw Errors.unprocessable('booking.mergeSame')
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const b = await client.query<{
          id: number; ref: string; property_id: number; source: string
          external_reference: string | null; legacy_system: string | null
          legacy_reference: string | null; booker_guest_id: number | null
          booker_company_id: number | null }>(
          `SELECT id, public_ref AS ref, property_id, source, external_reference,
                  legacy_system, legacy_reference, booker_guest_id, booker_company_id
             FROM booking WHERE public_ref = ANY($1::text[])
            ORDER BY id FOR UPDATE`, [[bookingRef, quelleRef]])
        const ziel = b.rows.find(x => x.ref === bookingRef)
        const quelle = b.rows.find(x => x.ref === quelleRef)
        if (ziel === undefined || quelle === undefined) throw Errors.notFound('res.booking')
        rechtImHaus(principal, 'reservation:write', ziel.property_id)
        rechtImHaus(principal, 'reservation:write', quelle.property_id)
        // Die Zeilenrichtlinie trennt Mandanten, nicht Haeuser.
        if (ziel.property_id !== quelle.property_id) {
          throw Errors.unprocessable('booking.mergeOtherProperty')
        }
        if ([ziel, quelle].some(x => x.source === 'channel' || x.external_reference !== null)) {
          throw Errors.unprocessable('booking.mergeChannel')
        }

        const umgezogen = await client.query<{
          public_ref: string; status: ReservationStatus; arrival: string; departure: string
          category_id: number; resource_id: number | null }>(
          `UPDATE reservation SET booking_id = $1, updated_at = now()
            WHERE booking_id = $2
          RETURNING public_ref, status, arrival::text, departure::text,
                    category_id, resource_id`, [ziel.id, quelle.id])
        await client.query(`DELETE FROM booking WHERE id = $1`, [quelle.id])
        /*
         * Die KWHotel-Gruppennummer geht mit, wenn die Zielbuchung keine
         * hat: sonst legte der naechste Import fuer neue Zimmer der Gruppe
         * wieder eine eigene Buchung an. Der Besteller nur, wo keiner steht.
         * Erst nach dem Loeschen, weil die Nummer je Haus eindeutig ist.
         */
        await client.query(
          `UPDATE booking
              SET legacy_system = CASE WHEN legacy_reference IS NULL THEN $2 ELSE legacy_system END,
                  legacy_reference = COALESCE(legacy_reference, $3),
                  booker_guest_id = COALESCE(booker_guest_id, $4),
                  booker_company_id = COALESCE(booker_company_id, $5)
            WHERE id = $1`,
          [ziel.id, quelle.legacy_system, quelle.legacy_reference,
           quelle.booker_guest_id, quelle.booker_company_id])

        await emitEvents(client, ziel.property_id, 'reservation.changed',
          umgezogen.rows.map(r => ({
            reservationRef: r.public_ref, bookingRef, status: r.status,
            arrival: r.arrival, departure: r.departure,
            categoryId: r.category_id, resourceId: r.resource_id })))

        return { bookingRef, moved: umgezogen.rows.map(r => r.public_ref) }
      })
    }
  })

  /**
   * Die ganze Gruppe in der Zeit verschieben.
   *
   * **Ein Versatz in Tagen, kein neuer Zeitraum.** Nach einzelnen
   * Aenderungen liegen die Zimmer einer Gruppe nicht mehr deckungsgleich --
   * zwei reisen einen Tag frueher an, eines bleibt laenger. Ein gemeinsamer
   * neuer Zeitraum machte daraus wieder einen Block und loeschte genau die
   * Abweichungen, die jemand von Hand eingetragen hat. Der Versatz erhaelt
   * sie: jeder Aufenthalt behaelt seine Laenge und seine Lage zu den
   * anderen.
   *
   * **Alle oder keiner.** Stoesst das fuenfte Zimmer an eine fremde
   * Reservierung, darf nicht die Haelfte der Gruppe eine Woche weiter
   * liegen als die andere. Eine Transaktion, und `aufenthaltVerlegen` wirft
   * -- der Rest rollt zurueck.
   *
   * Angefasst werden nur Aufenthalte, die Bestand halten. Ein storniertes
   * Zimmer der Gruppe mitzuschieben waere sinnlos und faende beim
   * Bestandszaehler keine Entsprechung.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/bookings/:bookingRef/change-stay',
    permission: 'reservation:write',
    summary: 'Alle Aufenthalte einer Buchung um dieselbe Zahl Tage verschieben',
    handler: async (req) => {
      const { bookingRef } = req.params as { bookingRef: string }
      const body = req.body as { shiftDays?: number; allowOverbooking?: boolean }
      if (!Number.isInteger(body.shiftDays) || body.shiftDays === 0) {
        throw Errors.validation({ shiftDays: ['field.nonZeroInteger'] })
      }
      const versatz = body.shiftDays!
      if (Math.abs(versatz) > MAX_STAY_NIGHTS) {
        throw Errors.validation({ shiftDays: ['field.maxValue'] }, { max: MAX_STAY_NIGHTS })
      }

      return tx(req.pool, req, async client => {
        /*
         * `FOR UPDATE OF r` sperrt die Reservierungen, nicht die
         * mitverbundene Buchung: ein `FOR UPDATE` ueber den ganzen Verbund
         * sperrte auch `booking`, und zwei Gruppen desselben Hauses haetten
         * sich gegenseitig blockiert, obwohl sie nichts gemeinsam haben.
         */
        const rows = await client.query<{ public_ref: string; arrival: string
                                          departure: string; status: ReservationStatus
                                          property_id: number }>(
          `SELECT r.public_ref, r.arrival::text, r.departure::text, r.status, r.property_id
             FROM reservation r
             JOIN booking b ON b.id = r.booking_id
            WHERE b.public_ref = $1
            ORDER BY r.id
              FOR UPDATE OF r`, [bookingRef])
        if (rows.rowCount === 0) throw Errors.notFound('res.booking')
        // Eine Buchung liegt in einem Haus; jede Zeile traegt es (Befund H4).
        for (const haus of new Set(rows.rows.map(r => r.property_id))) {
          rechtImHaus(req.principal as Principal, 'reservation:write', haus)
        }

        const beweglich = rows.rows.filter(r => occupiesInventory(r.status))
        if (beweglich.length === 0) throw Errors.conflict('stay.groupNothingToMove')
        await ueberbuchenErlauben(client, body.allowOverbooking)

        // Alle zusammen, in der Reihenfolge der ids -- dieselbe, in der die
        // Schleife sie frueher einzeln verlegte (`aufenthalteVerlegen`).
        const ergebnis = await aufenthalteVerlegen(client, beweglich.map(r => ({
          ref: r.public_ref,
          body: { arrival: addDays(r.arrival, versatz), departure: addDays(r.departure, versatz) }
        })))
        return { bookingRef, shiftDays: versatz, rooms: ergebnis }
      })
    }
  })

  /**
   * Ein Zimmer zu einer bestehenden Gruppe.
   *
   * **Warum nicht eine zweite Buchung.** Genau das ist der Fall, fuer den
   * es die Gruppe gibt: die Reisegruppe wird groesser, und das neunte
   * Zimmer gehoert zum selben Vorgang wie die ersten acht -- ein
   * Besteller, eine Rechnung, ein Storno. Als eigene Buchung angelegt
   * verbindet die beiden nichts mehr, und beim Abreisen faellt eines durch.
   *
   * **Zeitraum aus der Gruppe, nicht aus dem Aufruf.** Ohne Angabe gilt,
   * was die Gruppe schon hat -- die frueheste Anreise und die spaeteste
   * Abreise. Wer fuer dieses eine Zimmer andere Tage braucht, nennt sie;
   * dafuer ist die Maske da.
   *
   * Preis, Gast und Notiz kommen aus dem Aufruf, nicht aus der Gruppe. Den
   * Preis des ersten Zimmers zu uebernehmen waere die naheliegende
   * Bequemlichkeit und die falsche: das neunte Zimmer ist oft das teure,
   * das noch frei war.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/bookings/:bookingRef/rooms',
    permission: 'reservation:write',
    summary: 'Ein Zimmer zu einer bestehenden Buchung',
    handler: async (req, reply) => {
      const { bookingRef } = req.params as { bookingRef: string }
      const body = req.body as {
        categoryId?: number; resourceId?: number
        arrival?: string; departure?: string
        totalCent?: number; guestCount?: number; shortNote?: string
        adults?: number; children?: number; allowOverbooking?: boolean
      }
      const personen = personenAngabe(body)
      if (!Number.isInteger(body.categoryId)) {
        throw Errors.validation({ categoryId: ['field.required'] })
      }
      if (body.totalCent !== undefined
          && (!Number.isInteger(body.totalCent) || body.totalCent < 0)) {
        throw Errors.validation({ totalCent: ['field.positiveInteger'] })
      }
      if (body.shortNote !== undefined
          && body.shortNote.length > SHORT_NOTE_MAX_LENGTH) {
        throw Errors.validation({ shortNote: ['field.maxLength'] },
          { max: SHORT_NOTE_MAX_LENGTH })
      }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const b = await client.query<{
          id: number; property_id: number; booker_guest_id: number | null
          arrival: string; departure: string; rate_plan_id: number | null }>(
          `SELECT b.id, b.property_id, b.booker_guest_id,
                  min(r.arrival)::text AS arrival,
                  max(r.departure)::text AS departure,
                  min(r.rate_plan_id) AS rate_plan_id
             FROM booking b
             LEFT JOIN reservation r ON r.booking_id = b.id
            WHERE b.public_ref = $1
            GROUP BY b.id, b.property_id, b.booker_guest_id`, [bookingRef])
        if (b.rowCount === 0) throw Errors.notFound('res.booking')
        const buchung = b.rows[0]!
        rechtImHaus(principal, 'reservation:write', buchung.property_id)

        const arrival = body.arrival ?? buchung.arrival
        const departure = body.departure ?? buchung.departure
        if (arrival === null || departure === null
            || !isIsoDate(arrival) || !isIsoDate(departure)) {
          throw Errors.validation({ arrival: ['field.isoDate'] })
        }
        const naechte = nightsBetween(arrival, departure)
        if (naechte <= 0) throw Errors.validation({ departure: ['field.afterArrival'] })
        if (naechte > MAX_STAY_NIGHTS) {
          throw Errors.validation({ departure: ['field.stayTooLong'] },
            { max: MAX_STAY_NIGHTS })
        }

        const k = await client.query(
          `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
          [body.categoryId, buchung.property_id])
        if (k.rowCount === 0) throw Errors.notFound('res.category')

        /*
         * Zuerst den Bestand binden, dann das Zimmer pruefen, dann
         * schreiben -- dieselbe Reihenfolge wie beim Anlegen einer Buchung.
         * Andersherum stuende zwischen Pruefung und Bindung ein Fenster, in
         * dem ein zweiter Vorgang denselben Platz nimmt.
         */
        await ueberbuchenErlauben(client, body.allowOverbooking)
        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
          [buchung.property_id, body.categoryId, arrival, departure])
        inventoryError(inv.rows[0]!.e)

        if (body.resourceId !== undefined) {
          await assertUnitAssignable(client, {
            resourceId: body.resourceId, propertyId: buchung.property_id,
            arrival, departure })
        }

        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              rate_plan_id, primary_guest_id, short_note, resource_id, guest_count,
              adults, children, created_by)
           VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id, public_ref`,
          [buchung.property_id, buchung.id, body.categoryId, arrival, departure,
           buchung.rate_plan_id, buchung.booker_guest_id,
           body.shortNote?.trim() || null, body.resourceId ?? null,
           personen.guestCount, personen.adults, personen.children, principal.userId])
        const reservationId = res.rows[0]!.id

        const nights = eachNight(arrival, departure)
        const prices = body.totalCent !== undefined
          ? preisJeNacht(body.totalCent, nights.length)
          : await priceNights(client, buchung.rate_plan_id ?? undefined, nights)
        await client.query(
          `INSERT INTO reservation_night
             (reservation_id, property_id, date, rate_plan_id, price_cent)
           SELECT $1, $2, x.date, $3, x.price
             FROM unnest($4::date[], $5::bigint[]) AS x(date, price)`,
          [reservationId, buchung.property_id, buchung.rate_plan_id, nights, prices])

        await client.query(
          `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
           VALUES ($1,$2,$3,'guest')`,
          [buchung.property_id, reservationId, buchung.booker_guest_id])

        const summe = prices.reduce((s, x) => s + x, 0)
        await emitEvent(client, buchung.property_id, 'reservation.created', {
          bookingRef, reservationRef: res.rows[0]!.public_ref,
          categoryId: body.categoryId, resourceId: body.resourceId ?? null,
          arrival, departure, nights: nights.length, totalCent: summe
        })

        reply.status(201)
        return {
          bookingRef, reservationRef: res.rows[0]!.public_ref,
          categoryId: body.categoryId!, resourceId: body.resourceId ?? null,
          arrival, departure, nights: nights.length, totalCent: summe
        }
      })
    }
  })

  const action = (
    url: string, act: ReservationAction, permission: Parameters<typeof registerRoute>[1]['permission'],
    summary: string
  ) => registerRoute(app, {
    method: 'POST', url, permission, propertyParam: 'propertyId', summary,
    handler: async (req) => {
      const { reservationRef: pfadRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      const wechseln = async (client: PoolClient, reservationRef: string) => {
        const cur = await client.query<{
          id: number; property_id: number; category_id: number; status: ReservationStatus
          arrival: string; departure: string; resource_id: number | null
          block_id: number | null
        }>(`SELECT id, property_id, category_id, status,
                   arrival::text, departure::text, resource_id, block_id
              FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.reservation')
        const r = cur.rows[0]!
        /*
         * `propertyParam` greift hier nur, wenn der Aufrufer eine Property
         * mitschickt -- der Pfad traegt keine, und ohne Angabe prueft
         * `registerRoute` das Recht "irgendwo". Mit Angabe stuende Haus A im
         * Rumpf und die Reservierung aus Haus B im Pfad (Befund H4).
         */
        if (permission !== null) rechtImHaus(principal, permission, r.property_id)

        let target: ReservationStatus
        try { target = applyAction(r.status, act) }
        catch (e) {
          if (e instanceof InvalidTransitionError) throw Errors.conflict(e.message)
          throw e
        }

        /*
         * **Check-out mit offenem Saldo fragt nach** (Pruefung 13.10.2026,
         * Befund 6).
         *
         * Ein Klick checkte aus, auch wenn am Folio noch Geld offen war oder
         * Positionen ohne Rechnung standen. Folios werden nie geschlossen;
         * eine vergessene Rechnung fiel nur noch ueber die Liste des
         * Nachtlaufs ab 500 Euro auf. Beherbergung ist eine Leistung im
         * Zusammenhang mit einem Grundstueck, die Rechnung ist deshalb auch
         * gegenueber Privatgaesten Pflicht (§ 14 Abs. 2 Satz 1 Nr. 1 UStG).
         *
         * Gesperrt wird nicht: ein Firmengast zahlt auf Rechnung, die erst
         * Tage spaeter geschrieben wird, und ein Gast, der abgereist ist,
         * ist abgereist. Die Rezeption bestaetigt, dann geht es durch.
         * Maschinenzugaenge (Adminpanel) fragt niemand -- dort sitzt kein
         * Mensch, der bestaetigen koennte, und der Abgleich laeuft dort.
         *
         * Das Gruppenfolio zaehlt nicht mit: es haengt an der ersten
         * Reservierung der Buchung, gehoert aber der ganzen Gruppe, und
         * wer das erste Zimmer auscheckt, rechnet nicht die Gruppe ab.
         */
        const body = (req.body ?? {}) as { openBalance?: string }
        if (act === 'check_out' && principal.userId !== null
            && body.openBalance !== 'accept') {
          const offen = await client.query<{ saldo: string; posten: number }>(
            `SELECT COALESCE((SELECT sum(c.gross_cent) FROM charge c
                                JOIN folio f ON f.id = c.folio_id
                               WHERE f.reservation_id = $1 AND f.kind <> 'group'), 0)
                  - COALESCE((SELECT sum(s.amount_cent) FROM settlement s
                                JOIN folio f ON f.id = s.folio_id
                               WHERE f.reservation_id = $1 AND f.kind <> 'group'), 0) AS saldo,
                    (SELECT count(*)::int FROM charge c
                       JOIN folio f ON f.id = c.folio_id
                      WHERE f.reservation_id = $1 AND f.kind <> 'group' AND c.invoice_id IS NULL
                        AND c.gross_cent <> 0 AND c.reverses_id IS NULL
                        -- Gegengebucht und noch offen: hebt sich auf.
                        AND NOT EXISTS (SELECT 1 FROM charge g
                                         WHERE g.reverses_id = c.id AND g.invoice_id IS NULL)
                        -- Die Kurtaxe steht auf keiner Rechnung (0157).
                        AND NOT EXISTS (SELECT 1 FROM tax_rule tr
                                         WHERE tr.id = c.tax_rule_id
                                           AND tr.kind = 'city_tax')) AS posten`,
            [r.id])
          const saldo = Number(offen.rows[0]!.saldo)
          const posten = offen.rows[0]!.posten
          if (saldo !== 0 || posten > 0) {
            throw Errors.conflict('checkout.openBalance', {
              amount: (saldo / 100).toFixed(2), items: posten })
          }
        }

        /*
         * **Wer vorzeitig abreist, dessen Aufenthalt endet heute.**
         *
         * Ohne das stand der abgereiste Gast im Plan bis zur gebuchten
         * Abreise im Zimmer, obwohl der Bestand frei war, und die Naechte,
         * die er nie geschlafen hat, standen in seinem Aufenthalt. Danach
         * laesst sich nichts mehr verkuerzen: ein abgereister Aufenthalt
         * bindet keinen Bestand, und `aufenthaltVerlegen` weist ihn ab.
         *
         * Gemessen am Geschaeftstag, nicht an der Uhr: wer nach Mitternacht
         * vor dem Tagesabschluss auscheckt, reist am alten Tag ab. Gebuchte
         * Naechte bleiben, an ihnen haengen Belege. Am Anreisetag selbst
         * bleibt die eine Nacht stehen; ein Aufenthalt ohne Nacht ist keiner.
         */
        let checkoutUndo: CheckoutUndo | null = null
        if (act === 'check_out' && r.status === 'InHouse') {
          const heute = await geschaeftstag(client, r.property_id)
          const ende = heute > r.arrival ? heute : addDays(r.arrival, 1)
          // Was der Check-out wegnimmt, bleibt an der Reservierung stehen,
          // bis jemand ihn zuruecknimmt (0094). Die Naechte mit ihrem
          // Preis, nicht nur die Abreise: ein vereinbarter Preis ginge
          // beim Neurechnen im Durchschnitt unter.
          checkoutUndo = { businessDate: heute, departure: r.departure, nights: [] }
          // Vor der Anreise gibt es nichts zu kuerzen: der Geschaeftstag
          // weiss dann nicht, wann der Gast wirklich da war.
          if (heute >= r.arrival && ende < r.departure) {
            const weg = await client.query<{ date: string; price_cent: string
                                             rate_plan_id: number | null }>(
              `SELECT date::text, price_cent, rate_plan_id FROM reservation_night
                WHERE reservation_id = $1 AND NOT posted AND date >= $2::date
                ORDER BY date`, [r.id, ende])
            checkoutUndo.nights = weg.rows.map(n => ({
              date: n.date, priceCent: Number(n.price_cent), ratePlanId: n.rate_plan_id }))
            await aufenthaltVerlegen(client, reservationRef, { departure: ende })
            r.departure = ende
          }
        }

        /*
         * **Check-out zuruecknehmen, am selben Geschaeftstag.**
         *
         * Der Fall, der das braucht (Sven, 06.10.2026): ein eingecheckter
         * Gast sollte nur das Zimmer wechseln, und der einzige Weg, der
         * offen aussah, war der Check-out. Danach war der Aufenthalt auf
         * eine Nacht gekuerzt, abgereist und nicht mehr zu bearbeiten.
         *
         * **Warum nur am selben Tag.** Der Nachtlauf bucht die Logis nur
         * fuer Gaeste im Haus. Stand der Gast beim Tagesabschluss als
         * abgereist da, fehlt diese Nacht auf dem Konto, und ein
         * Zuruecknehmen am Tag danach machte daraus eine Nacht, die er
         * geschlafen und nie bezahlt hat -- ohne dass es irgendwo
         * auffiele. Ein Check-out von vor dieser Migration hat keinen
         * festgehaltenen Tag; dort gilt dieselbe Regel ueber die Naechte:
         * jede Nacht vor heute muss gebucht sein.
         *
         * Das Zimmer muss bis zur alten Abreise noch frei sein. Ist es
         * inzwischen vergeben, bleibt der Gast abgereist; die Meldung
         * nennt das Zimmer, und die Rezeption entscheidet.
         */
        let undo: CheckoutUndo | null = null
        if (act === 'undo_check_out') {
          const heute = await geschaeftstag(client, r.property_id)
          const gespeichert = await client.query<{ u: CheckoutUndo | null }>(
            `SELECT checkout_undo AS u FROM reservation WHERE id = $1`, [r.id])
          undo = gespeichert.rows[0]!.u
          if (undo !== null) {
            if (undo.businessDate !== heute) throw Errors.unprocessable('stay.undoCheckoutLate')
          } else {
            const offen = await client.query(
              `SELECT 1 FROM reservation_night
                WHERE reservation_id = $1 AND NOT posted AND date < $2::date LIMIT 1`,
              [r.id, heute])
            if ((offen.rowCount ?? 0) > 0 || heute > r.departure) {
              throw Errors.unprocessable('stay.undoCheckoutLate')
            }
          }
          if (r.resource_id !== null) {
            const bis = undo !== null && undo.departure > r.departure ? undo.departure : r.departure
            // Nach einem Zimmerwechsel (0195) nur der letzte Abschnitt: in
            // den Zimmern davor hat der Gast seine Naechte schon gehabt.
            const letzter = await client.query<{ resource_id: number; ab: string }>(
              `SELECT resource_id, from_date::text AS ab FROM reservation_room_part
                WHERE reservation_id = $1 ORDER BY from_date DESC LIMIT 1`, [r.id])
            const teil = letzter.rows[0]
            await assertUnitAssignable(client, {
              resourceId: teil?.resource_id ?? r.resource_id, propertyId: r.property_id,
              arrival: teil?.ab ?? r.arrival, departure: bis, exceptReservationId: r.id })
          }
        }

        /*
         * **Zuruecknehmen nur, solange keine Nacht gebucht ist.** Am
         * Anreisetag vor dem Tagesabschluss ist ein Check-in nur ein
         * Zustand; danach haengt an ihm eine Logisbuchung, und die ist
         * Haertegrad 1. Eine bestaetigte Reservierung mit gebuchter Nacht
         * waere ein Gast, der bezahlt hat und nicht da war -- das ist ein
         * Storno mit Gegenbuchung oder ein Check-out, kein Versehen mehr.
         * Dazu gilt nach dem Tagesabschluss Svens Regel (0088): wer im
         * Kalender steht, ist angereist.
         */
        if (act === 'undo_check_in') {
          const gebucht = await client.query(
            `SELECT 1 FROM reservation_night WHERE reservation_id = $1 AND posted LIMIT 1`,
            [r.id])
          if ((gebucht.rowCount ?? 0) > 0) throw Errors.unprocessable('stay.undoCheckinPosted')
        }

        /*
         * **Nicht angereist, auch nach dem Tagesabschluss.** Seit 0088
         * checkt der Nachtlauf jede Anreise mit Zimmer ein (Svens Regel:
         * was im Kalender steht, ist da). Kommt der Gast doch nicht, war
         * er bisher nicht mehr loszuwerden: Zuruecknehmen scheitert an der
         * gebuchten Nacht, Stornieren am Zustand. Die Ausnahme von der
         * Regel ist genau diese Handlung der Rezeption, keine Automatik.
         *
         * Vor der Anreise ist niemand ein No-Show; das waere ein Storno.
         * Die Logis und Kurtaxe, die der Nachtlauf gebucht hat, gehen per
         * Gegenbuchung zurueck (Haertegrad 1), mit dem heutigen
         * Geschaeftstag -- der gebuchte Tag ist abgeschlossen.
         */
        if (act === 'no_show') {
          const heute = await geschaeftstag(client, r.property_id)
          if (heute < r.arrival) throw Errors.unprocessable('stay.noShowBeforeArrival')
          if (r.status === 'InHouse') {
            await gebuchteNaechteGegenbuchen(client, r.id, r.property_id, heute,
                                             principal.userId)
          }
        }

        if (act === 'check_in' && r.resource_id === null) {
          throw Errors.unprocessable('stay.checkinNeedsRoom')
        }

        /*
         * Ein abgerufener Platz faellt an die Gruppe zurueck, nicht in den
         * freien Verkauf.
         *
         * Sonst verloere eine Gruppe bei jedem Storno ein Zimmer an
         * Laufkundschaft und stuende am Anreisetag mit zu wenigen da, obwohl
         * sie dieselbe Menge vereinbart hatte. Ist das Kontingent bereits
         * freigegeben, gibt es nichts mehr, wohin der Platz zurueckkoennte;
         * dann ist der freie Verkauf richtig.
         */
        const block = r.block_id === null
          ? null
          : (await client.query<{ id: number; status: string; category_id: number
                                  from_date: string; to_date: string }>(
              `SELECT id, status, category_id, from_date::text, to_date::text
                 FROM availability_block WHERE id = $1 FOR UPDATE`, [r.block_id])).rows[0] ?? null

        /*
         * Ob Bestand gebunden wird, entscheidet der **Zustand**, nicht die
         * Handlung. Hier stand das Paar Storno/Wiederherstellen
         * ausgeschrieben, und dabei fehlte ein Fall: ein No-Show, der doch
         * noch anreist, geht nicht ueber dieses Paar - er geht ueber
         * `check_in` direkt nach `InHouse`, einen bindenden Zustand, ohne
         * dass je wieder gebunden wurde. Das Zimmer war belegt und der
         * Zaehler sagte frei; auffallen wuerde das als Ueberbuchung, nicht
         * als Fehlermeldung. `occupiesInventory` fuer Vorher und Nachher
         * deckt jeden Weg ab, auch die, die es noch nicht gibt.
         */
        const bandVorher = occupiesInventory(r.status)
        const bindetNachher = occupiesInventory(target)

        // Kontingent freigeben, sobald die Reservierung es nicht mehr bindet.
        if (bandVorher && !bindetNachher) {
          await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
            [r.property_id, r.category_id, r.arrival, r.departure])
          if (block !== null && block.status === 'active') {
            await client.query(`SELECT inventory_block($1,$2,$3::date,$4::date,1)`,
              [r.property_id, block.category_id, block.from_date, block.to_date])
            await client.query(
              `UPDATE availability_block SET picked_up = picked_up - 1 WHERE id = $1`,
              [block.id])
          }
        }
        if (!bandVorher && bindetNachher) {
          // Wiederherstellung: derselbe Weg wie beim Abruf, erst freigeben,
          // dann binden.
          if (block !== null && block.status === 'active') {
            await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,1)`,
              [r.property_id, block.category_id, block.from_date, block.to_date])
          }
          const inv = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
            [r.property_id, r.category_id, r.arrival, r.departure])
          inventoryError(inv.rows[0]!.e)
          if (block !== null && block.status === 'active') {
            await client.query(
              `UPDATE availability_block SET picked_up = picked_up + 1 WHERE id = $1`,
              [block.id])
          }
        }

        // Ein zurueckgenommener Storno ist kein Storno mehr: der Zeitstempel
        // muss mit dem Zustand zurueckgehen, sonst zeigt das Seitenfenster
        // "Storniert am" an einer wieder bestaetigten Reservierung (A11).
        const stamp = act === 'check_in' ? 'checked_in_at = now(),'
          : act === 'check_out' ? 'checked_out_at = now(),'
          : act === 'cancel' ? 'canceled_at = now(),'
          : act === 'reinstate' ? 'canceled_at = NULL,'
          : act === 'undo_check_in' ? 'checked_in_at = NULL,'
          : act === 'undo_check_out' ? 'checked_out_at = NULL,'
          // Der Nachtlauf hat ihn eingecheckt, nicht der Gast.
          : act === 'no_show' ? 'checked_in_at = NULL,' : ''
        // Was ein Check-out festhaelt, gilt nur bis zum naechsten Zustand.
        await client.query(
          `UPDATE reservation SET status = $2, ${stamp} checkout_undo = $3::jsonb,
                  updated_at = now() WHERE id = $1`,
          [r.id, target, checkoutUndo === null ? null : JSON.stringify(checkoutUndo)])

        /*
         * Die alte Abreise zurueck, ueber dieselbe Rechnung wie jede
         * Verlaengerung: Bestand, Zimmer und Naechte in einem Zug. Danach
         * bekommen die Naechte den Preis, den sie vor dem Check-out hatten,
         * statt des Durchschnitts, den `aufenthaltVerlegen` vorschlaegt.
         */
        if (act === 'undo_check_out' && undo !== null && undo.departure > r.departure) {
          await aufenthaltVerlegen(client, reservationRef, { departure: undo.departure })
          r.departure = undo.departure
          if (undo.nights.length > 0) {
            await client.query(
              `UPDATE reservation_night n
                  SET price_cent = x.price, rate_plan_id = x.plan
                 FROM unnest($2::date[], $3::bigint[], $4::bigint[]) AS x(date, price, plan)
                WHERE n.reservation_id = $1 AND n.date = x.date AND NOT n.posted`,
              [r.id, undo.nights.map(n => n.date), undo.nights.map(n => n.priceCent),
               undo.nights.map(n => n.ratePlanId)])
          }
        }

        await emitEvent(client, r.property_id, EVENT_FOR_ACTION[act], {
          reservationRef, status: target,
          arrival: r.arrival, departure: r.departure,
          categoryId: r.category_id, resourceId: r.resource_id
        })

        return { reservationRef, status: target, by: principal.userId }
      }

      /*
       * **Die Gruppe in einem Zug einchecken** (Sven, 15.10.2026: "es
       * muessen natuerlich alle Zimmer der Gruppe eingecheckt werden").
       *
       * Der Meldeschein einer Gruppe haengt an einem Zimmer und nennt alle
       * Personen; eingecheckt wurde trotzdem nur dieses eine, die anderen
       * standen bis zum Nachtlauf als Anreise da. Die weiteren Zimmer kommen
       * im Rumpf, weil die Rezeption sie abwaehlen kann -- ein Teil der
       * Gruppe kommt mit dem spaeteren Bus. Alles in einer Transaktion: ein
       * Zimmer, das nicht geht, haelt die ganze Gruppe an, statt eine halb
       * eingecheckte zu hinterlassen, die niemand bemerkt.
       */
      const mit = act === 'check_in'
        ? ((req.body ?? {}) as { groupReservationRefs?: unknown }).groupReservationRefs
        : undefined
      if (mit !== undefined && (!Array.isArray(mit) || mit.length > GRUPPE_MAX_ZIMMER
          || mit.some(x => typeof x !== 'string'))) {
        throw Errors.validation({ groupReservationRefs: ['field.invalid'] })
      }
      const weitere = [...new Set((mit ?? []) as string[])].filter(x => x !== pfadRef)
      return tx(req.pool, req, async client => {
        const ergebnis = await wechseln(client, pfadRef)
        if (weitere.length === 0) return ergebnis
        const gleiche = await client.query<{ ref: string }>(
          `SELECT x.public_ref AS ref FROM reservation x
             JOIN reservation h ON h.booking_id = x.booking_id
            WHERE h.public_ref = $1 AND x.public_ref = ANY($2::text[])
            ORDER BY x.id`, [pfadRef, weitere])
        if (gleiche.rowCount !== weitere.length) {
          throw Errors.unprocessable('stay.groupCheckinForeign')
        }
        const gruppe = []
        for (const g of gleiche.rows) gruppe.push(await wechseln(client, g.ref))
        return { ...ergebnis, group: gruppe.map(g => ({ reservationRef: g.reservationRef,
                                                         status: g.status })) }
      })
    }
  })

  action('/v1/reservations/:reservationRef/confirm', 'confirm', 'reservation:write', 'Bestaetigen')
  action('/v1/reservations/:reservationRef/check-in', 'check_in', 'reservation:checkin', 'Check-in')
  action('/v1/reservations/:reservationRef/check-out', 'check_out', 'reservation:checkin', 'Check-out')
  // Ein versehentlicher Check-in war bisher nur per Check-out loszuwerden,
  // und der kuerzte den Aufenthalt auf heute und gab das Zimmer frei.
  action('/v1/reservations/:reservationRef/undo-check-in', 'undo_check_in', 'reservation:checkin',
    'Check-in zuruecknehmen')
  // Ein Check-out kuerzt den Aufenthalt und gibt das Zimmer frei; ein
  // Fehlgriff war damit endgueltig (Sven, 06.10.2026).
  action('/v1/reservations/:reservationRef/undo-check-out', 'undo_check_out',
    'reservation:checkin', 'Check-out zuruecknehmen')
  // Der Nachtlauf checkt Anreisen ein (0088); wer trotzdem nicht kam, wird
  // hier No-Show -- vor dem Tagesabschluss aus `Confirmed`, danach aus
  // `InHouse` samt Gegenbuchung der gebuchten Naechte.
  action('/v1/reservations/:reservationRef/no-show', 'no_show', 'reservation:checkin',
    'Als nicht angereist markieren')
  action('/v1/reservations/:reservationRef/cancel', 'cancel', 'reservation:write', 'Stornieren')
  // Der Zustandsautomat kennt `reinstate` seit jeher, einen Weg dorthin gab
  // es nicht: ein versehentlicher Storno war damit endgueltig, und ein
  // No-Show, der doch noch anreist, kam nur ueber den Check-in zurueck.
  action('/v1/reservations/:reservationRef/reinstate', 'reinstate', 'reservation:write',
    'Storno oder No-Show zuruecknehmen')

  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/assign-unit',
    permission: 'reservation:write',
    summary: 'Zimmer zuweisen oder wieder abnehmen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { resourceId } = req.body as { resourceId: number | null }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number; category_id: number
                                       arrival: string; departure: string
                                       status: ReservationStatus; room_moved: boolean }>(
          `SELECT id, property_id, category_id, arrival::text, departure::text, status,
                  room_moved
             FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        rechtImHaus(req.principal as Principal, 'reservation:write', res.property_id)
        /*
         * Ein geteilter Aufenthalt (0195) hat mehr als ein Zimmer; welches
         * hier gemeint waere, weiss die Route nicht. Mit einer Ausnahme:
         * liegt sein letzter Abschnitt im Band (0196), ist es dieser -- der
         * Balken, den die Rezeption aus dem Band in eine Zeile zieht.
         */
        if (res.room_moved) {
          const band = await client.query<{ from_date: string }>(
            `SELECT from_date::text FROM reservation_room_part
              WHERE reservation_id = $1 AND from_date < $2::date
              ORDER BY from_date DESC LIMIT 1`, [res.id, res.departure])
          const letzter = band.rows[0]
          const leer = letzter === undefined ? null : await client.query<{ leer: boolean }>(
            `SELECT resource_id IS NULL AS leer FROM reservation_room_part
              WHERE reservation_id = $1 AND from_date = $2::date`, [res.id, letzter.from_date])
          if (resourceId === null || letzter === undefined || leer?.rows[0]?.leer !== true) {
            throw Errors.conflict('stay.roomMovedUseMove')
          }
          await assertUnitAssignable(client, {
            resourceId, propertyId: res.property_id,
            arrival: letzter.from_date, departure: res.departure, exceptReservationId: res.id })
          const heute = await geschaeftstag(client, res.property_id)
          await client.query(`SELECT reservation_room_move($1, $2::date, $3, $4::date)`,
                             [res.id, letzter.from_date, resourceId, heute])
          const nachher = await client.query<{ resource_id: number | null }>(
            `SELECT resource_id::int FROM reservation WHERE id = $1`, [res.id])
          await emitEvent(client, res.property_id, 'reservation.changed', {
            reservationRef, status: res.status, arrival: res.arrival, departure: res.departure,
            categoryId: res.category_id, resourceId: nachher.rows[0]?.resource_id ?? null,
            roomMove: { from: letzter.from_date, resourceId }
          })
          return { reservationRef, resourceId }
        }

        /*
         * `null` nimmt das Zimmer wieder ab und legt die Buchung zurueck
         * ins Band der Unzugewiesenen.
         *
         * **Warum das gebraucht wird.** Im vollen Haus geht Umsortieren
         * nicht in einem Zug: das Zimmer, das man freimachen will, ist erst
         * frei, wenn sein Gast woanders liegt -- und der passt nur dorthin,
         * wo der erste noch liegt. Ohne einen Zwischenablageplatz muesste
         * die Rezeption stornieren und neu buchen, und das ist zweimal
         * falsch: der Vorgang verliert seine Geschichte, und zwischen
         * beidem ist der Platz im freien Verkauf.
         *
         * Der **Bestand bleibt unberuehrt**: gezaehlt wird je Zimmergruppe,
         * und die Buchung haelt ihren Platz weiter. Nur die Zeile im Plan
         * wechselt.
         *
         * **Nicht bei angereistem Gast.** Der liegt im Zimmer; die Zeile im
         * Plan zu leeren hiesse, die Hausliste und die Reinigung auf ein
         * leeres Zimmer zu schicken, in dem jemand schlaeft.
         */
        if (resourceId === null) {
          if (res.status === 'InHouse') throw Errors.conflict('stay.inHouseKeepsRoom')
        } else {
          await assertUnitAssignable(client, {
            resourceId, propertyId: res.property_id,
            arrival: res.arrival, departure: res.departure, exceptReservationId: res.id })
        }

        await client.query(
          `UPDATE reservation SET resource_id = $2, updated_at = now() WHERE id = $1`,
          [res.id, resourceId])

        await emitEvent(client, res.property_id, 'reservation.changed', {
          reservationRef, resourceId,
          arrival: res.arrival, departure: res.departure,
          categoryId: res.category_id
        })

        return { reservationRef, resourceId }
      })
    }
  })

  /**
   * Zwei Aufenthalte tauschen ihre Zimmer, in einem Zug.
   *
   * Der Fall (Sven, 06.10.2026): ein Gast ist eingecheckt und soll in ein
   * anderes Zimmer, in dem schon jemand geplant ist. Umsortieren lief
   * bisher ueber die Ablage, und ein angereister Gast kommt dort nicht
   * hin -- er liegt im Zimmer, und Hausliste und Reinigung saehen sonst
   * ein leeres Zimmer, in dem jemand schlaeft. Der Weg, der dann offen
   * aussah, war der Check-out, und der kuerzte den Aufenthalt.
   *
   * Ein Tausch braucht die Ablage nicht: beide wechseln in derselben
   * Transaktion, und es gibt keinen Augenblick, in dem einer ohne Zimmer
   * ist. Geprueft wird jedes Zimmer fuer den Aufenthalt, der hineinzieht,
   * wobei die beiden Tauschenden einander nicht stoeren. Bestand und Tage
   * bleiben, wie sie sind -- gezaehlt wird je Zimmergruppe, und beide
   * halten ihren Platz. Wer dabei die Gruppe wechselt, ist ein Upgrade wie
   * bei `assign-unit`.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/swap-room',
    permission: 'reservation:write',
    summary: 'Zimmer mit einem anderen Aufenthalt tauschen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { withReservationRef } = (req.body ?? {}) as { withReservationRef?: unknown }
      if (typeof withReservationRef !== 'string' || withReservationRef === reservationRef) {
        throw Errors.validation({ withReservationRef: ['field.required'] })
      }
      return tx(req.pool, req, async client => {
        // Beide in fester Reihenfolge sperren: zwei Tausche ueber Kreuz
        // liefen sonst in eine Verklemmung.
        const rs = await client.query<{ id: number; public_ref: string; property_id: number
                                        category_id: number; status: ReservationStatus
                                        arrival: string; departure: string
                                        resource_id: number | null; room_moved: boolean }>(
          `SELECT id, public_ref, property_id, category_id, status,
                  arrival::text, departure::text, resource_id, room_moved
             FROM reservation WHERE public_ref = ANY($1::text[])
            ORDER BY id FOR UPDATE`, [[reservationRef, withReservationRef]])
        const a = rs.rows.find(x => x.public_ref === reservationRef)
        const b = rs.rows.find(x => x.public_ref === withReservationRef)
        if (a === undefined || b === undefined) throw Errors.notFound('res.reservation')
        // Die Zeilenrichtlinie trennt Mandanten, nicht Haeuser.
        if (a.property_id !== b.property_id) throw Errors.notFound('res.reservation')
        rechtImHaus(req.principal as Principal, 'reservation:write', a.property_id)
        if (!occupiesInventory(a.status) || !occupiesInventory(b.status)) {
          throw Errors.conflict('stay.statusHoldsNoInventory',
            { status: occupiesInventory(a.status) ? b.status : a.status })
        }
        if (a.resource_id === null || b.resource_id === null
            || a.resource_id === b.resource_id) {
          throw Errors.unprocessable('stay.swapNeedsRooms')
        }
        // Getauscht werden ganze Aufenthalte; ein geteilter liegt nicht ganz
        // in einem Zimmer (0195).
        if (a.room_moved || b.room_moved) throw Errors.conflict('stay.roomMovedUseMove')
        await assertUnitAssignable(client, {
          resourceId: b.resource_id, propertyId: a.property_id,
          arrival: a.arrival, departure: a.departure,
          exceptReservationId: a.id, alsoExceptReservationId: b.id })
        await assertUnitAssignable(client, {
          resourceId: a.resource_id, propertyId: a.property_id,
          arrival: b.arrival, departure: b.departure,
          exceptReservationId: a.id, alsoExceptReservationId: b.id })

        await client.query(
          `UPDATE reservation r SET resource_id = x.res, updated_at = now()
             FROM unnest($1::bigint[], $2::bigint[]) AS x(id, res)
            WHERE r.id = x.id`,
          [[a.id, b.id], [b.resource_id, a.resource_id]])

        for (const [x, neu] of [[a, b.resource_id], [b, a.resource_id]] as const) {
          await emitEvent(client, x.property_id, 'reservation.changed', {
            reservationRef: x.public_ref, status: x.status, resourceId: neu,
            arrival: x.arrival, departure: x.departure, categoryId: x.category_id })
        }
        return { reservationRef, resourceId: b.resource_id,
                 withReservationRef, withResourceId: a.resource_id }
      })
    }
  })

  /**
   * Aufenthalt ändern: Verlängerung, Verkürzung, Kategoriewechsel,
   * Zimmerwechsel — einzeln oder zusammen (E11, Dokument 13).
   *
   * Der Fall, der diese Route nötig macht: der Gast bleibt länger, seine
   * Kategorie ist aber ausgebucht, eine andere frei. Das ist eine
   * Verlängerung **plus** einen Umzug, und beides muss zusammen gelingen
   * oder zusammen scheitern.
   *
   * Zwei Aufrufe hintereinander wären falsch, nicht nur unbequem: zwischen
   * Freigeben und Neubelegen ist das Kontingent frei, und genau dann kauft
   * es das Portal. Der Gast verlöre sein Zimmer, obwohl er es schon hatte.
   * `inventory_move` bindet deshalb zuerst und gibt erst danach frei.
   *
   * **`resourceId` kam später dazu, aus demselben Grund.** Ein Balken im
   * Plan lässt sich schräg ziehen — anderes Zimmer und andere Tage —, und
   * genau dann geht es nicht in zwei Schritten: das Zielzimmer ist an den
   * alten Tagen belegt, die alte Zeile an den neuen. Wer zuerst das eine
   * tut, wird abgewiesen, und wer zuerst das andere tut, auch. Die Lücke,
   * in die der Gast soll, ist nur diagonal erreichbar.
   *
   * Wer **nur** das Zimmer wechselt, nimmt weiterhin `assign-unit`: die
   * Route hier verlegt einen Aufenthalt und weist deshalb einen Abruf aus
   * einem Kontingent ab — dessen Tage gehören dem Kontingent. Ein Zimmer
   * bekommt auch der Abruf.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/change-stay',
    permission: 'reservation:write',
    summary: 'Aufenthalt verlaengern, verkuerzen oder umbuchen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = aenderungLesen(req.body)
      return tx(req.pool, req, async client => {
        await rechtAnReservierung(client, req.principal as Principal, reservationRef)
        await ueberbuchenErlauben(client, body.allowOverbooking)
        return aufenthaltVerlegen(client, reservationRef, body)
      })
    }
  })

  /**
   * Was `change-stay` mit diesem Rumpf ergaebe -- ohne es zu speichern.
   *
   * Die Maske vor einem Zug im Plan zeigt den neuen Preis, bevor jemand
   * bestaetigt (Sven, 05.10.2026: "da aendert sich der Preis, und das muss
   * geprueft werden"). Gerechnet wird **dieselbe** Aenderung in einem
   * Sicherungspunkt, der danach zurueckgenommen wird. Eine zweite
   * Rechnung fuer die Vorschau waere bequemer und liefe beim naechsten
   * Umbau auseinander -- dann zeigte die Maske einen Preis, und gespeichert
   * wuerde ein anderer. So scheitert die Vorschau auch an genau dem, woran
   * das Speichern scheitern wuerde: ein belegtes Zimmer, ein ausgebuchter
   * Tag.
   *
   * **Eine volle Zimmergruppe ist hier eine Warnung, kein Fehler.** Die
   * Vorschau rechnet dann ein zweites Mal mit bestaetigter Ueberbuchung und
   * meldet `overbooking: true`; die Maske zeigt es an und schickt beim
   * Speichern die Bestaetigung mit (Sven, 06.10.2026). Andernfalls stuende
   * in der Maske nur "kein Kontingent", und der Preis fehlte genau dort,
   * wo jemand bewusst umsortiert.
   *
   * POST und `reservation:write`, obwohl nichts bleibt: die Rechnung sperrt
   * die Reservierung und bewegt kurz Bestand, und wer nicht aendern darf,
   * hat an der Vorschau einer Aenderung nichts zu suchen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/change-stay/preview',
    permission: 'reservation:write',
    summary: 'Aufenthalt aendern: Vorschau mit neuem Preis, ohne zu speichern',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = aenderungLesen(req.body)
      return tx(req.pool, req, async client => {
        await rechtAnReservierung(client, req.principal as Principal, reservationRef)
        const vorher = await client.query<{ total: string }>(
          `SELECT COALESCE(sum(n.price_cent), 0)::bigint AS total
             FROM reservation r
             LEFT JOIN reservation_night n ON n.reservation_id = r.id
            WHERE r.public_ref = $1`, [reservationRef])
        await client.query('SAVEPOINT vorschau')
        try {
          await ueberbuchenErlauben(client, body.allowOverbooking)
          let overbooking = body.allowOverbooking === true
          let ergebnis
          try {
            ergebnis = await aufenthaltVerlegen(client, reservationRef, body)
          } catch (e) {
            if (!(e instanceof AppError) || e.type !== SOLD_OUT || overbooking) throw e
            await client.query('ROLLBACK TO SAVEPOINT vorschau')
            await ueberbuchenErlauben(client, true)
            overbooking = true
            ergebnis = await aufenthaltVerlegen(client, reservationRef, body)
          }
          const vollAn = overbooking
            ? await volleTage(client, reservationRef) : []
          const naechte = await client.query<{ date: string; priceCent: string
                                                posted: boolean }>(
            `SELECT n.date::text, n.price_cent AS "priceCent", n.posted
               FROM reservation_night n
               JOIN reservation r ON r.id = n.reservation_id
              WHERE r.public_ref = $1 ORDER BY n.date`, [reservationRef])
          return {
            reservationRef,
            arrival: ergebnis.arrival,
            departure: ergebnis.departure,
            previousTotalCent: Number(vorher.rows[0]?.total ?? 0),
            totalCent: ergebnis.totalCent,
            overbooking,
            fullDays: vollAn,
            nights: naechte.rows.map(n => ({
              date: n.date, priceCent: Number(n.priceCent), posted: n.posted }))
          }
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT vorschau')
        }
      })
    }
  })
}

/**
 * `reservation:write` im Haus der Reservierung, bevor `aufenthaltVerlegen`
 * irgendetwas anfasst (Befund H4). Eigene Abfrage, weil die Verlegung ihre
 * Zeile selbst laedt und auch fuer die Gruppe laeuft, die schon geprueft hat.
 */
async function rechtAnReservierung(
  client: PoolClient, principal: Principal, reservationRef: string
): Promise<void> {
  const r = await client.query<{ property_id: number }>(
    `SELECT property_id FROM reservation WHERE public_ref = $1`, [reservationRef])
  if (r.rowCount === 0) throw Errors.notFound('res.reservation')
  rechtImHaus(principal, 'reservation:write', r.rows[0]!.property_id)
}

/**
 * **Woran die Gruppe voll ist**, je Tag des Aufenthalts danach.
 *
 * "Die Zimmergruppe ist ausgebucht" allein half nicht, wenn der Plan an
 * dem Tag eine Luecke zeigte (Sven, 10.10.2026, zweimal an einem Morgen).
 * Was der Plan nicht zeigt und trotzdem bindet: ein Kontingent, eine
 * Buchung ohne Zimmer, eine Buchung in einem stillgelegten Zimmer -- und
 * ein Zaehler, der von den Reservierungen abweicht. Die Maske nennt jeden
 * dieser Teile, damit die Rezeption sieht, ob die Warnung stimmt.
 *
 * Gerechnet im Zustand **nach** der Aenderung, also mit der eigenen
 * Buchung: so stehen genau die Tage da, an denen sie zu viel ist. In der
 * Gruppe, in der sie danach zaehlt -- der ihres Zimmers (Migration 0120).
 */
async function volleTage(client: PoolClient, ref: string): Promise<Array<{
  date: string; capacity: number; sold: number; blocked: number
  withoutRoom: number; inactiveRoom: number; counterDrift: number }>> {
  const r = await client.query<{
    date: string; capacity: number; sold: number; blocked: number
    without_room: number; inactive_room: number; expected: number }>(
    `WITH ich AS (
       SELECT r.property_id, COALESCE(s.category_id, r.category_id) AS cat,
              r.arrival, r.departure
         FROM reservation r LEFT JOIN resource s ON s.id = r.resource_id
        WHERE r.public_ref = $1
     ), bindend AS (
       SELECT d::date AS date, x.resource_id, x.aktiv
         FROM ich
         JOIN LATERAL (
           SELECT r.resource_id, s.active AS aktiv, r.arrival, r.departure
             FROM reservation r LEFT JOIN resource s ON s.id = r.resource_id
            WHERE r.property_id = ich.property_id
              AND r.status IN ('Optional','Confirmed','InHouse')
              AND COALESCE(s.category_id, r.category_id) = ich.cat
              AND r.arrival < ich.departure AND r.departure > ich.arrival
         ) x ON true
        CROSS JOIN LATERAL generate_series(GREATEST(x.arrival, ich.arrival),
                                           LEAST(x.departure, ich.departure) - 1,
                                           interval '1 day') d
     )
     SELECT i.date::text, i.capacity, i.sold, i.blocked,
            count(b.date) FILTER (WHERE b.date IS NOT NULL AND b.resource_id IS NULL)::int AS without_room,
            count(b.date) FILTER (WHERE b.resource_id IS NOT NULL
                                 AND NOT b.aktiv)::int AS inactive_room,
            count(b.date)::int AS expected
       FROM ich
       JOIN inventory_day i ON i.property_id = ich.property_id AND i.category_id = ich.cat
        AND i.date >= ich.arrival AND i.date < ich.departure
       LEFT JOIN bindend b ON b.date = i.date
      WHERE i.sold + i.blocked > i.capacity + i.overbooking
      GROUP BY i.date, i.capacity, i.sold, i.blocked
      ORDER BY i.date`, [ref])
  return r.rows.map(t => ({
    date: t.date, capacity: t.capacity, sold: t.sold, blocked: t.blocked,
    withoutRoom: t.without_room, inactiveRoom: t.inactive_room,
    counterDrift: t.sold - t.expected }))
}

/**
 * Der Rumpf von `change-stay`, geprueft -- fuer die Route und ihre Vorschau,
 * damit beide dasselbe annehmen.
 */
function aenderungLesen(raw: unknown):
  Parameters<typeof aufenthaltVerlegen>[2] & { allowOverbooking?: boolean } {
  const body = (raw ?? {}) as {
    arrival?: string; departure?: string; categoryId?: number; ratePlanId?: number
    resourceId?: number | null; priceCent?: number; totalCent?: number
    allowOverbooking?: boolean }
  if (body.resourceId !== undefined && body.resourceId !== null
      && !Number.isInteger(body.resourceId)) {
    throw Errors.validation({ resourceId: ['field.positiveInteger'] })
  }
  for (const feld of ['priceCent', 'totalCent'] as const) {
    const wert = body[feld]
    if (wert !== undefined && (!Number.isInteger(wert) || wert < 0)) {
      throw Errors.validation({ [feld]: ['field.positiveInteger'] })
    }
  }
  // Beides zugleich ist keine Angabe, sondern eine Frage -- wie beim Anlegen.
  if (body.priceCent !== undefined && body.totalCent !== undefined) {
    throw Errors.validation({ totalCent: ['field.eitherPriceOrTotal'] })
  }
  return body
}