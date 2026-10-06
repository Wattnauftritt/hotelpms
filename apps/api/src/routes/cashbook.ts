import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import {
  CASHBOOK_SINGLE_KINDS, CASHBOOK_TAX_RATES, cashbookTaxGroups, fixedTaxRate, isIsoDate,
  signedAmount, splitGuestBooking, type CashbookLine, type CashbookSingleKind
} from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import {
  BELEGE_JE_BUCHUNG, BELEG_RUMPF_MAX, belegAnhaengen, belegAusDaten, belegSenden,
  eingeschaltet, einstellungLesen, geschaeftstag, type Beleg, type Einstellung
} from '../platform/kassenbuch.js'

/**
 * Kassenbuch (Migration 0095, Dokument 09).
 *
 * **Ein Aufruf je Bildschirm.** Die Monatsansicht liefert Zeilen, laufenden
 * Bestand, Belegverweise, Summen und Steuergruppen in einer Antwort. Im
 * Adminpanel lud die Erfassungsseite bei jedem Klick alle Eintraege seit dem
 * Anfangsbestand in PHP, und die Liste fragte je Gastgruppe einzeln nach
 * ihrer Summe. Hier rechnet die Datenbank: der Bestand vor dem Monat ist
 * ein Aggregat ueber den Index (`cashbook_entry_day`, mit `amount_cent`
 * darin), der laufende Bestand eine Fensterfunktion.
 *
 * **Storno ist eine Gegenbuchung**, auf das Datum der Buchung, die sie
 * aufhebt -- so bleibt die Tagessumme dieses Tages richtig, und beide
 * Zeilen bleiben sichtbar. Eine Gastbuchung wird als Ganzes storniert, wie
 * auf der Erfassungsseite des Adminpanels.
 *
 * **Der Bestand** zaehlt ab dem Anfangsbestand und nur, was nicht
 * storniert ist: eine Buchung und ihr Storno stehen im Bestand nicht
 * zwischen den Zeilen, sondern gar nicht.
 */

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/
const BUCHUNGSTEXT_MAX = 255
const GASTNAME_MAX = 100
/** Groesser bucht keine Rezeption bar; groesser ist ein Tippfehler. */
const BETRAG_MAX = 100_000_000

interface Zeile {
  id: string; entry_no: string; business_date: string; kind: string
  amount_cent: string; tax_rate_bp: number; text: string | null; guest_name: string | null
  group_no: string | null; reverses_no: string | null; voided_by_no: string | null
  balance_cent: string | null; external_number: string | null; datev: boolean
  created_by_name: string | null; created_at: string; legacy_split: Record<string, number> | null
}

function monatsgrenzen(monat: string): { von: string; bis: string } {
  const [j, m] = monat.split('-').map(Number) as [number, number]
  const naechster = m === 12 ? `${j + 1}-01` : `${j}-${String(m + 1).padStart(2, '0')}`
  return { von: `${monat}-01`, bis: `${naechster}-01` }
}

function ganzzahl(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function freitext(v: unknown, max: number, feld: string, f: Record<string, Meldung[]>): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') { f[feld] = ['field.invalid']; return null }
  const t = v.trim()
  if (t.length > max) { f[feld] = ['field.maxLength']; return null }
  return t === '' ? null : t
}

async function datumPruefen(
  client: PoolClient, propertyId: number, e: Einstellung, datum: string
): Promise<void> {
  const heute = await geschaeftstag(client, propertyId)
  if (datum > heute) {
    throw Errors.validation({ businessDate: ['cashbook.dateInFuture'] }, { today: heute })
  }
  if (e.opening_date !== null && datum < e.opening_date) {
    throw Errors.validation({ businessDate: ['cashbook.dateBeforeOpening'] },
      { date: e.opening_date })
  }
}

async function zeilenAnlegen(
  client: PoolClient, propertyId: number, datum: string, zeilen: CashbookLine[],
  text: string | null, gastname: string | null, userId: number | null
): Promise<{ id: number; entryNo: number }[]> {
  // Eine Anweisung fuer alle Zeilen. Die Nummern vergibt der Trigger in
  // der Reihenfolge der Zeilen; die Gruppe zeigt danach auf die erste.
  const r = await client.query<{ id: string; entry_no: string }>(
    `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                                 text, guest_name, created_by)
     SELECT $1, $2::date, z.kind, z.amount, z.rate, $6, $7, $8
       FROM unnest($3::text[], $4::bigint[], $5::int[]) WITH ORDINALITY AS z(kind, amount, rate, n)
      ORDER BY z.n
     RETURNING id, entry_no`,
    [propertyId, datum, zeilen.map(z => z.kind), zeilen.map(z => z.amountCent),
     zeilen.map(z => z.taxRateBp), text, gastname, userId])
  return r.rows.map(z => ({ id: Number(z.id), entryNo: Number(z.entry_no) }))
    .sort((a, b) => a.entryNo - b.entryNo)
}

/**
 * Eine Gastbuchung: erste Zeile allein, die weiteren mit Verweis auf sie.
 * Zwei Anweisungen statt einer, weil eine unveraenderliche Zeile ihre
 * Gruppe beim Anlegen kennen muss.
 */
async function gastbuchungAnlegen(
  client: PoolClient, propertyId: number, datum: string, zeilen: CashbookLine[],
  text: string | null, gastname: string | null, userId: number | null
): Promise<{ id: number; entryNo: number }> {
  const [erste, ...rest] = zeilen
  const kopf = (await zeilenAnlegen(client, propertyId, datum, [erste!], text, gastname, userId))[0]!
  if (rest.length > 0) {
    await client.query(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                                   text, guest_name, created_by, group_id)
       SELECT $1, $2::date, z.kind, z.amount, z.rate, $6, $7, $8, $9
         FROM unnest($3::text[], $4::bigint[], $5::int[]) WITH ORDINALITY AS z(kind, amount, rate, n)
        ORDER BY z.n`,
      [propertyId, datum, rest.map(z => z.kind), rest.map(z => z.amountCent),
       rest.map(z => z.taxRateBp), text, gastname, userId, kopf.id])
  }
  return kopf
}

/** Die Buchung zu einer Nummer, mit allem, was ein Storno wissen muss. */
async function buchung(client: PoolClient, propertyId: number, entryNo: number): Promise<{
  id: number; group_id: number | null; reverses_id: number | null
}> {
  const r = await client.query<{ id: string; group_id: string | null; reverses_id: string | null }>(
    `SELECT id, group_id, reverses_id FROM cashbook_entry
      WHERE property_id = $1 AND entry_no = $2`, [propertyId, entryNo])
  if (r.rowCount === 0) throw Errors.notFound('res.cashbookEntry')
  const z = r.rows[0]!
  return { id: Number(z.id), group_id: z.group_id === null ? null : Number(z.group_id),
           reverses_id: z.reverses_id === null ? null : Number(z.reverses_id) }
}

/**
 * Gegenbuchungen fuer eine Buchung, bei einer Gastbuchung fuer die ganze
 * Gruppe. Auf das Datum der aufgehobenen Zeile; was schon storniert ist,
 * bleibt aussen vor. Exportiert, damit die Uebernahme denselben Weg nimmt.
 */
export async function stornieren(
  client: PoolClient, propertyId: number, kopfId: number, grund: string | null,
  userId: number | null, nurDiese = false
): Promise<number[]> {
  const r = await client.query<{ entry_no: string }>(
    `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                                 text, guest_name, legacy_split, reverses_id, created_by)
     SELECT e.property_id, e.business_date, e.kind, -e.amount_cent, e.tax_rate_bp,
            $3, e.guest_name, e.legacy_split, e.id, $4
       FROM cashbook_entry e
      WHERE e.property_id = $1
        AND (e.id = $2 OR (NOT $5 AND e.group_id = $2))
        AND e.reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cashbook_entry s WHERE s.reverses_id = e.id)
      ORDER BY e.entry_no
     RETURNING entry_no`,
    [propertyId, kopfId, grund, userId, nurDiese])
  return r.rows.map(z => Number(z.entry_no)).sort((a, b) => a - b)
}

export function cashbookRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cashbook-settings',
    permission: 'cashbook:read',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: Einstellung des Hauses',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const e = await einstellungLesen(client, haus)
        return {
          enabled: e.enabled, openingBalanceCent: e.opening_balance_cent,
          openingDate: e.opening_date, datevFrom: e.datev_from,
          breakfastPriceCent: e.breakfast_price_cent,
          breakfastFoodShareBp: e.breakfast_food_share_bp, chartOfAccounts: e.chart_of_accounts,
          accounts: {
            lodging: e.account_lodging, breakfastFood: e.account_breakfast_food,
            breakfastDrinks: e.account_breakfast_drinks, cityTax: e.account_city_tax,
            cashIn: e.account_cash_in, bankDeposit: e.account_bank_deposit,
            expense: e.account_expense
          }
        }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cashbook-settings',
    permission: 'cashbook:export',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: Einstellung des Hauses setzen',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      if (typeof b.enabled !== 'boolean') f.enabled = ['field.required']
      const anfang = ganzzahl(b.openingBalanceCent ?? 0)
      if (anfang === null || Math.abs(anfang) > BETRAG_MAX) f.openingBalanceCent = ['field.invalid']
      const anfangDatum = b.openingDate ?? null
      if (anfangDatum !== null && (typeof anfangDatum !== 'string' || !isIsoDate(anfangDatum))) {
        f.openingDate = ['field.invalid']
      }
      const datevAb = b.datevFrom ?? null
      if (datevAb !== null && (typeof datevAb !== 'string' || !isIsoDate(datevAb))) {
        f.datevFrom = ['field.invalid']
      }
      const preis = ganzzahl(b.breakfastPriceCent ?? 550)
      if (preis === null || preis < 0 || preis > 100_000) f.breakfastPriceCent = ['field.invalid']
      const anteil = ganzzahl(b.breakfastFoodShareBp ?? 7000)
      if (anteil === null || anteil < 0 || anteil > 10_000) f.breakfastFoodShareBp = ['field.invalid']
      const rahmen = b.chartOfAccounts ?? 'SKR04'
      if (rahmen !== 'SKR03' && rahmen !== 'SKR04') f.chartOfAccounts = ['field.invalid']
      const k = (b.accounts ?? {}) as Record<string, unknown>
      const konten = {
        lodging: k.lodging ?? '4300', breakfastFood: k.breakfastFood ?? '4300',
        breakfastDrinks: k.breakfastDrinks ?? '4400', cityTax: k.cityTax ?? '4300',
        cashIn: k.cashIn ?? '1600', bankDeposit: k.bankDeposit ?? '1200', expense: k.expense ?? '6980'
      }
      for (const [name, wert] of Object.entries(konten)) {
        if (typeof wert !== 'string' || !/^[0-9]{4,8}$/.test(wert)) f[`accounts.${name}`] = ['field.invalid']
      }
      if (Object.keys(f).length > 0) throw Errors.validation(f)
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO cashbook_setting (property_id, enabled, opening_balance_cent, opening_date,
             breakfast_price_cent, breakfast_food_share_bp, chart_of_accounts, account_lodging,
             account_breakfast_food, account_breakfast_drinks, account_city_tax, account_cash_in,
             account_bank_deposit, account_expense, datev_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = EXCLUDED.enabled, opening_balance_cent = EXCLUDED.opening_balance_cent,
             opening_date = EXCLUDED.opening_date,
             breakfast_price_cent = EXCLUDED.breakfast_price_cent,
             breakfast_food_share_bp = EXCLUDED.breakfast_food_share_bp,
             chart_of_accounts = EXCLUDED.chart_of_accounts,
             account_lodging = EXCLUDED.account_lodging,
             account_breakfast_food = EXCLUDED.account_breakfast_food,
             account_breakfast_drinks = EXCLUDED.account_breakfast_drinks,
             account_city_tax = EXCLUDED.account_city_tax,
             account_cash_in = EXCLUDED.account_cash_in,
             account_bank_deposit = EXCLUDED.account_bank_deposit,
             account_expense = EXCLUDED.account_expense, datev_from = EXCLUDED.datev_from,
             updated_at = now()`,
          [haus, b.enabled, anfang, anfangDatum, preis, anteil, rahmen, konten.lodging,
           konten.breakfastFood, konten.breakfastDrinks, konten.cityTax, konten.cashIn,
           konten.bankDeposit, konten.expense, datevAb])
        return { saved: true }
      })
    }
  })

  /**
   * Ein Monat des Kassenbuchs: alles, was der Bildschirm zeigt.
   * Hoechstens ein Monat je Aufruf; laenger ist der Export.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cashbook',
    permission: 'cashbook:read',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: ein Monat mit laufendem Bestand',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { month?: string }
      return tx(req.pool, req, async client => {
        const e = await eingeschaltet(client, haus)
        const heute = await geschaeftstag(client, haus)
        const monat = q.month ?? heute.slice(0, 7)
        if (!MONAT.test(monat)) throw Errors.validation({ month: ['field.invalid'] })
        const { von, bis } = monatsgrenzen(monat)
        const ab = e.opening_date ?? '-infinity'

        /*
         * Bestand vor dem Monat und heute in einem Durchgang ueber den
         * Index. Gegenbuchungen stehen auf dem Datum ihrer Buchung, das
         * Paar hebt sich also in jeder Summe auf, die beide umfasst.
         */
        const stand = await client.query<{ vorher: string; heute: string }>(
          `SELECT COALESCE(sum(amount_cent) FILTER (WHERE business_date < $3::date), 0) AS vorher,
                  COALESCE(sum(amount_cent) FILTER (WHERE business_date <= $4::date), 0) AS heute
             FROM cashbook_entry
            WHERE property_id = $1 AND business_date >= $2::date`,
          [haus, ab, von, heute])
        const startCent = e.opening_balance_cent + Number(stand.rows[0]!.vorher)
        const heuteCent = e.opening_balance_cent + Number(stand.rows[0]!.heute)

        const { rows } = await client.query<Zeile>(
          `WITH monat AS (
             SELECT e.*,
                    s.entry_no AS voided_by_no,
                    o.entry_no AS reverses_no,
                    g.entry_no AS group_no,
                    (e.reverses_id IS NULL AND s.id IS NULL AND e.business_date >= $4::date)
                      AS wirksam
               FROM cashbook_entry e
               LEFT JOIN cashbook_entry s ON s.reverses_id = e.id
               LEFT JOIN cashbook_entry o ON o.id = e.reverses_id
               LEFT JOIN cashbook_entry g ON g.id = e.group_id
              WHERE e.property_id = $1 AND e.business_date >= $2::date AND e.business_date < $3::date
           )
           SELECT m.id, m.entry_no, m.business_date::text, m.kind, m.amount_cent, m.tax_rate_bp,
                  m.text, m.guest_name, m.group_no, m.reverses_no, m.voided_by_no,
                  CASE WHEN m.wirksam THEN
                    $5::bigint + sum(CASE WHEN m.wirksam THEN m.amount_cent ELSE 0 END)
                      OVER (ORDER BY m.business_date, m.entry_no)
                  END AS balance_cent,
                  m.external_number, (d.entry_id IS NOT NULL) AS datev,
                  COALESCE(u.display_name, m.created_by_name) AS created_by_name,
                  m.created_at::text, m.legacy_split
             FROM monat m
             LEFT JOIN cashbook_datev_mark d ON d.entry_id = m.id
             LEFT JOIN app_user u ON u.id = m.created_by
            ORDER BY m.business_date, m.entry_no`,
          [haus, von, bis, ab, startCent])

        // Belegverweise des Monats in einer Abfrage, ohne die Bytes.
        const belege = await client.query<{ entry_id: string; public_ref: string; mime: string }>(
          `SELECT r.entry_id, r.public_ref, r.mime
             FROM cashbook_receipt r
             JOIN cashbook_entry e ON e.id = r.entry_id
            WHERE e.property_id = $1 AND e.business_date >= $2::date AND e.business_date < $3::date
            ORDER BY r.id`, [haus, von, bis])
        const jeBuchung = new Map<string, { ref: string; mime: string }[]>()
        for (const b of belege.rows) {
          const l = jeBuchung.get(b.entry_id) ?? []
          l.push({ ref: b.public_ref, mime: b.mime })
          jeBuchung.set(b.entry_id, l)
        }

        let einnahmen = 0
        let ausgaben = 0
        let monatSumme = 0
        const steuerZeilen: { amountCent: number; taxRateBp: number }[] = []
        const vorsteuerZeilen: { amountCent: number; taxRateBp: number }[] = []
        for (const z of rows) {
          if (z.business_date >= (e.opening_date ?? '')) monatSumme += Number(z.amount_cent)
          if (z.balance_cent === null) continue
          const betrag = Number(z.amount_cent)
          if (betrag >= 0) einnahmen += betrag; else ausgaben += betrag
          // Einlage und Bankeinzahlung sind Geldbewegung, kein Umsatz.
          if (z.kind === 'cash_in' || z.kind === 'bank_deposit') continue
          if (z.kind === 'legacy_guest' && z.legacy_split !== null) {
            const s = z.legacy_split
            steuerZeilen.push({ amountCent: s.lodging ?? 0, taxRateBp: 700 },
              { amountCent: s.breakfastFood ?? 0, taxRateBp: 700 },
              { amountCent: s.breakfastDrinks ?? 0, taxRateBp: 1900 })
          } else if (betrag < 0) {
            // Ein Abgang traegt Vorsteuer, keine Umsatzsteuer. Beides in eine
            // Zeile zu saldieren ergaebe eine Zahl, die in keiner Meldung steht.
            vorsteuerZeilen.push({ amountCent: -betrag, taxRateBp: z.tax_rate_bp })
          } else {
            steuerZeilen.push({ amountCent: betrag, taxRateBp: z.tax_rate_bp })
          }
        }

        return {
          month: monat, today: heute,
          openingDate: e.opening_date, openingBalanceCent: e.opening_balance_cent,
          breakfastPriceCent: e.breakfast_price_cent,
          breakfastFoodShareBp: e.breakfast_food_share_bp,
          startBalanceCent: startCent,
          closingBalanceCent: startCent + monatSumme,
          todayBalanceCent: heuteCent,
          incomeCent: einnahmen, outgoingCent: ausgaben,
          taxGroups: cashbookTaxGroups(steuerZeilen).filter(g => g.grossCent !== 0),
          inputTaxGroups: cashbookTaxGroups(vorsteuerZeilen)
            .filter(g => g.grossCent !== 0 && g.rateBp !== 0),
          entries: rows.map(z => ({
            entryNo: Number(z.entry_no), businessDate: z.business_date, kind: z.kind,
            amountCent: Number(z.amount_cent), taxRateBp: z.tax_rate_bp,
            text: z.text, guestName: z.guest_name,
            groupNo: z.group_no === null ? null : Number(z.group_no),
            reversesNo: z.reverses_no === null ? null : Number(z.reverses_no),
            voidedByNo: z.voided_by_no === null ? null : Number(z.voided_by_no),
            balanceAfterCent: z.balance_cent === null ? null : Number(z.balance_cent),
            receipts: jeBuchung.get(z.id) ?? [],
            externalNumber: z.external_number, datevExported: z.datev,
            createdBy: z.created_by_name, createdAt: z.created_at
          }))
        }
      })
    }
  })

  /**
   * Buchen. `kind: 'guest'` zerlegt einen Gesamtpreis in Uebernachtung,
   * Fruehstueck und Kurtaxe; jede andere Art ist eine Zeile. Belege koennen
   * gleich mitkommen, in derselben Transaktion: eine Buchung, deren Beleg
   * nicht ankam, soll nicht ohne ihn dastehen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cashbook/entries',
    permission: 'cashbook:write',
    propertyParam: 'propertyId',
    bodyLimit: 2 * BELEG_RUMPF_MAX,
    summary: 'Kassenbuch: Einnahme, Ausgabe oder Gastbuchung erfassen',
    handler: async (req, reply) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as Record<string, unknown>
      const principal = req.principal as Principal
      const f: Record<string, Meldung[]> = {}

      const datum = b.businessDate
      if (typeof datum !== 'string' || !isIsoDate(datum)) f.businessDate = ['field.required']
      const text = freitext(b.text, BUCHUNGSTEXT_MAX, 'text', f)
      const gastname = freitext(b.guestName, GASTNAME_MAX, 'guestName', f)

      const roh = b.receipts ?? []
      if (!Array.isArray(roh)) f.receipts = ['field.invalid']
      else if (roh.length > BELEGE_JE_BUCHUNG) f.receipts = ['cashbook.tooManyReceipts']
      if (Object.keys(f).length > 0) throw Errors.validation(f, { max: BELEGE_JE_BUCHUNG })
      const belege: Beleg[] = (roh as Array<{ data?: unknown; name?: unknown }>)
        .map(r => belegAusDaten(r?.data, r?.name))

      const art = b.kind
      let zeilen: CashbookLine[] = []
      let gast: { totalCent: number; breakfasts: number; cityTaxCent: number } | null = null
      if (art === 'guest') {
        const gesamt = ganzzahl(b.totalCent ?? 0)
        const anzahl = ganzzahl(b.breakfasts ?? 0)
        const kurtaxe = ganzzahl(b.cityTaxCent ?? 0)
        if (gesamt === null || gesamt < 0 || gesamt > BETRAG_MAX) f.totalCent = ['field.invalid']
        if (anzahl === null || anzahl < 0 || anzahl > 1000) f.breakfasts = ['field.invalid']
        if (kurtaxe === null || kurtaxe < 0 || kurtaxe > BETRAG_MAX) f.cityTaxCent = ['field.invalid']
        if (Object.keys(f).length > 0) throw Errors.validation(f)
        // Die Aufteilung braucht die Einstellung des Hauses; die Zeilen
        // entstehen deshalb erst in der Transaktion.
        gast = { totalCent: gesamt!, breakfasts: anzahl!, cityTaxCent: kurtaxe! }
      } else if (typeof art === 'string' && (CASHBOOK_SINGLE_KINDS as readonly string[]).includes(art)) {
        const k = art as CashbookSingleKind
        const betrag = ganzzahl(b.amountCent)
        if (betrag === null || betrag === 0 || Math.abs(betrag) > BETRAG_MAX) {
          f.amountCent = ['field.invalid']
        }
        const fest = fixedTaxRate(k)
        const satz = fest ?? ganzzahl(b.taxRateBp ?? 0)
        if (satz === null || !CASHBOOK_TAX_RATES.includes(satz)) f.taxRateBp = ['field.invalid']
        if (Object.keys(f).length > 0) throw Errors.validation(f)
        zeilen = [{ kind: k, amountCent: signedAmount(k, betrag!), taxRateBp: satz! }]
      } else {
        throw Errors.validation({ kind: ['field.invalid'] })
      }

      return tx(req.pool, req, async client => {
        const e = await eingeschaltet(client, haus)
        await datumPruefen(client, haus, e, datum as string)
        if (gast !== null) {
          zeilen = splitGuestBooking({ ...gast, breakfastPriceCent: e.breakfast_price_cent,
            breakfastFoodShareBp: e.breakfast_food_share_bp })
          if (zeilen.length === 0) throw Errors.unprocessable('cashbook.emptyGuestBooking')
        }
        const kopf = await gastbuchungAnlegen(client, haus, datum as string, zeilen, text,
          gastname, principal.userId)
        const angehaengt = []
        for (const beleg of belege) {
          angehaengt.push(await belegAnhaengen(client, haus, kopf.id, beleg, principal.userId))
        }
        reply.status(201)
        return {
          entryNo: kopf.entryNo,
          entryNos: Array.from({ length: zeilen.length }, (_, i) => kopf.entryNo + i),
          receipts: angehaengt.map(a => ({ ref: a.ref, mime: a.mime }))
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cashbook/entries/:entryNo/void',
    permission: 'cashbook:void',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: Buchung stornieren (Gegenbuchung, Gastbuchung als Ganzes)',
    handler: async (req, reply) => {
      const { propertyId, entryNo } = req.params as { propertyId: string; entryNo: string }
      const haus = Number(propertyId)
      const f: Record<string, Meldung[]> = {}
      const grund = freitext((req.body as { reason?: unknown } | undefined)?.reason,
        BUCHUNGSTEXT_MAX, 'reason', f)
      if (Object.keys(f).length > 0) throw Errors.validation(f)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await eingeschaltet(client, haus)
        const z = await buchung(client, haus, Number(entryNo))
        if (z.reverses_id !== null) throw Errors.conflict('cashbook.voidOfVoid')
        const kopf = z.group_id ?? z.id
        const nummern = await stornieren(client, haus, kopf, grund, principal.userId)
        if (nummern.length === 0) throw Errors.conflict('cashbook.alreadyVoided')
        reply.status(201)
        return { reversalNos: nummern }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cashbook/entries/:entryNo/receipts',
    permission: 'cashbook:write',
    propertyParam: 'propertyId',
    bodyLimit: BELEG_RUMPF_MAX,
    summary: 'Kassenbuch: Beleg nachreichen',
    handler: async (req, reply) => {
      const { propertyId, entryNo } = req.params as { propertyId: string; entryNo: string }
      const haus = Number(propertyId)
      const b = (req.body ?? {}) as { data?: unknown; name?: unknown }
      const beleg = belegAusDaten(b.data, b.name)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await eingeschaltet(client, haus)
        const z = await buchung(client, haus, Number(entryNo))
        // Bei einer Gastbuchung haengt der Beleg an der ersten Zeile, wie im
        // Adminpanel; so findet ihn jede Zeile der Gruppe am selben Ort.
        const r = await belegAnhaengen(client, haus, z.group_id ?? z.id, beleg, principal.userId)
        if (!r.created) throw Errors.conflict('cashbook.receiptDuplicate')
        reply.status(201)
        return { ref: r.ref, mime: r.mime }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cashbook/receipts/:receiptRef',
    permission: 'cashbook:read',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: Beleg ansehen',
    handler: async (req, reply) => {
      const { propertyId, receiptRef } = req.params as { propertyId: string; receiptRef: string }
      const beleg = await tx(req.pool, req, async client => {
        const r = await client.query<{ mime: string; bytes: Buffer; entry_no: string }>(
          `SELECT r.mime, r.bytes, e.entry_no
             FROM cashbook_receipt r JOIN cashbook_entry e ON e.id = r.entry_id
            WHERE r.public_ref = $1 AND r.property_id = $2`, [receiptRef, Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.cashbookReceipt')
        return r.rows[0]!
      })
      const endung = beleg.mime === 'application/pdf' ? 'pdf'
        : beleg.mime === 'image/png' ? 'png' : 'jpg'
      return belegSenden(reply, { mime: beleg.mime, bytes: beleg.bytes,
        name: `Kassenbeleg-${beleg.entry_no}-${receiptRef}.${endung}` })
    }
  })
}
