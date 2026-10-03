import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import type { Meldung } from '../platform/texte.js'

/**
 * Erste Einrichtung eines leeren Hauses in einem Zug.
 *
 * **Warum neben der Einrichtung und nicht statt ihr.** Ein neuer Kunde
 * meldet sich zum ersten Mal an und sitzt vor einem System ohne ein einziges
 * Zimmer. Die Einrichtung (`setup.ts`) kann alles, was er jetzt braucht, aber
 * in fünf Bildschirmen und in einer Reihenfolge, die man kennen muss:
 * Gruppe, Serie, Ratenplan, Preise, und dann wartet die erste Buchung auf den
 * Pflegejob, der den Bestand erst in der Nacht materialisiert. Wer das nicht
 * weiß, bekommt beim ersten Anruf `not_materialized`.
 *
 * Diese Route nimmt den Zuschnitt des Hauses als **eine** Beschreibung
 * entgegen -- je Zimmerart Kürzel, Name, Belegung, Nummern und optional einen
 * Grundpreis -- und legt daraus Gruppen, Zimmer, je Gruppe eine Standardrate
 * mit einem Jahr Preisen und den Bestand an.
 *
 * **Eine Transaktion.** Bricht der Preisschritt ab, steht kein Haus mit
 * Zimmern, aber ohne Raten da, von dem der Kunde nicht weiß, wie weit es
 * gekommen ist. Entweder ist alles angelegt oder nichts.
 *
 * **Vorschau vor dem Anlegen,** wie bei Serie und Import: ohne `commit` wird
 * alles geprüft und nichts geschrieben, und der Bericht ist derselbe.
 *
 * **Keine Vorlage für Saison, Frühstück oder Wochenende.** Das ist Pflege im
 * Preisraster, und eine Vorlage, die davon die Hälfte trifft, muss danach
 * ohnehin jemand korrigieren. Die Oberfläche weist am Ende dorthin.
 */

/** Mehr Zimmerarten legt beim ersten Mal niemand an; schützt vor einer Schleife. */
const MAX_ARTEN = 20
/** Obergrenze über alle Arten zusammen. Ein Tippfehler in der Anzahl sonst. */
const MAX_ZIMMER = 1000
/** Ein Jahr Preise, unter der Grenze der Preispflege (400 Tage). */
const PREISTAGE = 365
/** Derselbe Horizont wie der Pflegejob des Workers (`materializeInventory`). */
const BESTAND_MONATE = 24

interface ArtEingabe {
  code?: string
  name?: string
  maxOccupancy?: number
  rooms?: { prefix?: string; from?: number; count?: number }
  /** Grundpreis je Nacht in Cent. Ohne Angabe entsteht keine Rate. */
  priceCent?: number | null
}

interface Eingabe {
  propertyId: number
  categories?: ArtEingabe[]
  /** Name der Standardrate, in der Sprache der Oberfläche. */
  ratePlanName?: string
  commit?: boolean
}

interface Art {
  code: string
  name: string
  maxOccupancy: number
  rooms: string[]
  ratePlanCode: string | null
  priceCent: number | null
}

/** Das Kürzel der Standardrate. `rate_plan.code` ist je Haus eindeutig. */
export const rateCodeFor = (categoryCode: string): string => `${categoryCode}-STD`

function pruefen(b: Eingabe): Art[] {
  const arten = Array.isArray(b.categories) ? b.categories : []
  if (arten.length === 0) throw Errors.validation({ categories: ['field.required'] })
  if (arten.length > MAX_ARTEN) throw Errors.rangeTooLarge(MAX_ARTEN)

  const fehler: Record<string, Meldung[]> = {}
  const melde = (feld: string, m: Meldung) => { (fehler[feld] ??= []).push(m) }
  const kuerzel = new Set<string>()
  const nummern = new Set<string>()
  let summe = 0

  const ergebnis = arten.map((a, i): Art => {
    const code = String(a.code ?? '').trim()
    const name = String(a.name ?? '').trim()
    if (code === '') melde(`categories.${i}.code`, 'field.required')
    else if (code.length > 20) melde(`categories.${i}.code`, 'firstSetup.codeTooLong')
    else if (kuerzel.has(code)) melde(`categories.${i}.code`, 'firstSetup.codeTwice')
    kuerzel.add(code)
    if (name === '') melde(`categories.${i}.name`, 'field.required')

    const belegung = a.maxOccupancy ?? 2
    if (!Number.isInteger(belegung) || belegung < 1 || belegung > 30) {
      melde(`categories.${i}.maxOccupancy`, 'field.integer')
    }

    const von = a.rooms?.from ?? 1
    const anzahl = a.rooms?.count ?? 0
    const prefix = a.rooms?.prefix ?? ''
    const zimmer: string[] = []
    if (!Number.isInteger(von) || von < 0) melde(`categories.${i}.rooms.from`, 'field.integer')
    else if (!Number.isInteger(anzahl) || anzahl < 1) {
      melde(`categories.${i}.rooms.count`, 'field.integer')
    } else {
      summe += anzahl
      if (summe <= MAX_ZIMMER) {
        for (let n = von; n < von + anzahl; n++) {
          const nr = `${prefix}${n}`
          // Zwei Arten mit überlappenden Nummern sind fast immer ein
          // vergessenes Ändern des Startwerts, nicht Absicht.
          if (nummern.has(nr)) {
            melde(`categories.${i}.rooms.from`, 'firstSetup.roomTwice')
            break
          }
          nummern.add(nr)
          zimmer.push(nr)
        }
      }
    }

    const preis = a.priceCent ?? null
    if (preis !== null && (!Number.isInteger(preis) || preis < 0 || preis > 10_000_000)) {
      melde(`categories.${i}.priceCent`, 'field.centAmount')
    }

    return { code, name, maxOccupancy: belegung, rooms: zimmer,
             ratePlanCode: preis === null ? null : rateCodeFor(code), priceCent: preis }
  })

  if (summe > MAX_ZIMMER) throw Errors.rangeTooLarge(MAX_ZIMMER)
  if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)
  return ergebnis
}

export function firstSetupRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/first-setup',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Erste Einrichtung: Zimmerarten, Zimmer, Standardraten und Bestand',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as Eingabe
      const arten = pruefen(b)
      const mitPreisen = arten.some(a => a.priceCent !== null)

      /*
       * Zwei Rechte, weil es zwei Handlungen sind. Die Route hängt an der
       * Einrichtung; wer Preise mitschickt, setzt aber auch Preise, und das
       * darf nicht jeder, der Zimmer anlegen darf. Abgewiesen wird vor jeder
       * Abfrage, auch in der Vorschau: eine Vorschau, die durchgeht und
       * deren Anlegen dann 403 gibt, ist eine Falle.
       */
      if (mitPreisen && !can(req.principal as Principal, 'rate:write', propertyId)) {
        throw Errors.forbidden('access.missingPermission', { permission: 'rate:write' })
      }

      return tx(req.pool, req, async client => {
        /*
         * Vorhandenes in einer Abfrage, nicht je Art: die Zeilenrichtlinie
         * filtert nach Mandant, die Bedingung auf property_id nach Haus
         * (Mandantentrennung, CLAUDE.md).
         */
        const da = await client.query<{ kind: string; code: string }>(
          `SELECT 'category' AS kind, code FROM resource_category
            WHERE property_id = $1 AND code = ANY($2::text[])
           UNION ALL
           SELECT 'room', code FROM resource
            WHERE property_id = $1 AND code = ANY($3::text[])
           UNION ALL
           SELECT 'rate', code FROM rate_plan
            WHERE property_id = $1 AND code = ANY($4::text[])`,
          [propertyId, arten.map(a => a.code), arten.flatMap(a => a.rooms),
           arten.flatMap(a => a.ratePlanCode ?? [])])
        if (da.rows.length > 0) {
          const fehler: Record<string, Meldung[]> = {}
          for (const [i, a] of arten.entries()) {
            if (da.rows.some(r => r.kind === 'category' && r.code === a.code)) {
              fehler[`categories.${i}.code`] = ['firstSetup.categoryExists']
            }
            if (da.rows.some(r => r.kind === 'rate' && r.code === a.ratePlanCode)) {
              fehler[`categories.${i}.priceCent`] = ['firstSetup.rateExists']
            }
            if (da.rows.some(r => r.kind === 'room' && a.rooms.includes(r.code))) {
              fehler[`categories.${i}.rooms.from`] = ['firstSetup.roomExists']
            }
          }
          throw Errors.validation(fehler)
        }

        /*
         * Preise ab dem offenen Geschäftstag, nicht ab heute: steht der
         * Nachtlauf noch aus, wird für gestern gebucht, und eine Nacht ohne
         * Preis wird mit 0 Cent gebucht (Geschäftstag, CLAUDE.md). Ohne
         * offenen Tag -- kommt nur in Tests vor -- gilt heute.
         */
        const tag = await client.query<{ from: string; to: string; inventory_from: string }>(
          `WITH t AS (
             SELECT COALESCE((SELECT min(date) FROM business_day
                               WHERE property_id = $1 AND status = 'open'),
                             current_date) AS d)
           SELECT d::text AS from, (d + $2::int - 1)::text AS to,
                  LEAST(d, current_date)::text AS inventory_from FROM t`,
          [propertyId, PREISTAGE])
        const zeitraum = tag.rows[0]!

        const bericht = {
          dryRun: b.commit !== true,
          categories: arten,
          roomCount: arten.reduce((s, a) => s + a.rooms.length, 0),
          ratePlanCount: arten.filter(a => a.ratePlanCode !== null).length,
          pricedFrom: mitPreisen ? zeitraum.from : null,
          pricedTo: mitPreisen ? zeitraum.to : null
        }
        if (b.commit !== true) return bericht

        // Eine Anweisung je Tabelle, nicht eine je Art oder je Zimmer: der
        // Kapazitätstrigger auf Anweisungsebene rechnet so einmal nach
        // (Migration 0013).
        const gruppen = await client.query<{ id: number; code: string }>(
          `INSERT INTO resource_category (property_id, code, name, max_occupancy, sort_order)
           SELECT $1, a.code, a.name, a.occ, b.base + a.ord * 10
             FROM unnest($2::text[], $3::text[], $4::int[])
                  WITH ORDINALITY AS a(code, name, occ, ord),
                  (SELECT COALESCE(max(sort_order), 0) AS base
                     FROM resource_category WHERE property_id = $1) b
           RETURNING id, code`,
          [propertyId, arten.map(a => a.code), arten.map(a => a.name),
           arten.map(a => a.maxOccupancy)])
        const idVon = new Map(gruppen.rows.map(g => [g.code, g.id]))

        await client.query(
          `INSERT INTO resource (property_id, category_id, code)
           SELECT $1, z.cat, z.code FROM unnest($2::bigint[], $3::text[]) AS z(cat, code)`,
          [propertyId,
           arten.flatMap(a => a.rooms.map(() => idVon.get(a.code)!)),
           arten.flatMap(a => a.rooms)])

        const bepreist = arten.filter(a => a.ratePlanCode !== null)
        let pricedDays = 0
        if (bepreist.length > 0) {
          const name = String(b.ratePlanName ?? '').trim() || 'Standardpreis'
          const plaene = await client.query<{ id: number; code: string }>(
            `INSERT INTO rate_plan (property_id, category_id, code, name)
             SELECT $1, p.cat, p.code, $4 FROM unnest($2::bigint[], $3::text[]) AS p(cat, code)
             RETURNING id, code`,
            [propertyId, bepreist.map(a => idVon.get(a.code)!),
             bepreist.map(a => a.ratePlanCode!), name.slice(0, 80)])
          const planVon = new Map(plaene.rows.map(p => [p.code, p.id]))

          /*
           * Über `rate_prices_write`, denselben Weg wie Preispflege und
           * Preissteuerung (Migration 0066): die Änderungsmeldung an den
           * Channel Manager und `rate.changed` gehen mit.
           *
           * Derselbe Preis für jede Belegung bis zur höchsten der Art. Ein
           * einzelner Wert im Feld genügte der Buchung (`priceNights` fällt
           * auf den ersten zurück), aber das Preisraster liest je Belegung
           * und zeigte für zwei Personen einen leeren Tag -- der Kunde sähe
           * direkt nach dem Assistenten ein Raster ohne Preise.
           */
          const preise = await client.query<{ days: number }>(
            `SELECT count(*)::int AS days,
                    rate_prices_write($1, array_agg(p.plan), array_agg(d::date),
                                      array_agg(p.price), 'manual') AS changed
               FROM unnest($2::bigint[], $3::text[]) AS p(plan, price)
              CROSS JOIN generate_series($4::date, $5::date, interval '1 day') d`,
            [propertyId, bepreist.map(a => planVon.get(a.ratePlanCode!)!),
             bepreist.map(a => `{${Array<number>(a.maxOccupancy).fill(a.priceCent!).join(',')}}`),
             zeitraum.from, zeitraum.to])
          pricedDays = preise.rows[0]!.days
        }

        /*
         * Den Bestand gleich mit, nicht erst durch den Pflegejob in der
         * Nacht. Sonst weist die erste Buchung am Tag der Einrichtung mit
         * `not_materialized` ab -- genau dann, wenn der neue Kunde
         * ausprobiert, ob es geht.
         */
        const bestand = await client.query<{ n: number }>(
          `SELECT inventory_materialize($1, $2::date,
                    ($2::date + ($3 || ' months')::interval)::date) AS n`,
          [propertyId, zeitraum.inventory_from, BESTAND_MONATE])

        return { ...bericht,
                 created: { categories: gruppen.rowCount ?? 0,
                            rooms: bericht.roomCount,
                            ratePlans: bepreist.length,
                            pricedDays,
                            inventoryDays: bestand.rows[0]!.n } }
      })
    }
  })
}
