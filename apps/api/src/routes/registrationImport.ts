import type { FastifyInstance } from 'fastify'
import { isIsoDate } from '@hotelpms/domain'
import { istLand, istUnterschriftSvg, MAX_MITREISENDE,
         UNTERSCHRIFT_MAX_ZEICHEN } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import { AUFBEWAHRUNG_MONATE, erfasseMeldeschein } from '../platform/meldeschein.js'
import { gastAendern, gastAnlegen } from '../platform/gast.js'

/**
 * Einen fertigen Meldeschein aus einem Umsystem uebernehmen (Migration 0087).
 *
 * Bis zur Umstellung hat das Adminpanel die Meldescheine eingesammelt. Was
 * dort ausgefuellt und unterschrieben liegt, soll die Rezeption in StayGrid
 * sehen, ohne den Gast ein zweites Mal zu fragen.
 *
 * **Derselbe Weg wie der Online-Check-in.** Die Angaben gehen ins Profil des
 * Hauptgastes (`gastAendern`), Mitreisende bekommen eigene Profile, und den
 * Schein legt `erfasseMeldeschein` an -- die eine Stelle fuer die Regeln.
 * Eine zweite Fassung waere die, in der beim naechsten Befund die
 * Unterschrift eines deutschen Gastes doch gespeichert wird.
 *
 * **Was nicht angenommen wird.** Keine Ausweisnummer: das Adminpanel hat
 * keine erhoben, und eine aus einem zweiten System waere eine, deren
 * Herkunft niemand belegen kann. Kein PDF, keine IP-Adresse, keine
 * Browserkennung: StayGrid setzt den Schein selbst, und die anderen beiden
 * braucht es fuer nichts. Unbekannte Felder werden abgewiesen, nicht still
 * entfernt -- wer etwas mitschickt, soll wissen, dass es nicht ankommt.
 *
 * **Nie ueberschreiben.** Liegt fuer die Reservierung schon ein Schein vor,
 * hat der Gast hier selbst bestaetigt; die Antwort sagt `kept_existing`, und
 * ein Wiederholungslauf des Umsystems aendert nichts.
 */

const WURZEL = new Set(['source', 'completedAt', 'guest', 'companions', 'signature',
                        'avsReportedAt'])
const GAST = new Set(['lastName', 'firstName', 'birthDate', 'nationality', 'address'])
const PERSON = new Set(['lastName', 'firstName', 'birthDate', 'nationality'])
const ANSCHRIFT = new Set(['line1', 'postalCode', 'city', 'country'])
const QUELLE = new Set(['system', 'reference'])
const UNTERSCHRIFT = new Set(['png', 'signedAt'])

const SYSTEM_MAX = 40
const REFERENCE_MAX = 100
/** Die Seitenlaengen, die `istUnterschriftSvg` zulaesst. */
const KANTE_MAX = 9999

/**
 * `nationality` darf `null` sein: das Formular im Adminpanel nahm Freitext,
 * und "XX" oder "deutsch" ist keine Angabe, die StayGrid uebernehmen kann.
 * Dann bleibt im Profil, was dort steht. Den ganzen Schein abzuweisen hiesse,
 * dass der Gast an der Rezeption ein zweites Mal ausfuellt -- fuer ein Feld.
 */
interface Person { lastName: string; firstName: string; birthDate: string
                   nationality: string | null }

interface Eingabe {
  source: { system: string; reference: string | null }
  completedAt: string | null
  guest: Person & { address: { line1: string; postalCode: string; city: string
                               country: string | null } | null }
  companions: Person[]
  signature: { svg: string; signedAt: string | null } | null
  avsReportedAt: string | null
}

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Ein Zeitpunkt mit Zone. Ohne Zone waere er je nach Server ein anderer. */
function zeitpunkt(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    return undefined
  }
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * Das Bild der Unterschrift in die eine Form bringen, die StayGrid speichert:
 * ein SVG mit dem PNG als data-URL darin (`istUnterschriftSvg`). Das
 * Adminpanel hat ein PNG; die Groesse steht im Kopf des PNG selbst.
 *
 * Nur PNG. Ein SVG aus fremder Hand kann Skript tragen, und der Schein wird
 * spaeter einem Menschen gezeigt, wenn die Meldebehoerde Einsicht nimmt.
 */
export function unterschriftAusPng(dataUrl: string): string | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (m === null) return null
  const roh = Buffer.from(m[1]!, 'base64')
  // Signatur und IHDR: acht Bytes Kennung, dann Laenge, Typ, Breite, Hoehe.
  if (roh.length < 24 || roh.readUInt32BE(0) !== 0x89504e47
      || roh.toString('latin1', 12, 16) !== 'IHDR') return null
  const breite = roh.readUInt32BE(16)
  const hoehe = roh.readUInt32BE(20)
  if (breite < 1 || hoehe < 1 || breite > KANTE_MAX || hoehe > KANTE_MAX) return null
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${breite}" height="${hoehe}">`
    + `<image href="data:image/png;base64,${m[1]}" width="${breite}" height="${hoehe}"/></svg>`
  return istUnterschriftSvg(svg) ? svg : null
}

function pruefe(body: unknown): Eingabe {
  const f: Record<string, Meldung[]> = {}
  const fehlt = (k: string, m: Meldung = 'field.required'): void => {
    (f[k] ??= []).push(m)
  }
  const unbekannt = (o: Record<string, unknown>, erlaubt: Set<string>, pfad: string) => {
    for (const k of Object.keys(o)) if (!erlaubt.has(k)) fehlt(`${pfad}${k}`, 'field.unknown')
  }
  if (!istObjekt(body)) throw Errors.validation({ body: ['field.bodyMissing'] })
  unbekannt(body, WURZEL, '')

  const text = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() !== '' && v.trim().length <= max ? v.trim() : null

  const person = (v: unknown, pfad: string, felder: Set<string>): Person | null => {
    if (!istObjekt(v)) { fehlt(pfad); return null }
    unbekannt(v, felder, `${pfad}.`)
    const p = {
      lastName: text(v.lastName, 100), firstName: text(v.firstName, 100),
      birthDate: typeof v.birthDate === 'string' ? v.birthDate : null,
      nationality: typeof v.nationality === 'string' ? v.nationality.toUpperCase() : null
    }
    const ohneLand = v.nationality === null || v.nationality === undefined
    if (p.lastName === null) fehlt(`${pfad}.lastName`)
    if (p.firstName === null) fehlt(`${pfad}.firstName`)
    if (p.birthDate === null || !isIsoDate(p.birthDate)) fehlt(`${pfad}.birthDate`, 'field.isoDate')
    if (!ohneLand && !istLand(p.nationality)) fehlt(`${pfad}.nationality`, 'field.country')
    return p.lastName && p.firstName && p.birthDate ? p as Person : null
  }

  let source: Eingabe['source'] | null = null
  if (!istObjekt(body.source)) fehlt('source')
  else {
    unbekannt(body.source, QUELLE, 'source.')
    const system = text(body.source.system, SYSTEM_MAX)
    const r = body.source.reference
    const reference = r === undefined || r === null ? null
      : typeof r === 'string' || typeof r === 'number' ? text(String(r), REFERENCE_MAX) : null
    if (system === null) fehlt('source.system')
    if (r !== undefined && r !== null && reference === null) fehlt('source.reference', 'field.invalid')
    if (system !== null) source = { system, reference }
  }

  const completedAt = zeitpunkt(body.completedAt)
  if (completedAt === undefined) fehlt('completedAt', 'field.invalid')
  const avsReportedAt = zeitpunkt(body.avsReportedAt)
  if (avsReportedAt === undefined) fehlt('avsReportedAt', 'field.invalid')

  const g = person(body.guest, 'guest', GAST)
  let anschrift: Eingabe['guest']['address'] = null
  const a = istObjekt(body.guest) ? body.guest.address : undefined
  if (a !== undefined && a !== null) {
    if (!istObjekt(a)) fehlt('guest.address', 'field.invalid')
    else {
      unbekannt(a, ANSCHRIFT, 'guest.address.')
      // Eine Anschrift gibt es nur ganz; das Land darf fehlen, dann bleibt,
      // was StayGrid schon kennt (wie beim Kontakt, 0086).
      const line1 = text(a.line1, 200)
      const postalCode = text(a.postalCode, 20)
      const city = text(a.city, 100)
      const land = typeof a.country === 'string' && a.country.trim() !== ''
        ? a.country.trim().toUpperCase() : null
      if (line1 === null) fehlt('guest.address.line1')
      if (postalCode === null) fehlt('guest.address.postalCode')
      if (city === null) fehlt('guest.address.city')
      if (land !== null && !istLand(land)) fehlt('guest.address.country', 'field.country')
      if (line1 && postalCode && city) anschrift = { line1, postalCode, city, country: land }
    }
  }

  const begleiter: Person[] = []
  if (body.companions !== undefined && body.companions !== null) {
    if (!Array.isArray(body.companions)) fehlt('companions', 'field.invalid')
    else if (body.companions.length > MAX_MITREISENDE) {
      fehlt('companions', 'checkin.tooManyCompanions')
    } else {
      body.companions.forEach((c, i) => {
        const p = person(c, `companions.${i}`, PERSON)
        if (p !== null) begleiter.push(p)
      })
    }
  }

  let signature: Eingabe['signature'] = null
  if (body.signature !== undefined && body.signature !== null) {
    const s = body.signature
    if (!istObjekt(s)) fehlt('signature', 'field.invalid')
    else {
      unbekannt(s, UNTERSCHRIFT, 'signature.')
      const signedAt = zeitpunkt(s.signedAt)
      if (signedAt === undefined) fehlt('signature.signedAt', 'field.invalid')
      if (typeof s.png !== 'string') fehlt('signature.png')
      else if (s.png.length > UNTERSCHRIFT_MAX_ZEICHEN) {
        fehlt('signature.png', 'registration.signatureTooLarge')
      } else {
        const svg = unterschriftAusPng(s.png)
        if (svg === null) fehlt('signature.png', 'checkin.signatureInvalid')
        else if (signedAt !== undefined) signature = { svg, signedAt }
      }
    }
  }

  if (Object.keys(f).length > 0) throw Errors.validation(f, { max: MAX_MITREISENDE })
  return {
    source: source!, completedAt: completedAt!, avsReportedAt: avsReportedAt!,
    guest: { ...g!, address: anschrift }, companions: begleiter, signature
  }
}

export function registrationImportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/reservations/:reservationRef/registration',
    permission: 'registration:import',
    summary: 'Fertigen Meldeschein aus einem Umsystem uebernehmen',
    handler: async (req, reply) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const e = pruefe(req.body)
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        // FOR UPDATE: zwei Laeufe des Umsystems zugleich legten sonst zwei
        // Scheine an, beide nach der Pruefung auf "noch keiner da".
        const r = await client.query<{ id: number; property_id: number; account_id: number
                                       primary_guest_id: number | null; language: string
                                       arrival: string; departure: string
                                       abgelaufen: boolean }>(
          `SELECT r.id, r.property_id, p.account_id, r.primary_guest_id,
                  COALESCE(g.language, 'de') AS language,
                  r.arrival::text, r.departure::text,
                  -- Gegen den Geschaeftstag, nicht gegen now() (CLAUDE.md).
                  (r.departure + ($2 || ' months')::interval)::date
                    < COALESCE((SELECT max(b.date) FROM business_day b
                                 WHERE b.property_id = r.property_id
                                   AND b.status = 'open'), current_date) AS abgelaufen
             FROM reservation r
             JOIN property p ON p.id = r.property_id
             LEFT JOIN guest g ON g.id = r.primary_guest_id
            WHERE r.public_ref = $1
              FOR UPDATE OF r`, [reservationRef, AUFBEWAHRUNG_MONATE])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        // Das Recht im Haus der Reservierung: die Route nimmt keine
        // Property, und `registerRoute` prueft dann nur "irgendwo".
        if (!can(principal, 'registration:import', Number(res.property_id))) {
          throw Errors.forbidden('access.missingPermission',
            { permission: 'registration:import' })
        }
        /*
         * Ueber die Frist hinaus (§ 30 Abs. 4 BMG): ein Jahr nach Abreise ist
         * der Schein zu vernichten. Ihn jetzt anzulegen hiesse, eine Kopie
         * zu erzeugen, die der naechste Nachtlauf wieder loescht -- und bis
         * dahin eine ohne Rechtsgrund. Kein Fehler: das Umsystem soll ihn
         * nicht wieder schicken.
         */
        if (res.abgelaufen) {
          return { reservationRef, guestRef: null,
                   result: 'skipped', reason: 'retention_expired' }
        }
        if (res.primary_guest_id === null) throw Errors.conflict('reservation.noPrimaryGuest')

        const g = await client.query<{ public_ref: string; status: string; loeschantrag: boolean }>(
          `SELECT public_ref, status, erasure_requested_at IS NOT NULL AS loeschantrag
             FROM guest WHERE id = $1 FOR UPDATE`, [res.primary_guest_id])
        const gast = g.rows[0]!

        const vorhanden = await client.query(
          `SELECT 1 FROM registration WHERE reservation_id = $1 LIMIT 1`, [res.id])
        if ((vorhanden.rowCount ?? 0) > 0) {
          return { reservationRef, guestRef: gast.public_ref,
                   result: 'kept_existing', reason: 'registration_exists' }
        }

        if (gast.status === 'anonymized') throw Errors.conflict('guest.anonymizedNotRevived')
        if (gast.loeschantrag) throw Errors.conflict('guest.erasureRequested')

        await gastAendern(client, res.primary_guest_id, {
          lastName: e.guest.lastName, firstName: e.guest.firstName,
          birthDate: e.guest.birthDate, nationality: e.guest.nationality ?? undefined,
          ...(e.guest.address === null ? {} : {
            addressLine1: e.guest.address.line1, postalCode: e.guest.address.postalCode,
            city: e.guest.address.city, country: e.guest.address.country ?? undefined })
        })

        // Mitreisende als eigene Profile: die Meldepflicht gilt je Person.
        const mitreisende: number[] = []
        for (const c of e.companions) {
          const neu = await gastAnlegen(client, Number(res.account_id), {
            lastName: c.lastName, firstName: c.firstName,
            birthDate: c.birthDate, nationality: c.nationality ?? undefined,
            language: res.language })
          mitreisende.push(neu.id)
        }

        /*
         * Mit Unterschrift: sie gilt ab dem Zeitpunkt, an dem sie dort
         * geleistet wurde. Ohne: wie ein Schein, der vorab ueber den Link
         * kam -- braucht er eine, steht sie aus und wird am Anreisetag am
         * Tresen oder am Terminal nachgeholt.
         */
        const ergebnis = await erfasseMeldeschein(client, {
          propertyId: Number(res.property_id), reservationId: Number(res.id),
          arrival: res.arrival, departure: res.departure,
          primaryGuestId: Number(res.primary_guest_id), mitreisende,
          unterschrift: e.signature === null
            ? { art: 'amAnreisetag' }
            : { art: 'jetzt', svg: e.signature.svg, signedAt: e.signature.signedAt },
          quelle: 'import',
          herkunft: { system: e.source.system, reference: e.source.reference,
                      completedAt: e.completedAt, avsReportedAt: e.avsReportedAt }
        })

        reply.status(201)
        return { reservationRef, guestRef: gast.public_ref, result: 'imported',
                 signatureStored: ergebnis.signatureStored,
                 signaturePending: ergebnis.signaturePending }
      })
    }
  })
}
