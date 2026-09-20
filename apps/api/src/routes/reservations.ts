import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent } from '../platform/events.js'
import { loadBlock } from './blocks.js'
import { applyAction, InvalidTransitionError, eachNight, nightsBetween,
         isIsoDate, occupiesInventory, preisJeNacht, gruppeAufteilen,
         type ReservationStatus, type ReservationAction,
         type WebhookEventType } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
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

/** Ein Zimmer einer Gruppenbuchung. */
interface CreateBookingRoom {
  categoryId: number
  resourceId?: number
  /** Preis dieses Zimmers fuer den ganzen Aufenthalt. Siehe Vertrag. */
  totalCent?: number
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
  /** Merkmal fuer den Balken im Plan. Der Vorgang gehoert in `notes`. */
  shortNote?: string
  source?: string
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
async function assertUnitAssignable(
  client: PoolClient, opts: {
    resourceId: number; propertyId: number; arrival: string; departure: string
    exceptReservationId?: number }
): Promise<void> {
  const unit = await client.query<{ property_id: number; active: boolean }>(
    `SELECT property_id, active FROM resource WHERE id = $1`, [opts.resourceId])
  if (unit.rowCount === 0 || unit.rows[0]!.property_id !== opts.propertyId) {
    throw Errors.notFound('res.room')
  }
  if (!unit.rows[0]!.active) {
    throw Errors.conflict('room.inactive')
  }

  const blocked = await client.query(
    `SELECT 1 FROM maintenance_block
      WHERE resource_id = $1 AND kind = 'out_of_order'
        AND from_date < $3::date AND to_date > $2::date LIMIT 1`,
    [opts.resourceId, opts.arrival, opts.departure])
  if (blocked.rowCount && blocked.rowCount > 0) {
    throw Errors.conflict('room.outOfOrder')
  }

  const taken = await client.query(
    `SELECT 1 FROM reservation
      WHERE resource_id = $1 AND id <> COALESCE($2, -1)
        AND status IN ('Confirmed','InHouse')
        AND arrival < $4::date AND departure > $3::date LIMIT 1`,
    [opts.resourceId, opts.exceptReservationId ?? null, opts.arrival, opts.departure])
  if (taken.rowCount && taken.rowCount > 0) {
    throw Errors.conflict('room.occupied')
  }
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
 * **Nur vor dem Check-in.** Danach liegt der Meldeschein vor, und er ist
 * eine Erklaerung des Gastes ueber sich selbst. Wer den Hauptgast
 * nachtraeglich austauschte, liesse eine Unterschrift unter einem fremden
 * Namen stehen. Wer sich wirklich vertan hat, storniert den Meldeschein
 * nicht, sondern legt fuer die richtige Person einen an.
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
      && res.status !== 'Confirmed') {
    throw Errors.conflict('reservation.guestFixedAfterCheckIn',
      { status: res.status })
  }

  const g = await client.query<{ id: number }>(
    `SELECT id FROM guest WHERE public_ref = $1`, [guestRef])
  if (g.rowCount === 0) throw Errors.notFound('res.guest')
  const guestId = g.rows[0]!.id

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

/** Uebersetzt den Fehlercode der Inventarfunktion in eine saubere Antwort. */
export function inventoryError(code: string | null): never | void {
  if (code === 'sold_out') throw Errors.soldOut()
  if (code === 'not_materialized') throw Errors.notMaterialized()
  if (code !== null) throw Errors.conflict('inventory.unknownError', { code })
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
 * Jede Zustandsaktion hat genau eine Ereignisart. Vollstaendig ueber alle
 * Aktionen des Automaten, nicht nur ueber die heute als Route angebotenen:
 * so entscheidet der Typ die Frage mit, sobald eine weitere hinzukommt,
 * statt sie stillschweigend offen zu lassen.
 */
const EVENT_FOR_ACTION: Record<ReservationAction, WebhookEventType> = {
  confirm:   'reservation.changed',
  hold:      'reservation.changed',
  check_in:  'reservation.checked_in',
  check_out: 'reservation.checked_out',
  cancel:    'reservation.canceled',
  no_show:   'reservation.changed',
  reinstate: 'reservation.changed'
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

      if (body.guestCount !== undefined
          && (!Number.isInteger(body.guestCount)
              || body.guestCount < 1 || body.guestCount > 99)) {
        throw Errors.validation({ guestCount: ['field.positiveInteger'] })
      }
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

        let guestId = body.guestId
        if (body.guestRef !== undefined) {
          const g = await client.query<{ id: number }>(
            `SELECT id FROM guest WHERE public_ref = $1`, [body.guestRef])
          if (g.rowCount === 0) throw Errors.notFound('res.guest')
          guestId = g.rows[0]!.id
        }

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
          if (body.arrival !== block.from_date || body.departure !== block.to_date) {
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
         * Je Zimmergruppe **ein** Aufruf mit der Anzahl, nicht einer je
         * Zimmer: `inventory_reserve` sperrt die Bestandszeilen des
         * Zeitraums, und acht Aufrufe nacheinander sperrten sie achtmal.
         * Fuer eine Gruppe aus acht Doppelzimmern ist das derselbe Vorgang.
         */
        const jeGruppe = new Map<number, number>()
        for (const z of zimmer) {
          jeGruppe.set(z.categoryId, (jeGruppe.get(z.categoryId) ?? 0) + 1)
        }
        for (const [categoryId, anzahl] of jeGruppe) {
          const inv = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,$5) AS e`,
            [body.propertyId, categoryId, body.arrival, body.departure, anzahl])
          inventoryError(inv.rows[0]!.e)
        }

        if (block !== null) {
          await client.query(
            `UPDATE availability_block SET picked_up = picked_up + $2 WHERE id = $1`,
            [block.id, zimmer.length])
        }

        const booking = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO booking (property_id, booker_guest_id, source, external_reference, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, public_ref`,
          [body.propertyId, guestId ?? null, body.source ?? 'direct',
           body.externalReference ?? null, principal.userId])

        // Der Ratenplan des Kontingents gilt, wenn keiner genannt ist: eine
        // Gruppe hat ihren Preis vereinbart, und ihn je Abruf erneut
        // eintippen zu lassen, waere die Stelle, an der er abweicht.
        const ratePlanId = body.ratePlanId ?? block?.rate_plan_id ?? undefined

        /*
         * Der Preis haengt am Ratenplan und am Tag, nicht am Zimmer. Einmal
         * ermittelt und fuer alle Zimmer der Gruppe benutzt: acht Zimmer
         * derselben Nacht kosten acht Abfragen, die achtmal dieselbe Antwort
         * geben.
         */
        const nights = eachNight(body.arrival, body.departure)
        /*
         * Ein vereinbarter Preis schlaegt den Ratenplan, und zwar fuer jede
         * Nacht derselbe. Der Ratenplan bleibt trotzdem an der Reservierung
         * stehen: er sagt, unter welcher Bedingung gebucht wurde -- Storno,
         * Verpflegung, Mindestaufenthalt --, und das gilt weiter, auch wenn
         * am Preis gehandelt wurde.
         */
        const standardPreise = body.priceCent !== undefined
          ? nights.map(() => body.priceCent!)
          : await priceNights(client, ratePlanId, nights)

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
          if (z.totalCent !== undefined) return preisJeNacht(z.totalCent, nights.length)
          if (gruppenTeile !== null) return preisJeNacht(gruppenTeile[i]!, nights.length)
          return standardPreise
        })
        const summeJeZimmer = preiseJeZimmer.map(p => p.reduce((s, x) => s + x, 0))

        const angelegt: Array<{ reservationRef: string; categoryId: number
                                resourceId: number | null; totalCent: number }> = []

        for (const [i, z] of zimmer.entries()) {
          /*
           * Das Zimmer, falls eines mitkommt, wird **vor** dem Anlegen
           * geprueft und in derselben Anweisung gesetzt. Ein zweiter Aufruf
           * danach haette ein Fenster, in dem jemand anders dasselbe Zimmer
           * belegt -- und die Reservierung stuende ohne das Zimmer da, das
           * die Rezeption im Belegungsplan gerade zugesagt hat.
           */
          if (z.resourceId !== undefined) {
            await assertUnitAssignable(client, {
              resourceId: z.resourceId, propertyId: body.propertyId,
              arrival: body.arrival, departure: body.departure })
          }

          const res = await client.query<{ id: number; public_ref: string }>(
            `INSERT INTO reservation
               (property_id, booking_id, category_id, arrival, departure, status,
                option_expires_at, rate_plan_id, primary_guest_id, notes, short_note,
                block_id, resource_id, guest_count, created_by)
             VALUES ($1,$2,$3,$4::date,$5::date,$6::reservation_status,$7,
                     $8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id, public_ref`,
            [body.propertyId, booking.rows[0]!.id, z.categoryId, body.arrival, body.departure,
             body.status ?? 'Confirmed', body.optionExpiresAt ?? null,
             ratePlanId ?? null, guestId ?? null, body.notes ?? null,
             body.shortNote?.trim() || null,
             block?.id ?? null, z.resourceId ?? null, body.guestCount ?? null,
             principal.userId])
          const reservationId = res.rows[0]!.id

          // Eine Anweisung fuer alle Naechte der Reservierung statt einer je
          // Nacht (Performanceaudit): dieselbe Form wie bei `priceNights`.
          await client.query(
            `INSERT INTO reservation_night
               (reservation_id, property_id, date, rate_plan_id, price_cent)
             SELECT $1, $2, x.date, $3, x.price
               FROM unnest($4::date[], $5::bigint[]) AS x(date, price)`,
            [reservationId, body.propertyId, ratePlanId ?? null, nights, preiseJeZimmer[i]!])

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
          const occupants = i === 0
            ? body.occupants ?? (guestId ? [{ guestId, isPrimary: true }] : [])
            : []
          for (const o of occupants) {
            await client.query(
              `INSERT INTO reservation_occupant
                 (property_id, reservation_id, guest_id, age_at_arrival, is_primary)
               VALUES ($1,$2,$3,$4,$5)`,
              [body.propertyId, reservationId, o.guestId ?? null,
               o.ageAtArrival ?? null, o.isPrimary ?? false])
          }

          await client.query(
            `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
             VALUES ($1,$2,$3,'guest')`,
            [body.propertyId, reservationId, guestId ?? null])

          angelegt.push({
            reservationRef: res.rows[0]!.public_ref,
            categoryId: z.categoryId,
            resourceId: z.resourceId ?? null,
            totalCent: summeJeZimmer[i]!
          })
        }

        const result = {
          bookingRef: booking.rows[0]!.public_ref,
          reservationRef: angelegt[0]!.reservationRef,
          reservations: angelegt,
          arrival: body.arrival,
          departure: body.departure,
          nights: nights.length,
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
         * zusammen.
         */
        for (const a of angelegt) {
          await emitEvent(client, body.propertyId, 'reservation.created', {
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
          })
        }

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
          `SELECT r.id,
                  r.public_ref            AS "reservationRef",
                  b.public_ref            AS "bookingRef",
                  r.status, r.arrival::text, r.departure::text,
                  r.notes,
                  r.short_note            AS "shortNote",
                  r.guest_count           AS "guestCount",
                  r.category_id           AS "categoryId",
                  c.code                  AS "categoryCode",
                  c.name                  AS "categoryName",
                  r.resource_id           AS "resourceId",
                  u.code                  AS "roomCode",
                  u.floor,
                  r.rate_plan_id          AS "ratePlanId",
                  rp.code                 AS "ratePlanCode",
                  g.public_ref            AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS "guestName",
                  g.email                 AS "guestEmail",
                  g.language              AS "guestLanguage",
                  co.public_ref           AS "companyRef",
                  co.name                 AS "companyName",
                  bl.public_ref           AS "blockRef",
                  bl.name                 AS "blockName",
                  b.source, b.external_reference AS "externalReference",
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
             LEFT JOIN folio f         ON f.reservation_id = r.id
            WHERE r.public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const kopf = r.rows[0]! as Record<string, unknown>

        const naechte = await client.query(
          `SELECT date::text, price_cent AS "priceCent",
                  rate_plan_id AS "ratePlanId"
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

        // Die laufende id bleibt drinnen; nach aussen geht die oeffentliche
        // Referenz (C1, Dokument 13).
        delete kopf.id
        return {
          ...kopf,
          nights: naechte.rows,
          occupants: mitreisende.rows,
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
   * Freitext und wird weder durchsucht noch anonymisiert.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/reservations/:reservationRef',
    permission: 'reservation:write',
    summary: 'Notiz oder Hauptgast einer Reservierung aendern',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = req.body as { notes?: string | null; shortNote?: string | null
                                 guestRef?: string }
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

        let gastRef: string | null | undefined
        if (body.guestRef !== undefined) {
          gastRef = await setzeHauptgast(client, res, body.guestRef)
        }

        return {
          reservationRef,
          notes: body.notes ?? null,
          ...(body.shortNote === undefined ? {} : { shortNote: body.shortNote }),
          ...(gastRef === undefined ? {} : { guestRef: gastRef })
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
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const cur = await client.query<{
          id: number; property_id: number; category_id: number; status: ReservationStatus
          arrival: string; departure: string; resource_id: number | null
          block_id: number | null
        }>(`SELECT id, property_id, category_id, status,
                   arrival::text, departure::text, resource_id, block_id
              FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.reservation')
        const r = cur.rows[0]!

        let target: ReservationStatus
        try { target = applyAction(r.status, act) }
        catch (e) {
          if (e instanceof InvalidTransitionError) throw Errors.conflict(e.message)
          throw e
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
          : act === 'reinstate' ? 'canceled_at = NULL,' : ''
        await client.query(
          `UPDATE reservation SET status = $2, ${stamp} updated_at = now() WHERE id = $1`,
          [r.id, target])

        await emitEvent(client, r.property_id, EVENT_FOR_ACTION[act], {
          reservationRef, status: target,
          arrival: r.arrival, departure: r.departure,
          categoryId: r.category_id, resourceId: r.resource_id
        })

        return { reservationRef, status: target, by: principal.userId }
      })
    }
  })

  action('/v1/reservations/:reservationRef/confirm', 'confirm', 'reservation:write', 'Bestaetigen')
  action('/v1/reservations/:reservationRef/check-in', 'check_in', 'reservation:checkin', 'Check-in')
  action('/v1/reservations/:reservationRef/check-out', 'check_out', 'reservation:checkin', 'Check-out')
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
    summary: 'Zimmer zuweisen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { resourceId } = req.body as { resourceId: number }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number; category_id: number
                                       arrival: string; departure: string }>(
          `SELECT id, property_id, category_id, arrival::text, departure::text
             FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!

        await assertUnitAssignable(client, {
          resourceId, propertyId: res.property_id,
          arrival: res.arrival, departure: res.departure, exceptReservationId: res.id })

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
   * Aufenthalt ändern: Verlängerung, Verkürzung, Kategoriewechsel, einzeln
   * oder zusammen (E11, Dokument 13).
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
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/change-stay',
    permission: 'reservation:write',
    summary: 'Aufenthalt verlaengern, verkuerzen oder umbuchen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = req.body as {
        arrival?: string; departure?: string; categoryId?: number; ratePlanId?: number }

      return tx(req.pool, req, async client => {
        const cur = await client.query<{
          id: number; property_id: number; category_id: number; status: ReservationStatus
          arrival: string; departure: string; resource_id: number | null
          rate_plan_id: number | null; block_id: number | null }>(
          `SELECT id, property_id, category_id, status, arrival::text, departure::text,
                  resource_id, rate_plan_id, block_id
             FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (cur.rowCount === 0) throw Errors.notFound('res.reservation')
        const r = cur.rows[0]!

        /*
         * Ein Abruf laeuft ueber den Zeitraum seines Kontingents. Waere er
         * verschiebbar, stimmte die Rechnung beim Freigeben des Rests nicht
         * mehr: sie geht ueber den Zeitraum des Kontingents, nicht den der
         * einzelnen Reservierung. Wer anders buchen will, storniert den Abruf
         * und legt eine freie Reservierung an.
         */
        if (r.block_id !== null) {
          throw Errors.conflict(
            'stay.pickupNotMovable')
        }

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
        if (neuKategorie !== r.category_id) {
          const k = await client.query(
            `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
            [neuKategorie, r.property_id])
          if (k.rowCount === 0) throw Errors.notFound('res.category')
        }

        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_move($1,$2,$3::date,$4::date,$5,$6::date,$7::date) AS e`,
          [r.property_id, r.category_id, r.arrival, r.departure,
           neuKategorie, neuAnkunft, neuAbreise])
        inventoryError(inv.rows[0]!.e)

        // Bei Kategoriewechsel passt das zugewiesene Zimmer nicht mehr. Es
        // stehen zu lassen waere schlimmer als es zu entfernen: die
        // Hausliste zeigte dann ein Zimmer der falschen Gruppe.
        const zimmerBleibt = neuKategorie === r.category_id
        await client.query(
          `UPDATE reservation
              SET arrival = $2::date, departure = $3::date, category_id = $4,
                  rate_plan_id = COALESCE($5, rate_plan_id),
                  resource_id = CASE WHEN $6 THEN resource_id ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`,
          [r.id, neuAnkunft, neuAbreise, neuKategorie, body.ratePlanId ?? null, zimmerBleibt])

        /*
         * Naechte fortschreiben. Bereits gebuchte Naechte bleiben unberuehrt:
         * an ihnen haengen Belege, und `posted` sagt, dass die Logis schon
         * auf dem Folio steht. Entfernt werden nur ungebuchte Naechte
         * ausserhalb des neuen Zeitraums.
         */
        const entfernt = await client.query(
          `DELETE FROM reservation_night
            WHERE reservation_id = $1 AND NOT posted
              AND (date < $2::date OR date >= $3::date)`,
          [r.id, neuAnkunft, neuAbreise])

        const nights = eachNight(neuAnkunft, neuAbreise)
        const planId = body.ratePlanId ?? r.rate_plan_id ?? undefined
        const prices = await priceNights(client, planId, nights)
        // Eine Anweisung fuer alle Naechte statt einer je Nacht (Performanceaudit).
        await client.query(
          `INSERT INTO reservation_night
             (reservation_id, property_id, date, rate_plan_id, price_cent)
           SELECT $1, $2, x.date, $3, x.price
             FROM unnest($4::date[], $5::bigint[]) AS x(date, price)
           ON CONFLICT (reservation_id, date) DO NOTHING`,
          [r.id, r.property_id, planId ?? null, nights, prices])

        const summe = await client.query<{ n: number; total: number }>(
          `SELECT count(*)::int AS n, COALESCE(sum(price_cent),0)::bigint AS total
             FROM reservation_night WHERE reservation_id = $1`, [r.id])

        await emitEvent(client, r.property_id, 'reservation.changed', {
          reservationRef, status: r.status,
          arrival: neuAnkunft, departure: neuAbreise,
          categoryId: neuKategorie,
          previousArrival: r.arrival, previousDeparture: r.departure,
          previousCategoryId: r.category_id,
          nights: summe.rows[0]!.n,
          totalCent: Number(summe.rows[0]!.total)
        })

        return {
          reservationRef,
          arrival: neuAnkunft,
          departure: neuAbreise,
          categoryId: neuKategorie,
          // Beim Kategoriewechsel faellt die Zimmerzuweisung weg und muss
          // neu erfolgen. Das gehoert in die Antwort, nicht in eine Fussnote.
          roomAssignmentCleared: !zimmerBleibt && r.resource_id !== null,
          nights: summe.rows[0]!.n,
          removedNights: entfernt.rowCount ?? 0,
          totalCent: Number(summe.rows[0]!.total)
        }
      })
    }
  })
}