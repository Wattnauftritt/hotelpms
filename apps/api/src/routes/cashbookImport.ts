import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { isIsoDate } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { BELEG_RUMPF_MAX, belegAnhaengen, belegAusDaten } from '../platform/kassenbuch.js'

/**
 * Kassenbuch aus einem Umsystem uebernehmen (Migration 0095, Dokument 09).
 *
 * Das Adminpanel fuehrt sein Kassenbuch weiter, bis Sven umschaltet, und
 * schiebt es bis dahin wiederholt hierher. Der Weg ist deshalb einer, den
 * man beliebig oft gehen kann:
 *
 * **Schluessel ist die ID im Umsystem** (`external_reference`), die
 * Belegnummer `KB-{id}` bleibt als `external_number` sichtbar -- unter ihr
 * kennt der Steuerberater die Zeile aus DATEV. Eine schon uebernommene
 * Zeile wird nicht noch einmal angelegt und nicht geaendert; sie ist
 * unveraenderlich. Weicht sie ab, steht das in `conflicts`. Im Adminpanel
 * laesst sich nichts bearbeiten, eine Abweichung ist also ein Befund.
 *
 * **Nichts verschwindet still.** Im Adminpanel ist Storno ein Merker, und
 * eine Zeile, die noch nicht an DATEV ging, laesst sich hart loeschen. Hier
 * wird beides zur Gegenbuchung: ein Storno sofort, eine Loeschung, sobald
 * `reconcile` die vollstaendige ID-Liste bringt und die Zeile darin fehlt.
 *
 * **Das Vorzeichen rechnet StayGrid**, nach der Regel des Adminpanels:
 * Gastbuchung alt mit dem Gesamtpreis, Bankeinzahlung umgedreht, alles
 * andere wie gespeichert. Nur so stimmt der Bestand am Stichtag mit dem
 * dortigen ueberein -- auch bei den Ausreissern, die das Adminpanel nie
 * serverseitig geprueft hat. Die stehen in `warnings`, nicht im Fehler:
 * abzuweisen hiesse, dass der Bestand hier ein anderer ist als dort.
 *
 * **Probelauf.** `dryRun` rechnet alles in der Transaktion und rollt es
 * zurueck; die Antwort ist dieselbe. Der Befehl im Adminpanel faehrt damit
 * zuerst.
 *
 * **Gegenprobe.** `check` traegt die Monatswerte des Adminpanels, die
 * Antwort stellt die eigenen daneben.
 *
 * Datum: frei, auch vor dem Anfangsbestand und nach dem Geschaeftstag --
 * die Zeilen stehen im Adminpanel so, und der Bestand zaehlt nach derselben
 * Regel wie dort erst ab dem Anfangsbestand.
 */

const STAPEL_MAX = 500
/** Eine Kasse seit April 2026; mehr als das ist kein Kassenbuch eines Hotels. */
const IDS_MAX = 500_000
const MONATE_MAX = 60
const BETRAG_MAX = 100_000_000
const SYSTEM = /^[a-z][a-z0-9_-]{1,39}$/
const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/

/** Typ im Adminpanel -> Art hier. */
const ARTEN: Record<string, string> = {
  uebernachtung: 'lodging',
  fruehstueck_speisen: 'breakfast_food',
  fruehstueck_getraenke: 'breakfast_drinks',
  kurtaxe: 'city_tax',
  bareinlage: 'cash_in',
  bankeinzahlung: 'bank_deposit',
  ausgabe: 'expense',
  manuell: 'other',
  gast: 'legacy_guest'
}
const SAETZE: Record<number, number> = { 0: 0, 7: 700, 19: 1900 }

interface Altgast {
  totalCent: number; breakfasts: number
  lodgingGrossCent: number; breakfastFoodGrossCent: number; breakfastDrinksGrossCent: number
}

interface Eintrag {
  id: number; date: string; type: string; kind: string; deltaCent: number; taxRateBp: number
  text: string | null; guestName: string | null; groupId: number | null; voided: boolean
  datevSent: boolean; datevSentAt: string | null; createdBy: string | null; createdAt: string | null
  reservationRef: string | null
  guest: Altgast | null
}

interface Pruefwert { month: string; count: number; sumCent: number; closingBalanceCent: number }

interface Eingabe {
  system: string
  dryRun: boolean
  settings: Record<string, unknown> | null
  entries: Eintrag[]
  reconcile: { maxId: number; allIds: number[] } | null
  check: Pruefwert[]
}

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const ganzzahl = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null

/** Ein Zeitpunkt mit Zone; ohne Zone waere er je nach Server ein anderer. */
function zeitpunkt(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

function text(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.length > max) return undefined
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * Was die Lade gewinnt oder verliert, nach der Regel des Adminpanels
 * (`gast` -> +Gesamtpreis, `bankeinzahlung` -> -Betrag, sonst +Betrag).
 */
export function kassenDelta(typ: string, betragCent: number, gesamtCent: number | null): number {
  if (typ === 'gast') return gesamtCent ?? 0
  if (typ === 'bankeinzahlung') return -betragCent
  return betragCent
}

function pruefe(body: unknown): Eingabe {
  const f: Record<string, Meldung[]> = {}
  const fehler = (k: string, m: Meldung = 'field.invalid'): void => { (f[k] ??= []).push(m) }
  if (!istObjekt(body)) throw Errors.validation({ body: ['field.bodyMissing'] })

  const system = typeof body.system === 'string' && SYSTEM.test(body.system) ? body.system : null
  if (system === null) fehler('system', 'field.required')
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') fehler('dryRun')
  if (body.settings !== undefined && body.settings !== null && !istObjekt(body.settings)) {
    fehler('settings')
  }

  const roh = body.entries ?? []
  const entries: Eintrag[] = []
  if (!Array.isArray(roh)) fehler('entries')
  else if (roh.length > STAPEL_MAX) fehler('entries', 'field.maxValue')
  else {
    const gesehen = new Set<number>()
    roh.forEach((e: unknown, i: number) => {
      const p = `entries[${i}]`
      if (!istObjekt(e)) { fehler(p); return }
      const id = ganzzahl(e.id)
      if (id === null || id <= 0) fehler(`${p}.id`)
      else if (gesehen.has(id)) fehler(`${p}.id`, 'field.invalid')
      else gesehen.add(id)
      if (typeof e.date !== 'string' || !isIsoDate(e.date)) fehler(`${p}.date`, 'field.isoDate')
      const typ = typeof e.type === 'string' ? e.type : ''
      const art = ARTEN[typ]
      if (art === undefined) fehler(`${p}.type`)
      const betrag = ganzzahl(e.amountCent)
      if (betrag === null || Math.abs(betrag) > BETRAG_MAX) fehler(`${p}.amountCent`)
      const satz = ganzzahl(e.taxRate)
      if (satz === null || SAETZE[satz] === undefined) fehler(`${p}.taxRate`)
      const t = text(e.text, 255)
      if (t === undefined) fehler(`${p}.text`)
      const g = text(e.guestName, 100)
      if (g === undefined) fehler(`${p}.guestName`)
      const wer = text(e.createdBy, 100)
      // Die Reservierungsreferenz aus dem Buchungs-Report des Adminpanels.
      // `updatedAt` und `bookingReportEntryId` kommen auch, werden aber nicht
      // gebraucht: die Report-ID ist instabil, und eine Zeile hier aendert
      // sich nach dem Anlegen nicht mehr.
      const reservierung = text(e.reportReference, 100)
      if (reservierung === undefined) fehler(`${p}.reportReference`)
      if (wer === undefined) fehler(`${p}.createdBy`)
      const gruppe = e.groupId === undefined || e.groupId === null ? null : ganzzahl(e.groupId)
      if (gruppe !== null && gruppe <= 0) fehler(`${p}.groupId`)
      if (e.groupId !== undefined && e.groupId !== null && gruppe === null) fehler(`${p}.groupId`)
      if (typeof e.voided !== 'boolean') fehler(`${p}.voided`, 'field.required')
      const datev = zeitpunkt(e.datevSentAt)
      if (datev === undefined) fehler(`${p}.datevSentAt`, 'field.isoTimestamp')
      if (e.datevSent !== undefined && typeof e.datevSent !== 'boolean') fehler(`${p}.datevSent`)
      const am = zeitpunkt(e.createdAt)
      if (am === undefined) fehler(`${p}.createdAt`, 'field.isoTimestamp')

      let gast: Altgast | null = null
      if (typ === 'gast') {
        if (!istObjekt(e.guest)) fehler(`${p}.guest`, 'field.required')
        else {
          const w = (k: string): number => {
            const n = ganzzahl((e.guest as Record<string, unknown>)[k] ?? 0)
            if (n === null || Math.abs(n) > BETRAG_MAX) { fehler(`${p}.guest.${k}`); return 0 }
            return n
          }
          gast = { totalCent: w('totalCent'), breakfasts: w('breakfasts'),
                   lodgingGrossCent: w('lodgingGrossCent'),
                   breakfastFoodGrossCent: w('breakfastFoodGrossCent'),
                   breakfastDrinksGrossCent: w('breakfastDrinksGrossCent') }
        }
      } else if (e.guest !== undefined && e.guest !== null) fehler(`${p}.guest`, 'field.unknown')

      if (id !== null && art !== undefined && betrag !== null && satz !== null
          && typeof e.date === 'string' && typeof e.voided === 'boolean') {
        entries.push({
          id, date: e.date, type: typ, kind: art,
          deltaCent: kassenDelta(typ, betrag, gast?.totalCent ?? null),
          taxRateBp: SAETZE[satz]!, text: t ?? null, guestName: g ?? null,
          groupId: gruppe === id ? null : gruppe, voided: e.voided,
          // `datevSent` ohne Zeitpunkt: die Bulk-Action im Adminpanel setzt
          // den Merker, der Zeitpunkt kann fehlen. Gesendet ist gesendet.
          datevSent: e.datevSent === true || datev !== null, datevSentAt: datev ?? null,
          createdBy: wer ?? null, createdAt: am ?? null, guest: gast,
          reservationRef: reservierung ?? null
        })
      }
    })
  }

  let reconcile: Eingabe['reconcile'] = null
  if (body.reconcile !== undefined && body.reconcile !== null) {
    const r = body.reconcile
    if (!istObjekt(r)) fehler('reconcile')
    else {
      const maxId = ganzzahl(r.maxId)
      if (maxId === null || maxId < 0) fehler('reconcile.maxId', 'field.required')
      const ids = r.allIds
      if (!Array.isArray(ids) || ids.length > IDS_MAX
          || ids.some(x => ganzzahl(x) === null || (x as number) <= 0)) {
        fehler('reconcile.allIds')
      } else if (maxId !== null) {
        reconcile = { maxId, allIds: ids as number[] }
        // Eine Liste, der eine Zeile dieses Stapels fehlt, ist keine
        // vollstaendige -- mit ihr abzugleichen hiesse, Zeilen als geloescht
        // zu stornieren, die es dort gibt.
        const menge = new Set(reconcile.allIds)
        if (entries.some(e => e.id <= maxId && !menge.has(e.id))) {
          fehler('reconcile.allIds', 'cashbook.importIdsIncomplete')
        }
      }
    }
  }

  const check: Pruefwert[] = []
  if (body.check !== undefined && body.check !== null) {
    if (!Array.isArray(body.check) || body.check.length > MONATE_MAX) fehler('check')
    else {
      body.check.forEach((c: unknown, i: number) => {
        if (!istObjekt(c) || typeof c.month !== 'string' || !MONAT.test(c.month)
            || ganzzahl(c.count) === null || ganzzahl(c.sumCent) === null
            || ganzzahl(c.closingBalanceCent) === null) {
          fehler(`check[${i}]`)
          return
        }
        check.push({ month: c.month, count: c.count as number, sumCent: c.sumCent as number,
                     closingBalanceCent: c.closingBalanceCent as number })
      })
    }
  }

  if (Object.keys(f).length > 0) throw Errors.validation(f, { max: STAPEL_MAX })
  return { system: system!, dryRun: body.dryRun === true,
           settings: istObjekt(body.settings) ? body.settings : null,
           entries: entries.sort((a, b) => a.id - b.id), reconcile, check }
}

/** Die Einstellung aus dem Umsystem; `enabled` bleibt, wie das Haus es hat. */
async function einstellungUebernehmen(
  client: PoolClient, haus: number, s: Record<string, unknown>
): Promise<void> {
  const f: Record<string, Meldung[]> = {}
  const zahl = (k: string, min: number, max: number): number | null => {
    if (s[k] === undefined) return null
    const n = ganzzahl(s[k])
    if (n === null || n < min || n > max) { f[`settings.${k}`] = ['field.invalid']; return null }
    return n
  }
  const anfang = zahl('openingBalanceCent', -BETRAG_MAX, BETRAG_MAX)
  const preis = zahl('breakfastPriceCent', 0, 100_000)
  const anteil = zahl('breakfastFoodShareBp', 0, 10_000)
  const datum = s.openingDate ?? null
  if (datum !== null && (typeof datum !== 'string' || !isIsoDate(datum))) {
    f['settings.openingDate'] = ['field.isoDate']
  }
  const rahmen = s.chartOfAccounts ?? null
  if (rahmen !== null && rahmen !== 'SKR03' && rahmen !== 'SKR04') {
    f['settings.chartOfAccounts'] = ['field.invalid']
  }
  const k = istObjekt(s.accounts) ? s.accounts : {}
  const konto = (n: string): string | null => {
    const v = k[n]
    if (v === undefined || v === null) return null
    if (typeof v !== 'string' || !/^[0-9]{4,8}$/.test(v)) {
      f[`settings.accounts.${n}`] = ['field.invalid']
      return null
    }
    return v
  }
  const konten = ['lodging', 'breakfastFood', 'breakfastDrinks', 'cityTax', 'cashIn',
                  'bankDeposit', 'expense'].map(konto)
  if (Object.keys(f).length > 0) throw Errors.validation(f)
  // Erst die Zeile, dann nur, was mitkam: ein fehlendes Feld laesst den
  // Wert des Hauses stehen, statt ihn auf die Vorgabe zurueckzusetzen.
  await client.query(
    `INSERT INTO cashbook_setting (property_id) VALUES ($1) ON CONFLICT DO NOTHING`, [haus])
  await client.query(
    `UPDATE cashbook_setting SET
       opening_balance_cent = COALESCE($2, opening_balance_cent),
       opening_date = CASE WHEN $3 THEN $4::date ELSE opening_date END,
       breakfast_price_cent = COALESCE($5, breakfast_price_cent),
       breakfast_food_share_bp = COALESCE($6, breakfast_food_share_bp),
       chart_of_accounts = COALESCE($7, chart_of_accounts),
       account_lodging = COALESCE($8, account_lodging),
       account_breakfast_food = COALESCE($9, account_breakfast_food),
       account_breakfast_drinks = COALESCE($10, account_breakfast_drinks),
       account_city_tax = COALESCE($11, account_city_tax),
       account_cash_in = COALESCE($12, account_cash_in),
       account_bank_deposit = COALESCE($13, account_bank_deposit),
       account_expense = COALESCE($14, account_expense),
       updated_at = now()
     WHERE property_id = $1`,
    [haus, anfang, s.openingDate !== undefined, datum, preis, anteil, rahmen, ...konten])
}

interface Vorhanden {
  ref: string; id: string; entry_no: string; business_date: string; kind: string
  amount_cent: string; reversed: boolean
}

export function cashbookImportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cashbook/import',
    permission: 'cashbook:import',
    propertyParam: 'propertyId',
    // Die ID-Liste: eine halbe Million Zahlen sind gut drei Megabyte.
    bodyLimit: 8 * 1024 * 1024,
    summary: 'Kassenbuch aus einem Umsystem uebernehmen (idempotent, mit Probelauf)',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const e = pruefe(req.body)
      const sys = e.system

      return tx(req.pool, req, async client => {
        if (e.dryRun) await client.query('SAVEPOINT cashbook_probe')
        if (e.settings !== null) await einstellungUebernehmen(client, haus, e.settings)

        const ids = e.entries.map(z => String(z.id))
        const gruppen = [...new Set(e.entries.flatMap(z => z.groupId === null ? [] : [String(z.groupId)]))]
        const vorher = await client.query<Vorhanden>(
          `SELECT x.external_reference AS ref, x.id, x.entry_no, x.business_date::text, x.kind,
                  x.amount_cent,
                  EXISTS (SELECT 1 FROM cashbook_entry s WHERE s.reverses_id = x.id) AS reversed
             FROM cashbook_entry x
            WHERE x.property_id = $1 AND x.external_system = $2 AND x.reverses_id IS NULL
              AND x.external_reference = ANY ($3::text[])`,
          [haus, sys, [...ids, ...gruppen]])
        const da = new Map(vorher.rows.map(r => [r.ref, r]))

        const warnings: { id: number; reason: string }[] = []
        const conflicts: { id: number; reason: string }[] = []
        const neu = e.entries.filter(z => !da.has(String(z.id)))
        const imStapel = new Set(neu.map(z => z.id))
        for (const z of e.entries) {
          const v = da.get(String(z.id))
          if (v !== undefined) {
            if (v.business_date !== z.date || Number(v.amount_cent) !== z.deltaCent
                || v.kind !== z.kind) {
              conflicts.push({ id: z.id, reason: 'differs' })
            }
            if (v.reversed && !z.voided) conflicts.push({ id: z.id, reason: 'voided_here_not_at_source' })
          }
          if (z.deltaCent === 0) warnings.push({ id: z.id, reason: 'zero_amount' })
          if (z.type === 'ausgabe' && z.deltaCent > 0) warnings.push({ id: z.id, reason: 'positive_expense' })
          if (z.groupId !== null && !imStapel.has(z.groupId) && !da.has(String(z.groupId))) {
            warnings.push({ id: z.id, reason: 'group_head_missing' })
          }
        }

        /*
         * Zwei Anweisungen: erst die Zeilen ohne Gruppe (und die, deren
         * erste Zeile es nicht gibt), dann die Mitglieder, die ihre erste
         * Zeile ueber die ID im Umsystem finden. Eine unveraenderliche Zeile
         * muss ihre Gruppe beim Anlegen kennen.
         */
        const kopfDa = (z: Eintrag) => z.groupId !== null
          && (imStapel.has(z.groupId) || da.has(String(z.groupId)))
        const anlegen = async (zeilen: Eintrag[], mitGruppe: boolean): Promise<void> => {
          if (zeilen.length === 0) return
          await client.query(
            `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                text, guest_name, legacy_split, external_system, external_reference,
                external_number, created_by_name, origin_created_at, origin_reservation_ref, group_id)
             SELECT $1, z.d, z.k, z.a, z.t, z.tx, z.g, z.ls, $2, z.ref, 'KB-' || z.ref, z.wer, z.am, z.res,
                    CASE WHEN $3 THEN (SELECT h.id FROM cashbook_entry h
                                        WHERE h.property_id = $1 AND h.external_system = $2
                                          AND h.reverses_id IS NULL
                                          AND h.external_reference = z.grp) END
               FROM unnest($4::text[], $5::date[], $6::text[], $7::bigint[], $8::int[], $9::text[],
                           $10::text[], $11::jsonb[], $12::text[], $13::timestamptz[], $14::text[], $15::text[])
                    WITH ORDINALITY AS z(ref, d, k, a, t, tx, g, ls, wer, am, grp, res, n)
              ORDER BY z.n`,
            [haus, sys, mitGruppe, zeilen.map(z => String(z.id)), zeilen.map(z => z.date),
             zeilen.map(z => z.kind), zeilen.map(z => z.deltaCent), zeilen.map(z => z.taxRateBp),
             zeilen.map(z => z.text), zeilen.map(z => z.guestName),
             zeilen.map(z => z.guest === null ? null : JSON.stringify({
               lodging: z.guest.lodgingGrossCent, breakfastFood: z.guest.breakfastFoodGrossCent,
               breakfastDrinks: z.guest.breakfastDrinksGrossCent,
               totalCent: z.guest.totalCent, breakfasts: z.guest.breakfasts })),
             zeilen.map(z => z.createdBy), zeilen.map(z => z.createdAt),
             zeilen.map(z => z.groupId === null ? null : String(z.groupId)),
             zeilen.map(z => z.reservationRef)])
        }
        await anlegen(neu.filter(z => !kopfDa(z)), false)
        await anlegen(neu.filter(kopfDa), true)

        // Storno im Umsystem: Gegenbuchung je Zeile, wie dort je Zeile
        // markiert -- die Tabelle des Adminpanels storniert einzeln.
        const storniert = await gegenbuchen(client, haus, sys,
          e.entries.filter(z => z.voided).map(z => String(z.id)), `Storno im Umsystem (${sys})`)

        let geloescht: number[] = []
        if (e.reconcile !== null) {
          const r = await client.query<{ ref: string }>(
            `SELECT x.external_reference AS ref
               FROM cashbook_entry x
              WHERE x.property_id = $1 AND x.external_system = $2 AND x.reverses_id IS NULL
                AND x.external_reference ~ '^[0-9]{1,18}$'
                AND x.external_reference::bigint <= $3
                AND NOT (x.external_reference::bigint = ANY ($4::bigint[]))
                AND NOT EXISTS (SELECT 1 FROM cashbook_entry s WHERE s.reverses_id = x.id)`,
            [haus, sys, e.reconcile.maxId, e.reconcile.allIds])
          geloescht = await gegenbuchen(client, haus, sys, r.rows.map(z => z.ref),
            `Im Umsystem geloescht (${sys})`)
        }

        const datev = await client.query(
          `INSERT INTO cashbook_datev_mark (entry_id, property_id, source, marked_at)
           SELECT x.id, $1, 'import', COALESCE(m.am, now())
             FROM unnest($3::text[], $4::timestamptz[]) AS m(ref, am)
             JOIN cashbook_entry x ON x.property_id = $1 AND x.external_system = $2
                                  AND x.reverses_id IS NULL AND x.external_reference = m.ref
           ON CONFLICT (entry_id) DO NOTHING`,
          [haus, sys, e.entries.filter(z => z.datevSent).map(z => String(z.id)),
           e.entries.filter(z => z.datevSent).map(z => z.datevSentAt)])

        const comparison = e.check.length === 0 ? [] : await gegenprobe(client, haus, sys, e.check)

        const ergebnis = {
          dryRun: e.dryRun,
          received: e.entries.length,
          created: neu.length,
          unchanged: e.entries.length - neu.length,
          voided: storniert,
          deletedAtSource: geloescht,
          datevMarked: datev.rowCount ?? 0,
          conflicts, warnings, comparison
        }
        if (e.dryRun) await client.query('ROLLBACK TO SAVEPOINT cashbook_probe')
        return ergebnis
      })
    }
  })

  /**
   * Ein Beleg aus dem Umsystem, an die Zeile mit dieser ID (bei einer
   * Gastbuchung an ihre erste). `sha256` prueft, dass die Datei vollstaendig
   * ankam; dieselbe Datei ein zweites Mal ist kein Fehler, sondern `exists`.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cashbook/import/:legacyId/receipt',
    permission: 'cashbook:import',
    propertyParam: 'propertyId',
    bodyLimit: BELEG_RUMPF_MAX,
    summary: 'Kassenbuch: Beleg aus einem Umsystem uebernehmen',
    handler: async (req, reply) => {
      const { propertyId, legacyId } = req.params as { propertyId: string; legacyId: string }
      const haus = Number(propertyId)
      const b = (req.body ?? {}) as { system?: unknown; data?: unknown; name?: unknown; sha256?: unknown }
      const f: Record<string, Meldung[]> = {}
      if (typeof b.system !== 'string' || !SYSTEM.test(b.system)) f.system = ['field.required']
      if (typeof b.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(b.sha256)) f.sha256 = ['field.required']
      if (!/^[0-9]{1,18}$/.test(legacyId)) f.legacyId = ['field.invalid']
      if (Object.keys(f).length > 0) throw Errors.validation(f)
      const beleg = belegAusDaten(b.data, b.name)
      if (beleg.sha256 !== (b.sha256 as string).toLowerCase()) {
        throw Errors.validation({ sha256: ['cashbook.receiptHashMismatch'] })
      }
      return tx(req.pool, req, async client => {
        const z = await client.query<{ id: string; group_id: string | null }>(
          `SELECT id, group_id FROM cashbook_entry
            WHERE property_id = $1 AND external_system = $2 AND external_reference = $3
              AND reverses_id IS NULL`, [haus, b.system, legacyId])
        if (z.rowCount === 0) throw Errors.notFound('res.cashbookEntry')
        const ziel = Number(z.rows[0]!.group_id ?? z.rows[0]!.id)
        const r = await belegAnhaengen(client, haus, ziel, beleg, null)
        reply.status(r.created ? 201 : 200)
        return { result: r.created ? 'stored' : 'exists', ref: r.ref, mime: r.mime }
      })
    }
  })
}

/** Gegenbuchungen fuer die Zeilen mit diesen IDs, je Zeile; liefert die IDs. */
async function gegenbuchen(
  client: PoolClient, haus: number, sys: string, refs: string[], grund: string
): Promise<number[]> {
  if (refs.length === 0) return []
  const r = await client.query<{ id: string; ref: string }>(
    `SELECT x.id, x.external_reference AS ref FROM cashbook_entry x
      WHERE x.property_id = $1 AND x.external_system = $2 AND x.reverses_id IS NULL
        AND x.external_reference = ANY ($3::text[])
        AND NOT EXISTS (SELECT 1 FROM cashbook_entry s WHERE s.reverses_id = x.id)
      ORDER BY x.entry_no`, [haus, sys, refs])
  if (r.rows.length === 0) return []
  await stornierenViele(client, haus, r.rows.map(z => Number(z.id)), grund)
  return r.rows.map(z => Number(z.ref)).sort((a, b) => a - b)
}

/**
 * Wie `stornieren` (routes/cashbook.ts) je Zeile, aber in einer Anweisung: ein Lauf mit
 * hunderten Stornos soll nicht hunderte Runden zur Datenbank drehen.
 */
async function stornierenViele(
  client: PoolClient, haus: number, ids: number[], grund: string
): Promise<void> {
  await client.query(
    `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                                 text, guest_name, legacy_split, reverses_id)
     SELECT e.property_id, e.business_date, e.kind, -e.amount_cent, e.tax_rate_bp,
            $3, e.guest_name, e.legacy_split, e.id
       FROM cashbook_entry e
      WHERE e.property_id = $1 AND e.id = ANY ($2::bigint[]) AND e.reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cashbook_entry s WHERE s.reverses_id = e.id)
      ORDER BY e.entry_no`, [haus, ids, grund])
}

/**
 * Die Monatswerte hier neben denen des Umsystems. Anzahl und Summe ueber die
 * uebernommenen, nicht stornierten Zeilen des Monats; der Endbestand ueber
 * alles ab dem Anfangsbestand -- bucht hier schon jemand, zeigt die
 * Gegenprobe genau das.
 */
async function gegenprobe(
  client: PoolClient, haus: number, sys: string, check: Pruefwert[]
): Promise<Array<{ month: string; source: Omit<Pruefwert, 'month'>
                   staygrid: Omit<Pruefwert, 'month'>; equal: boolean }>> {
  const r = await client.query<{ month: string; count: string; sum: string; closing: string }>(
    `WITH s AS (SELECT opening_balance_cent AS anfang, opening_date AS ab
                  FROM cashbook_setting WHERE property_id = $1),
          m AS (SELECT DISTINCT unnest($3::text[]) AS month)
     SELECT m.month,
            (SELECT count(*) FROM cashbook_entry x
              WHERE x.property_id = $1 AND x.external_system = $2 AND x.reverses_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM cashbook_entry y WHERE y.reverses_id = x.id)
                AND x.business_date >= (m.month || '-01')::date
                AND x.business_date < (m.month || '-01')::date + interval '1 month') AS count,
            (SELECT COALESCE(sum(x.amount_cent), 0) FROM cashbook_entry x
              WHERE x.property_id = $1 AND x.external_system = $2 AND x.reverses_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM cashbook_entry y WHERE y.reverses_id = x.id)
                AND x.business_date >= (m.month || '-01')::date
                AND x.business_date < (m.month || '-01')::date + interval '1 month') AS sum,
            COALESCE((SELECT anfang FROM s), 0)
              + (SELECT COALESCE(sum(x.amount_cent), 0) FROM cashbook_entry x
                  WHERE x.property_id = $1
                    AND x.business_date >= COALESCE((SELECT ab FROM s), '-infinity'::date)
                    AND x.business_date < (m.month || '-01')::date + interval '1 month') AS closing
       FROM m ORDER BY m.month`,
    [haus, sys, check.map(c => c.month)])
  const hier = new Map(r.rows.map(z => [z.month, {
    count: Number(z.count), sumCent: Number(z.sum), closingBalanceCent: Number(z.closing) }]))
  return check.map(c => {
    const s = hier.get(c.month)!
    const source = { count: c.count, sumCent: c.sumCent, closingBalanceCent: c.closingBalanceCent }
    return { month: c.month, source, staygrid: s,
             equal: s.count === c.count && s.sumCent === c.sumCent
               && s.closingBalanceCent === c.closingBalanceCent }
  })
}
