import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { isIsoDate } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { assertNotTraining } from '../platform/training.js'
import { einstellungLesen, geschaeftstag, type Einstellung } from '../platform/kassenbuch.js'

/**
 * DATEV-Export des Kassenbuchs (Dokument 09, vierte Fassung; Migration 0097).
 *
 * **Dasselbe Format wie im Adminpanel**, die Importvorlage „Kassenbuch
 * online": der Steuerberater soll am Stichtag nichts umstellen. Belegnummer
 * einer uebernommenen Zeile bleibt `KB-{id}`; eine Zeile aus StayGrid traegt
 * `SG-{Nummer}`, damit sich die beiden Kreise nie ueberschneiden.
 *
 * **Was hineingehoert.** Eine Buchung, deren Storno es gibt, und das Storno
 * selbst heben sich auf; solange die Buchung nicht an DATEV ging, gehen
 * beide nicht hin -- wie im Adminpanel, wo Storniertes aus dem Export
 * faellt. Ging die Buchung schon hin, geht das Storno als Korrektur
 * hinterher. So steht in DATEV nie eine Zeile, die im Kassenbuch nicht
 * wirkt, und nie eine fehlende Korrektur.
 *
 * **Herunterladen aendert nichts.** Im Adminpanel markierte ein GET die
 * Zeilen als gesendet, bevor der Download ankam; brach er ab, galten sie als
 * gesendet. Hier ist das Markieren ein eigener Aufruf, und er markiert
 * genau, was der Export enthielt: bis zu der Nummer, die der Export im Kopf
 * `x-staygrid-cashbook-through` mitgibt.
 *
 * **Nur ein System exportiert.** Vor dem Stichtag (`datev_from`) weist
 * StayGrid ab; bis dahin exportiert das Adminpanel, und seine Merker kommen
 * mit der Uebernahme.
 */

const RANGE_MAX_TAGE = 366
const ZEILEN_MAX = 20_000

/** BU-Schluessel nach Steuersatz, wie im Adminpanel fest: 7 % -> 9, 19 % -> 3. */
function buSchluessel(satzBp: number): string {
  return satzBp === 700 ? '9' : satzBp === 1900 ? '3' : ''
}

/**
 * Die Bezeichnungen aus `KassenbuchEintrag::TYPEN` im Adminpanel. Sie stehen
 * im Belegtext, und der Steuerberater kennt die Zeilen unter diesen Worten;
 * deshalb deutsch und in keinem Sprachkatalog -- DATEV ist ein deutsches
 * Papier, kein Bildschirm.
 */
const ARTNAME: Record<string, string> = {
  lodging: 'Übernachtung', breakfast_food: 'Frühstück Speisen',
  breakfast_drinks: 'Frühstück Getränke', city_tax: 'Kurtaxe', cash_in: 'Bareinlage',
  bank_deposit: 'Bankeinzahlung', expense: 'Ausgabe', other: 'Manuell', legacy_guest: 'Gast'
}

export interface DatevKassenzeile {
  entryNo: number; businessDate: string; kind: string; amountCent: number; taxRateBp: number
  text: string | null; guestName: string | null; externalNumber: string | null
  legacySplit: Record<string, number> | null; reversesNumber: string | null
}

/** Ein Betrag mit Vorzeichen und Dezimalkomma, ohne Tausenderpunkt. */
function vorzBetrag(cent: number): string {
  const s = (Math.abs(cent) / 100).toFixed(2).replace('.', ',')
  return (cent < 0 ? '-' : '+') + s
}

/**
 * Belegtext nach der Regel des Adminpanels. Die Datei kennt kein Maskieren:
 * aus „;" wird „,", „"" entfaellt, ein Zeilenumbruch wird Leerzeichen.
 *
 * Bei einer uebernommenen Zeile mit Gast und Beschreibung steht nur die
 * Beschreibung -- das Adminpanel hat dort „Art Gast Notiz" schon
 * hineingeschrieben. Sonst Art, Gast und Text nacheinander; so auch bei
 * jeder Zeile aus StayGrid, deren Text nur die Notiz ist.
 */
function belegtext(z: DatevKassenzeile): string {
  const teile = z.externalNumber !== null && z.guestName !== null && z.text !== null
    ? [z.text]
    : [ARTNAME[z.kind] ?? '', z.guestName ?? '', z.text ?? '']
  return Array.from(teile.filter(t => t.trim() !== '').join(' ')
    .replace(/;/g, ',').replace(/"/g, '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('')
}

/**
 * Die Zeilen der CSV zu einer Buchung, Feld fuer Feld wie
 * `DatevXmlService` im Adminpanel: UStSatz bleibt leer, die Steuer traegt
 * der BU-Schluessel. Eine Altdaten-Gastbuchung wird in ihre drei
 * Bruttoteile zerlegt, jeder mit eigenem Zusatz im Text.
 */
export function datevZeilen(z: DatevKassenzeile, e: Einstellung): string[][] {
  const nummer = z.reversesNumber ?? z.externalNumber ?? `SG-${z.entryNo}`
  const datum = z.businessDate.slice(8, 10) + z.businessDate.slice(5, 7)
  const text = belegtext(z)
  const zeile = (cent: number, bu: string, konto: string, t = text): string[] =>
    ['EUR', vorzBetrag(cent), nummer, datum, t, '', bu, konto, '', '', '', '', '']
  switch (z.kind) {
    // Fest je Art, nicht nach dem gespeicherten Satz: so exportiert es das Adminpanel.
    case 'lodging': return [zeile(z.amountCent, '9', e.account_lodging)]
    case 'breakfast_food': return [zeile(z.amountCent, '9', e.account_breakfast_food)]
    case 'breakfast_drinks': return [zeile(z.amountCent, '3', e.account_breakfast_drinks)]
    case 'city_tax': return [zeile(z.amountCent, '9', e.account_city_tax)]
    case 'cash_in': return [zeile(z.amountCent, '', e.account_cash_in)]
    case 'bank_deposit': return [zeile(z.amountCent, '', e.account_bank_deposit)]
    case 'expense': return [zeile(z.amountCent, buSchluessel(z.taxRateBp), e.account_expense)]
    // Manuell hat kein festes Konto; der Steuerberater kontiert es, wie im Adminpanel.
    case 'other': return [zeile(z.amountCent, buSchluessel(z.taxRateBp), '')]
    case 'legacy_guest': {
      const s = z.legacySplit ?? {}
      // Ein Storno einer Altdaten-Zeile kehrt alle Teile um.
      const richtung = z.amountCent < 0 ? -1 : 1
      const kurz = (n: number) => Array.from(text).slice(0, n).join('')
      return ([
        [s.lodging ?? 0, '9', e.account_lodging, `${kurz(50)} (Übernachtung)`],
        [s.breakfastFood ?? 0, '9', e.account_breakfast_food, `${kurz(48)} (Frühst. Sp.)`],
        [s.breakfastDrinks ?? 0, '3', e.account_breakfast_drinks, `${kurz(48)} (Frühst. Gt.)`]
      ] as const).filter(([c]) => c > 0)
        .map(([c, bu, konto, t]) => zeile(richtung * c, bu, konto, t))
    }
    default: return []
  }
}

const KOPF = ['Währung', 'VorzBetrag', 'RechNr', 'BelegDatum', 'Belegtext', 'UStSatz', 'BU',
              'Gegenkonto', 'Kost1', 'Kost2', 'Kostmenge', 'Skonto', 'Nachricht']

interface Auswahl { mode: 'unsent' | 'range'; from: string | null; to: string }

function auswahlPruefen(q: Record<string, unknown>, heute: string): Auswahl {
  const f: Record<string, Meldung[]> = {}
  const mode = q.mode ?? 'unsent'
  if (mode !== 'unsent' && mode !== 'range') f.mode = ['field.invalid']
  const from = q.from ?? null
  const to = q.to ?? heute
  if (from !== null && (typeof from !== 'string' || !isIsoDate(from))) f.from = ['field.isoDate']
  if (typeof to !== 'string' || !isIsoDate(to)) f.to = ['field.isoDate']
  if (mode === 'range' && from === null) f.from = ['field.required']
  if (Object.keys(f).length > 0) throw Errors.validation(f)
  if (mode === 'range') {
    const tage = (Date.parse(to as string) - Date.parse(from as string)) / 86_400_000
    if (tage < 0) throw Errors.validation({ to: ['field.notBeforeFrom'] })
    if (tage > RANGE_MAX_TAGE) throw Errors.rangeTooLarge(RANGE_MAX_TAGE)
  }
  return { mode: mode as Auswahl['mode'], from: from as string | null, to: to as string }
}

async function stichtagPruefen(client: PoolClient, haus: number, e: Einstellung): Promise<string> {
  // Ein Stapel aus Uebungsdaten landet in der echten Buchhaltung (C11).
  await assertNotTraining(client, haus, 'training.what.datev')
  const heute = await geschaeftstag(client, haus)
  if (e.datev_from === null) throw Errors.conflict('cashbook.datevNotStarted')
  if (heute < e.datev_from) throw Errors.conflict('cashbook.datevBeforeStart', { date: e.datev_from })
  return heute
}

/**
 * Die Zeilen eines Exports. `bis` begrenzt auf die Nummer, die ein frueherer
 * Export gesehen hat -- das Markieren trifft so genau dessen Inhalt.
 */
async function auswahl(
  client: PoolClient, haus: number, a: Auswahl, bis: number | null
): Promise<Array<DatevKassenzeile & { id: string }>> {
  const r = await client.query<{
    id: string; entry_no: string; business_date: string; kind: string; amount_cent: string
    tax_rate_bp: number; text: string | null; guest_name: string | null
    external_number: string | null; legacy_split: Record<string, number> | null
    reverses_number: string | null }>(
    `SELECT e.id, e.entry_no, e.business_date::text, e.kind, e.amount_cent, e.tax_rate_bp,
            e.text, e.guest_name, e.external_number, e.legacy_split,
            -- Das Storno traegt die Belegnummer der Buchung, die es aufhebt:
            -- unter ihr kennt DATEV die Zeile, die korrigiert wird.
            CASE WHEN o.id IS NOT NULL THEN COALESCE(o.external_number, 'SG-' || o.entry_no) END
              AS reverses_number
       FROM cashbook_entry e
       LEFT JOIN cashbook_entry o ON o.id = e.reverses_id
       LEFT JOIN cashbook_entry s ON s.reverses_id = e.id
       LEFT JOIN cashbook_datev_mark dm ON dm.entry_id = e.id
       LEFT JOIN cashbook_datev_mark om ON om.entry_id = o.id
      WHERE e.property_id = $1
        AND e.business_date <= $3::date
        AND ($2::date IS NULL OR e.business_date >= $2::date)
        AND ($4 = 'range' OR dm.entry_id IS NULL)
        AND ($5::bigint IS NULL OR e.entry_no <= $5)
        -- Buchung und Storno, beide nie an DATEV: heben sich auf, keines geht hin.
        AND NOT (e.reverses_id IS NULL AND s.id IS NOT NULL AND dm.entry_id IS NULL)
        AND NOT (e.reverses_id IS NOT NULL AND om.entry_id IS NULL)
      ORDER BY e.business_date, e.entry_no
      LIMIT $6`,
    [haus, a.from, a.to, a.mode, bis, ZEILEN_MAX + 1])
  if (r.rows.length > ZEILEN_MAX) throw Errors.unprocessable('cashbook.datevTooMany', { max: ZEILEN_MAX })
  return r.rows.map(z => ({
    id: z.id, entryNo: Number(z.entry_no), businessDate: z.business_date, kind: z.kind,
    amountCent: Number(z.amount_cent), taxRateBp: z.tax_rate_bp, text: z.text,
    guestName: z.guest_name, externalNumber: z.external_number, legacySplit: z.legacy_split,
    reversesNumber: z.reverses_number
  }))
}

/** Ohne Anfuehrungszeichen, wie im Adminpanel; die Felder sind vorher bereinigt. */
function csv(zeilen: string[][]): string {
  return '\uFEFF' + zeilen.map(z => z.join(';')).join('\r\n') + '\r\n'
}

export function cashbookDatevRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cashbook/datev',
    permission: 'cashbook:export',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: DATEV-CSV (Kassenbuch online), ohne zu markieren',
    handler: async (req, reply) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const e = await einstellungLesen(client, haus)
        const heute = await stichtagPruefen(client, haus, e)
        const a = auswahlPruefen(req.query as Record<string, unknown>, heute)
        const zeilen = await auswahl(client, haus, a, null)
        const bis = await client.query<{ n: string | null }>(
          `SELECT max(entry_no) AS n FROM cashbook_entry WHERE property_id = $1`, [haus])
        reply.header('content-type', 'text/csv; charset=utf-8')
        // Der Dateiname des Adminpanels: Kassenbuch_{Ymd}.csv, im Zeitraum mit beiden Tagen.
        const tag = (d: string) => d.replace(/-/g, '')
        reply.header('content-disposition', `attachment; filename="Kassenbuch_${
          a.mode === 'range' && a.from !== null ? `${tag(a.from)}-${tag(a.to)}` : tag(a.to)}.csv"`)
        reply.header('x-staygrid-cashbook-through', String(bis.rows[0]!.n ?? 0))
        reply.header('x-staygrid-cashbook-entries', String(zeilen.length))
        return csv([KOPF, ...zeilen.flatMap(z => datevZeilen(z, e))])
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/cashbook/datev/mark',
    permission: 'cashbook:export',
    propertyParam: 'propertyId',
    summary: 'Kassenbuch: den Inhalt eines DATEV-Exports als uebergeben markieren',
    handler: async (req) => {
      const haus = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as Record<string, unknown>
      const durch = b.through
      if (typeof durch !== 'number' || !Number.isSafeInteger(durch) || durch < 0) {
        throw Errors.validation({ through: ['field.required'] })
      }
      return tx(req.pool, req, async client => {
        const e = await einstellungLesen(client, haus)
        const heute = await stichtagPruefen(client, haus, e)
        const a = auswahlPruefen(b, heute)
        const zeilen = await auswahl(client, haus, a, durch)
        const r = await client.query(
          `INSERT INTO cashbook_datev_mark (entry_id, property_id, source)
           SELECT unnest($2::bigint[]), $1, 'staygrid'
           ON CONFLICT (entry_id) DO NOTHING`, [haus, zeilen.map(z => z.id)])
        return { marked: r.rowCount ?? 0 }
      })
    }
  })
}
