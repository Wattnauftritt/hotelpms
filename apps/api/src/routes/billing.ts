import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { hinweisText } from '../platform/texte.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent } from '../platform/events.js'
import { isIsoDate, isSendableAddress, nightsBetween, BREAKFAST_DRINKS_RATE_BP, BREAKFAST_DRINKS_SHARE_BP,
         BREAKFAST_FOOD_RATE_BP, BREAKFAST_FOOD_ACCOUNT, BREAKFAST_DRINKS_ACCOUNT,
         breakfastPerNight, splitNight, alignLineNets, taxAdjustToGross,
         preisJeNacht, guestLineLabel, lineWithGuest } from '@hotelpms/domain'
import { sumInvoice, taxFromNet, taxFromGross, blockingFindings, expectedRateMix,
         splitDeposit, depositLines, type RateGroupAmount, type ExpectedItem,
         type Party, type InvoiceTotals }
  from '@hotelpms/domain'
import { groupInvoiceLines, chargeLineSource, depositLedgerLine, partyFromSnapshot,
         payeeFromSnapshot, type CiiInvoice, type CiiParty } from '@hotelpms/domain'
import { renderInvoicePdf, renderInvoiceDocument } from '@hotelpms/beleg'
import type { PoolClient } from '@hotelpms/db'
import { isTrainingProperty, TRAINING_PREFIX } from '../platform/training.js'
import { anzahlungssicht, rechtImHaus } from './depositRequests.js'
import type { Principal } from '../platform/context.js'
import { produktImHaus, gastPerRefImBetrieb, firmaPerRefImBetrieb } from '../platform/fremdeIds.js'
import { bildAusRumpf, bildSenden, BILD_MAX_BYTES } from '../platform/terminalBild.js'

/** Ermaessigter Satz als Rueckfall, wie im Nachtlauf. */
const VAT_FALLBACK = 700

/**
 * Zeichnet den Beleg sofort, nachdem eine Rechnung festgeschrieben ist.
 *
 * Gast und Rezeption warteten bisher auf den naechsten Lauf des Workers,
 * bis zu fuenf Minuten, wenn der Gast die Rechnung gleich gedruckt haben
 * wollte (Sven, 16.10.2026). Gezeichnet wird **nach** der Transaktion der
 * Route: in ihr ist die Zaehlerzeile der Rechnungsnummer gesperrt, und ein
 * PDF darin hielte jede andere Kasse des Hauses an. Die Antwort kommt
 * dadurch einige hundert Millisekunden spaeter, mit fertigem Beleg.
 *
 * Scheitert das Zeichnen, ist die Rechnung trotzdem festgeschrieben und die
 * Antwort ein Erfolg; der Worker holt den Beleg nach und schlaegt dort
 * Alarm. Eine wiederholte Anfrage mit demselben Idempotency-Key findet den
 * Beleg vor und zeichnet nichts.
 */
async function mitBeleg<T>(req: FastifyRequest, ergebnis: Promise<T>): Promise<T> {
  const r = await ergebnis
  const ref = (r as { invoiceRef?: unknown } | null)?.invoiceRef
  if (typeof ref === 'string') {
    try {
      await renderInvoiceDocument(fn => tx(req.pool, req, fn), ref, {
        onLogoSkipped: () => req.log.warn('Rechnungslogo zu gross oder unlesbar, Beleg ohne Logo')
      })
    } catch (err) {
      req.log.warn({ err }, 'Beleg nicht sofort erzeugt, der Worker holt ihn nach')
    }
  }
  return r
}

/**
 * Wer die Rechnung bekommt.
 *
 * Die Firma geht vor: ist eine gesetzt, geht die Rechnung an sie, und der
 * Gast bleibt der Gast des Aufenthalts. Dieselbe Reihenfolge benutzt das
 * Festschreiben, und sie steht hier noch einmal, damit die Maske vorher
 * zeigt, was der Beleg nachher traegt.
 *
 * `folio.guest_id` ist dabei **nicht** der Gast des Aufenthalts -- der
 * steht an der Reservierung (`primary_guest_id`). Am Folio steht, an wen
 * abgerechnet wird, und das kann jemand anderes sein: der Ehepartner zahlt,
 * der Gast reist.
 */
async function empfaenger(
  client: PoolClient, guestId: number | null, companyId: number | null
): Promise<{
  kind: 'company' | 'guest' | 'none'
  name: string
  guestRef: string | null
  companyRef: string | null
  hasAddress: boolean
}> {
  if (companyId !== null) {
    const { rows } = await client.query<{ companyRef: string; name: string
                                          hasAddress: boolean }>(
      `SELECT public_ref AS "companyRef", name,
              (address_line1 IS NOT NULL AND city IS NOT NULL) AS "hasAddress"
         FROM company WHERE id = $1`, [companyId])
    const c = rows[0]
    if (c !== undefined) {
      return { kind: 'company', name: c.name, guestRef: null,
               companyRef: c.companyRef, hasAddress: c.hasAddress }
    }
  }
  if (guestId !== null) {
    const { rows } = await client.query<{ guestRef: string; name: string
                                          hasAddress: boolean }>(
      `SELECT public_ref AS "guestRef",
              trim(both ', ' from coalesce(last_name,'') || ', ' || coalesce(first_name,''))
                AS name,
              (address_line1 IS NOT NULL AND city IS NOT NULL) AS "hasAddress"
         FROM guest WHERE id = $1`, [guestId])
    const g = rows[0]
    if (g !== undefined) {
      return { kind: 'guest', name: g.name, guestRef: g.guestRef,
               companyRef: null, hasAddress: g.hasAddress }
    }
  }
  return { kind: 'none', name: '', guestRef: null, companyRef: null, hasAddress: false }
}

/** Ein Zahlungsvermerk, der noch keiner Rechnung zugeordnet ist. */
interface OffenerVermerk { id: number; amount_cent: number }

/**
 * Zahlungsvermerke eines Folios, die noch keiner Rechnung zugeordnet sind.
 *
 * **Warum nur positive.** Eine Erstattung ist keine Zahlung auf eine
 * Rechnung. Sie automatisch der naechsten offenen Rechnung zuzuordnen
 * hiesse, sie gegen einen Beleg zu rechnen, den sie nicht betrifft; der
 * Saldo des Folios traegt sie ohnehin.
 *
 * **Warum nicht die einer Anzahlung.** Ein Vermerk, aus dem eine
 * Anzahlungsrechnung geworden ist, steht auf der Schlussrechnung schon als
 * Position (Anzahlungsjournal, Aufgabe 3). Ihn zusaetzlich als Zahlung
 * anzuhaengen zoege denselben Betrag zweimal ab.
 */
async function offeneVermerke(
  client: PoolClient, folioId: number
): Promise<OffenerVermerk[]> {
  const { rows } = await client.query<OffenerVermerk>(
    `SELECT s.id, s.amount_cent
       FROM settlement s
      WHERE s.folio_id = $1 AND s.invoice_id IS NULL AND s.amount_cent > 0
        AND NOT EXISTS (SELECT 1 FROM deposit_ledger dl WHERE dl.settlement_id = s.id)
      ORDER BY s.id`, [folioId])
  return rows
}

/**
 * Welche Vermerke auf eine Rechnung passen, bis zu ihrem Zahlbetrag.
 *
 * **Die Obergrenze ist nicht kosmetisch.** Mehr zuzuordnen als die Rechnung
 * fordert hiesse, einen vorausgezahlten Betrag (BT-113) auszuweisen, der
 * groesser ist als die Summe -- der Zahlbetrag (BT-115) waere negativ, und
 * ein Beleg, der Geld fordert und zugleich Geld zurueckgibt, ist keiner.
 *
 * Uebersteigt ein Vermerk die Grenze, bleibt er **ganz** offen und die
 * Auswahl endet: ein Vermerk ist nicht teilbar, und ihn zu ueberspringen,
 * um einen spaeteren kleineren zu nehmen, waere am Gastkonto nicht mehr
 * nachzuvollziehen.
 */
function passendeVermerke(
  vermerke: readonly OffenerVermerk[], obergrenzeCent: number
): { ids: number[]; summeCent: number } {
  const ids: number[] = []
  let summeCent = 0
  for (const v of vermerke) {
    if (summeCent + v.amount_cent > obergrenzeCent) break
    ids.push(v.id)
    summeCent += v.amount_cent
  }
  return { ids, summeCent }
}

/**
 * Einen Zahlungsvermerk der aeltesten Rechnung des Folios zuordnen, die
 * noch offen ist -- fuer das Vermerken am Tresen wie fuer den Eingang ueber
 * einen Zahlungslink ohne eigene Rechnung (Webhook). Ohne `kandidaten`
 * werden alle Schluss- und Zwischenrechnungen des Folios betrachtet.
 *
 * Zahlt der Gast Rechnung und Kurtaxe in einem Betrag -- der Regelfall am
 * Tresen --, uebersteigt der Vermerk den Rest der Rechnung um genau die
 * Kurtaxe, die nicht auf ihr steht. Ohne diesen Spielraum bliebe jede
 * solche Rechnung fuer immer "offen".
 */
export async function zuOffenerRechnung(
  client: PoolClient, folioId: number, settlementId: number, amountCent: number,
  kandidaten?: ReadonlyArray<{ id: number; rest: number }>
): Promise<void> {
  const liste = kandidaten ?? (await client.query<{ id: number; rest: number }>(
    `SELECT i.id,
            coalesce((i.totals->>'payableCent')::bigint,
                     (i.totals->>'grossCent')::bigint, 0)
            - coalesce((SELECT sum(s.amount_cent)
                          FROM settlement s WHERE s.invoice_id = i.id), 0) AS rest
       FROM invoice i
      WHERE i.folio_id = $1 AND i.kind IN ('final','interim')
      ORDER BY i.id`, [folioId])).rows
  const ziel = liste.find(z => Number(z.rest) > 0)
  if (ziel !== undefined && amountCent > 0
      && amountCent <= Number(ziel.rest) + await kurtaxeAmFolio(client, folioId)) {
    await vermerkeZuordnen(client, ziel.id, [settlementId])
  }
}

/**
 * Die Zuordnung schreiben. `settlement` ist Haertegrad 1; das ist der
 * **eine** erlaubte Uebergang (Migration 0012, `NULL` -> Wert), und was
 * hier zugeordnet wird, ist zugeordnet.
 */
async function vermerkeZuordnen(
  client: PoolClient, invoiceId: number, ids: readonly number[]
): Promise<void> {
  if (ids.length === 0) return
  await client.query(
    `UPDATE settlement SET invoice_id = $2 WHERE id = ANY($1) AND invoice_id IS NULL`,
    [ids, invoiceId])
}

/**
 * Der Kalendertag im Haus, nicht der der Datenbank.
 *
 * Die Datenbank laeuft in UTC. Eine Rechnung zwischen Mitternacht und zwei
 * Uhr trug damit das Datum des Vortags, und in der Silvesternacht eine
 * Nummer des Vorjahres (Pruefung 13.10.2026). Ausstellungstag und
 * Nummernjahr kommen deshalb aus `property.timezone`.
 */
async function heuteImHaus(client: PoolClient, propertyId: number): Promise<string> {
  const r = await client.query<{ heute: string }>(
    `SELECT (now() AT TIME ZONE timezone)::date::text AS heute
       FROM property WHERE id = $1`, [propertyId])
  return r.rows[0]!.heute
}

/**
 * Der offene Geschaeftstag. Fehlt er, weil der erste Nachtlauf noch nicht
 * war, gilt der Kalendertag im Haus.
 */
async function offenerGeschaeftstag(client: PoolClient, propertyId: number): Promise<string> {
  const bd = await client.query<{ date: string }>(
    `SELECT date::text FROM business_day
      WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
    [propertyId])
  return bd.rows[0]?.date ?? await heuteImHaus(client, propertyId)
}

/**
 * Die Summen einer Stornorechnung: die des Originals mit umgekehrtem
 * Vorzeichen. Nicht aus den Gegenbuchungen neu gerechnet -- die
 * Stornorechnung hebt auf, was auf dem Original stand, auch dessen
 * Rundungsausgleich, und nicht, was eine neue Rechnung heute ergaebe.
 * Vorausbezahlt ist sie ganz: sie wird mit dem Original verrechnet, Geld
 * fliesst nicht.
 */
function gegenSummen(t: Record<string, unknown>): InvoiceTotals & {
  roundingCent: number; payableCent: number; prepaidCent: number
  lineAdjustCent?: Record<string, number>
  taxAdjustCent?: Record<string, number>
} {
  const n = (v: unknown): number => -Number(v ?? 0)
  const gruppen = (t.groups as Array<Record<string, number>> | undefined) ?? []
  const brutto = n(t.grossCent)
  const zahlbar = t.payableCent === undefined ? brutto : n(t.payableCent)
  return {
    netCent: n(t.netCent), taxCent: n(t.taxCent), grossCent: brutto,
    groups: gruppen.map(g => ({ rateBp: Number(g.rateBp), netCent: n(g.netCent),
                                taxCent: n(g.taxCent), grossCent: n(g.grossCent) })),
    roundingCent: n(t.roundingCent), payableCent: zahlbar, prepaidCent: zahlbar,
    // Der Ausgleich der Positionen mit umgekehrtem Vorzeichen, gefuehrt unter
    // der Buchung des Originals: die Gegenbuchung verweist auf sie.
    ...(t.lineAdjustCent !== undefined
      ? { lineAdjustCent: Object.fromEntries(
            Object.entries(t.lineAdjustCent as Record<string, number>)
              .map(([k, v]) => [k, -Number(v)])) }
      : {}),
    ...(t.taxAdjustCent !== undefined
      ? { taxAdjustCent: Object.fromEntries(
            Object.entries(t.taxAdjustCent as Record<string, number>)
              .map(([k, v]) => [k, -Number(v)])) }
      : {})
  }
}

/**
 * Die Umsatzsteuersaetze, die eine Buchung von Hand tragen darf.
 *
 * Bisher nahm `POST .../charges` jeden Satz an, auch 12,34 Prozent, und
 * Menge 0 oder negativ; ein Bruchbetrag endete als Fehler 500 (Pruefung
 * 13.10.2026). In Deutschland gibt es 7 und 19 Prozent; 0 steht fuer den
 * nicht steuerbaren Posten.
 */
const ERLAUBTE_SAETZE: ReadonlySet<number> = new Set([0, 700, 1900])
/** Eine Million Euro je Position. Darueber ist es ein Tippfehler. */
const MAX_POSITION_CENT = 100_000_000
const MAX_MENGE = 9_999
/** Laengste Bezeichnung eines weiteren Folios. */
const FOLIO_LABEL_MAX = 60
/** Folios je Aufenthalt, Gastfolio eingeschlossen. */
const FOLIOS_JE_AUFENTHALT = 6

interface BuchungsAuftrag {
  description: string; netCent?: number; taxRateBp: number
  grossCent?: number
  quantity?: number; revenueAccount?: string; productId?: number
}

/** Prueft eine Buchung von Hand, bevor eine Abfrage laeuft. */
function buchungPruefen(b: BuchungsAuftrag): void {
  const f: Record<string, Meldung[]> = {}
  if (typeof b.description !== 'string' || b.description.trim() === '') {
    f.description = ['field.required']
  } else if (b.description.length > 200) {
    f.description = ['field.maxLength']
  }
  if (!ERLAUBTE_SAETZE.has(b.taxRateBp)) f.taxRateBp = ['field.taxRate']
  if (b.quantity !== undefined
      && (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > MAX_MENGE)) {
    f.quantity = ['field.positiveInteger']
  }
  const betrag = b.grossCent ?? b.netCent
  if ((b.grossCent === undefined) === (b.netCent === undefined)) {
    f.grossCent = ['field.required']
  } else if (!Number.isSafeInteger(betrag) || Math.abs(betrag!) > MAX_POSITION_CENT) {
    f[b.grossCent === undefined ? 'netCent' : 'grossCent'] = ['field.integer']
  }
  if (b.revenueAccount !== undefined
      && (typeof b.revenueAccount !== 'string' || !/^\d{4,8}$/.test(b.revenueAccount))) {
    f.revenueAccount = ['field.invalid']
  }
  if (Object.keys(f).length > 0) throw Errors.validation(f, { max: 200 })
}

/**
 * Das Erloeskonto einer Buchung von Hand, wenn keines mitkommt.
 *
 * Bisher immer 8300. In SKR03 ist das das Automatikkonto fuer 7 Prozent,
 * und der DATEV-Stapel setzt keinen Steuerschluessel: eine Minibar zu
 * 19 Prozent buchte dort mit 7 Prozent Umsatzsteuer. 8400 ist das Konto
 * fuer 19 Prozent, 8200 eines ohne Automatik fuer den nicht steuerbaren
 * Posten.
 */
function kontoFuerSatz(rateBp: number): string {
  return rateBp === 1900 ? '8400' : rateBp === 0 ? '8200' : '8300'
}

/** Grossbuchstaben und Ziffern, bis sechs; der Bindestrich kommt von selbst. */
const KUERZEL = /^[A-Z0-9]{1,6}$/

/** Angaben fuer Kopf, Fuss und XML der Rechnung (0164). Leer heisst: steht nicht drauf. */
const KONTAKT_FELDER = {
  contactName: 'invoice_contact_name', phone: 'invoice_phone', email: 'invoice_email',
  iban: 'bank_iban', bic: 'bank_bic', bankName: 'bank_name',
  commercialRegister: 'commercial_register',
  // Fuss der Rechnung (0177): wem das Konto gehoert, und wo das Haus im
  // Netz steht.
  accountHolder: 'bank_account_holder', website: 'invoice_website'
} as const
type KontaktFeld = keyof typeof KONTAKT_FELDER

/**
 * Prueft und vereinheitlicht die Kontaktangaben aus dem Rumpf. Nur die
 * genannten Felder werden geschrieben; ein leerer Text loescht.
 */
function kontaktPruefen(roh: unknown): Partial<Record<KontaktFeld, string | null>> | null {
  if (roh === undefined) return null
  if (roh === null || typeof roh !== 'object') {
    throw Errors.validation({ contact: ['field.invalid'] })
  }
  const aus: Partial<Record<KontaktFeld, string | null>> = {}
  const fehler: Record<string, Meldung[]> = {}
  for (const [k, v] of Object.entries(roh as Record<string, unknown>)) {
    if (!(k in KONTAKT_FELDER)) continue
    const feld = k as KontaktFeld
    if (v !== null && typeof v !== 'string') { fehler[`contact.${k}`] = ['field.invalid']; continue }
    let t = (v ?? '').trim()
    if (t.length > 100) { fehler[`contact.${k}`] = ['field.invalid']; continue }
    if (feld === 'iban' || feld === 'bic') t = t.replace(/\s+/g, '').toUpperCase()
    if (t !== '' && feld === 'iban' && !ibanGueltig(t)) fehler['contact.iban'] = ['field.invalid']
    if (t !== '' && feld === 'bic' && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(t)) {
      fehler['contact.bic'] = ['field.invalid']
    }
    if (t !== '' && feld === 'email' && !isSendableAddress(t)) fehler['contact.email'] = ['field.email']
    aus[feld] = t === '' ? null : t
  }
  if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)
  return Object.keys(aus).length === 0 ? null : aus
}

/** IBAN-Pruefziffer nach ISO 13616 (Modulo 97). Ein Zahlendreher wird sonst gedruckt. */
function ibanGueltig(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const umgestellt = (iban.slice(4) + iban.slice(0, 4))
    .replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55))
  let rest = 0
  for (const ziffer of umgestellt) rest = (rest * 10 + Number(ziffer)) % 97
  return rest === 1
}

/**
 * Was der E-Rechnung fehlt. `xml`: ohne das traegt keine Rechnung ein XML
 * (BR-CO-26, BR-08); `xrechnung`: ohne das scheitert die Rechnung an eine
 * Behoerde mit Leitweg-ID (BR-DE-*). Der Bildschirm nennt es, statt dass
 * es erst als Hinweis auf einem Beleg auffaellt.
 */
function eRechnungFehlt(p: Record<string, string | null>): { xml: string[]; xrechnung: string[] } {
  const leer = (v: string | null | undefined): boolean => v === null || v === undefined || v === ''
  const xml: string[] = []
  if (leer(p.vat_id) && leer(p.commercial_register)) xml.push('identifier')
  if (leer(p.postal_code) || leer(p.city) || leer(p.country)) xml.push('address')
  const xrechnung: string[] = []
  if (leer(p.invoice_contact_name) || leer(p.invoice_phone) || leer(p.invoice_email)) {
    xrechnung.push('contact')
  }
  if (leer(p.bank_iban)) xrechnung.push('iban')
  if (leer(p.vat_id) && leer(p.tax_number)) xrechnung.push('taxId')
  return { xml, xrechnung }
}

async function rechnungseinstellung(client: PoolClient, propertyId: number): Promise<{
  prefix: string | null; missing: boolean; locked: boolean; nextNumber: string
  paymentTermsDays: number
  contact: Record<KontaktFeld, string | null>
  eInvoiceMissing: { xml: string[]; xrechnung: string[] }
  logo: { mime: string; updatedAt: string } | null
}> {
  const jahr = Number((await heuteImHaus(client, propertyId)).slice(0, 4))
  const r = await client.query<{ prefix: string | null; fehlt: boolean
                                 zaehler: string | null; naechste: string | null
                                 ziel: number }>(
    `SELECT p.invoice_prefix AS prefix, invoice_prefix_missing(p.id) AS fehlt,
            c.prefix AS zaehler, c.next_number::text AS naechste,
            p.payment_terms_days AS ziel
       FROM property p
       LEFT JOIN invoice_counter c ON c.property_id = p.id AND c.year = $2
      WHERE p.id = $1`, [propertyId, jahr])
  const z = r.rows[0]!
  const p = (await client.query<Record<string, string | null>>(
    `SELECT ${Object.values(KONTAKT_FELDER).join(', ')}, vat_id, tax_number,
            postal_code, city, country
       FROM property WHERE id = $1`, [propertyId])).rows[0]!
  const contact = Object.fromEntries(Object.entries(KONTAKT_FELDER)
    .map(([k, spalte]) => [k, p[spalte] ?? null])) as Record<KontaktFeld, string | null>
  const locked = z.prefix !== null && ((await client.query(
    `SELECT 1 FROM invoice
      WHERE property_id = $1 AND (number LIKE $2 OR number LIKE $3) LIMIT 1`,
    [propertyId, `${z.prefix}-%`, `${TRAINING_PREFIX}${z.prefix}-%`])).rowCount ?? 0) > 0
  const nextNumber = `${z.zaehler ?? ''}${z.prefix === null ? '' : `${z.prefix}-`}${jahr}-`
    + String(Number(z.naechste ?? 1)).padStart(5, '0')
  return {
    prefix: z.prefix,
    // Ohne Kuerzel und mit einem zweiten Haus: genau dann verweigert die
    // Rechnung, und genau dann muss der Bildschirm es sagen.
    missing: z.fehlt,
    locked, nextNumber,
    paymentTermsDays: z.ziel,
    contact,
    eInvoiceMissing: eRechnungFehlt(p),
    logo: (await client.query<{ mime: string; updatedAt: string }>(
      `SELECT mime, created_at AS "updatedAt" FROM property_invoice_logo
        WHERE property_id = $1`, [propertyId])).rows[0] ?? null
  }
}

/**
 * Kurtaxe gehoert nicht auf die Rechnung des Hauses.
 *
 * Sie ist die Abgabe der Gemeinde; das Haus zieht sie nur ein und fuehrt
 * sie ab. Den Beleg dafuer hat der Gast schon in der Hand: die Kurkarte mit
 * dem Betrag darauf. So rechnen die Haeuser heute (Sven, 13.10.2026), und
 * so ist es auch steuerlich richtig -- ein durchlaufender Posten ist kein
 * Entgelt des Hauses (§ 10 Abs. 1 Satz 5 UStG). Auf der Rechnung stuende
 * sie zu 0 Prozent, und die Pflichtangabenpruefung verlangte dafuer einen
 * Befreiungsgrund, den es nicht gibt: jede Rechnung ueber einen Aufenthalt
 * mit Kurtaxe wurde abgewiesen.
 *
 * Am Folio bleibt sie stehen. Dort wird sie kassiert, und der Saldo muss
 * sie kennen, sonst ginge der Gast mit offener Kurtaxe. Eine
 * Bettensteuer (`bed_tax`) ist etwas anderes: die schuldet das Haus
 * selbst, sie ist Teil seines Entgelts und bleibt auf der Rechnung.
 *
 * Ein Fragment fuer `charge c`, damit Rechnung und Zahlungszuordnung
 * dieselbe Grenze ziehen.
 */
const OHNE_KURTAXE = `NOT EXISTS (SELECT 1 FROM tax_rule tr
                                   WHERE tr.id = c.tax_rule_id AND tr.kind = 'city_tax')`

/**
 * Ein offenes Storno-Paar steht auf keiner Rechnung (Sven, 23.10.2026: "die
 * alten falschen buchungen und die gegenbuchungen ... sollten automatisch
 * nicht auf der rechnung landen").
 *
 * Wer im Folio einen Preis korrigiert, hebt die alte Position mit einer
 * Gegenbuchung auf und bucht sie neu. Beide Haelften bleiben am Folio, wie
 * GoBD es will, und heben sich auf; auf dem Beleg waeren sie nur zwei
 * Zeilen, die der Gast nachrechnen muss, und an der Rezeption musste jemand
 * sie von Hand abwaehlen. Unberechnet bleiben sie, und das ist richtig: ein
 * Paar aendert weder Saldo noch Steuer, und der Check-out zaehlt es schon
 * jetzt nicht als offen (reservations.ts, `checkout.openBalance`).
 *
 * Nur, solange **beide** offen sind. Steht eine Haelfte schon auf einer
 * Rechnung, gehoert die andere auf die naechste, sonst fehlte dem Beleg
 * eine Buchung.
 */
const OHNE_STORNOPAAR = `NOT EXISTS (SELECT 1 FROM charge g
                                      WHERE g.reverses_id = c.id AND g.invoice_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM charge o
                   WHERE o.id = c.reverses_id AND o.invoice_id IS NULL)`

/** Was am Folio an Kurtaxe gebucht ist, brutto: der Teil des Saldos, der auf keiner Rechnung steht. */
async function kurtaxeAmFolio(client: PoolClient, folioId: number): Promise<number> {
  const r = await client.query<{ cent: string }>(
    `SELECT COALESCE(sum(c.gross_cent), 0)::bigint AS cent FROM charge c
      WHERE c.folio_id = $1 AND NOT (${OHNE_KURTAXE})`, [folioId])
  return Math.max(Number(r.rows[0]!.cent), 0)
}

/**
 * Die naechste Rechnungsnummer, fuer Schluss- wie Anzahlungsrechnung.
 *
 * Ein Uebungshaus bekommt ein sichtbares Kuerzel vor der Nummer. Die
 * Nummernfolge ist ohnehin je Property getrennt, aber eine Uebungsrechnung
 * muss man auch dann als solche erkennen, wenn sie ausgedruckt auf dem
 * Tresen liegt (C11, Dokument 13). Das Kuerzel wird einmal am Zaehler
 * gesetzt, nicht bei jeder Nummer: sonst haette dieselbe Property mal mit
 * und mal ohne Kuerzel numeriert.
 *
 * **Ohne Hauskuerzel keine Rechnung, sobald der Account zwei Haeuser hat.**
 * Beide zaehlten sonst ab 2026-00001, und § 14 Abs. 4 Nr. 4 UStG verlangt
 * Eindeutigkeit beim Unternehmer, nicht beim Haus (Migration 0157). Lieber
 * eine Rechnung, die heute nicht entsteht, als zwei mit derselben Nummer,
 * die der Steuerberater in einem Jahr findet.
 */
async function naechsteNummer(
  client: PoolClient, propertyId: number
): Promise<{ rows: Array<{ next_invoice_number: string }> }> {
  const kuerzel = await client.query<{ fehlt: boolean }>(
    `SELECT invoice_prefix_missing($1) AS fehlt`, [propertyId])
  if (kuerzel.rows[0]!.fehlt) throw Errors.unprocessable('invoice.prefixMissing')

  const year = Number((await heuteImHaus(client, propertyId)).slice(0, 4))
  if (await isTrainingProperty(client, propertyId)) {
    await client.query(
      `INSERT INTO invoice_counter (property_id, year, prefix)
       VALUES ($1,$2,$3) ON CONFLICT (property_id, year) DO NOTHING`,
      [propertyId, year, TRAINING_PREFIX])
  }
  return client.query<{ next_invoice_number: string }>(
    `SELECT next_invoice_number($1, $2)`, [propertyId, year])
}

/**
 * Die erwartete Zusammensetzung des Aufenthalts nach Steuersaetzen: die
 * Grundlage, in deren Verhaeltnis eine pauschale Anzahlung aufgeteilt wird.
 *
 * Gerechnet wird mit dem **geplanten** Aufenthalt, nicht mit dem schon
 * Gebuchten. Fuer die Aufteilung zaehlt nur das Verhaeltnis, und der Plan
 * kennt es auch dann, wenn noch keine einzige Nacht gebucht ist -- der
 * Regelfall bei einer Anzahlung, die bei der Buchung gefordert wird.
 */
async function erwarteteSaetze(
  client: PoolClient, propertyId: number, reservationId: number
): Promise<RateGroupAmount[]> {
  /*
   * Das Fruehstueck aus der Rate rechnet wie der Nachtlauf
   * (`breakfastPerNight`, `splitNight`): je Nacht Erwachsene und Kinder zu
   * ihrem Preis, nie mehr als die Nacht, mit dem Plan der Nacht. Die Anzahlung soll dieselben Saetze ausweisen, die spaeter die
   * Schlussrechnung traegt.
   */
  const r = await client.query<{ rate_plan_id: number | null; naechte: number
                                 logis_cent: number; personen: number
                                 fruehstueck_cent: number }>(
    `WITH p AS (
       SELECT res.id, res.adults, res.children,
              GREATEST(COALESCE(res.guest_count,
                (SELECT count(*) FROM reservation_occupant o
                  WHERE o.reservation_id = res.id)::int), 1) AS personen
         FROM reservation res WHERE res.id = $1 AND res.property_id = $2
     )
     SELECT res.rate_plan_id, (res.departure - res.arrival) AS naechte,
            COALESCE((SELECT sum(rn.price_cent) FROM reservation_night rn
                       WHERE rn.reservation_id = res.id), 0)::bigint AS logis_cent,
            p.personen,
            COALESCE((SELECT sum(LEAST(
                                CASE WHEN fp.kind IS NOT NULL
                                          AND p.adults IS NOT NULL
                                     THEN p.adults::bigint * fp.erwachsen
                                          + COALESCE(p.children, 0)::bigint * fp.kind
                                     ELSE fp.erwachsen::bigint * p.personen END,
                                GREATEST(rn.price_cent, 0)))
                        FROM reservation_night rn
                        LEFT JOIN rate_plan rp
                          ON rp.id = COALESCE(rn.rate_plan_id, res.rate_plan_id)
                        -- Wie im Nachtlauf: Rate vor Haus, abgewaehlt vor beidem (0169).
                        CROSS JOIN LATERAL (
                          SELECT CASE WHEN res.breakfast_declined THEN NULL
                                      ELSE COALESCE(rp.breakfast_cent, pr.breakfast_cent)
                                 END AS erwachsen,
                                 CASE WHEN rp.breakfast_cent IS NOT NULL
                                      THEN rp.breakfast_child_cent
                                      ELSE pr.breakfast_child_cent END AS kind
                        ) fp
                       WHERE rn.reservation_id = res.id
                         AND fp.erwachsen IS NOT NULL), 0)::bigint AS fruehstueck_cent
       FROM reservation res JOIN p ON p.id = res.id
       JOIN property pr ON pr.id = res.property_id`,
    [reservationId, propertyId])
  if (r.rowCount === 0) return []
  const res = r.rows[0]!
  if (Number(res.logis_cent) <= 0) return []

  const steuer = await client.query<{ rate_bp: number }>(
    // Wie im Nachtlauf: der ermaessigte Satz, wo es ihn gibt.
    `SELECT COALESCE((SELECT rate_bp FROM tax_rule
                       WHERE property_id = $1 AND kind = 'vat' AND basis = 'percent'
                         AND active ORDER BY rate_bp = 700 DESC, id LIMIT 1), $2) AS rate_bp`,
    [propertyId, VAT_FALLBACK])
  const logisSatz = steuer.rows[0]!.rate_bp

  /*
   * Im Ratenpreis enthaltene Leistungen. Das Fruehstueck steckt dann im
   * Zimmerpreis und muss herausgerechnet werden (Aufteilungsgebot): der
   * Preis der Uebernachtung traegt den ermaessigten Satz, das Fruehstueck
   * seinen eigenen -- und ein Buffet gleich zwei.
   */
  const enthalten = res.rate_plan_id === null ? { rows: [] } : await client.query<{
    price_cent: number; charge_mode: string; rate_bp: number | null
    split_rate_bp: number | null; split_share_bp: number | null }>(
    `SELECT p.price_cent, p.charge_mode, tr.rate_bp,
            sp.rate_bp AS split_rate_bp, p.split_share_bp
       FROM rate_plan_product rpp
       JOIN product p ON p.id = rpp.product_id AND p.active AND p.property_id = $2
       LEFT JOIN tax_rule tr ON tr.id = p.tax_rule_id
       LEFT JOIN tax_rule sp ON sp.id = p.split_tax_rule_id
      WHERE rpp.rate_plan_id = $1`,
    [res.rate_plan_id, propertyId])

  const naechte = Math.max(Number(res.naechte), 1)
  const personen = Number(res.personen)
  const posten: ExpectedItem[] = []
  let extras = 0

  const fruehstueck = Number(res.fruehstueck_cent)
  if (fruehstueck > 0) {
    extras += fruehstueck
    posten.push({
      grossCent: fruehstueck,
      rateBp: BREAKFAST_FOOD_RATE_BP,
      splitShareBp: BREAKFAST_DRINKS_SHARE_BP,
      splitRateBp: BREAKFAST_DRINKS_RATE_BP
    })
  }

  for (const p of enthalten.rows) {
    const menge = p.charge_mode === 'once' ? 1
      : p.charge_mode === 'per_person_night' ? naechte * personen
        : naechte
    const brutto = Number(p.price_cent) * menge
    if (brutto <= 0) continue
    extras += brutto
    posten.push({
      grossCent: brutto,
      rateBp: p.rate_bp ?? logisSatz,
      splitShareBp: p.split_share_bp,
      splitRateBp: p.split_rate_bp
    })
  }

  // Was nach Abzug der enthaltenen Leistungen bleibt, ist Logis. Nie
  // negativ: ein Ratenpreis unter dem Wert der enthaltenen Leistungen ist
  // eine Frage an die Stammdaten, aber kein Grund, hier Unsinn zu rechnen.
  const logis = Math.max(Number(res.logis_cent) - extras, 0)
  if (logis > 0) posten.unshift({ grossCent: logis, rateBp: logisSatz })

  return expectedRateMix(posten)
}

/**
 * Ein Jahr Rechnungen je Anfrage. Mehr braucht keine Ansicht, und die
 * Buchhaltung nimmt ohnehin den GoBD-Export.
 */
interface RechnungsAuftrag {
  kind?: 'final' | 'interim'
  chargeIds?: number[]
  /**
   * Abweichende Rechnungsanschrift fuer **diese** Rechnung (Sven,
   * 13.10.2026: Firmengaeste haben oft eine andere). Ein leerer Wert nimmt
   * das Feld heraus. Die Stammdaten bleiben unberuehrt; wer sie aendern
   * will, aendert die Firma.
   */
  recipient?: Partial<Record<typeof EMPFAENGER_FELDER[number], string>>
  /** Faelligkeit (BT-9). Ohne Angabe aus dem Ziel der Firma, sonst des Hauses. */
  dueOn?: string
  /** Gleich bezahlt: bucht den offenen Betrag als Zahlungsvermerk dieser Rechnung. */
  paid?: { paymentMethodCode: string; externalReference?: string }
}

const EMPFAENGER_FELDER = ['name', 'contactName', 'addressLine1', 'postalCode', 'city',
                           'country', 'vatId'] as const
const EMPFAENGER_MAX = 200
/** Laengstes Zahlungsziel, das eine Rechnung tragen darf. */
const ZIEL_MAX_TAGE = 365

/** Prueft die Angaben des Rechnungsdialogs, bevor eine Abfrage laeuft. */
function auftragPruefen(a: RechnungsAuftrag): void {
  const f: Record<string, Meldung[]> = {}
  if (a.recipient !== undefined) {
    if (typeof a.recipient !== 'object' || a.recipient === null) {
      f.recipient = ['field.invalid']
    } else {
      for (const [k, v] of Object.entries(a.recipient)) {
        if (!(EMPFAENGER_FELDER as readonly string[]).includes(k)
            || typeof v !== 'string' || v.length > EMPFAENGER_MAX) {
          f[`recipient.${k}`] = ['field.invalid']
        }
      }
      const land = a.recipient.country?.trim()
      if (land && !/^[A-Z]{2}$/.test(land)) f['recipient.country'] = ['field.invalid']
    }
  }
  // Eine Stornorechnung entsteht nur ueber `POST /v1/invoices/:ref/cancel`,
  // mit Bezug und Gegenbuchungen. Ungeprueft durchgereicht entstand hier
  // eine "Stornorechnung" mit positiven Betraegen und ohne Original
  // (Pruefung 13.10.2026, Befund 2).
  if (a.kind !== undefined && a.kind !== 'final' && a.kind !== 'interim') {
    f.kind = ['field.invalid']
  }
  if (a.dueOn !== undefined && !isIsoDate(a.dueOn)) f.dueOn = ['field.isoDate']
  if (a.paid !== undefined && typeof a.paid?.paymentMethodCode !== 'string') {
    f['paid.paymentMethodCode'] = ['field.required']
  }
  if (Object.keys(f).length > 0) throw Errors.validation(f)
}

/** Die Vorgabe aus den Stammdaten, ueberschrieben mit dem, was der Dialog sagt. */
function mitAbweichung(vorgabe: Party, abweichung: RechnungsAuftrag['recipient']): Party {
  if (abweichung === undefined) return vorgabe
  const p: Record<string, string | null | undefined> = { ...vorgabe }
  for (const k of EMPFAENGER_FELDER) {
    const v = abweichung[k]
    if (v === undefined) continue
    const t = v.trim()
    if (t === '') delete p[k]
    else p[k] = t
  }
  return p as Party
}

/**
 * Zimmer und Gast je Position (Sven, 15.10.2026; Migration 0175).
 *
 * Eine Firma bucht mehrere Zimmer in einer Buchung und bekommt eine
 * Sammelrechnung; jede Position eines Zimmers muss dann sagen, wer dort
 * uebernachtet hat. Gast ist der Hauptgast der Reservierung, aus der die
 * Buchung stammt -- dort steht er aus Buchung und Meldeschein.
 *
 * Nur, wo es etwas sagt: die Rechnung umfasst mehrere Zimmer, oder sie geht
 * an jemand anderen als den Gast (eine Firma, der Ehepartner). Die eigene
 * Rechnung eines Einzelgastes nennt ihn schon als Empfaenger; ihn in jeder
 * Zeile zu wiederholen, waere nur laenger.
 */
async function gastJePosition(
  client: PoolClient,
  folio: { guest_id: number | null; company_id: number | null },
  charges: ReadonlyArray<{ id: number; reservation_id: number | null }>
): Promise<Record<string, string>> {
  const ids = [...new Set(charges.map(c => c.reservation_id)
    .filter((x): x is number => x !== null))]
  if (ids.length === 0) return {}
  const r = await client.query<{ id: number; guest_id: number | null
                                 room: string | null; name: string | null }>(
    `SELECT r.id, r.primary_guest_id AS guest_id, u.code AS room,
            NULLIF(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name
       FROM reservation r
       LEFT JOIN guest g ON g.id = r.primary_guest_id
       LEFT JOIN resource u ON u.id = r.resource_id
      WHERE r.id = ANY($1::bigint[])`, [ids])
  const mehrere = ids.length > 1
  const zusatz = new Map<number, string>()
  for (const x of r.rows) {
    const fremd = folio.company_id !== null
      || (x.guest_id !== null && Number(x.guest_id) !== Number(folio.guest_id))
    if (!mehrere && !fremd) continue
    const label = guestLineLabel(x.room, x.name)
    if (label !== '') zusatz.set(Number(x.id), label)
  }
  const out: Record<string, string> = {}
  for (const c of charges) {
    const label = c.reservation_id === null ? undefined : zusatz.get(Number(c.reservation_id))
    if (label !== undefined) out[String(c.id)] = label
  }
  return out
}

/**
 * Was eine Rechnung waere, ohne sie festzuschreiben.
 *
 * Dieselbe Rechnung fuer die Vorschau im Dialog und fuer das Festschreiben:
 * zwei Rechenwege liefen auseinander, und die Vorschau zeigte dann eine
 * andere Summe als das Papier. Schreibt nichts; die Nummer vergibt erst
 * der Aufrufer, der wirklich festschreibt.
 */
async function rechnungsEntwurf(
  client: PoolClient,
  folio: { id: number; property_id: number; guest_id: number | null
           company_id: number | null },
  auftrag: RechnungsAuftrag
) {
  // Eine Rechnung umfasst eine Menge von Charges, nicht ein Folio.
  // Damit sind Zwischenrechnungen und getrennte Rechnungen moeglich.
  // Die Kurtaxe nie: siehe OHNE_KURTAXE. Ein offenes Storno-Paar auch
  // nicht, auch nicht ausdruecklich gewaehlt: siehe OHNE_STORNOPAAR.
  const charges = await client.query<{ id: number; net_cent: number; tax_rate_bp: number
                                       gross_cent: number
                                       description: string; quantity: number
                                       business_date: string
                                       reservation_id: number | null
                                       revenue_account: string
                                       package_part: string | null }>(
    auftrag.chargeIds?.length
      ? `SELECT id, net_cent, tax_rate_bp, gross_cent, description, quantity,
                business_date::text, reservation_id, revenue_account, package_part
           FROM charge c
          WHERE folio_id = $1 AND invoice_id IS NULL AND id = ANY($2)
            AND ${OHNE_KURTAXE} AND ${OHNE_STORNOPAAR} ORDER BY id`
      : `SELECT id, net_cent, tax_rate_bp, gross_cent, description, quantity,
                business_date::text, reservation_id, revenue_account, package_part
           FROM charge c
          WHERE folio_id = $1 AND invoice_id IS NULL AND ${OHNE_KURTAXE}
            AND ${OHNE_STORNOPAAR}
          ORDER BY id`,
    auftrag.chargeIds?.length ? [folio.id, auftrag.chargeIds] : [folio.id])
  if (charges.rowCount === 0) throw Errors.unprocessable('folio.nothingOpen')
  const lineGuests = await gastJePosition(client, folio, charges.rows)

  /*
   * Offene Anzahlungen dieses Folios: Verrechnung als eigene Position
   * mit negativem Betrag und Verweis auf die Anzahlungsrechnung
   * (Aufgabe 3, § 13 Abs. 1 Nr. 1a UStG). Der Steuersatz der Position
   * bleibt der der Anzahlung, nicht der des Aufenthalts: verrechnet
   * wird, was schon versteuert wurde, zum Satz, zu dem es versteuert
   * wurde. Das Folio selbst bleibt unberuehrt, dessen Saldo kommt
   * allein aus charge und settlement; die Anzahlung stand dort schon
   * als settlement und wuerde sonst doppelt gezaehlt.
   *
   * Nur auf der Schlussrechnung ueber alle offenen Positionen. Eine
   * Zwischenrechnung ueber eine Auswahl darf die Anzahlung nicht
   * verbrauchen: sie gehoert zum ganzen Aufenthalt, nicht zu einer
   * Auswahl daraus. Sonst zoege eine Zwischenrechnung ueber ein
   * Mineralwasser die ganze Anzahlung ab -- und lautete ueber einen
   * negativen Betrag.
   */
  const schlussrechnung = (auftrag.kind ?? 'final') === 'final' && !auftrag.chargeIds?.length
  const deposits = schlussrechnung ? await client.query<{
    deposit_invoice_id: number; net_cent: string; tax_cent: string
    tax_rate_bp: number; amount_gross_cent: string
    deposit_number: string; deposit_issued_on: string
  }>(
    // Verrechnet wird, was nach Rueckzahlungen bleibt (0162): die Steuer
    // auf den zurueckgezahlten Teil hat dessen Korrektur schon berichtigt.
    `SELECT dl.deposit_invoice_id, dl.net_cent - COALESCE(r.net, 0) AS net_cent,
            dl.tax_cent - COALESCE(r.tax, 0) AS tax_cent, dl.tax_rate_bp,
            dl.amount_gross_cent - COALESCE(r.gross, 0) AS amount_gross_cent,
            di.number AS deposit_number,
            di.issued_on::text AS deposit_issued_on
       FROM deposit_ledger dl
       JOIN invoice di ON di.id = dl.deposit_invoice_id
       LEFT JOIN LATERAL (
         SELECT sum(x.amount_gross_cent) AS gross, sum(x.net_cent) AS net,
                sum(x.tax_cent) AS tax
           FROM deposit_ledger x
          WHERE x.deposit_invoice_id = dl.deposit_invoice_id
            AND x.tax_rate_bp = dl.tax_rate_bp AND x.kind = 'refunded'
       ) r ON true
      WHERE dl.folio_id = $1 AND dl.kind = 'received'
        AND dl.amount_gross_cent > COALESCE(r.gross, 0)
        -- Offen ist, was keine Schlussrechnung verrechnet, die noch gilt:
        -- eine Stornorechnung hebt die Verrechnung wieder auf (0161).
        AND NOT EXISTS (
          SELECT 1 FROM deposit_ledger a
           WHERE a.deposit_invoice_id = dl.deposit_invoice_id AND a.kind = 'applied'
             AND NOT EXISTS (SELECT 1 FROM invoice s WHERE s.reverses_id = a.applied_invoice_id))
      ORDER BY dl.id`,
    [folio.id]) : { rows: [] as Array<{
      deposit_invoice_id: number; net_cent: string; tax_cent: string
      tax_rate_bp: number; amount_gross_cent: string
      deposit_number: string; deposit_issued_on: string }> }

  /*
   * Netto der Positionen ausgleichen, damit jede Satzgruppe das gebuchte
   * Brutto trifft (alignLineNets). Der Ausgleich steht in der
   * Momentaufnahme und wird beim Zeichnen nicht neu gerechnet; die
   * Buchungen selbst bleiben unberuehrt.
   */
  const lineAdjustCent = alignLineNets([
    ...charges.rows.map(c => ({ key: String(c.id), netCent: Number(c.net_cent),
                                grossCent: Number(c.gross_cent), rateBp: c.tax_rate_bp })),
    ...deposits.rows.map(d => ({ key: `d${d.deposit_invoice_id}`, fest: true,
                                 netCent: -Number(d.net_cent),
                                 grossCent: -Number(d.amount_gross_cent),
                                 rateBp: d.tax_rate_bp }))
  ])
  for (const c of charges.rows) {
    c.net_cent = Number(c.net_cent) + (lineAdjustCent.get(String(c.id)) ?? 0)
  }

  const positionen = [
    ...charges.rows.map(c => ({ netCent: Number(c.net_cent), rateBp: c.tax_rate_bp })),
    ...deposits.rows.map(d => ({ netCent: -Number(d.net_cent), rateBp: d.tax_rate_bp }))
  ]

  /*
   * Rundungsausgleich (Aufgabe 12).
   *
   * Die Rechnung kann nicht jeden Bruttobetrag treffen. Die Steuer wird
   * je Satzgruppe aus der Nettosumme gerechnet (BR-CO-14), und bei
   * ganzzahligem Netto und ganzzahliger Steuer gibt es Bruttobetraege,
   * zu denen kein Netto passt: zu 7 Prozent 6,5 Prozent aller Betraege,
   * zu 19 Prozent 16,0 Prozent. Ein Kassenbeleg ueber glatte 250,00 zu
   * 7 Prozent ergibt 233,64 + 16,35 = 249,99; darueber liegt erst
   * wieder 250,01.
   *
   * Ohne Ausgleich fordert die Rechnung einen Cent weniger, als die
   * Positionen zusammen ergeben. Der Gast zahlt, was auf dem Papier
   * steht, und der Cent bleibt auf dem Folio offen -- fuer immer, weil
   * niemand nach einem Cent sucht. Ueber viele Posten waren es bis zu
   * drei.
   *
   * **Warum keine eigene Position.** Das war der erste Entwurf und ist
   * an der eigenen Pflichtangabenpruefung gescheitert: eine Position zu
   * 0 Prozent braucht nach § 14 Abs. 4 Nr. 8 UStG den Grund der
   * Steuerbefreiung, und fuer eine Rundung gibt es keinen -- sie ist
   * kein Umsatz. Im Satz der Gruppe wiederum muesste die Position rund
   * vierzehn Cent gross sein, um einen Cent Wirkung zu haben, weil sie
   * die Steuer der ganzen Gruppe mitverschiebt.
   *
   * EN 16931 hat dafuer den Rundungsbetrag auf Belegebene (BT-114): er
   * laesst Satzgruppen und Gesamtsumme unberuehrt und wirkt allein auf
   * den Zahlbetrag (BR-CO-16). Keine Position, keine Steuerkategorie,
   * kein Befreiungsgrund -- und auf dem Blatt eine benannte Zeile.
   */
  /*
   * Seit dem 14.10.2026 bleibt der Rundungsbetrag fast immer null: den
   * Cent, den `alignLineNets` je Gruppe nicht trifft, traegt die Steuer der
   * Gruppe (`taxAdjustToGross`, Svens Entscheidung "Herausrechnen"). Er
   * bleibt fuer den Rest, den das nicht deckt -- eine Gruppe zu 0 Prozent
   * oder mehr als ein Cent.
   */
  const zielJeSatz = new Map<number, number>()
  for (const c of charges.rows) {
    zielJeSatz.set(c.tax_rate_bp, (zielJeSatz.get(c.tax_rate_bp) ?? 0) + Number(c.gross_cent))
  }
  for (const d of deposits.rows) {
    zielJeSatz.set(d.tax_rate_bp,
      (zielJeSatz.get(d.tax_rate_bp) ?? 0) - Number(d.amount_gross_cent))
  }
  const taxAdjustCent = taxAdjustToGross(sumInvoice(positionen).groups, zielJeSatz)
  const gerundet = sumInvoice(positionen, taxAdjustCent)
  const zielBrutto =
    charges.rows.reduce((sum, c) => sum + Number(c.gross_cent), 0)
    - deposits.rows.reduce((sum, d) => sum + Number(d.amount_gross_cent), 0)
  const roundingCent = zielBrutto - gerundet.grossCent

  /*
   * Was festgeschrieben und zurueckgegeben wird, traegt beides: die
   * normgerechten Summen (BT-106, BT-110, BT-112) und daneben den
   * Ausgleich und den Betrag, den die Rechnung tatsaechlich fordert.
   * Der Beleg liest den Ausgleich spaeter von hier und rechnet ihn
   * nicht neu -- waere er ableitbar, waere er nicht noetig.
   */
  /*
   * Was schon bezahlt ist, wird **jetzt** festgestellt und in die
   * Momentaufnahme geschrieben, statt es spaeter beim Zeichnen des
   * Belegs aus den Zahlungsvermerken zu rechnen.
   *
   * Der Grund ist derselbe wie beim Ausgleich: der Beleg ist eine
   * Momentaufnahme. Zahlt der Gast nach dem Festschreiben und ist der
   * Beleg noch nicht gezeichnet, stuende auf ihm ein anderer
   * vorausgezahlter Betrag als auf dem gleich ausgedruckten -- und
   * welcher, haenge davon ab, wann der Worker gelaufen ist. Die
   * Zuordnung selbst laeuft weiter, damit eine Liste sagen kann, was
   * offen ist; der Beleg liest sie nicht.
   */
  /*
   * Dieselbe Kurtaxe von der anderen Seite: hat der Gast vorab alles
   * bezahlt, auch sie, passt sein Vermerk nur mit ihr unter die
   * Grenze. Ausgewiesen wird als vorausbezahlt (BT-113) dennoch
   * hoechstens der Betrag der Rechnung -- der Rest war die Kurtaxe,
   * und der Zahlbetrag darf nicht negativ werden.
   */
  const kurtaxe = await kurtaxeAmFolio(client, folio.id)
  const { ids: vorausbezahlt, summeCent: gezahltCent } =
    passendeVermerke(await offeneVermerke(client, folio.id), zielBrutto + kurtaxe)
  const prepaidCent = Math.min(gezahltCent, Math.max(zielBrutto, 0))
  const totals = {
    ...gerundet, roundingCent, payableCent: zielBrutto, prepaidCent,
    ...(lineAdjustCent.size > 0
      ? { lineAdjustCent: Object.fromEntries(lineAdjustCent) as Record<string, number> }
      : {}),
    ...(Object.keys(taxAdjustCent).length > 0 ? { taxAdjustCent } : {})
  }

  /*
   * Mehr angezahlt als abzurechnen: das kommt vor, wenn der Gast
   * frueher abreist oder ein Teil des Aufenthalts schon
   * zwischenabgerechnet wurde. Dem Gast steht dann Geld zu -- und
   * dafuer ist eine Rechnung ueber einen negativen Betrag das falsche
   * Papier. Abgewiesen wird hier deshalb, solange es die Rueckzahlung
   * ('refunded' im Anzahlungsjournal) noch nicht gibt: lieber keine
   * Rechnung als eine, die niemand buchen kann.
   */
  if (deposits.rows.length > 0 && totals.grossCent < 0) {
    throw Errors.unprocessable(
      'deposit.exceedsServices', { cent: -totals.grossCent })
  }

  /*
   * Aussteller und Empfaenger werden gleich in der Form gelesen, in der
   * sie geprueft und gespeichert werden. Eine Umbenennung zwischen
   * Datenbank und Pruefung ist eine Stelle, an der ein Feld lautlos
   * verschwindet: genau das ist hier einmal passiert, die Anschrift kam
   * als postal_code an und wurde als postalCode gesucht.
   */
  const prop = await client.query<Party>(
    `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
            city, country, tax_number AS "taxNumber", vat_id AS "vatId",
            commercial_register AS "registrationId", invoice_contact_name AS "contactName",
            invoice_phone AS phone,
            invoice_email AS email, invoice_email AS "electronicAddress",
            bank_iban AS iban, bank_bic AS bic, bank_name AS "bankName",
            bank_account_holder AS "accountHolder", invoice_website AS website
       FROM property WHERE id = $1`, [folio.property_id])
  const recipient = folio.company_id
    ? await client.query<Party>(
        `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                city, country, vat_id AS "vatId", contact_name AS "contactName",
                buyer_reference AS "buyerReference", invoice_email AS "electronicAddress"
           FROM company WHERE id = $1`, [folio.company_id])
    : folio.guest_id
      ? await client.query<Party>(
          `SELECT trim(both ', ' from
                    coalesce(last_name,'') || ', ' || coalesce(first_name,'')) AS name,
                  address_line1 AS "addressLine1", postal_code AS "postalCode",
                  city, country
             FROM guest WHERE id = $1`, [folio.guest_id])
      : { rows: [] as Party[] }
  const vorgabe = recipient.rows[0] ?? {}
  const empfaenger = mitAbweichung(vorgabe, auftrag.recipient)

  const businessDate = await offenerGeschaeftstag(client, folio.property_id)
  const heute = await heuteImHaus(client, folio.property_id)

  /*
   * Leistungszeitraum nach § 14 Abs. 4 Nr. 6 UStG.
   *
   * Bei Beherbergung ist das der **Aufenthalt**, nicht das
   * Rechnungsdatum. Die Verwechslung ist der häufigste Mangel an
   * Hotelrechnungen. Er wird aus den Geschäftsdaten der abzurechnenden
   * Positionen abgeleitet und nicht vom Aufrufer entgegengenommen:
   * die Positionen wissen es, der Aufrufer könnte sich irren.
   */
  const daten = charges.rows.map(c => c.business_date).sort()
  const serviceFrom = daten[0]!
  const serviceTo = daten[daten.length - 1]!

  
  /*
   * Faelligkeit. Ohne Angabe aus dem Ziel der Firma, sonst aus der Vorgabe
   * des Hauses, gezaehlt ab dem Ausstellungstag. Ist nichts offen, gibt es
   * keine: "zahlbar bis" ueber null Euro liest ein Gast als Mahnung.
   */
  const ziel = await client.query<{ vorgabe: string; spaetestens: string }>(
    `SELECT ($4::date + COALESCE(
               (SELECT c.payment_terms_days FROM company c WHERE c.id = $2),
               p.payment_terms_days))::text AS vorgabe,
            ($4::date + $3::int)::text AS spaetestens
       FROM property p WHERE p.id = $1`,
    [folio.property_id, folio.company_id, ZIEL_MAX_TAGE, heute])
  const { spaetestens } = ziel.rows[0]!
  if (auftrag.dueOn !== undefined && (auftrag.dueOn < heute || auftrag.dueOn > spaetestens)) {
    throw Errors.validation({ dueOn: ['field.range'] }, { min: heute, max: spaetestens })
  }
  const offenCent = auftrag.paid !== undefined ? 0
    : totals.payableCent - totals.prepaidCent
  const dueOn = offenCent > 0 ? auftrag.dueOn ?? ziel.rows[0]!.vorgabe : null

  return {
    charges: charges.rows, deposits: deposits.rows, totals, vorausbezahlt, lineGuests,
    issuer: prop.rows[0] ?? {}, recipient: empfaenger, defaultRecipient: vorgabe,
    businessDate, serviceFrom, serviceTo, dueOn, offenCent, heute
  }
}

/**
 * Der Entwurf als Rechnung, wie Blatt und XML sie lesen (Sven, 16.10.2026:
 * eine Vorschau, bevor die Rechnung festgeschrieben und unveraenderbar ist).
 *
 * Dieselbe Abbildung wie im Worker (`chargeLineSource`, `groupInvoiceLines`,
 * `depositLedgerLine`), nur aus dem Entwurf statt aus der Momentaufnahme:
 * der Entwurf soll genau die Zeilen zeigen, die das Papier danach traegt.
 * Der Ausgleich je Position steckt schon im Netto der Buchungen
 * (`rechnungsEntwurf`), deshalb hier null.
 */
function entwurfAlsRechnung(
  e: Awaited<ReturnType<typeof rechnungsEntwurf>>, kind: 'final' | 'interim',
  bezahlt: boolean
): CiiInvoice {
  const issuer = e.issuer as Parameters<typeof payeeFromSnapshot>[0] & Partial<CiiParty>
  const recipient = e.recipient as Partial<CiiParty> & { buyerReference?: string | null }
  return {
    number: 'Entwurf',
    issuedOn: e.heute,
    kind,
    currency: 'EUR',
    seller: partyFromSnapshot(issuer),
    buyer: partyFromSnapshot(recipient),
    buyerReference: recipient.buyerReference ?? null,
    payee: payeeFromSnapshot(issuer),
    lines: [
      ...groupInvoiceLines(e.charges.map(c =>
        chargeLineSource(c, 0, e.lineGuests[String(c.id)]))),
      ...e.deposits.map(d => depositLedgerLine({
        kind: 'applied', net_cent: d.net_cent, tax_rate_bp: d.tax_rate_bp,
        deposit_number: d.deposit_number, deposit_issued_on: d.deposit_issued_on }))
    ],
    serviceFrom: e.serviceFrom,
    serviceTo: e.serviceTo,
    // "Bezahlt" schreibt den Zahlungsvermerk erst beim Festschreiben; der
    // Entwurf zeigt schon, was dann darauf steht.
    prepaidCent: bezahlt ? e.totals.payableCent : e.totals.prepaidCent,
    roundingCent: e.totals.roundingCent,
    ...(e.totals.taxAdjustCent === undefined ? {} : { taxAdjustCent: e.totals.taxAdjustCent }),
    dueOn: bezahlt ? null : e.dueOn,
    precedingInvoice: null,
    notes: []
  }
}

/** Die Pflichtangaben einer Rechnung, wie sie festgeschrieben wuerde. */
function rechnungsMaengel(
  e: Awaited<ReturnType<typeof rechnungsEntwurf>>, nummer: string,
  kind: 'final' | 'interim'
) {
  return blockingFindings({
    number: nummer,
    issuedOn: e.heute,
    serviceFrom: e.serviceFrom, serviceTo: e.serviceTo,
    issuer: e.issuer,
    recipient: e.recipient,
    lines: e.charges.map(c => ({
      description: lineWithGuest(c.description, e.lineGuests[String(c.id)]),
      quantity: c.quantity,
      netCent: Number(c.net_cent), rateBp: c.tax_rate_bp })),
    // An der Grenze zur Kleinbetragsrechnung (§ 33 UStDV) entscheidet der
    // Gesamtbetrag der Leistung, wie er gefordert wird -- mit Rundung, aber
    // vor Abzug einer Anzahlung. Bisher galt der Betrag danach: 600 Euro
    // Aufenthalt mit 400 Euro Anzahlung wurden zur Kleinbetragsrechnung
    // ohne Empfaenger (Pruefung 13.10.2026).
    grossCent: e.charges.reduce((sum, c) => sum + Number(c.gross_cent), 0),
    kind
  })
}

const MAX_RECHNUNGSTAGE = 400

export function billingRoutes(app: FastifyInstance): void {
  /**
   * Rechnungskuerzel des Hauses (Migration 0157).
   *
   * `required` sagt, ob ohne Kuerzel keine Rechnung entsteht -- das haengt
   * an den anderen Haeusern des Accounts, die der Bildschirm nicht sieht.
   * `locked`: unter dem Kuerzel ist schon eine Rechnung ausgestellt. Dann
   * bleibt es. Gaebe das Haus es ab und nahm ein anderes Haus es spaeter
   * auf, zaehlte dieses ab H-2026-00001 noch einmal.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/invoice-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Rechnungskuerzel des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => rechnungseinstellung(client, Number(propertyId)))
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/invoice-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Rechnungskuerzel des Hauses setzen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as { prefix?: unknown; paymentTermsDays?: unknown
                                      contact?: Partial<Record<KontaktFeld, unknown>> }
      const kontakt = kontaktPruefen(b.contact)
      // Beides einzeln setzbar: wer das Zahlungsziel aendert, soll nicht
      // das Kuerzel mitschicken muessen.
      const ziel = b.paymentTermsDays
      if (ziel !== undefined && !(typeof ziel === 'number' && Number.isInteger(ziel)
                                  && ziel >= 0 && ziel <= ZIEL_MAX_TAGE)) {
        throw Errors.validation({ paymentTermsDays: ['field.range'] },
          { min: 0, max: ZIEL_MAX_TAGE })
      }
      const prefix = typeof b.prefix === 'string' ? b.prefix.trim().toUpperCase() : ''
      const anderes = ziel !== undefined || kontakt !== null
      if ((b.prefix !== undefined || !anderes) && !KUERZEL.test(prefix)) {
        throw Errors.validation({ prefix: ['field.invalid'] })
      }

      return tx(req.pool, req, async client => {
        if (ziel !== undefined) {
          await client.query(`UPDATE property SET payment_terms_days = $2 WHERE id = $1`,
            [Number(propertyId), ziel])
        }
        if (kontakt !== null) {
          const felder = Object.keys(kontakt) as KontaktFeld[]
          await client.query(
            `UPDATE property SET ${felder.map((k, i) => `${KONTAKT_FELDER[k]} = $${i + 2}`)
              .join(', ')} WHERE id = $1`,
            [Number(propertyId), ...felder.map(k => kontakt[k])])
        }
        const jetzt = await rechnungseinstellung(client, Number(propertyId))
        if (b.prefix === undefined || jetzt.prefix === prefix) return jetzt
        if (jetzt.locked) {
          throw Errors.conflict('invoice.prefixInUse', { prefix: jetzt.prefix ?? '' })
        }
        try {
          await client.query(
            `UPDATE property SET invoice_prefix = $2 WHERE id = $1`,
            [Number(propertyId), prefix])
        } catch (e) {
          // Der Index sieht die anderen Haeuser des Accounts, die
          // Zeilenrichtlinie nicht: eine Vorabfrage fände das Kuerzel nie.
          if ((e as { constraint?: string }).constraint === 'property_invoice_prefix') {
            throw Errors.conflict('invoice.prefixTaken', { prefix })
          }
          throw e
        }
        return rechnungseinstellung(client, Number(propertyId))
      })
    }
  })

  /**
   * Logo auf der Rechnung (Migration 0170). Base64 im JSON-Rumpf wie bei den
   * Terminalbildern, hoechstens ein Megabyte, nur PNG und JPEG -- die
   * Formate, die das PDF/A-3 ohne Umwandlung einbettet. Die Art erkennen die
   * Bytes, nicht die Angabe. Wirkt auf jeden Beleg, der danach gezeichnet
   * wird; ein gezeichneter bleibt, wie er ist.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/invoice-logo',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    bodyLimit: Math.ceil(BILD_MAX_BYTES * 4 / 3) + 4096,
    summary: 'Logo fuer Rechnungen hochladen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { art, bytes } = bildAusRumpf(req.body)
      if (art !== 'image/png' && art !== 'image/jpeg') {
        throw Errors.validation({ data: ['invoice.logoType'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO property_invoice_logo (property_id, mime, bytes, sha256, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (property_id) DO UPDATE
              SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
                  created_by = EXCLUDED.created_by, created_at = now()`,
          [Number(propertyId), art, bytes, createHash('sha256').update(bytes).digest('hex'),
           principal.userId])
        return rechnungseinstellung(client, Number(propertyId))
      })
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/properties/:propertyId/invoice-logo',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Logo fuer Rechnungen entfernen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        await client.query(`DELETE FROM property_invoice_logo WHERE property_id = $1`,
          [Number(propertyId)])
        return rechnungseinstellung(client, Number(propertyId))
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/invoice-logo',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Logo fuer Rechnungen ansehen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const logo = await tx(req.pool, req, async client => {
        const r = await client.query<{ mime: string; bytes: Buffer }>(
          `SELECT mime, bytes FROM property_invoice_logo WHERE property_id = $1`,
          [Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.invoiceLogo')
        return r.rows[0]!
      })
      return bildSenden(reply, logo)
    }
  })

  /**
   * Versandnachweis einer Rechnung (Migration 0170): an wen, wann, mit
   * welcher Kennung des Anbieters und welcher Fassung des Belegs. "Versandt"
   * heisst vom Anbieter angenommen, nicht im Postfach gelesen -- mehr kann
   * ein Mailversand nicht belegen, und der Bildschirm sagt es so.
   *
   * Die volle Adresse, nicht verdeckt wie im Postausgang: sie ist der
   * Nachweis, und wer das Folio sehen darf, sieht den Empfaenger ohnehin.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/invoices/:invoiceRef/mails',
    permission: 'folio:read',
    summary: 'Versandnachweis einer Rechnung',
    handler: async (req) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      return tx(req.pool, req, async client => {
        const i = await client.query<{ id: number; property_id: number
                                       sha256: string | null }>(
          `SELECT i.id, i.property_id, d.sha256
             FROM invoice i LEFT JOIN invoice_document d ON d.invoice_id = i.id
            WHERE i.public_ref = $1`, [invoiceRef])
        if (i.rowCount === 0) throw Errors.notFound('res.invoice')
        rechtImHaus(req.principal as Principal, 'folio:read', i.rows[0]!.property_id)
        const { rows } = await client.query(
          `SELECT e.public_ref AS "messageRef", e.status,
                  NULLIF(e.to_email, 'entfernt@invalid') AS "toEmail",
                  e.to_name AS "toName", e.subject,
                  e.created_at AS "requestedAt", e.sent_at AS "sentAt",
                  e.attempts, e.provider_message_id AS "providerMessageId",
                  e.attachment_sha256 AS "attachmentSha256",
                  e.attachment_sha256 IS NOT NULL
                    AND e.attachment_sha256 = $2 AS "sameDocument",
                  u.display_name AS "requestedBy"
             FROM outbound_email e
             LEFT JOIN app_user u ON u.id = e.requested_by
            WHERE e.invoice_id = $1
            ORDER BY e.id`, [i.rows[0]!.id, i.rows[0]!.sha256])
        return { invoiceRef, documentSha256: i.rows[0]!.sha256, mails: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/payment-methods',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Zahlungsarten der Property',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { includeInactive?: string }
      return tx(req.pool, req, async client => {
        // `id`, `sortOrder` und `active` kommen immer mit: ohne sie ist die
        // Liste ansehbar, aber nicht pflegbar, und die Pflegemaske muesste
        // sie einzeln nachfragen.
        const { rows } = await client.query(
          `SELECT id, code, name, is_external AS "isExternal",
                  sort_order AS "sortOrder", active
             FROM payment_method
            WHERE property_id = $1 AND (active OR $2::boolean)
            ORDER BY sort_order, code`,
          [Number(propertyId), q.includeInactive === 'true'])
        // Der Hinweis gehoert an die Liste, nicht in eine Fussnote: dieses
        // System wickelt keine Zahlung ab und fuehrt keinen Kassenbestand.
        // Es vermerkt, wo abgerechnet wurde (Entscheidung 9, Dokument 09).
        return {
          paymentMethods: rows,
          hinweis: hinweisText('hint.settlementIsNotPayment'),
          hinweisKey: 'hint.settlementIsNotPayment'
        }
      })
    }
  })


  /**
   * Zahlungsart anlegen.
   *
   * Was hier **nicht** entsteht, ist eine Kasse. Ein Zahlungsvermerk ordnet
   * zu, er wickelt nicht ab: es gibt keinen Kassenbestand, keine TSE und
   * keinen Bon (Entscheidung 10, Dokument 09). `isExternal` sagt deshalb
   * nur, ob die Abwicklung ausser Haus liegt -- eine Buchungsregel ist es
   * nicht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/payment-methods',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Zahlungsart anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = req.body as { code: string; name: string; isExternal?: boolean
                              sortOrder?: number }
      const fehler: Record<string, string[]> = {}
      if (!b.code?.trim()) fehler.code = ['field.required']
      if (!b.name?.trim()) fehler.name = ['field.required']
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      return tx(req.pool, req, async client => {
        const da = await client.query(
          `SELECT 1 FROM payment_method WHERE property_id = $1 AND code = $2`,
          [Number(propertyId), b.code.trim()])
        if (da.rowCount && da.rowCount > 0) {
          throw Errors.conflict('paymentMethod.duplicateCode', { code: b.code })
        }
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO payment_method (property_id, code, name, is_external, sort_order)
           VALUES ($1,$2,$3,COALESCE($4,true),
                   COALESCE($5,(SELECT COALESCE(max(sort_order),0)+10
                                  FROM payment_method WHERE property_id = $1)))
           RETURNING id`,
          [Number(propertyId), b.code.trim(), b.name.trim(),
           b.isExternal ?? null, b.sortOrder ?? null])
        reply.status(201)
        return { paymentMethodId: rows[0]!.id, code: b.code.trim() }
      })
    }
  })

  /**
   * Zahlungsart aendern oder stilllegen.
   *
   * Es gibt **kein** Loeschen, und das ist keine Bequemlichkeit: an einer
   * Zahlungsart haengen Verrechnungen, und `settlement` ist Haertegrad 1.
   * Eine geloeschte Zahlungsart liesse Belege zurueck, deren Zahlungsweg
   * niemand mehr benennen kann. Stillgelegt verschwindet sie aus der Auswahl
   * und bleibt in der Geschichte.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/payment-methods/:paymentMethodId',
    permission: 'settings:property',
    summary: 'Zahlungsart aendern oder stilllegen',
    handler: async (req) => {
      const { paymentMethodId } = req.params as { paymentMethodId: string }
      const b = req.body as { name?: string; isExternal?: boolean
                              sortOrder?: number; active?: boolean }
      if (b.name !== undefined && b.name.trim() === '') {
        throw Errors.validation({ name: ['field.required'] })
      }
      return tx(req.pool, req, async client => {
        /*
         * Das Recht im Haus der Zahlungsart, nicht in irgendeinem: die Pfade
         * dieser Datei tragen keine Property, `registerRoute` prueft deshalb
         * nur "irgendwo", und die Zeilenrichtlinie laesst jedes Haus durch,
         * in dem der Benutzer irgendeine Rolle hat (Befund H4,
         * Sicherheitsaudit 2026-10-11). Jede Route hier prueft das Recht
         * deshalb noch einmal, sobald der Datensatz und damit sein Haus
         * feststeht.
         */
        const pmHaus = await client.query<{ property_id: number }>(
          `SELECT property_id FROM payment_method WHERE id = $1 FOR UPDATE`,
          [Number(paymentMethodId)])
        if (pmHaus.rowCount === 0) throw Errors.notFound('res.paymentMethod')
        rechtImHaus(req.principal as Principal, 'settings:property', pmHaus.rows[0]!.property_id)
        const { rows, rowCount } = await client.query(
          `UPDATE payment_method SET
             name = COALESCE($2, name),
             is_external = COALESCE($3, is_external),
             sort_order = COALESCE($4, sort_order),
             active = COALESCE($5, active)
           WHERE id = $1
           RETURNING id, code, name, is_external AS "isExternal",
                     sort_order AS "sortOrder", active`,
          [Number(paymentMethodId), b.name?.trim() ?? null, b.isExternal ?? null,
           b.sortOrder ?? null, b.active ?? null])
        // Die Zeilenrichtlinie hat fremde Haeuser schon aussortiert; hier
        // bleibt nur "gibt es nicht".
        if (rowCount === 0) throw Errors.notFound('res.paymentMethod')
        return rows[0]!
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/folios/:folioRef',
    permission: 'folio:read',
    summary: 'Folio mit Positionen und Saldo',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      return tx(req.pool, req, async client => {
        const f = await client.query(
          `SELECT id, public_ref, property_id, reservation_id, kind, status, label,
                  guest_id, company_id
             FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(req.principal as Principal, 'folio:read', folio.property_id)

        const charges = await client.query(
          `SELECT id, business_date::text, description, quantity,
                  net_cent, tax_cent, gross_cent, tax_rate_bp,
                  revenue_account, invoice_id, reverses_id,
                  NOT (${OHNE_KURTAXE}) AS city_tax
             FROM charge c WHERE folio_id = $1 ORDER BY id`, [folio.id])
        const settlements = await client.query(
          `SELECT s.id, s.business_date::text, s.amount_cent, s.external_reference,
                  pm.code AS method, s.reverses_id
             FROM settlement s JOIN payment_method pm ON pm.id = s.payment_method_id
            WHERE s.folio_id = $1 ORDER BY s.id`, [folio.id])

        /*
         * Die Rechnungen dieses Folios, mit Beleg. Bisher fuehrte vom Folio
         * kein Weg zum gerade ausgestellten PDF; man musste es in der
         * Rechnungsliste suchen (Pruefung 13.10.2026).
         */
        const invoices = await client.query(
          `SELECT i.public_ref AS "invoiceRef", i.number, i.kind,
                  i.issued_on::text AS "issuedOn",
                  (i.totals->>'grossCent')::bigint AS "grossCent",
                  sn.number AS "cancelledBy",
                  d.invoice_id IS NOT NULL AS "documentReady"
             FROM invoice i
             LEFT JOIN invoice sn ON sn.reverses_id = i.id AND NOT sn.partial_reversal
             LEFT JOIN invoice_document d ON d.invoice_id = i.id
            WHERE i.folio_id = $1 ORDER BY i.id`, [folio.id])

        // Die Konten der Buchung (Split und Sammelrechnung): erst die des
        // eigenen Zimmers, Gastfolio vorn, dann die der anderen Zimmer einer
        // Gruppe. Weitere legt `.../split` als 'company' an.
        const stay = folio.reservation_id === null ? [] : (await client.query<{
          folioRef: string; label: string | null; main: boolean; group: boolean; saldo: string
          accommodationHere: boolean; room: string | null; ownStay: boolean }>(
          `SELECT x.public_ref AS "folioRef", x.label, x.kind = 'guest' AS main,
                  x.kind = 'group' AS "group",
                  (COALESCE((SELECT sum(gross_cent) FROM charge WHERE folio_id = x.id), 0)
                 - COALESCE((SELECT sum(amount_cent) FROM settlement
                              WHERE folio_id = x.id), 0))::text AS saldo,
                  EXISTS (SELECT 1 FROM routing_rule rr
                           WHERE rr.reservation_id = x.reservation_id
                             AND rr.target_folio_id = x.id
                             AND rr.match_kind IN ('accommodation', 'all'))
                    AS "accommodationHere",
                  u.code AS room, r.id = $1 AS "ownStay"
             FROM reservation eigene
             JOIN reservation r ON r.booking_id = eigene.booking_id
             JOIN folio x ON x.reservation_id = r.id
             LEFT JOIN resource u ON u.id = r.resource_id
            WHERE eigene.id = $1 AND x.property_id = $2
            -- Das Gruppenfolio vorn: es ist das Konto, auf das alle buchen.
            ORDER BY x.kind = 'group' DESC, r.id = $1 DESC, r.id, x.kind = 'guest' DESC, x.id
            LIMIT 60`,
          [folio.reservation_id, folio.property_id])).rows
          .map(({ saldo, ...x }) => ({ ...x, balanceCent: Number(saldo) }))

        const charged = charges.rows.reduce((s, c) => s + Number(c.gross_cent), 0)
        const settled = settlements.rows.reduce((s, p) => s + Number(p.amount_cent), 0)
        return {
          folio, charges: charges.rows, settlements: settlements.rows,
          invoices: invoices.rows.map(i => ({ ...i, grossCent: Number(i.grossCent) })),
          stay,
          balanceCent: charged - settled,
          recipient: await empfaenger(client, folio.guest_id, folio.company_id)
        }
      })
    }
  })

  /**
   * Wer die Rechnung bekommt.
   *
   * **Warum das ueberhaupt aenderbar ist.** Die Rechnung geht nicht immer
   * an den, der im Zimmer schlaeft: die Firma zahlt, der Ehepartner zahlt,
   * die Reisestelle zahlt. Bisher stand der Empfaenger nur da, wo ihn die
   * Buchung hingeschrieben hatte, und eine Korrektur war an der Oberflaeche
   * nicht moeglich -- wer sich vertippt hatte, bekam die Rechnung an den
   * Falschen und musste sie stornieren.
   *
   * **`invoice:issue` und nicht `folio:post`.** Wer eine Minibar bucht,
   * soll keine Rechnung umleiten koennen. Wer sie ausstellen darf,
   * entscheidet auch, an wen.
   *
   * Schon **festgeschriebene** Rechnungen aendert das nicht: ihr Empfaenger
   * steht als Momentaufnahme an der Rechnung (B6, Dokument 13) und ist
   * Haertegrad 1. Das hier wirkt auf die naechste.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/folios/:folioRef/recipient',
    permission: 'invoice:issue',
    summary: 'Rechnungsempfaenger des Folios setzen',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        guestRef?: string | null
        companyRef?: string | null
      }
      if (body.guestRef === undefined && body.companyRef === undefined) {
        throw Errors.validation({ guestRef: ['field.required'] })
      }

      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: number; property_id: number; status: string
                                       guest_id: number | null; company_id: number | null }>(
          `SELECT id, property_id, status, guest_id, company_id
             FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(req.principal as Principal, 'invoice:issue', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        /*
         * Gast und Firma haengen am Account, nicht an der Property -- und
         * zwar am Account **dieses** Hauses. Die Zeilenrichtlinie allein
         * genuegt nicht: wer in zwei Betrieben arbeitet, hat beide im Kontext
         * und setzte sonst den Gast oder die Firma des anderen als Empfaenger
         * (Sicherheitsaudit 2026-10-19, M2).
         */
        let guestId = folio.guest_id
        if (body.guestRef !== undefined) {
          guestId = body.guestRef === null ? null
            : await gastPerRefImBetrieb(client, folio.property_id, body.guestRef)
        }
        let companyId = folio.company_id
        if (body.companyRef !== undefined) {
          companyId = body.companyRef === null ? null
            : await firmaPerRefImBetrieb(client, folio.property_id, body.companyRef)
        }

        await client.query(
          `UPDATE folio SET guest_id = $2, company_id = $3 WHERE id = $1`,
          [folio.id, guestId, companyId])

        return { recipient: await empfaenger(client, guestId, companyId) }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/charges',
    permission: 'folio:post',
    summary: 'Leistung buchen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      // grossCent statt netCent fuer Dialog und Folio: dort wird ein Betrag
      // so eingegeben, wie er auf dem Papier stehen soll. Genau eines von
      // beiden.
      const body = (req.body ?? {}) as BuchungsAuftrag
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      buchungPruefen(body)

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        rechtImHaus(principal, 'folio:post', f.rows[0]!.property_id)
        if (f.rows[0]!.status === 'closed') throw Errors.conflict('folio.closed')
        const folio = f.rows[0]!
        // Der Artikel gehoert zum Haus des Folios. Die Buchung ist
        // Haertegrad 1; ein Verweis auf den Artikel eines fremden Hauses
        // liesse sich danach nur noch gegenbuchen (M4, Sicherheitsaudit
        // 2026-10-11).
        await produktImHaus(client, folio.property_id, body.productId)

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])
        const businessDate = bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10)

        const qty = body.quantity ?? 1
        let net: number
        let tax: number
        if (typeof body.grossCent === 'number' && body.netCent === undefined) {
          const brutto = body.grossCent * qty
          tax = taxFromGross(brutto, body.taxRateBp)
          net = brutto - tax
        } else {
          net = (body.netCent ?? 0) * qty
          tax = taxFromNet(net, body.taxRateBp)
        }
        const r = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp,
                               revenue_account, product_id, created_by)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [folio.property_id, folio.id, businessDate, body.description, qty,
           net, tax, net + tax, body.taxRateBp,
           body.revenueAccount ?? kontoFuerSatz(body.taxRateBp), body.productId ?? null,
           principal.userId])

        const result = { chargeId: r.rows[0]!.id, netCent: net, taxCent: tax, grossCent: net + tax }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Gegenbuchung einer offenen Position (Rechnungsdialog: "korrigieren").
   *
   * Eine Buchung ist Haertegrad 1 und wird nie geaendert. Korrigiert wird,
   * indem die Position mit `reverses_id` aufgehoben und richtig neu gebucht
   * wird; beides bleibt sichtbar, und der Pruefer sieht, was war (GoBD,
   * Nachvollziehbarkeit). Nur offene Positionen: eine schon berechnete
   * gehoert zu einer Rechnung, die erst storniert werden muesste.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/charges/:chargeId/reverse',
    permission: 'folio:post',
    summary: 'Offene Position gegenbuchen',
    handler: async (req, reply) => {
      const { folioRef, chargeId } = req.params as { folioRef: string; chargeId: string }
      const id = Number(chargeId)
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw Errors.validation({ chargeId: ['field.positiveInteger'] })
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { chargeId: id }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1 FOR UPDATE`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        // Die Position gehoert zu diesem Folio, ist offen, selbst keine
        // Gegenbuchung und noch nicht gegengebucht.
        const c = await client.query<{ invoice_id: number | null; reverses_id: number | null
                                       aufgehoben: boolean }>(
          `SELECT c.invoice_id, c.reverses_id,
                  EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id) AS aufgehoben
             FROM charge c WHERE c.id = $1 AND c.folio_id = $2`, [id, folio.id])
        if (c.rowCount === 0) throw Errors.notFound('res.charge')
        const pos = c.rows[0]!
        if (pos.invoice_id !== null) throw Errors.conflict('charge.invoiced')
        if (pos.reverses_id !== null || pos.aufgehoben) {
          throw Errors.conflict('charge.alreadyReversed')
        }

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])
        const r = await client.query<{ id: number; gross_cent: string }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, product_id, reservation_id, reverses_id,
                               created_by, package_part)
           SELECT c.property_id, c.folio_id, $3::date, 'Storno ' || c.description,
                  c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
                  c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id,
                  $4, c.package_part
             FROM charge c WHERE c.id = $1 AND c.folio_id = $2
           RETURNING id, gross_cent`,
          [id, folio.id, bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10),
           principal.userId])

        const result = { chargeId: r.rows[0]!.id, reversesId: id,
                         grossCent: Number(r.rows[0]!.gross_cent) }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Fruehstueck nachtraeglich aus gebuchten Naechten herausrechnen (Sven,
   * 14.10.2026: "fuer bereits eingecheckte und ausgecheckte Buchungen
   * nachtraeglich festlegen und buchen").
   *
   * Die Regel an Rate und Haus (0158, 0169) wirkt erst ab der naechsten
   * Nacht; was vorher gebucht wurde, steht als ganze Uebernachtung im
   * Folio. Eine Position wird nie umgeschrieben (Haertegrad 1): jede offene
   * Uebernachtung ohne Fruehstuecksteil bekommt eine Gegenbuchung und
   * dieselbe Aufteilung wie im Nachtlauf -- Logis, Speisen, Getraenke.
   *
   * **Mit dem Geschaeftstag der Nacht**, nicht mit dem heutigen. Der
   * Leistungszeitraum der Rechnung kommt aus den Geschaeftstagen der
   * Positionen; mit heute verlaengerte die Korrektur den Aufenthalt auf dem
   * Beleg bis zum Tag der Korrektur.
   *
   * Der Preis kommt aus dem Rumpf, vorbelegt in der Maske mit Rate oder
   * Haus. Berechnete Naechte bleiben: dort hilft nur eine Stornorechnung.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/breakfast-split',
    permission: 'folio:post',
    summary: 'Fruehstueck aus gebuchten Naechten herausrechnen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      const body = (req.body ?? {}) as { breakfastCent?: unknown; childBreakfastCent?: unknown }
      const erwachsen = body.breakfastCent
      if (!(typeof erwachsen === 'number' && Number.isInteger(erwachsen)
            && erwachsen >= 1 && erwachsen <= 100_000)) {
        throw Errors.validation({ breakfastCent: ['field.range'] },
          { min: '0,01 €', max: '1.000,00 €' })
      }
      const kind = body.childBreakfastCent ?? null
      if (kind !== null && !(typeof kind === 'number' && Number.isInteger(kind)
                             && kind >= 0 && kind <= 100_000)) {
        throw Errors.validation({ childBreakfastCent: ['field.range'] },
          { min: '0,00 €', max: '1.000,00 €' })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key,
          { folioRef, erwachsen, kind }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1 FOR UPDATE`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        /*
         * Die Uebernachtungen des Nachtlaufs: Konto der Logis, ohne Produkt
         * und ohne Teil, offen, nicht gegengebucht. Und nur Naechte, an
         * denen fuer diese Reservierung noch kein Fruehstueck steht --
         * sonst stuende es nach einer zweiten Korrektur doppelt da.
         */
        const naechte = await client.query<{
          id: number; reservation_id: number; business_date: string; description: string
          gross_cent: string; tax_rate_bp: number; tax_rule_id: number | null
          personen: number; adults: number | null; children: number | null
          declined: boolean }>(
          `SELECT c.id, c.reservation_id, c.business_date::text, c.description,
                  c.gross_cent, c.tax_rate_bp, c.tax_rule_id,
                  GREATEST(COALESCE(r.guest_count,
                    (SELECT count(*) FROM reservation_occupant o
                      WHERE o.reservation_id = r.id)::int), 1) AS personen,
                  r.adults, r.children, r.breakfast_declined AS declined
             FROM charge c
             JOIN reservation r ON r.id = c.reservation_id
            WHERE c.folio_id = $1
              AND c.package_part IS NULL AND c.product_id IS NULL
              AND c.revenue_account = '8300'
              AND (c.description LIKE 'Übernachtung %' OR c.description LIKE 'Uebernachtung %')
              AND c.invoice_id IS NULL AND c.reverses_id IS NULL AND c.gross_cent > 0
              AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM charge b
                               WHERE b.reservation_id = c.reservation_id
                                 AND b.business_date = c.business_date
                                 AND b.package_part IN ('breakfast_food', 'breakfast_drinks')
                                 AND b.reverses_id IS NULL
                                 AND NOT EXISTS (SELECT 1 FROM charge x
                                                  WHERE x.reverses_id = b.id))
            ORDER BY c.business_date, c.id
            FOR UPDATE OF c`, [folio.id])
        if (naechte.rows.some(n => n.declined)) throw Errors.conflict('breakfast.declined')
        if (naechte.rowCount === 0) throw Errors.conflict('breakfast.nothingToSplit')

        const zeilen: Array<{ datum: string; text: string; brutto: number; satz: number
                              regel: number | null; konto: string; teil: string | null
                              reservation: number; reverses: number | null }> = []
        let summe = 0
        for (const n of naechte.rows) {
          const brutto = Number(n.gross_cent)
          const teile = splitNight({ priceCent: brutto, breakfastCent: breakfastPerNight({
            adultCent: erwachsen, childCent: kind, persons: n.personen,
            adults: n.adults, children: n.children }) })
          if (teile.foodCent + teile.drinksCent === 0) continue
          summe += teile.foodCent + teile.drinksCent
          // Das Datum der Nacht steht im Text des Nachtlaufs; es bleibt.
          const tag = n.description.replace(/^(Übernachtung|Uebernachtung) /, '')
          const gemeinsam = { datum: n.business_date, reservation: n.reservation_id }
          zeilen.push(
            { ...gemeinsam, text: `Storno ${n.description}`, brutto: -brutto,
              satz: n.tax_rate_bp, regel: n.tax_rule_id, konto: '8300', teil: null,
              reverses: n.id },
            { ...gemeinsam, text: n.description, brutto: teile.lodgingCent,
              satz: n.tax_rate_bp, regel: n.tax_rule_id, konto: '8300', teil: null,
              reverses: null },
            { ...gemeinsam, text: `Frühstück Speisen ${tag}`, brutto: teile.foodCent,
              satz: BREAKFAST_FOOD_RATE_BP, regel: null, konto: BREAKFAST_FOOD_ACCOUNT,
              teil: 'breakfast_food', reverses: null })
          if (teile.drinksCent > 0) {
            zeilen.push({ ...gemeinsam, text: `Frühstück Getränke ${tag}`,
              brutto: teile.drinksCent, satz: BREAKFAST_DRINKS_RATE_BP, regel: null,
              konto: BREAKFAST_DRINKS_ACCOUNT, teil: 'breakfast_drinks', reverses: null })
          }
        }
        if (zeilen.length === 0) throw Errors.conflict('breakfast.nothingToSplit')

        // Die Gegenbuchung uebernimmt den Steuerbetrag der Position, nicht
        // einen neu gerechneten: sonst bliebe ein Cent Steuer stehen.
        await client.query(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, reservation_id, reverses_id, created_by,
                               package_part)
           SELECT $1, $2, z.datum, z.text, 1,
                  CASE WHEN z.reverses IS NULL
                       THEN z.brutto - round(z.brutto * z.satz / (10000.0 + z.satz))
                       ELSE -o.net_cent END,
                  CASE WHEN z.reverses IS NULL
                       THEN round(z.brutto * z.satz / (10000.0 + z.satz))
                       ELSE -o.tax_cent END,
                  z.brutto, z.satz, z.regel, z.konto, z.reservation, z.reverses, $3, z.teil
             FROM unnest($4::date[], $5::text[], $6::bigint[], $7::int[], $8::bigint[],
                         $9::text[], $10::bigint[], $11::bigint[], $12::text[])
                  WITH ORDINALITY AS z(datum, text, brutto, satz, regel, konto, reservation,
                                       reverses, teil, ord)
             LEFT JOIN charge o ON o.id = z.reverses
            ORDER BY z.ord`,
          [folio.property_id, folio.id, principal.userId,
           zeilen.map(z => z.datum), zeilen.map(z => z.text), zeilen.map(z => z.brutto),
           zeilen.map(z => z.satz), zeilen.map(z => z.regel), zeilen.map(z => z.konto),
           zeilen.map(z => z.reservation), zeilen.map(z => z.reverses),
           zeilen.map(z => z.teil)])

        const result = { nights: zeilen.filter(z => z.reverses !== null).length,
                         breakfastCent: summe }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Aufenthaltspreis nachtraeglich korrigieren (Sven, 15.10.2026: "ich hatte
   * in der buchung 268€, der betrag war aber 268,80€. da muesste ich ja nun
   * jede nacht und jedes fruehstueck mit den steuersaetzen ausrechnen per
   * hand und korrigieren").
   *
   * Eingegeben wird der neue Gesamtpreis des Aufenthalts. Er faellt wie beim
   * Anlegen auf die Naechte (`preisJeNacht`, Rest-Cent auf der ersten). Je
   * gebuchter Nacht bleibt, was neben der Logis steht -- Fruehstueck und
   * Inklusivleistungen haben ihren eigenen Preis --, und die Logis traegt den
   * Unterschied: Gegenbuchung der alten, neue Logis mit dem Geschaeftstag der
   * Nacht. Die Steuer rechnet jede Zeile selbst, wie im Nachtlauf. Noch nicht
   * gebuchte Naechte bekommen nur ihren neuen Preis; der Nachtlauf bucht ihn.
   *
   * Eine schon berechnete Nacht bleibt: dort hilft nur erst die
   * Stornorechnung (Haertegrad 1). Danach ist die Nacht wieder offen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/stay-price',
    permission: 'folio:post',
    summary: 'Aufenthaltspreis nachtraeglich korrigieren',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      const gesamt = ((req.body ?? {}) as { totalCent?: unknown }).totalCent
      if (!(typeof gesamt === 'number' && Number.isInteger(gesamt)
            && gesamt >= 1 && gesamt <= MAX_POSITION_CENT)) {
        throw Errors.validation({ totalCent: ['field.range'] },
          { min: '0,01 €', max: '1.000.000,00 €' })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key,
          { folioRef, gesamt }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1 FOR UPDATE`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        // Die Uebernachtungen des Nachtlaufs wie beim Fruehstueck: Konto der
        // Logis, ohne Produkt und ohne Teil, nicht gegengebucht. Berechnete
        // kommen mit, damit sie den Vorgang abweisen statt still zu fehlen.
        const logis = await client.query<{
          id: number; reservation_id: number; business_date: string; description: string
          gross_cent: string; tax_rate_bp: number; tax_rule_id: number | null
          invoice_id: number | null; extras: string }>(
          `SELECT c.id, c.reservation_id, c.business_date::text, c.description, c.gross_cent,
                  c.tax_rate_bp, c.tax_rule_id, c.invoice_id,
                  COALESCE((SELECT sum(b.gross_cent) FROM charge b
                             WHERE b.folio_id = c.folio_id
                               AND b.reservation_id = c.reservation_id
                               AND b.business_date = c.business_date
                               AND b.package_part IS NOT NULL AND b.reverses_id IS NULL
                               AND NOT EXISTS (SELECT 1 FROM charge x
                                                WHERE x.reverses_id = b.id)), 0) AS extras
             FROM charge c
            WHERE c.folio_id = $1 AND c.reservation_id IS NOT NULL
              AND c.package_part IS NULL AND c.product_id IS NULL
              AND c.revenue_account = '8300'
              AND (c.description LIKE 'Übernachtung %' OR c.description LIKE 'Uebernachtung %')
              AND c.reverses_id IS NULL AND c.gross_cent > 0
              AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id)
            ORDER BY c.business_date, c.id
            FOR UPDATE OF c`, [folio.id])
        if (logis.rowCount === 0) throw Errors.conflict('stayPrice.nothingOpen')
        if (logis.rows.some(n => n.invoice_id !== null)) {
          throw Errors.conflict('stayPrice.invoicedNight')
        }
        const reservierungen = new Set(logis.rows.map(n => n.reservation_id))
        if (reservierungen.size > 1) throw Errors.conflict('stayPrice.multipleStays')
        const reservationId = logis.rows[0]!.reservation_id
        // Zwei Logiszeilen an einem Tag sind keine Nacht, sondern ein
        // Nachtrag von Hand; welche davon der Preis ist, weiss nur die
        // Rezeption.
        if (new Set(logis.rows.map(n => n.business_date)).size !== logis.rows.length) {
          throw Errors.conflict('stayPrice.ambiguousNight')
        }

        const gebucht = new Set(logis.rows.map(n => n.business_date))
        const offenNaechte = (await client.query<{ date: string }>(
          `SELECT date::text FROM reservation_night
            WHERE reservation_id = $1 AND NOT posted ORDER BY date`,
          [reservationId])).rows.map(r => r.date).filter(d => !gebucht.has(d))
        const naechte = [...logis.rows.map(n => ({ datum: n.business_date, nacht: n })),
                         ...offenNaechte.map(d => ({ datum: d, nacht: null }))]
          .sort((a, b) => a.datum.localeCompare(b.datum))
        const preise = preisJeNacht(gesamt, naechte.length)

        const zeilen: Array<{ datum: string; text: string; brutto: number; satz: number
                              regel: number | null; reverses: number | null }> = []
        naechte.forEach(({ nacht }, i) => {
          if (nacht === null) return
          const neu = preise[i]! - Number(nacht.extras)
          if (neu < 1) throw Errors.unprocessable('stayPrice.belowExtras')
          if (neu === Number(nacht.gross_cent)) return
          zeilen.push(
            { datum: nacht.business_date, text: `Storno ${nacht.description}`,
              brutto: -Number(nacht.gross_cent), satz: nacht.tax_rate_bp,
              regel: nacht.tax_rule_id, reverses: nacht.id },
            { datum: nacht.business_date, text: nacht.description, brutto: neu,
              satz: nacht.tax_rate_bp, regel: nacht.tax_rule_id, reverses: null })
        })

        if (zeilen.length > 0) {
          // Die Gegenbuchung uebernimmt den Steuerbetrag der Position, nicht
          // einen neu gerechneten: sonst bliebe ein Cent Steuer stehen.
          await client.query(
            `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                                 net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                                 revenue_account, reservation_id, reverses_id, created_by)
             SELECT $1, $2, z.datum, z.text, 1,
                    CASE WHEN z.reverses IS NULL
                         THEN z.brutto - round(z.brutto * z.satz / (10000.0 + z.satz))
                         ELSE -o.net_cent END,
                    CASE WHEN z.reverses IS NULL
                         THEN round(z.brutto * z.satz / (10000.0 + z.satz))
                         ELSE -o.tax_cent END,
                    z.brutto, z.satz, z.regel, '8300', $3, z.reverses, $4
               FROM unnest($5::date[], $6::text[], $7::bigint[], $8::int[], $9::bigint[],
                           $10::bigint[])
                    WITH ORDINALITY AS z(datum, text, brutto, satz, regel, reverses, ord)
               LEFT JOIN charge o ON o.id = z.reverses
              ORDER BY z.ord`,
            [folio.property_id, folio.id, reservationId, principal.userId,
             zeilen.map(z => z.datum), zeilen.map(z => z.text), zeilen.map(z => z.brutto),
             zeilen.map(z => z.satz), zeilen.map(z => z.regel), zeilen.map(z => z.reverses)])
        }

        // Die Buchung zeigt danach denselben Preis wie das Folio.
        await client.query(
          `UPDATE reservation_night n SET price_cent = x.price
             FROM unnest($2::date[], $3::bigint[]) AS x(date, price)
            WHERE n.reservation_id = $1 AND n.date = x.date`,
          [reservationId, naechte.map(n => n.datum), preise])

        const result = { nights: naechte.length,
                         corrected: zeilen.filter(z => z.reverses !== null).length,
                         totalCent: gesamt }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Split: ein weiteres Folio zum selben Aufenthalt.
   *
   * "Firma zahlt Logis, Gast zahlt Extras" ging bisher nur ueber eine
   * Rechnung mit abgewaehlten Positionen, und was offen blieb, sah niemand
   * (Pruefung 13.10.2026). Das neue Folio hat die Art 'company': das
   * Gastfolio bleibt das einzige, das beim Wechsel des Gastes mitgeht und
   * auf das der Nachtlauf bucht, wenn keine Umleitung etwas anderes sagt.
   * Den Empfaenger setzt danach `.../recipient` wie bei jedem Folio.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/split',
    permission: 'folio:route',
    summary: 'Weiteres Folio zum selben Aufenthalt anlegen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as { label?: unknown }
      if (body.label !== undefined && typeof body.label !== 'string') {
        throw Errors.validation({ label: ['field.invalid'] })
      }
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (label.length > FOLIO_LABEL_MAX) {
        throw Errors.validation({ label: ['field.maxLength'] }, { max: FOLIO_LABEL_MAX })
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { folioRef, label }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ property_id: number; reservation_id: number | null
                                       status: string }>(
          `SELECT property_id, reservation_id, status FROM folio WHERE public_ref = $1`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:route', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')
        if (folio.reservation_id === null) throw Errors.unprocessable('folio.noStay')

        // Die Reservierung sperren: zwei gleichzeitige Klicks zaehlten sonst
        // beide unter der Grenze.
        await client.query(`SELECT 1 FROM reservation WHERE id = $1 FOR UPDATE`,
          [folio.reservation_id])
        const n = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM folio WHERE reservation_id = $1`,
          [folio.reservation_id])
        if (n.rows[0]!.n >= FOLIOS_JE_AUFENTHALT) {
          throw Errors.conflict('folio.tooMany', { max: FOLIOS_JE_AUFENTHALT })
        }
        const neu = await client.query<{ public_ref: string }>(
          `INSERT INTO folio (property_id, reservation_id, kind, label)
           VALUES ($1, $2, 'company', $3) RETURNING public_ref`,
          [folio.property_id, folio.reservation_id, label === '' ? null : label])

        const result = { folioRef: neu.rows[0]!.public_ref }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Gruppenfolio: ein Konto fuer die ganze Buchung, auf das die Zimmer
   * ihre Naechte buchen (Sven, 16.10.2026: "damit man nicht 10 zimmer
   * einzeln auf eines der zimmer umbuchen muss im folio").
   *
   * **Woran es haengt.** An der ersten Reservierung der Buchung, mit der Art
   * 'group'. So bleibt es ein Folio wie jedes andere: Umbuchen, Empfaenger,
   * Rechnung, Gastzusatz je Zimmer und das Zuruecksetzen einer
   * Datenuebernahme gehen ueber `folio.reservation_id` und kennen es damit
   * schon. Je Buchung gibt es hoechstens eines; ein zweiter Klick findet das
   * erste wieder.
   *
   * **Was darauf laeuft** sagt `scope`: 'accommodation' nimmt Uebernachtung
   * mit Fruehstueck und Inklusivleistungen, also die ganze gebuchte Nacht;
   * 'all' auch Minibar, Restaurant und jede andere Position. Beides setzt
   * die Umleitung fuer jedes Zimmer der Buchung, damit der Nachtlauf
   * kuenftige Naechte gleich dorthin bucht, und bucht die schon gebuchten
   * offenen Positionen der Gastfolios um -- Gegenbuchung dort, dieselbe
   * Position hier, wie `.../transfer`. Ein Split-Folio eines Zimmers ("Firma
   * zahlt Logis") bleibt, wie es ist: das hat jemand mit Absicht so
   * gebucht. Die Kurtaxe bleibt am Zimmer: sie steht auf keiner Rechnung,
   * und ihr Beleg ist die Kurkarte des einzelnen Gastes.
   *
   * Empfaenger ist zunaechst der Bucher der Buchung, Firma vor Person; wie
   * bei jedem Folio aendert ihn `.../recipient`.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/group-folio',
    permission: 'folio:route',
    summary: 'Gruppenfolio der Buchung anlegen und die Zimmer darauf umleiten',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as { scope?: unknown }
      if (body.scope !== 'accommodation' && body.scope !== 'all') {
        throw Errors.validation({ scope: ['field.invalid'] })
      }
      const scope = body.scope
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { folioRef, scope }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ property_id: number; reservation_id: number | null }>(
          `SELECT property_id, reservation_id FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:route', folio.property_id)
        if (folio.reservation_id === null) throw Errors.unprocessable('folio.noGroup')

        // Die Buchung sperren: zwei gleichzeitige Klicks legten sonst zwei
        // Gruppenfolios an. Haus ausdruecklich mitgeprueft (mehrere Haeuser
        // je Account).
        const b = await client.query<{ id: number; booker_guest_id: number | null
                                       booker_company_id: number | null }>(
          `SELECT b.id, b.booker_guest_id, b.booker_company_id
             FROM booking b JOIN reservation r ON r.booking_id = b.id
            WHERE r.id = $1 AND b.property_id = $2 FOR UPDATE OF b`,
          [folio.reservation_id, folio.property_id])
        if (b.rowCount === 0) throw Errors.notFound('res.folio')
        const buchung = b.rows[0]!
        const zimmer = (await client.query<{ id: number }>(
          `SELECT id FROM reservation
            WHERE booking_id = $1 AND property_id = $2
              AND status NOT IN ('Canceled', 'NoShow')
            ORDER BY id`, [buchung.id, folio.property_id])).rows.map(r => r.id)
        if (zimmer.length < 2) throw Errors.unprocessable('folio.noGroup')

        const vorhanden = await client.query<{ id: number; public_ref: string; status: string }>(
          `SELECT f.id, f.public_ref, f.status FROM folio f
             JOIN reservation r ON r.id = f.reservation_id
            WHERE r.booking_id = $1 AND f.kind = 'group' AND f.property_id = $2
            ORDER BY f.id LIMIT 1`, [buchung.id, folio.property_id])
        let gruppe = vorhanden.rows[0]
        if (gruppe?.status === 'closed') throw Errors.conflict('folio.closed')
        if (gruppe === undefined) {
          gruppe = (await client.query<{ id: number; public_ref: string; status: string }>(
            `INSERT INTO folio (property_id, reservation_id, kind, guest_id, company_id)
             VALUES ($1, $2, 'group', $3, $4) RETURNING id, public_ref, status`,
            [folio.property_id, zimmer[0], buchung.booker_guest_id,
             buchung.booker_company_id])).rows[0]!
        }

        // Eine Regel je Zimmer. 'all' ersetzt auch eine Logis-Regel, weil die
        // genauere im Nachtlauf sonst gewoenne und die Naechte dort liesse.
        await client.query(
          `DELETE FROM routing_rule
            WHERE reservation_id = ANY($1::bigint[])
              AND match_kind = ANY($2::text[])`,
          [zimmer, scope === 'all' ? ['accommodation', 'all'] : ['accommodation']])
        await client.query(
          `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id, match_kind)
           SELECT $1, x, $2, $3 FROM unnest($4::bigint[]) AS x`,
          [folio.property_id, gruppe.id, scope, zimmer])

        // Die offenen Positionen der Gastfolios: nicht berechnet, keine
        // Gegenbuchung und keine gegengebuchte, keine Kurtaxe.
        const offen = (await client.query<{ id: number }>(
          `SELECT c.id FROM charge c
             JOIN folio q ON q.id = c.folio_id
            WHERE q.reservation_id = ANY($1::bigint[]) AND q.kind = 'guest'
              AND q.status = 'open' AND q.property_id = $2
              AND c.invoice_id IS NULL AND c.reverses_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id)
              AND ${OHNE_KURTAXE}
              AND ($3 OR c.revenue_account = '8300' OR c.package_part IS NOT NULL)
            ORDER BY c.id
            FOR UPDATE OF q`,
          [zimmer, folio.property_id, scope === 'all'])).rows.map(r => r.id)
        if (offen.length > 0) {
          await client.query(
            `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                                 net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                                 revenue_account, product_id, reservation_id, reverses_id,
                                 created_by, package_part)
             SELECT c.property_id, c.folio_id, c.business_date, 'Umbuchung ' || c.description,
                    c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
                    c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id,
                    $2, c.package_part
               FROM charge c WHERE c.id = ANY($1::bigint[]) ORDER BY c.id`,
            [offen, principal.userId])
          await client.query(
            `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                                 net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                                 revenue_account, product_id, reservation_id,
                                 created_by, package_part)
             SELECT c.property_id, $2, c.business_date, c.description,
                    c.quantity, c.net_cent, c.tax_cent, c.gross_cent, c.tax_rate_bp,
                    c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id,
                    $3, c.package_part
               FROM charge c WHERE c.id = ANY($1::bigint[]) ORDER BY c.id`,
            [offen, gruppe.id, principal.userId])
        }

        const result = { folioRef: gruppe.public_ref, rooms: zimmer.length,
                         moved: offen.length }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Umbuchen: eine offene Position auf ein anderes Folio derselben Buchung,
   * also desselben Zimmers (Split) oder eines anderen Zimmers der Gruppe
   * (Sammelrechnung).
   *
   * Eine Position ist unveraenderlich (Haertegrad 1); umgebucht wird mit
   * einer Gegenbuchung hier und derselben Position dort. Beide behalten den
   * Geschaeftstag des Originals, damit Tagesumsatz und Statistik des Tages
   * gleich bleiben -- umgebucht wird, wer zahlt, nicht wann geleistet
   * wurde. Die Gegenbuchung nennt kein Ziel: eine Bezeichnung wie
   * "Firma Petersen" stuende acht Jahre in einer Zeile, die keine Loeschung
   * erreicht.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/charges/:chargeId/transfer',
    permission: 'folio:route',
    summary: 'Offene Position auf ein anderes Folio der Buchung umbuchen',
    handler: async (req, reply) => {
      const { folioRef, chargeId } = req.params as { folioRef: string; chargeId: string }
      const id = Number(chargeId)
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw Errors.validation({ chargeId: ['field.positiveInteger'] })
      }
      const body = (req.body ?? {}) as { targetFolioRef?: unknown }
      if (typeof body.targetFolioRef !== 'string' || body.targetFolioRef === '') {
        throw Errors.validation({ targetFolioRef: ['field.required'] })
      }
      const ziel = body.targetFolioRef
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { chargeId: id, ziel }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        // Beide Folios in fester Reihenfolge sperren; zwei Umbuchungen in
        // entgegengesetzter Richtung warten sonst aufeinander.
        const f = await client.query<{ id: number; public_ref: string; property_id: number
                                       reservation_id: number | null; status: string }>(
          `SELECT id, public_ref, property_id, reservation_id, status FROM folio
            WHERE public_ref = ANY($1::text[]) ORDER BY id FOR UPDATE`,
          [[folioRef, ziel]])
        const quelle = f.rows.find(x => x.public_ref === folioRef)
        if (quelle === undefined) throw Errors.notFound('res.folio')
        rechtImHaus(principal, 'folio:route', quelle.property_id)
        const nach = f.rows.find(x => x.public_ref === ziel)
        // Ziel ist ein Folio derselben Buchung: dasselbe Zimmer (Split) oder
        // ein anderes Zimmer der Gruppe (Sammelrechnung). Weiter nicht --
        // eine Position wandert nicht zu einem fremden Gast.
        const dieselbeBuchung = nach !== undefined && quelle.reservation_id !== null
          && nach.reservation_id !== null
          && (await client.query(
            `SELECT 1 FROM reservation a JOIN reservation b ON b.booking_id = a.booking_id
              WHERE a.id = $1 AND b.id = $2`,
            [quelle.reservation_id, nach.reservation_id])).rowCount === 1
        if (nach === undefined || nach.id === quelle.id
            || nach.property_id !== quelle.property_id || !dieselbeBuchung) {
          throw Errors.unprocessable('charge.transferTarget')
        }
        if (quelle.status === 'closed' || nach.status === 'closed') {
          throw Errors.conflict('folio.closed')
        }

        const c = await client.query<{ invoice_id: number | null; reverses_id: number | null
                                       aufgehoben: boolean }>(
          `SELECT c.invoice_id, c.reverses_id,
                  EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = c.id) AS aufgehoben
             FROM charge c WHERE c.id = $1 AND c.folio_id = $2`, [id, quelle.id])
        if (c.rowCount === 0) throw Errors.notFound('res.charge')
        const pos = c.rows[0]!
        if (pos.invoice_id !== null) throw Errors.conflict('charge.invoiced')
        if (pos.reverses_id !== null || pos.aufgehoben) {
          throw Errors.conflict('charge.alreadyReversed')
        }

        const r = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, product_id, reservation_id, reverses_id,
                               created_by, package_part)
           SELECT c.property_id, c.folio_id, c.business_date, 'Umbuchung ' || c.description,
                  c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
                  c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id,
                  $3, c.package_part
             FROM charge c WHERE c.id = $1 AND c.folio_id = $2
           RETURNING id`,
          [id, quelle.id, principal.userId])
        const n = await client.query<{ id: number }>(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, product_id, reservation_id,
                               created_by, package_part)
           SELECT c.property_id, $2, c.business_date, c.description,
                  c.quantity, c.net_cent, c.tax_cent, c.gross_cent, c.tax_rate_bp,
                  c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id,
                  $3, c.package_part
             FROM charge c WHERE c.id = $1
           RETURNING id`,
          [id, nach.id, principal.userId])

        const result = { reversalId: r.rows[0]!.id, chargeId: n.rows[0]!.id,
                         targetFolioRef: ziel }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Umleitung: die Uebernachtungen eines Aufenthalts kuenftig auf dieses
   * Folio. Der Nachtlauf beachtet `routing_rule` schon lange, nur setzen
   * liess sie sich nirgends. Wirkt ab der naechsten Nacht; schon gebuchte
   * Naechte bucht man mit `.../transfer` um.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/folios/:folioRef/routing',
    permission: 'folio:route',
    summary: 'Uebernachtungen des Aufenthalts auf dieses Folio umleiten',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as { accommodation?: unknown }
      if (typeof body.accommodation !== 'boolean') {
        throw Errors.validation({ accommodation: ['field.required'] })
      }
      const hierher = body.accommodation
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: number; property_id: number; kind: string
                                       reservation_id: number | null; status: string }>(
          `SELECT id, property_id, kind, reservation_id, status FROM folio
            WHERE public_ref = $1 FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:route', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')
        if (folio.reservation_id === null) throw Errors.unprocessable('folio.noStay')

        // Ein Gruppenfolio leitet alle Zimmer der Buchung um, jedes andere
        // nur seinen eigenen Aufenthalt.
        const zimmer = folio.kind !== 'group' ? [folio.reservation_id]
          : (await client.query<{ id: number }>(
              `SELECT b.id FROM reservation a JOIN reservation b ON b.booking_id = a.booking_id
                WHERE a.id = $1 AND b.property_id = $2
                  AND b.status NOT IN ('Canceled', 'NoShow')`,
              [folio.reservation_id, folio.property_id])).rows.map(r => r.id)

        // Eine Regel je Aufenthalt: wer sie auf ein Folio setzt, nimmt sie
        // dem bisherigen. Aufs Gastfolio heisst keine Regel -- dorthin
        // bucht der Nachtlauf ohnehin. Abschalten nimmt auch ein 'all' des
        // Gruppenfolios weg; die Zimmer buchen dann wieder auf sich.
        await client.query(
          `DELETE FROM routing_rule
            WHERE reservation_id = ANY($1::bigint[])
              AND (match_kind = 'accommodation' AND (target_folio_id = $2 OR $3)
                   OR match_kind = 'all' AND target_folio_id = $2 AND NOT $3)`,
          [zimmer, folio.id, hierher])
        if (hierher && folio.kind !== 'guest') {
          await client.query(
            `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id, match_kind)
             SELECT $1, x, $2, 'accommodation' FROM unnest($3::bigint[]) AS x
              WHERE NOT EXISTS (SELECT 1 FROM routing_rule y
                                 WHERE y.reservation_id = x AND y.target_folio_id = $2
                                   AND y.match_kind = 'all')`,
            [folio.property_id, folio.id, zimmer])
        }
        return { accommodation: hierher && folio.kind !== 'guest' }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/settlements',
    permission: 'folio:post',
    summary: 'Zahlungsvermerk erfassen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        amountCent: number; paymentMethodCode: string; externalReference?: string
        /**
         * Fuer genau diese Rechnung ("Zahlung eingegangen" in der
         * Rechnungsliste). Ohne Angabe die aelteste offene des Folios.
         */
        invoiceRef?: string
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)

        const pm = await client.query<{ id: number }>(
          `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2 AND active`,
          [folio.property_id, body.paymentMethodCode])
        if (pm.rowCount === 0) throw Errors.validation({ paymentMethodCode: ['field.unknownPaymentMethod'] })

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [folio.property_id])

        const r = await client.query<{ id: number }>(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                   payment_method_id, external_reference, created_by)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7) RETURNING id`,
          [folio.property_id, folio.id, bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10),
           body.amountCent, pm.rows[0]!.id, body.externalReference ?? null, principal.userId])

        /*
         * Zahlt der Gast **nach** dem Festschreiben -- der Regelfall, wenn
         * die Rechnung beim Auschecken gedruckt und danach bezahlt wird --,
         * gehoert der Vermerk an die aelteste Rechnung dieses Folios, die
         * noch nicht ausgeglichen ist. Ohne diese Zuordnung wuesste das
         * System nur, dass das Folio ausgeglichen ist, nicht **welche**
         * Rechnung bezahlt wurde; eine Liste koennte kein "offen" fuehren,
         * ohne zu raten.
         *
         * Auf den Beleg wirkt das nicht mehr: der vorausgezahlte Betrag
         * steht seit dem Festschreiben in der Momentaufnahme.
         */
        const offen = await client.query<{ id: number; rest: number }>(
          `SELECT i.id,
                  coalesce((i.totals->>'payableCent')::bigint,
                           (i.totals->>'grossCent')::bigint, 0)
                  - coalesce((SELECT sum(s.amount_cent)
                                FROM settlement s WHERE s.invoice_id = i.id), 0)
                  AS rest
             FROM invoice i
            WHERE i.folio_id = $1 AND i.kind IN ('final','interim')
              AND ($2::text IS NULL OR i.public_ref = $2)
            ORDER BY i.id`, [folio.id, body.invoiceRef ?? null])
        if (body.invoiceRef !== undefined && offen.rowCount === 0) {
          throw Errors.notFound('res.invoice')
        }
        await zuOffenerRechnung(client, folio.id, r.rows[0]!.id, body.amountCent, offen.rows)

        const result = { settlementId: r.rows[0]!.id, amountCent: body.amountCent }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Anzahlungsrechnung: dokumentiert eine Vereinnahmung vor der Leistung.
   *
   * Nach § 13 Abs. 1 Nr. 1a UStG entsteht die Steuer mit dem Zufluss, nicht
   * mit dem Aufenthalt. Der Zahlungsvermerk muss deshalb bereits existieren
   * (`POST .../settlements`); diese Route macht daraus die Rechnung, die
   * das Finanzamt verlangt, und traegt die Vereinnahmung ins Anzahlungs-
   * journal ein. Der Zahlungsvermerk selbst bleibt unangetastet: sein
   * `invoice_id` ist fuer eine andere, bereits bestehende Zuordnung reserviert
   * (Zahlung direkt der eigenen Rechnung zugeordnet, siehe BT-113) und wuerde
   * dort zu Verwirrung fuehren, wenn er hier zusaetzlich auf die
   * Anzahlungsrechnung zeigte.
   *
   * Der Steuersatz kommt entweder ausdruecklich mit -- dann hat jemand
   * hingesehen -- oder wird aus dem erwarteten Aufenthalt abgeleitet. Eine
   * Anzahlung ist ein pauschaler Betrag, die spaetere Leistung ist es
   * nicht: die Uebernachtung traegt den ermaessigten Satz, das Fruehstueck
   * seinen eigenen und ein Buffet gleich zwei. Ausgewiesen werden muss das
   * schon jetzt (§ 14 Abs. 5 UStG).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/deposit-invoice',
    permission: 'invoice:issue',
    summary: 'Anzahlungsrechnung erstellen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as {
        settlementId: number
        /** Ein einziger Satz fuer die ganze Anzahlung. */
        taxRateBp?: number
        /** Ausdrueckliche Aufteilung. Ueberschreibt die Ableitung. */
        lines?: Array<{ grossCent: number; taxRateBp: number }>
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return mitBeleg(req, tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null; reservation_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id, reservation_id
             FROM folio WHERE public_ref = $1 FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'invoice:issue', folio.property_id)

        // Der Leistungszeitraum nach § 14 Abs. 4 Nr. 6 UStG ist der
        // geplante Aufenthalt: die Leistung selbst steht noch aus, aber
        // wofuer angezahlt wird, muss feststehen.
        if (folio.reservation_id === null) {
          throw Errors.unprocessable(
            'deposit.needsReservation')
        }
        const res = await client.query<{ arrival: string; departure: string }>(
          `SELECT arrival::text, departure::text FROM reservation WHERE id = $1`,
          [folio.reservation_id])
        if (res.rowCount === 0) throw Errors.notFound('res.reservation')
        const { arrival, departure } = res.rows[0]!

        const s = await client.query<{ id: number; amount_cent: number; business_date: string }>(
          `SELECT id, amount_cent, business_date::text FROM settlement
            WHERE id = $1 AND folio_id = $2 FOR UPDATE`, [body.settlementId, folio.id])
        if (s.rowCount === 0) throw Errors.notFound('res.settlement')
        const settlement = s.rows[0]!

        /*
         * Eine Rueckzahlung ist keine Anzahlung. Negative Zahlungsvermerke
         * gibt es (Storno, Erstattung), und ohne diese Pruefung schlaegt
         * erst die Bedingung am Anzahlungsjournal zu -- als Fehler 500
         * statt als Antwort, die sagt, was falsch war.
         */
        if (settlement.amount_cent <= 0) {
          throw Errors.validation({ settlementId: [
            'field.notAnIncomingPayment'] })
        }

        /*
         * Ein Vermerk, der schon auf einer Rechnung als Zahlung steht, kann
         * nicht zusaetzlich eine Anzahlungsrechnung tragen: derselbe Betrag
         * waere zweimal abgerechnet, einmal als vorausgezahlt (BT-113) und
         * einmal als verrechnete Anzahlung. Seit die Zuordnung geschrieben
         * wird, ist das erreichbar -- vorher nicht, weil niemand sie setzte.
         */
        const schonAufRechnung = await client.query<{ number: string }>(
          `SELECT i.number FROM settlement s JOIN invoice i ON i.id = s.invoice_id
            WHERE s.id = $1`, [settlement.id])
        if (schonAufRechnung.rowCount !== null && schonAufRechnung.rowCount > 0) {
          throw Errors.conflict('deposit.settlementOnInvoice',
            { number: schonAufRechnung.rows[0]!.number })
        }

        const bereits = await client.query(
          `SELECT 1 FROM deposit_ledger WHERE settlement_id = $1`, [settlement.id])
        if ((bereits.rowCount ?? 0) > 0) {
          throw Errors.conflict('deposit.alreadyInvoiced')
        }

        /*
         * Die Aufteilung auf die Steuersaetze. Die Summe der Teile ist auf
         * den Cent der vereinnahmte Betrag: die Anzahlungsrechnung weist
         * diese Teile aus, und eine Differenz zum Zahlungseingang ist genau
         * die Art Fehler, die erst der Betriebspruefer findet.
         */
        let teile: RateGroupAmount[]
        if (body.lines?.length) {
          const summe = body.lines.reduce((acc, l) => acc + l.grossCent, 0)
          if (summe !== settlement.amount_cent) {
            throw Errors.validation({ lines: ['field.depositPartsMismatch'] },
              { sum: summe, received: settlement.amount_cent })
          }
          teile = body.lines.map(l => ({ rateBp: l.taxRateBp, grossCent: l.grossCent }))
        } else if (body.taxRateBp !== undefined) {
          teile = [{ rateBp: body.taxRateBp, grossCent: settlement.amount_cent }]
        } else {
          const mix = await erwarteteSaetze(client, folio.property_id, folio.reservation_id)
          if (mix.length === 0) {
            throw Errors.unprocessable(
              'deposit.noRatesForSplit')
          }
          teile = splitDeposit(settlement.amount_cent, mix)
        }

        /*
         * Brutto herein, netto heraus: eine Anzahlung wird brutto
         * vereinbart, der Gast ueberweist 200 Euro und nicht 186,92 plus
         * Steuer. Die Nettobetraege werden dabei so gewaehlt, dass die
         * Rechnung den vereinnahmten Betrag ausweist -- herausrechnen und
         * wieder daraufschlagen verfehlt ihn sonst um einen Cent, weil
         * beide Schritte runden.
         */
        const positionen = depositLines(settlement.amount_cent, teile)

        const prop = await client.query<Party>(
          `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                  city, country, tax_number AS "taxNumber", vat_id AS "vatId",
                  commercial_register AS "registrationId", invoice_contact_name AS "contactName",
                  invoice_phone AS phone,
                  invoice_email AS email, invoice_email AS "electronicAddress",
                  bank_iban AS iban, bank_bic AS bic, bank_name AS "bankName",
            bank_account_holder AS "accountHolder", invoice_website AS website
             FROM property WHERE id = $1`, [folio.property_id])
        const recipient = folio.company_id
          ? await client.query<Party>(
              `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                      city, country, vat_id AS "vatId", contact_name AS "contactName",
                      buyer_reference AS "buyerReference",
                      invoice_email AS "electronicAddress"
                 FROM company WHERE id = $1`, [folio.company_id])
          : folio.guest_id
            ? await client.query<Party>(
                `SELECT trim(both ', ' from
                          coalesce(last_name,'') || ', ' || coalesce(first_name,'')) AS name,
                        address_line1 AS "addressLine1", postal_code AS "postalCode",
                        city, country
                   FROM guest WHERE id = $1`, [folio.guest_id])
            : { rows: [] as Party[] }

        const num = await naechsteNummer(client, folio.property_id)

        /*
         * Die Anzahlungsrechnung entsteht erst, wenn das Geld da ist: sie
         * belegt einen Zahlungseingang. Sie ist deshalb bezahlt, und das
         * steht in der Momentaufnahme (BT-113 gleich BT-112, Zahlbetrag 0).
         * Bisher fehlte es, und der Beleg forderte den ganzen Betrag ein
         * zweites Mal; die Liste fuehrte sie dauerhaft als offen, und der
         * Validator wies sie nach BR-CO-25 ab (Pruefung 13.10.2026,
         * Befund 5).
         */
        const summen = sumInvoice(positionen)
        const totals = { ...summen, roundingCent: 0,
                         payableCent: summen.grossCent, prepaidCent: summen.grossCent }

        const heute = await heuteImHaus(client, folio.property_id)
        const maengel = blockingFindings({
          number: num.rows[0]!.next_invoice_number,
          issuedOn: heute,
          serviceFrom: arrival, serviceTo: departure,
          issuer: prop.rows[0] ?? {},
          recipient: recipient.rows[0] ?? {},
          lines: positionen.map(pos => ({
            description: 'Anzahlung auf den Aufenthalt', quantity: 1,
            netCent: pos.netCent, rateBp: pos.rateBp })),
          // Geprueft wird, was der Beleg sagt, nicht was ueberwiesen wurde:
          // an der Grenze zur Kleinbetragsrechnung (§ 33 UStDV) entscheidet
          // der ausgewiesene Betrag.
          grossCent: totals.grossCent,
          kind: 'deposit'
        })
        if (maengel.length > 0) {
          throw Errors.unprocessable(
            'deposit.requirementsUnmet',
            { maengel: maengel.map(m => `${m.de} (${m.reference})`).join(' ') })
        }

        const inv = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to,
                                issuer_snapshot, recipient_snapshot, totals, created_by)
           VALUES ($1,$2,$3,$11::date,$4::date,'deposit',$5::date,$6::date,$7,$8,$9,$10)
           RETURNING id, public_ref, number`,
          [folio.property_id, folio.id, num.rows[0]!.next_invoice_number, settlement.business_date,
           arrival, departure, JSON.stringify(prop.rows[0] ?? {}),
           JSON.stringify(recipient.rows[0] ?? {}), JSON.stringify(totals), principal.userId,
           heute])

        /*
         * Die Vereinnahmung ins Anzahlungsjournal eintragen, je Satzgruppe
         * eine Zeile. business_date ist das des Zahlungsvermerks, nicht das
         * der heutigen Ausstellung: die Steuer entsteht im Monat des
         * Zuflusses (§ 13 Abs. 1 Nr. 1a UStG), und der kann vor dem
         * Ausstellungstag dieser Rechnung liegen.
         *
         * Eingetragen wird, was der Beleg ausweist, und nicht noch einmal
         * gerechnet: aus dem Journal bucht der DATEV-Stapel, und ein Stapel,
         * der einen anderen Betrag traegt als der Beleg beim Gast, ist bei
         * der naechsten Pruefung ein Fund.
         */
        for (const g of totals.groups) {
          await client.query(
            `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                         amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                         business_date, settlement_id, created_by)
             VALUES ($1,$2,$3,'received',$4,$5,$6,$7,$8::date,$9,$10)`,
            [folio.property_id, folio.id, inv.rows[0]!.id, g.grossCent,
             g.netCent, g.taxCent, g.rateBp, settlement.business_date, settlement.id,
             principal.userId])
        }

        const result = {
          invoiceRef: inv.rows[0]!.public_ref, number: inv.rows[0]!.number,
          netCent: totals.netCent, taxCent: totals.taxCent, grossCent: totals.grossCent,
          groups: totals.groups
        }

        await emitEvent(client, folio.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef, number: result.number, folioRef,
          kind: 'deposit', serviceFrom: arrival, serviceTo: departure,
          grossCent: totals.grossCent
        })

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      }))
    }
  })

  /**
   * Die Rechnungen eines Hauses zu einem Zeitraum.
   *
   * Bisher liess sich eine Rechnung nur ueber ihr Folio finden. Wer wissen
   * will, was im Oktober hinausgegangen ist, musste den GoBD-Export nehmen
   * -- der weist ein Uebungshaus hart ab und haengt an einem Recht, das die
   * Rezeption nicht hat.
   *
   * **Zum Zahlungsstand.** `settledCent` ist die Summe der Zahlungsvermerke,
   * die dieser Rechnung zugeordnet sind, `openCent` der Rest zum Zahlbetrag.
   * Das Feld `settlement.invoice_id` hatte lange keinen Schreiber; solange
   * das so war, stand hier bewusst nichts ueber Zahlungen, weil jede Zahl
   * strukturell falsch gewesen waere. Seit das Festschreiben und das
   * Vermerken einer Zahlung die Zuordnung setzen, sagt sie etwas.
   *
   * **Sie sagt nicht alles.** Eine Zahlung, die vor dieser Aenderung
   * vermerkt wurde, ist keiner Rechnung zugeordnet und wird nie eine
   * bekommen -- `NULL` -> Wert ist der einzige erlaubte Uebergang, und
   * niemand darf ihn nachtraeglich fuer alte Zeilen raten. Solche
   * Rechnungen stehen als offen da, obwohl sie bezahlt sind. Der Saldo des
   * Folios ist in dem Fall die Wahrheit, und `folioRef` fuehrt dorthin.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/invoices',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Rechnungen eines Zeitraums',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { from: string; to: string; kind?: string; limit?: string }
      if (!isIsoDate(q.from) || !isIsoDate(q.to)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const tage = nightsBetween(q.from, q.to) + 1
      if (tage <= 0) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
      if (tage > MAX_RECHNUNGSTAGE) throw Errors.rangeTooLarge(MAX_RECHNUNGSTAGE)
      // Obergrenze wie bei jedem Listenendpunkt: ohne sie ist er ein
      // Selbstangriff. Ein Haus mit 200 Zimmern schreibt an einem starken
      // Tag ueber hundert Rechnungen.
      const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500)

      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT i.public_ref AS "invoiceRef", i.number,
                  i.issued_on::text AS "issuedOn",
                  i.business_date::text AS "businessDate",
                  i.kind, i.currency,
                  (i.totals->>'grossCent')::bigint AS "grossCent",
                  -- Der Zahlbetrag steht erst seit Aufgabe 12 in der
                  -- Momentaufnahme; aeltere Rechnungen fordern ihre
                  -- Bruttosumme.
                  COALESCE((i.totals->>'payableCent')::bigint,
                           (i.totals->>'grossCent')::bigint) AS "payableCent",
                  -- ::bigint, weil sum() ueber bigint numeric liefert und
                  -- numeric als Zeichenkette ankommt.
                  -- Eine Anzahlungsrechnung belegt einen Zahlungseingang, eine
                  -- Stornorechnung wird mit ihrem Original verrechnet: beide
                  -- sind nie offen (Befund 2 und 5 der Pruefung vom
                  -- 13.10.2026). Bisher stand jede Anzahlungsrechnung fuer
                  -- immer als offen in der Liste.
                  CASE i.kind
                    WHEN 'deposit' THEN COALESCE(a.summe, 0)
                    WHEN 'credit_note' THEN COALESCE((i.totals->>'payableCent')::bigint,
                                                     (i.totals->>'grossCent')::bigint)
                    ELSE COALESCE(z.summe, 0)
                  END::bigint AS "settledCent",
                  sn.number AS "cancelledBy",
                  o.number AS "reverses",
                  COALESCE(i.recipient_snapshot->>'name', '') AS recipient,
                  f.public_ref AS "folioRef",
                  d.invoice_id IS NOT NULL AS "documentReady",
                  d.xml IS NOT NULL AS "hasXml",
                  (SELECT e.status FROM outbound_email e
                    WHERE e.invoice_id = i.id
                    ORDER BY e.id DESC LIMIT 1) AS "mailStatus"
             FROM invoice i
             JOIN folio f ON f.id = i.folio_id
             LEFT JOIN invoice_document d ON d.invoice_id = i.id
             -- Gruppiert statt je Zeile: eine Rechnung kann mehrere
             -- Zahlungsvermerke tragen, und ein Verbund gegen settlement
             -- selbst vervielfachte die Zeile.
             LEFT JOIN (SELECT invoice_id, sum(amount_cent) AS summe
                          FROM settlement
                         WHERE property_id = $1 AND invoice_id IS NOT NULL
                         GROUP BY invoice_id) z ON z.invoice_id = i.id
             LEFT JOIN (SELECT deposit_invoice_id, sum(amount_gross_cent) AS summe
                          FROM deposit_ledger
                         WHERE property_id = $1 AND kind = 'received'
                         GROUP BY deposit_invoice_id) a ON a.deposit_invoice_id = i.id
             LEFT JOIN invoice sn ON sn.reverses_id = i.id AND NOT sn.partial_reversal
             LEFT JOIN invoice o ON o.id = i.reverses_id
            WHERE i.property_id = $1
              AND i.issued_on BETWEEN $2::date AND $3::date
              AND ($4::text IS NULL OR i.kind = $4)
            ORDER BY i.issued_on DESC, i.id DESC
            LIMIT $5`,
          [Number(propertyId), q.from, q.to, q.kind ?? null, limit])
        return { from: q.from, to: q.to, limit, invoices: rows }
      })
    }
  })

  /**
   * Der Beleg zur Rechnung: PDF/A-3 mit eingebettetem CII-XML nach
   * EN 16931, also ZUGFeRD.
   *
   * Ausgeliefert wird, was der Worker erzeugt hat, und nichts wird hier
   * nachgerechnet oder neu gezeichnet. Ein Beleg, der bei jedem Abruf neu
   * entstuende, waere bei jedem Abruf ein anderer -- und der Gast haelt
   * eine Fassung in der Hand, die das Haus nicht mehr kennt.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/invoices/:invoiceRef/pdf',
    permission: 'folio:read',
    summary: 'Rechnung als PDF/A-3 mit eingebettetem ZUGFeRD-XML',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ number: string; property_id: number
                                       pdf: Buffer | null }>(
          `SELECT i.number, i.property_id, d.pdf
             FROM invoice i
             LEFT JOIN invoice_document d ON d.invoice_id = i.id
            WHERE i.public_ref = $1`, [invoiceRef])
        if (r.rowCount === 0) throw Errors.notFound('res.invoice')
        rechtImHaus(req.principal as Principal, 'folio:read', r.rows[0]!.property_id)
        const pdf = r.rows[0]!.pdf
        if (pdf === null) throw Errors.documentPending()

        // Die Rechnungsnummer kann einen Praefix aus den Stammdaten tragen;
        // was dort steht, gehoert nicht ungeprueft in einen Dateinamen.
        const name = `Rechnung-${r.rows[0]!.number.replace(/[^\w.-]/g, '-')}.pdf`
        // `?inline=1` oeffnet den Beleg im Browser statt ihn zu speichern:
        // iOS zeigt ein PDF im eingebetteten Blatt oft gar nicht an, im
        // eigenen Fenster schon (Pruefung 13.10.2026).
        const inline = (req.query as { inline?: string } | undefined)?.inline === '1'
        reply.header('content-type', 'application/pdf')
        reply.header('content-disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${name}"`)
        return pdf
      })
    }
  })

  /**
   * Stornorechnung (Pruefung 13.10.2026, Befund 2).
   *
   * Hebt eine Schluss- oder Zwischenrechnung ganz auf: eine eigene Rechnung
   * mit eigener Nummer, Typ 381 und Bezug auf das Original (BT-25). Eine
   * falsche Rechnung laesst sich nicht aendern -- sie ist Haertegrad 1 --,
   * aber berichtigen, und erst die Berichtigung beendet die Steuerschuld
   * aus § 14c UStG.
   *
   * **Was dabei am Folio geschieht.** Jede Position des Originals bekommt
   * eine Gegenbuchung, die auf der Stornorechnung steht, und daneben eine
   * neue, offene Buchung mit denselben Angaben. Der Saldo bleibt, und die
   * richtige Rechnung entsteht danach wie jede andere -- mit anderer
   * Anschrift, ohne eine Position, mit Nachlass. Beide Buchungen tragen
   * den Geschaeftstag des Originals: der Leistungszeitraum der neuen
   * Rechnung bleibt der Aufenthalt, und die Tagesstatistik sieht netto
   * nichts.
   *
   * Zahlungsvermerke und Anzahlungen, die dem Original zugeordnet waren,
   * werden ebenso uebertragen: Gegenvermerk auf der Stornorechnung, neuer
   * offener Vermerk daneben. Ohne das stuende die neue Rechnung als offen
   * da, obwohl der Gast laengst bezahlt hat.
   *
   * Anzahlungsrechnungen nicht: die hebt eine Rueckzahlung auf, keine
   * Stornierung, weil an ihr ein Zahlungseingang haengt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/invoices/:invoiceRef/cancel',
    permission: 'invoice:credit',
    summary: 'Rechnung stornieren',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return mitBeleg(req, tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { invoiceRef }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const o = await client.query<{
          id: number; property_id: number; folio_id: number; number: string; kind: string
          issued_on: string; service_from: string | null; service_to: string | null
          issuer_snapshot: unknown; recipient_snapshot: unknown
          totals: Record<string, unknown> }>(
          `SELECT id, property_id, folio_id, number, kind, issued_on::text,
                  service_from::text, service_to::text,
                  issuer_snapshot, recipient_snapshot, totals
             FROM invoice WHERE public_ref = $1`, [invoiceRef])
        if (o.rowCount === 0) throw Errors.notFound('res.invoice')
        const original = o.rows[0]!
        rechtImHaus(principal, 'invoice:credit', original.property_id)

        // Unter der Sperre des Folios, wie das Festschreiben: zwei
        // Stornierungen zugleich faenden sonst beide kein Storno vor.
        const f = await client.query<{ public_ref: string }>(
          `SELECT public_ref FROM folio WHERE id = $1 FOR UPDATE`, [original.folio_id])
        const folioRef = f.rows[0]!.public_ref

        if (original.kind !== 'final' && original.kind !== 'interim') {
          throw Errors.conflict('invoice.notCancellable')
        }
        const schon = await client.query<{ number: string }>(
          `SELECT number FROM invoice WHERE reverses_id = $1 AND NOT partial_reversal`,
          [original.id])
        if ((schon.rowCount ?? 0) > 0) {
          throw Errors.conflict('invoice.alreadyCancelled', { number: schon.rows[0]!.number })
        }

        const businessDate = await offenerGeschaeftstag(client, original.property_id)
        const heute = await heuteImHaus(client, original.property_id)
        const num = await naechsteNummer(client, original.property_id)
        const totals = gegenSummen(original.totals)

        const cn = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to, issuer_snapshot,
                                recipient_snapshot, totals, reverses_id, created_by,
                                line_guests)
           VALUES ($1,$2,$3,$12::date,$4::date,'credit_note',$5::date,$6::date,
                   $7,$8,$9,$10,$11,
                   (SELECT o.line_guests FROM invoice o WHERE o.id = $10))
           RETURNING id, public_ref, number`,
          [original.property_id, original.folio_id, num.rows[0]!.next_invoice_number,
           businessDate, original.service_from, original.service_to,
           JSON.stringify(original.issuer_snapshot),
           JSON.stringify(original.recipient_snapshot),
           JSON.stringify(totals), original.id, principal.userId, heute])
        const gutschrift = cn.rows[0]!

        // Gegenbuchungen auf die Stornorechnung, neue offene Buchungen ans
        // Folio. Herkunft und Fremdreferenz der Kasse bleiben am Original:
        // sie sind je Haus eindeutig und gehoeren zu genau einer Buchung.
        await client.query(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, product_id, reservation_id, reverses_id,
                               invoice_id, created_by, package_part)
           SELECT c.property_id, c.folio_id, c.business_date, 'Storno ' || c.description,
                  c.quantity, -c.net_cent, -c.tax_cent, -c.gross_cent, c.tax_rate_bp,
                  c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id, c.id,
                  $2, $3, c.package_part
             FROM charge c WHERE c.invoice_id = $1 ORDER BY c.id`,
          [original.id, gutschrift.id, principal.userId])
        await client.query(
          `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                               net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                               revenue_account, product_id, reservation_id,
                               created_by, package_part)
           SELECT c.property_id, c.folio_id, c.business_date, c.description,
                  c.quantity, c.net_cent, c.tax_cent, c.gross_cent, c.tax_rate_bp,
                  c.tax_rule_id, c.revenue_account, c.product_id, c.reservation_id,
                  $2, c.package_part
             FROM charge c WHERE c.invoice_id = $1 ORDER BY c.id`,
          [original.id, principal.userId])

        // Zahlungsvermerke des Originals: Gegenvermerk auf die
        // Stornorechnung, derselbe Betrag wieder offen am Folio.
        await client.query(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                   payment_method_id, external_reference, invoice_id,
                                   reverses_id, created_by)
           SELECT s.property_id, s.folio_id, $2::date, -s.amount_cent, s.payment_method_id,
                  s.external_reference, $3, s.id, $4
             FROM settlement s WHERE s.invoice_id = $1 ORDER BY s.id`,
          [original.id, businessDate, gutschrift.id, principal.userId])
        await client.query(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                   payment_method_id, external_reference, created_by)
           SELECT s.property_id, s.folio_id, $2::date, s.amount_cent, s.payment_method_id,
                  s.external_reference, $3
             FROM settlement s WHERE s.invoice_id = $1 ORDER BY s.id`,
          [original.id, businessDate, principal.userId])

        // Verrechnete Anzahlungen werden wieder offen.
        await client.query(
          `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                       amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                       business_date, applied_invoice_id, created_by)
           SELECT dl.property_id, dl.folio_id, dl.deposit_invoice_id, 'unapplied',
                  dl.amount_gross_cent, dl.net_cent, dl.tax_cent, dl.tax_rate_bp,
                  $2::date, $3, $4
             FROM deposit_ledger dl
            WHERE dl.applied_invoice_id = $1 AND dl.kind = 'applied'
            ORDER BY dl.id`,
          [original.id, businessDate, gutschrift.id, principal.userId])

        const result = {
          invoiceRef: gutschrift.public_ref,
          number: gutschrift.number,
          reversesNumber: original.number,
          totals
        }

        await emitEvent(client, original.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef,
          number: result.number,
          folioRef,
          kind: 'credit_note',
          reversesNumber: original.number,
          serviceFrom: original.service_from, serviceTo: original.service_to,
          grossCent: totals.grossCent,
          payableCent: totals.payableCent
        })

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      }))
    }
  })

  /**
   * Rueckzahlung einer Anzahlung (0162).
   *
   * Reist der Gast frueher ab oder storniert, steht ihm Geld zu. Die
   * Anzahlungsrechnung hat die Steuer auf das ganze vereinnahmte Geld
   * ausgewiesen; ohne Berichtigung schuldet das Haus sie auch fuer den Teil,
   * der zurueckging (§ 14c, § 17 Abs. 2 Nr. 2 UStG). Deshalb entsteht in
   * einem Zug:
   *
   * - eine Rechnungskorrektur zur Anzahlungsrechnung (`credit_note`,
   *   `partial_reversal`) ueber den zurueckgezahlten Teil, zu den Saetzen,
   *   zu denen er versteuert wurde;
   * - je Satz eine Zeile 'refunded' im Anzahlungsjournal;
   * - der Zahlungsvermerk der Auszahlung, negativ, an der Korrektur.
   *
   * Verrechnet die naechste Schlussrechnung die Anzahlung, nimmt sie nur
   * noch, was davon bleibt. Eine schon verrechnete Anzahlung geht nicht:
   * erst die Schlussrechnung stornieren, sonst stuende die Steuer auf
   * demselben Geld zweimal berichtigt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/invoices/:invoiceRef/refund',
    permission: 'invoice:credit',
    summary: 'Anzahlung ganz oder teilweise zurueckzahlen',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      const body = (req.body ?? {}) as { amountCent?: unknown; paymentMethodCode?: unknown
                                         externalReference?: unknown }
      const f: Record<string, Meldung[]> = {}
      if (typeof body.amountCent !== 'number' || !Number.isSafeInteger(body.amountCent)
          || body.amountCent <= 0 || body.amountCent > MAX_POSITION_CENT) {
        f.amountCent = ['field.positiveInteger']
      }
      if (typeof body.paymentMethodCode !== 'string' || body.paymentMethodCode === '') {
        f.paymentMethodCode = ['field.required']
      }
      if (body.externalReference !== undefined
          && (typeof body.externalReference !== 'string' || body.externalReference.length > 200)) {
        f.externalReference = ['field.maxLength']
      }
      if (Object.keys(f).length > 0) throw Errors.validation(f, { max: 200 })
      const betrag = body.amountCent as number
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return mitBeleg(req, tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { invoiceRef, ...body }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const d = await client.query<{ id: number; property_id: number; folio_id: number
                                       kind: string; number: string
                                       service_from: string | null; service_to: string | null
                                       issuer_snapshot: unknown; recipient_snapshot: unknown }>(
          `SELECT id, property_id, folio_id, kind, number, service_from::text,
                  service_to::text, issuer_snapshot, recipient_snapshot
             FROM invoice WHERE public_ref = $1`, [invoiceRef])
        if (d.rowCount === 0) throw Errors.notFound('res.invoice')
        const anzahlung = d.rows[0]!
        rechtImHaus(principal, 'invoice:credit', anzahlung.property_id)
        if (anzahlung.kind !== 'deposit') throw Errors.conflict('deposit.refundOnlyDeposit')

        // Unter der Sperre des Folios: dort laufen auch Schlussrechnung und
        // Verrechnung, und die duerfen nicht dazwischen geraten.
        const fo = await client.query<{ public_ref: string; status: string }>(
          `SELECT public_ref, status FROM folio WHERE id = $1 FOR UPDATE`, [anzahlung.folio_id])
        if (fo.rows[0]!.status === 'closed') throw Errors.conflict('folio.closed')

        const verrechnet = await client.query(
          `SELECT 1 FROM deposit_ledger a
            WHERE a.deposit_invoice_id = $1 AND a.kind = 'applied'
              AND NOT EXISTS (SELECT 1 FROM invoice s
                               WHERE s.reverses_id = a.applied_invoice_id
                                 AND NOT s.partial_reversal)`, [anzahlung.id])
        if ((verrechnet.rowCount ?? 0) > 0) throw Errors.conflict('deposit.refundApplied')

        // Was je Satz noch offen ist: vereinnahmt minus schon zurueckgezahlt.
        const rest = (await client.query<{ rate: number; gross: string; net: string
                                           tax: string }>(
          `SELECT tax_rate_bp AS rate,
                  (sum(amount_gross_cent) FILTER (WHERE kind = 'received')
                   - COALESCE(sum(amount_gross_cent) FILTER (WHERE kind = 'refunded'), 0))::text
                    AS gross,
                  (sum(net_cent) FILTER (WHERE kind = 'received')
                   - COALESCE(sum(net_cent) FILTER (WHERE kind = 'refunded'), 0))::text AS net,
                  (sum(tax_cent) FILTER (WHERE kind = 'received')
                   - COALESCE(sum(tax_cent) FILTER (WHERE kind = 'refunded'), 0))::text AS tax
             FROM deposit_ledger
            WHERE deposit_invoice_id = $1 AND kind IN ('received', 'refunded')
            GROUP BY tax_rate_bp ORDER BY tax_rate_bp`, [anzahlung.id])).rows
          .map(r => ({ rateBp: r.rate, grossCent: Number(r.gross), netCent: Number(r.net),
                       taxCent: Number(r.tax) }))
          .filter(r => r.grossCent > 0)
        const offen = rest.reduce((s, r) => s + r.grossCent, 0)
        if (betrag > offen) {
          throw Errors.unprocessable('deposit.refundTooHigh', { max: (offen / 100).toFixed(2) })
        }

        /*
         * Je Satz: alles zurueck nimmt genau den Rest, Netto und Steuer
         * eingeschlossen -- nachgerechnet bliebe sonst ein Cent Steuer auf
         * einer Anzahlung stehen, die es nicht mehr gibt. Ein Teil wird nach
         * dem Rest der Saetze aufgeteilt und wie die Anzahlungsrechnung
         * gerechnet.
         */
        let teile: Array<{ rateBp: number; netCent: number; taxCent: number; grossCent: number }>
        if (betrag === offen) {
          teile = rest
        } else {
          const anteile = splitDeposit(betrag, rest.map(r => ({ rateBp: r.rateBp,
                                                                grossCent: r.grossCent })))
          teile = sumInvoice(depositLines(betrag, anteile)).groups
          for (const t of teile) {
            const r = rest.find(x => x.rateBp === t.rateBp)
            if (r === undefined || t.grossCent > r.grossCent) {
              throw Errors.unprocessable('deposit.refundTooHigh',
                { max: (offen / 100).toFixed(2) })
            }
          }
        }
        const netto = teile.reduce((s, t) => s + t.netCent, 0)
        const steuer = teile.reduce((s, t) => s + t.taxCent, 0)
        const totals = {
          netCent: -netto, taxCent: -steuer, grossCent: -betrag,
          groups: teile.map(t => ({ rateBp: t.rateBp, netCent: -t.netCent,
                                    taxCent: -t.taxCent, grossCent: -t.grossCent })),
          roundingCent: 0, payableCent: -betrag, prepaidCent: -betrag
        }

        const pm = await client.query<{ id: number }>(
          `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2 AND active`,
          [anzahlung.property_id, body.paymentMethodCode])
        if (pm.rowCount === 0) {
          throw Errors.validation({ paymentMethodCode: ['field.unknownPaymentMethod'] })
        }

        const heute = await heuteImHaus(client, anzahlung.property_id)
        const geschaeftstag = await offenerGeschaeftstag(client, anzahlung.property_id)
        const num = await naechsteNummer(client, anzahlung.property_id)
        const k = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to, issuer_snapshot, recipient_snapshot,
                                totals, created_by, reverses_id, partial_reversal)
           VALUES ($1,$2,$3,$4::date,$5::date,'credit_note',$6::date,$7::date,$8,$9,$10,$11,
                   $12,true)
           RETURNING id, public_ref, number`,
          [anzahlung.property_id, anzahlung.folio_id, num.rows[0]!.next_invoice_number,
           heute, geschaeftstag, anzahlung.service_from, anzahlung.service_to,
           JSON.stringify(anzahlung.issuer_snapshot), JSON.stringify(anzahlung.recipient_snapshot),
           JSON.stringify(totals), principal.userId, anzahlung.id])
        const korrektur = k.rows[0]!

        const z = await client.query<{ id: number }>(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                   payment_method_id, external_reference, created_by, invoice_id)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8) RETURNING id`,
          [anzahlung.property_id, anzahlung.folio_id, geschaeftstag, -betrag, pm.rows[0]!.id,
           (body.externalReference as string | undefined) ?? null, principal.userId,
           korrektur.id])
        for (const t of teile) {
          await client.query(
            `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                         amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                         business_date, settlement_id, applied_invoice_id,
                                         created_by)
             VALUES ($1,$2,$3,'refunded',$4,$5,$6,$7,$8::date,$9,$10,$11)`,
            [anzahlung.property_id, anzahlung.folio_id, anzahlung.id, t.grossCent, t.netCent,
             t.taxCent, t.rateBp, geschaeftstag, z.rows[0]!.id, korrektur.id,
             principal.userId])
        }

        const result = { invoiceRef: korrektur.public_ref, number: korrektur.number,
                         amountCent: betrag, remainingCent: offen - betrag }
        await emitEvent(client, anzahlung.property_id, 'invoice.finalized', {
          invoiceRef: korrektur.public_ref, number: korrektur.number,
          folioRef: fo.rows[0]!.public_ref, kind: 'credit_note',
          serviceFrom: anzahlung.service_from, serviceTo: anzahlung.service_to,
          grossCent: -betrag
        })
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      }))
    }
  })

  /**
   * Vorschau fuer den Rechnungsdialog: was festgeschrieben wuerde, mit
   * denselben Angaben wie `POST .../invoice`, aber ohne Nummer und ohne
   * Schreiben. Die Maengel kommen als Liste statt als Fehler, damit der
   * Dialog sie zeigen kann, bevor jemand auf "Festschreiben" drueckt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/invoice-preview',
    permission: 'invoice:issue',
    summary: 'Rechnung vorab ansehen',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as RechnungsAuftrag
      const principal = req.principal as Principal
      auftragPruefen(body)

      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null; email: string | null }>(
          `SELECT f.id, f.property_id, f.guest_id, f.company_id,
                  COALESCE(c.invoice_email, g.email) AS email
             FROM folio f
             LEFT JOIN company c ON c.id = f.company_id
             LEFT JOIN guest g ON g.id = f.guest_id
            WHERE f.public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'invoice:issue', folio.property_id)

        const e = await rechnungsEntwurf(client, folio, body)
        // Die Nummer vergibt erst das Festschreiben; geprueft wird hier
        // alles andere.
        const maengel = rechnungsMaengel(e, 'ENTWURF', body.kind ?? 'final')
        const einstellung = await rechnungseinstellung(client, folio.property_id)
        return {
          lines: e.charges.map(c => ({
            chargeId: c.id, description: lineWithGuest(c.description, e.lineGuests[String(c.id)]),
            quantity: c.quantity,
            businessDate: c.business_date, grossCent: Number(c.gross_cent),
            taxRateBp: c.tax_rate_bp })),
          depositsApplied: e.deposits.map(d => ({
            depositInvoiceNumber: d.deposit_number,
            amountGrossCent: Number(d.amount_gross_cent) })),
          totals: e.totals,
          serviceFrom: e.serviceFrom, serviceTo: e.serviceTo,
          recipient: e.recipient,
          defaultRecipient: e.defaultRecipient,
          recipientEmail: folio.email,
          dueOn: e.dueOn,
          openCent: e.offenCent,
          nextNumber: einstellung.nextNumber,
          prefixMissing: einstellung.missing,
          findings: maengel.map(m => ({ key: m.key, reference: m.reference, de: m.de, en: m.en }))
        }
      })
    }
  })

  /**
   * Die Rechnung als PDF, bevor sie festgeschrieben ist (Sven, 16.10.2026:
   * "es waere gut wenn es kuenftig eine rechnungsvorschau gaebe bevor ich
   * diese festschreibe und diese unveraenderbar ist").
   *
   * Dasselbe Blatt wie der Beleg (`@hotelpms/beleg`), aus demselben Entwurf
   * wie die Vorschau daneben, aber ohne Nummer, ohne XML und mit "ENTWURF"
   * quer ueber jeder Seite. Geschrieben wird nichts: keine Nummer
   * verbraucht, kein Zahlungsvermerk, kein Beleg abgelegt. Ein POST, weil
   * der Auftrag (Auswahl, Anschrift, Zahlung) im Rumpf kommt, wie bei der
   * Vorschau.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/invoice-preview/pdf',
    permission: 'invoice:issue',
    summary: 'Rechnung als PDF-Entwurf vorab ansehen',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as RechnungsAuftrag
      const principal = req.principal as Principal
      auftragPruefen(body)

      const { rechnung, logo, website } = await tx(req.pool, req, async client => {
        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id FROM folio WHERE public_ref = $1`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'invoice:issue', folio.property_id)
        const e = await rechnungsEntwurf(client, folio, body)
        const l = await client.query<{ mime: string; bytes: Buffer }>(
          `SELECT mime, bytes FROM property_invoice_logo WHERE property_id = $1`,
          [folio.property_id])
        return {
          rechnung: entwurfAlsRechnung(e, body.kind ?? 'final', body.paid !== undefined),
          logo: l.rows[0] ?? null,
          website: (e.issuer as { website?: string | null }).website ?? null
        }
      })
      // Gezeichnet ausserhalb der Transaktion: einige hundert Millisekunden
      // Rechenarbeit halten sonst eine Verbindung offen (wie im Worker).
      const doc = await renderInvoicePdf({
        invoice: rechnung, publicRef: '', draft: true, logo, website,
        onLogoSkipped: () => req.log.warn('Rechnungslogo zu gross oder unlesbar, Entwurf ohne Logo')
      })
      const pdf = await doc.save()
      reply.header('content-type', 'application/pdf')
      reply.header('content-disposition', 'inline; filename="Rechnung-Entwurf.pdf"')
      // Ein Entwurf ist nach der naechsten Buchung ein anderer.
      reply.header('cache-control', 'no-store')
      return Buffer.from(pdf)
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/invoice',
    permission: 'invoice:issue',
    summary: 'Rechnung festschreiben',
    handler: async (req, reply) => {
      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as RechnungsAuftrag
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      auftragPruefen(body)

      return mitBeleg(req, tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; guest_id: number | null
                                       company_id: number | null }>(
          `SELECT id, property_id, guest_id, company_id FROM folio WHERE public_ref = $1
             FOR UPDATE`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'invoice:issue', folio.property_id)

        const e = await rechnungsEntwurf(client, folio, body)
        const charges = { rows: e.charges }
        const deposits = { rows: e.deposits }
        const { serviceFrom, serviceTo, businessDate } = e

        const num = await naechsteNummer(client, folio.property_id)

        // Vor dem Festschreiben prüfen. Eine fehlende Pflichtangabe kostet
        // dem Empfänger den Vorsteuerabzug, und das merkt niemand beim
        // Ausstellen, sondern der Firmenkunde drei Monate später (E4).
        const maengel = rechnungsMaengel(e, num.rows[0]!.next_invoice_number,
                                         body.kind ?? 'final')
        if (maengel.length > 0) {
          throw Errors.unprocessable(
            'invoice.requirementsUnmet',
            { maengel: maengel.map(m => `${m.de} (${m.reference})`).join(' ') })
        }

        /*
         * "Gleich bezahlt" im Dialog: ein echter Zahlungsvermerk ueber den
         * offenen Betrag, dieser Rechnung zugeordnet. Ein blosses Kennzeichen
         * "bezahlt" liesse das Folio mit Saldo stehen und die Kasse ohne
         * Zahlart -- am Monatsende stimmte nichts davon.
         */
        let { totals, vorausbezahlt } = e
        const rest = totals.payableCent - totals.prepaidCent
        if (body.paid !== undefined && rest > 0) {
          const pm = await client.query<{ id: number }>(
            `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2 AND active`,
            [folio.property_id, body.paid.paymentMethodCode])
          if (pm.rowCount === 0) {
            throw Errors.validation({ 'paid.paymentMethodCode': ['field.unknownPaymentMethod'] })
          }
          const z = await client.query<{ id: number }>(
            `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                     payment_method_id, external_reference, created_by)
             VALUES ($1,$2,$3::date,$4,$5,$6,$7) RETURNING id`,
            [folio.property_id, folio.id, businessDate, rest, pm.rows[0]!.id,
             body.paid.externalReference?.trim() || null, principal.userId])
          vorausbezahlt = [...vorausbezahlt, z.rows[0]!.id]
          totals = { ...totals, prepaidCent: totals.payableCent }
        }
        const inv = await client.query<{ id: number; public_ref: string; number: string }>(
          `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                                service_from, service_to,
                                issuer_snapshot, recipient_snapshot, totals, created_by,
                                due_on, line_guests)
           VALUES ($1,$2,$3,$13::date,$4::date,$5,$6::date,$7::date,$8,$9,$10,$11,
                   $12::date,$14)
           RETURNING id, public_ref, number`,
          [folio.property_id, folio.id, num.rows[0]!.next_invoice_number, businessDate,
           body.kind ?? 'final', serviceFrom, serviceTo,
           JSON.stringify(e.issuer), JSON.stringify(e.recipient),
           JSON.stringify(totals), principal.userId,
           body.paid !== undefined ? null : e.dueOn, e.heute,
           JSON.stringify(e.lineGuests)])

        // charge.invoice_id wird einmal gesetzt und nie geaendert. Die Tabelle
        // ist append-only, daher hebt der Trigger hier gezielt ab: das
        // Festschreiben ist die einzige erlaubte Zuordnung.
        await client.query(
          `UPDATE charge SET invoice_id = $2 WHERE id = ANY($1)`,
          [charges.rows.map(c => c.id), inv.rows[0]!.id])

        // Dasselbe fuer die Zahlungsvermerke, und aus demselben Grund
        // erlaubt: NULL -> Wert, einmal und nie wieder (Migration 0012).
        await vermerkeZuordnen(client, inv.rows[0]!.id, vorausbezahlt)

        // Verrechnet, nicht mehr offen: eine Anzahlung wird genau einer
        // Schlussrechnung zugeordnet (deposit_ledger_applied_once).
        for (const d of deposits.rows) {
          await client.query(
            `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                         amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                         business_date, applied_invoice_id, created_by)
             VALUES ($1,$2,$3,'applied',$4,$5,$6,$7,$8::date,$9,$10)`,
            [folio.property_id, folio.id, d.deposit_invoice_id, d.amount_gross_cent,
             d.net_cent, d.tax_cent, d.tax_rate_bp, businessDate, inv.rows[0]!.id,
             principal.userId])
        }

        const result = {
          invoiceRef: inv.rows[0]!.public_ref,
          number: inv.rows[0]!.number,
          serviceFrom, serviceTo,
          totals,
          dueOn: body.paid !== undefined ? null : e.dueOn,
          depositsApplied: deposits.rows.map(d => ({
            depositInvoiceNumber: d.deposit_number, amountGrossCent: Number(d.amount_gross_cent)
          }))
        }

        await emitEvent(client, folio.property_id, 'invoice.finalized', {
          invoiceRef: result.invoiceRef,
          number: result.number,
          folioRef,
          kind: body.kind ?? 'final',
          serviceFrom, serviceTo,
          // grossCent bleibt die Gesamtsumme nach BT-112; payableCent ist,
          // was der Gast zahlt. Wer die beiden gleichsetzt, bekommt keine
          // Fehlermeldung, sondern einen Cent Abweichung im Abgleich.
          grossCent: totals.grossCent,
          payableCent: totals.payableCent
        })

        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      }))
    }
  })

  /**
   * Was am Folio vorausbezahlt ist: Anzahlungsrechnungen und Zahlungslinks.
   *
   * **Warum nicht im Folio-Aufruf.** `GET /v1/folios/:folioRef` liefert
   * Positionen, Zahlungsvermerke und Saldo -- das taegliche Geschaeft. Die
   * Vorauszahlung ist ein eigener Vorgang mit eigener Maske, und sie wird
   * nur geholt, wenn jemand sie aufmacht. Ein Aufruf je Bildschirmteil,
   * nicht je Zeile: hier sind es drei Abfragen fester Zahl, keine je
   * Zahlungsvermerk.
   *
   * Drei Dinge stehen hier zusammen, weil sie nur zusammen eine Aussage
   * ergeben:
   *
   * 1. **Welcher Zahlungsvermerk schon eine Anzahlungsrechnung hat.** Ein
   *    zweiter Versuch auf denselben Vermerk wird abgewiesen
   *    (`deposit_ledger_settlement_once`); die Maske soll ihn gar nicht
   *    erst anbieten.
   * 2. **Ob eine Anzahlungsrechnung schon verrechnet ist.** Verrechnet wird
   *    auf der Schlussrechnung, als Position und nicht als Kopfangabe --
   *    hier steht, auf welcher.
   * 3. **Welche Zahlungslinks offen sind.** Ein Link ist keine Zahlung; er
   *    wird es erst, wenn der Zahlungsdienstleister sich meldet.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/folios/:folioRef/prepayments',
    permission: 'folio:read',
    summary: 'Anzahlungen und Zahlungslinks eines Folios',
    handler: async (req) => {
      const { folioRef } = req.params as { folioRef: string }
      return tx(req.pool, req, async client => {
        const f = await client.query<{ id: number; property_id: number
                                       reservation_id: number | null; status: string }>(
          `SELECT id, property_id, reservation_id, status FROM folio WHERE public_ref = $1`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(req.principal as Principal, 'folio:read', folio.property_id)

        /*
         * Der Verbund gegen eine *gruppierte* Unterabfrage, nicht gegen
         * deposit_ledger selbst: das Journal traegt eine Zeile je
         * Satzgruppe, und ein Vermerk mit 7 % und 19 % erschiene sonst
         * zweimal in der Liste.
         */
        const settlements = await client.query(
          `SELECT s.id, s.business_date::text AS "businessDate",
                  s.amount_cent AS "amountCent", s.external_reference AS "externalReference",
                  pm.name AS method,
                  di.public_ref AS "depositInvoiceRef", di.number AS "depositInvoiceNumber",
                  dr.public_ref AS "depositRequestRef"
             FROM settlement s
             JOIN payment_method pm ON pm.id = s.payment_method_id
             LEFT JOIN (SELECT settlement_id, min(deposit_invoice_id) AS deposit_invoice_id
                          FROM deposit_ledger
                         WHERE folio_id = $1 AND settlement_id IS NOT NULL
                         GROUP BY settlement_id) d ON d.settlement_id = s.id
             LEFT JOIN invoice di ON di.id = d.deposit_invoice_id
             LEFT JOIN deposit_request_settlement drs ON drs.settlement_id = s.id
             LEFT JOIN deposit_request dr ON dr.id = drs.deposit_request_id
            WHERE s.folio_id = $1
            ORDER BY s.id`,
          [folio.id])

        /*
         * Die Anzahlungsrechnungen dieses Folios, je Rechnung eine Zeile.
         * `applied...` bleibt null, solange nicht verrechnet ist -- das
         * unterscheidet "angezahlt" von "abgerechnet". Die Satzgruppen
         * kommen als JSON mit, statt sie je Rechnung nachzuladen.
         */
        const deposits = await client.query(
          `SELECT di.public_ref AS "invoiceRef", di.number, di.issued_on::text AS "issuedOn",
                  max(dl.settlement_id) AS "settlementId",
                  -- ::bigint ist nicht kosmetisch: sum() ueber bigint liefert
                  -- numeric, und numeric kommt als Zeichenkette an. Eine
                  -- Zeichenkette in einer Centsumme faellt nicht auf -- sie
                  -- rechnet sich nur falsch, sobald jemand sie addiert.
                  sum(dl.amount_gross_cent) FILTER (WHERE dl.kind = 'received')::bigint
                    AS "amountGrossCent",
                  sum(dl.tax_cent) FILTER (WHERE dl.kind = 'received')::bigint AS "taxCent",
                  COALESCE(sum(dl.amount_gross_cent) FILTER (WHERE dl.kind = 'refunded'), 0)
                    ::bigint AS "refundedCent",
                  jsonb_agg(jsonb_build_object(
                      'rateBp', dl.tax_rate_bp,
                      'grossCent', dl.amount_gross_cent,
                      'taxCent', dl.tax_cent)
                    ORDER BY dl.tax_rate_bp) FILTER (WHERE dl.kind = 'received') AS groups,
                  -- Verrechnet ist sie mit der Schlussrechnung, die noch gilt;
                  -- eine stornierte hat die Verrechnung wieder aufgehoben.
                  max(ai.number) FILTER (WHERE dl.kind = 'applied' AND sn.id IS NULL)
                    AS "appliedInvoiceNumber",
                  max(ai.public_ref) FILTER (WHERE dl.kind = 'applied' AND sn.id IS NULL)
                    AS "appliedInvoiceRef",
                  max(dl.business_date) FILTER (WHERE dl.kind = 'applied' AND sn.id IS NULL)::text
                    AS "appliedOn"
             FROM deposit_ledger dl
             JOIN invoice di ON di.id = dl.deposit_invoice_id
             LEFT JOIN invoice ai ON ai.id = dl.applied_invoice_id
             LEFT JOIN invoice sn ON sn.reverses_id = dl.applied_invoice_id
            WHERE dl.folio_id = $1
            GROUP BY di.id, di.public_ref, di.number, di.issued_on
            ORDER BY di.number`,
          [folio.id])

        // Anforderungen, Geschaeftstag und Postbereitschaft: eine feste
        // Zahl weiterer Abfragen, keine je Anforderung.
        const anzahlung = await anzahlungssicht(client, folio)

        /*
         * Die Links des Folios: die dauerhaften von uns (0068) und, darunter
         * gemischt, Checkouts von vor 0068, die keinen eigenen Link haben.
         * Die Checkouts eines dauerhaften Links erscheinen nicht einzeln --
         * fuer die Rezeption ist der Link der Vorgang, der Checkout ein
         * Versuch des Gastes, ihn einzuloesen. Was sie davon wissen will,
         * steht am Link: geoeffnet und bezahlt.
         *
         * payment_intent traegt **keine** Zeilenrichtlinie (0021): die
         * Property wird dort von Hand mitgefiltert. Die Versuche je Link
         * kommen als gruppierte Menge im Verbund, nicht je Link nachgefragt.
         */
        const links = await client.query(
          `SELECT * FROM (
             SELECT l.id, false AS legacy, l.created_at AS "createdAt",
                    l.amount_cent AS "amountCent",
                    CASE WHEN v.bezahlt_am IS NOT NULL THEN 'succeeded'
                         WHEN l.revoked_at IS NOT NULL THEN 'canceled'
                         ELSE 'pending' END AS status,
                    v.bezahlt_am AS "settledAt", v.bezahlt_am IS NOT NULL AS "hasSettlement",
                    NULL::timestamptz AS "expiresAt", l.valid_until::text AS "validUntil",
                    -- Gegen den Geschaeftstag: der Link gilt bis zu einem Tag.
                    (l.revoked_at IS NULL AND v.bezahlt_am IS NULL
                     AND l.valid_until < $3::date) AS expired,
                    dr.public_ref AS "depositRequestRef", e.status AS "mailStatus",
                    v.geoeffnet AS "openedAt"
               FROM payment_link l
               LEFT JOIN (SELECT payment_link_id, min(created_at) AS geoeffnet,
                                 max(settled_at) FILTER (WHERE status = 'succeeded')
                                   AS bezahlt_am
                            FROM payment_intent
                           WHERE folio_id = $1 AND property_id = $2
                             AND payment_link_id IS NOT NULL
                           GROUP BY payment_link_id) v ON v.payment_link_id = l.id
               LEFT JOIN deposit_request dr ON dr.id = l.deposit_request_id
               LEFT JOIN outbound_email e ON e.id = l.email_id
              WHERE l.folio_id = $1
             UNION ALL
             SELECT pi.id, true, pi.created_at, pi.amount_cent, pi.status, pi.settled_at,
                    pi.settlement_id IS NOT NULL, pi.expires_at, NULL,
                    -- Die Uhr: ein Checkout gilt bis zu einem Zeitpunkt.
                    (pi.status = 'pending' AND pi.expires_at IS NOT NULL
                     AND pi.expires_at <= now()),
                    dr.public_ref, e.status, pi.created_at
               FROM payment_intent pi
               LEFT JOIN deposit_request dr ON dr.id = pi.deposit_request_id
               LEFT JOIN outbound_email e ON e.id = pi.email_id
              WHERE pi.folio_id = $1 AND pi.property_id = $2 AND pi.payment_link_id IS NULL
           ) alle
           ORDER BY "createdAt" DESC
           LIMIT 20`,
          [folio.id, folio.property_id, anzahlung.businessDate])

        return {
          folioRef,
          propertyId: folio.property_id,
          // Ohne Reservierung fehlt der Leistungszeitraum nach
          // Paragraph 14 Abs. 4 Nr. 6 UStG, und die Anzahlungsrechnung wird
          // abgewiesen. Die Maske sagt das vorher statt hinterher.
          canIssueDeposit: folio.reservation_id !== null && folio.status === 'open',
          ...anzahlung,
          settlements: settlements.rows,
          deposits: deposits.rows,
          paymentLinks: links.rows
        }
      })
    }
  })
}
