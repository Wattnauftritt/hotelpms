import type { PoolClient } from '@hotelpms/db'
import { requiresRegistrationSignature } from '@hotelpms/domain'
import { UNTERSCHRIFT_MAX_ZEICHEN } from '@hotelpms/contracts'
import { Errors } from './errors.js'

/**
 * Meldeschein nach §§ 29, 30 BMG -- die Regeln an einer Stelle.
 *
 * Bis zum Online-Check-in standen sie in der Route `POST /v1/registrations`.
 * Jetzt erfassen drei Wege einen Meldeschein: der Tresen, die Gastseite per
 * Link und die Station im Haus. Drei Fassungen der Regeln waeren drei
 * Gelegenheiten, eine davon beim naechsten Befund zu vergessen -- dieselbe
 * Lehre wie bei der Loeschung (Migration 0046, `guest_erase_one`). Die
 * Routen sammeln ein und pruefen ihre Eingabe; was ein Meldeschein ist,
 * entscheidet diese Datei.
 *
 * Drei Regeln bestimmen alles Weitere:
 *
 * 1. **Seit dem 1.1.2025 unterschreiben nur noch auslaendische Personen**
 *    (§ 29 Abs. 2 BMG), und zwar nach Staatsangehoerigkeit, nicht nach
 *    Wohnsitz (`requiresRegistrationSignature`, packages/domain). Fuer
 *    alle anderen entfaellt die Unterschrift ersatzlos; eine mitgeschickte wird verworfen, nicht
 *    gespeichert -- eine Unterschrift ohne Rechtsgrund waere eine
 *    Datenerhebung ohne Rechtsgrund.
 * 2. **Keine Ausweiskopie.** Es gibt kein Feld dafuer und kommt keines dazu.
 * 3. **Ein Jahr ab Abreise, dann Vernichtung** (§ 30 Abs. 4 BMG).
 *
 * **Steht eine auslaendische Person auf dem Schein, braucht er eine
 * Unterschrift** -- auch wenn der Hauptgast deutsch ist. Bisher entschied
 * allein der Hauptgast; eine deutsche Reisende mit auslaendischem Begleiter
 * ergab einen Schein ohne Unterschrift, obwohl das Gesetz von "beherbergten
 * auslaendischen Personen" spricht und nicht vom Besteller. Die vorsichtige
 * Lesart verlangt sie (Dokument 30, Abschnitt 3).
 *
 * **Die Unterschrift darf spaeter kommen, aber nur am Anreisetag.** § 29
 * Abs. 2 BMG verlangt sie "am Tag der Ankunft". Der Weg ueber den Link
 * erfasst deshalb vorab alles ausser ihr (`unterschrift: 'amAnreisetag'`);
 * am Tresen und an der Station wird sie im selben Zug geleistet
 * (`unterschrift: 'jetzt'`).
 */

/**
 * Die Frist. "Vom Tag der Abreise der beherbergten Person an ein Jahr"
 * (§ 30 Abs. 4 BMG), nicht ab Anreise -- hier stand einmal das Gegenteil.
 *
 * Kommunale Gaestebeitragssatzungen verlangen laengere Aufbewahrung, aber
 * fuer einen **anderen** Nachweis (Dokument 16, "Fristen nach Landes- und
 * Kommunalrecht"). Sie haengt am Haus und bremst die Anonymisierung, nicht
 * diese Tabelle.
 */
export const AUFBEWAHRUNG_MONATE = 12

export type MeldescheinQuelle = 'desk' | 'online' | 'terminal' | 'import'

/** Ein Schein, den ein Umsystem schon eingesammelt hat (Migration 0087). */
export interface MeldescheinHerkunft {
  system: string
  reference: string | null
  /** Wann der Gast ihn dort ausgefuellt hat. */
  completedAt: string | null
  avsReportedAt: string | null
}

/**
 * Eine mitgeschickte Unterschrift pruefen: vorhanden, Text, nicht zu gross.
 *
 * Die Grenze ist die des Vertrags (`UNTERSCHRIFT_MAX_ZEICHEN`), eine Zahl
 * fuer alle Wege. Sie steht hier und nicht nur im allgemeinen Rumpflimit,
 * weil inzwischen Wege ohne Mitarbeiter unterschreiben -- die Gastseite
 * und das Gaesteterminal (Dokument 31) --, und ein Megabyte je Schein in
 * einer Tabelle, die ein Jahr haelt, waere ein Weg, sie zu fuellen. Die
 * genaue Form (`istUnterschriftSvg`) pruefen die Wege, an denen kein
 * Mitarbeiter steht, an ihrer Route.
 */
export function pruefeUnterschrift(svg: unknown): string {
  if (typeof svg !== 'string' || svg.trim() === '') {
    throw Errors.validation({ signatureSvg: ['field.required'] })
  }
  if (svg.length > UNTERSCHRIFT_MAX_ZEICHEN) {
    throw Errors.validation({ signatureSvg: ['registration.signatureTooLarge'] })
  }
  return svg
}

export type Unterschrift =
  /** Am Tresen und an der Station: jetzt oder gar nicht. */
  | { art: 'jetzt'; svg: string | null | undefined
      /** Nur bei der Uebernahme: unterschrieben wurde dort, nicht jetzt. */
      signedAt?: string | null }
  /** Ueber den Link vor Anreise: nie jetzt, sondern am Anreisetag. */
  | { art: 'amAnreisetag' }

/**
 * Befreiung von der Kurtaxe, wie die Person sie erklaert hat (0089). Der
 * Aufrufer hat den Grund gegen das Haus geprueft und die Nummer verworfen,
 * wo der Grund keine verlangt.
 */
export interface Befreiung { reasonId: number; proof: string | null }

export interface MeldescheinEingabe {
  propertyId: number
  reservationId: number
  arrival: string
  departure: string
  primaryGuestId: number
  /** Gaeste-ids der Mitreisenden, in der Reihenfolge der Eingabe. */
  mitreisende: number[]
  unterschrift: Unterschrift
  quelle: MeldescheinQuelle
  herkunft?: MeldescheinHerkunft
  /** Je Gaeste-id; wer fehlt, ist nicht befreit. */
  befreiungen?: Map<number, Befreiung>
}

export interface MeldescheinErgebnis {
  registrationId: number
  isForeign: boolean
  signatureRequired: boolean
  signatureStored: boolean
  /** Unterschrift noch zu leisten, am Anreisetag. */
  signaturePending: boolean
  groupMembers: number
}

interface Person { id: number; nationality: string | null; country: string | null }

/**
 * Einen Meldeschein anlegen, mit Sammelmeldeschein fuer Mitreisende.
 *
 * Laeuft in der Transaktion des Aufrufers und unter seinem Kontext. Der
 * Aufrufer hat die Reservierung bereits geladen und gegen sein Haus
 * geprueft.
 */
export async function erfasseMeldeschein(
  client: PoolClient, e: MeldescheinEingabe
): Promise<MeldescheinErgebnis> {
  const vorhanden = await client.query(
    `SELECT 1 FROM registration WHERE reservation_id = $1 LIMIT 1`, [e.reservationId])
  if (vorhanden.rowCount && vorhanden.rowCount > 0) {
    throw Errors.conflict('registration.alreadyExists')
  }

  // Alle Personen in einer Abfrage, nicht je Mitreisendem eine.
  const ids = [e.primaryGuestId, ...e.mitreisende]
  const p = await client.query<Person>(
    `SELECT id, nationality, country FROM guest WHERE id = ANY($1::bigint[])`, [ids])
  const nachId = new Map(p.rows.map(r => [Number(r.id), r]))
  const haupt = nachId.get(e.primaryGuestId)
  if (haupt === undefined) throw Errors.notFound('res.guest')
  const begleiter = e.mitreisende.map(id => {
    const m = nachId.get(id)
    if (m === undefined) throw Errors.notFound('res.guest')
    return m
  })

  const befreiung = (id: number): Befreiung | undefined => e.befreiungen?.get(id)
  const hauptAuslaendisch = requiresRegistrationSignature(haupt)
  const noetig = hauptAuslaendisch || begleiter.some(m => requiresRegistrationSignature(m))

  let signatur: string | null = null
  if (e.unterschrift.art === 'jetzt') {
    if (noetig && !e.unterschrift.svg) {
      throw Errors.unprocessable('registration.signatureRequired')
    }
    // Ohne Rechtsgrund keine Unterschrift: verworfen, nicht gespeichert --
    // und deshalb auch nicht geprueft.
    signatur = noetig ? pruefeUnterschrift(e.unterschrift.svg) : null
  }

  const signedAt = e.unterschrift.art === 'jetzt' ? e.unterschrift.signedAt ?? null : null
  const k = e.herkunft
  const h = await client.query<{ id: number }>(
    `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                               planned_departure, occupant_count, is_foreign,
                               signature_svg, signed_at, destroy_after,
                               source, signature_required, external_system,
                               external_reference, completed_at, avs_reported_at,
                               tax_exemption_reason_id, tax_exemption_proof)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8::text,
             CASE WHEN $8::text IS NULL THEN NULL
                  ELSE COALESCE($12::timestamptz, now()) END,
             -- Ab Abreise, nicht ab Anreise: § 30 Abs. 4 BMG.
             ($5::date + ($9 || ' months')::interval)::date,
             $10, $11, $13, $14, $15::timestamptz, $16::timestamptz, $17, $18)
     RETURNING id`,
    [e.propertyId, e.reservationId, e.primaryGuestId, e.arrival, e.departure,
     e.mitreisende.length + 1, hauptAuslaendisch, signatur, AUFBEWAHRUNG_MONATE,
     e.quelle, noetig, signedAt, k?.system ?? null, k?.reference ?? null,
     k?.completedAt ?? null, k?.avsReportedAt ?? null,
     befreiung(e.primaryGuestId)?.reasonId ?? null,
     befreiung(e.primaryGuestId)?.proof ?? null])
  const hauptId = Number(h.rows[0]!.id)

  /**
   * Sammelmeldeschein (E6, Dokument 13). Jeder Mitreisende bekommt einen
   * eigenen Datensatz, der auf den Hauptschein zeigt: die Meldepflicht gilt
   * je Person, unterschrieben wird einmal.
   */
  for (const m of begleiter) {
    await client.query(
      `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                 planned_departure, occupant_count, is_foreign,
                                 group_registration_id, destroy_after, source,
                                 external_system, tax_exemption_reason_id,
                                 tax_exemption_proof)
       VALUES ($1,$2,$3,$4::date,$5::date,1,$6,$7,
               ($5::date + ($8 || ' months')::interval)::date, $9, $10, $11, $12)`,
      [e.propertyId, e.reservationId, m.id, e.arrival, e.departure,
       requiresRegistrationSignature(m), hauptId, AUFBEWAHRUNG_MONATE, e.quelle,
       k?.system ?? null, befreiung(Number(m.id))?.reasonId ?? null,
       befreiung(Number(m.id))?.proof ?? null])

    /*
     * Wer gemeldet ist, wohnt auch im Zimmer.
     *
     * Die Kurtaxe rechnet aus `reservation_occupant`, und so meldete das
     * Haus einmal zwei Personen und berechnete eine -- ohne Fehlermeldung,
     * mit einer Rechnung, die plausibel aussieht (Dokument 16). Nur, wenn
     * die Person nicht schon in der Liste steht; ein zweiter Eintrag zaehlte
     * denselben Menschen doppelt.
     */
    await client.query(
      `INSERT INTO reservation_occupant
         (property_id, reservation_id, guest_id, is_primary)
       SELECT $1,$2,$3,false
        WHERE NOT EXISTS (SELECT 1 FROM reservation_occupant o
                           WHERE o.reservation_id = $2 AND o.guest_id = $3)`,
      [e.propertyId, e.reservationId, m.id])
  }

  return {
    registrationId: hauptId,
    isForeign: hauptAuslaendisch,
    signatureRequired: noetig,
    signatureStored: signatur !== null,
    signaturePending: noetig && signatur === null,
    groupMembers: begleiter.length
  }
}

/**
 * Die Unterschrift nachreichen -- am Tresen, ueber die Gastseite am
 * Anreisetag oder am Gaesteterminal (Dokument 31).
 *
 * **Die eine Stelle fuer diese Regel.** Drei Wege rufen sie auf; zwei
 * Fassungen derselben Pruefung liefen auseinander, und dann unterschriebe
 * am Terminal, wer am Tresen abgewiesen worden waere.
 *
 * Nur, wo der Schein eine braucht und noch keine hat. Fuer einen Schein
 * ohne auslaendische Person gibt es keine, die geleistet werden koennte.
 *
 * `darfImHaus`: die Zeilenrichtlinie laesst jedes Haus des Aufrufers durch,
 * ein Recht gilt aber je Haus -- wer in Haus A einchecken darf, darf in
 * Haus B noch lange nicht unterschreiben lassen. Ein fremdes Haus sieht
 * aus wie kein Schein.
 */
export async function unterschreibeMeldeschein(
  client: PoolClient, registrationId: number, svg: unknown,
  darfImHaus: (propertyId: number) => boolean = () => true
): Promise<void> {
  const unterschrift = pruefeUnterschrift(svg)
  if (!Number.isSafeInteger(registrationId)) throw Errors.notFound('res.registration')
  const cur = await client.query<{ signature_required: boolean; signed_at: string | null
                                   property_id: string }>(
    `SELECT signature_required, signed_at::text, property_id FROM registration
      WHERE id = $1 AND group_registration_id IS NULL FOR UPDATE`, [registrationId])
  if (cur.rowCount === 0 || !darfImHaus(Number(cur.rows[0]!.property_id))) {
    throw Errors.notFound('res.registration')
  }
  if (!cur.rows[0]!.signature_required) {
    throw Errors.unprocessable('registration.signatureNotForeseen')
  }
  if (cur.rows[0]!.signed_at !== null) {
    throw Errors.conflict('registration.alreadySigned')
  }
  await client.query(
    `UPDATE registration SET signature_svg = $2, signed_at = now() WHERE id = $1`,
    [registrationId, unterschrift])
}
