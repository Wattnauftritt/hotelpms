import type { FastifyInstance } from 'fastify'
import { isSendableAddress } from '@hotelpms/domain'
import { istLand } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Kontaktdaten eines Gastes aus einem Umsystem (Migration 0083).
 *
 * Ein Umsystem des Hotels gleicht Buchungen aus seinen Quellen mit StayGrid
 * ab und kennt danach, wie der Gast zu erreichen ist. Von Hand angelegte
 * Buchungen kennen das nicht, und ohne Mailadresse geht kein Link zum
 * Online-Check-in hinaus.
 *
 * **Adressiert ueber die Reservierung, nicht ueber den Gast.** Das Umsystem
 * kennt aus der Reservierungsliste die `reservationRef`, nicht das Profil,
 * und es soll auch keines suchen muessen: ein Abgleich, der sich ein
 * Gastprofil aussucht, ist ein zweiter Abgleich.
 *
 * **Wer gewinnt.** Ein Abgleich irrt. Was die Rezeption eingetragen oder der
 * Gast selbst angegeben hat, bleibt deshalb stehen (`kept_existing`); das
 * Umsystem fuellt Leeres und ersetzt nur, was es selbst gesetzt hat. Seine
 * eigenen Werte kann es mit `null` zurueckziehen -- nach einer korrigierten
 * Zuordnung stuende sonst die Adresse eines Fremden im Formular.
 *
 * **Wann gar nichts mehr geht.** Ist der Meldeschein erfasst, hat der Gast
 * seine Daten selbst bestaetigt, und kein Abgleich aendert sie danach.
 *
 * **Ein Link an die falsche Adresse** (Migration 0084). Aendert oder zieht
 * das Umsystem eine Mailadresse zurueck, waehrend ein Check-in-Link per Mail
 * offen ist, ging dieser Link an die Adresse, die es gerade korrigiert. Er
 * wird zurueckgezogen, mit Grund, und der naechste Lauf des Workers laedt an
 * die neue Adresse ein. Stehen zu lassen hiesse: ein Fremder haelt einen
 * Link zu Buchungsdaten, und der Gast bekommt keinen.
 */

type Feld = 'email' | 'phone' | 'language' | 'address'
type Ergebnis = 'applied' | 'unchanged' | 'kept_existing' | 'withdrawn'
type Grund = 'set_otherwise' | 'registration_recorded'

interface Anschrift { line1: string; postalCode: string; city: string; country: string }

interface Herkunft {
  client: string
  system: string
  reference: string | null
  matchConfidence: number | null
  manual: boolean
  at: string
}

interface GastZeile {
  id: number; public_ref: string; status: string
  email: string | null; phone: string | null; language: string
  address_line1: string | null; postal_code: string | null
  city: string | null; country: string | null
  contact_origin: Partial<Record<Feld, Herkunft>>
}

/** Die Grundeinstellung der Spalte; sie gilt als "nicht gesetzt". */
const SPRACHE_VORGABE = 'de'

const PHONE_MAX = 50
const LINE1_MAX = 200
const POSTAL_MAX = 20
const CITY_MAX = 100
const SYSTEM_MAX = 40
const REFERENCE_MAX = 100

interface Vermerk {
  system: string
  invitationSentAt: string | null
  completedAt: string | null
  submittedVia: 'link' | 'reception' | null
}

interface Eingabe {
  email?: string | null
  phone?: string | null
  language?: string | null
  address?: Anschrift | null
  /** Nur Pflicht, wenn Kontaktfelder dabei sind. */
  source: { system: string; reference: string | null
            matchConfidence: number | null; manual: boolean } | null
  registration?: Vermerk | null
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
 * Ein leerer Text zaehlt wie ein weggelassenes Feld, nicht wie `null`.
 * Ein Umsystem, das ein leeres Telefonfeld aus seiner Quelle durchreicht,
 * meint "weiss ich nicht", nicht "zieh meinen Wert zurueck".
 */
function text(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

function pruefen(body: unknown): Eingabe {
  const b = (body ?? {}) as Record<string, unknown>
  const fehler: Record<string, Array<'field.required' | 'field.invalid' | 'field.email'
                                     | 'field.country' | 'field.maxLength'>> = {}
  const falsch = (feld: string, m: 'field.required' | 'field.invalid' | 'field.email'
                                  | 'field.country' | 'field.maxLength') => {
    (fehler[feld] ??= []).push(m)
  }
  const nichtText = (feld: string) => {
    if (b[feld] !== undefined && b[feld] !== null && typeof b[feld] !== 'string') {
      falsch(feld, 'field.invalid')
    }
  }
  nichtText('email'); nichtText('phone'); nichtText('language')

  const email = text(b.email)
  if (typeof email === 'string' && !isSendableAddress(email)) falsch('email', 'field.email')
  const phone = text(b.phone)
  if (typeof phone === 'string' && phone.length > PHONE_MAX) falsch('phone', 'field.maxLength')
  const sprache = text(b.language)
  const language = typeof sprache === 'string' ? sprache.toLowerCase() : sprache
  if (typeof language === 'string' && !/^[a-z]{2}$/.test(language)) {
    falsch('language', 'field.invalid')
  }

  let address: Anschrift | null | undefined
  if (b.address === null) {
    address = null
  } else if (b.address !== undefined) {
    if (typeof b.address !== 'object' || Array.isArray(b.address)) {
      falsch('address', 'field.invalid')
    } else {
      // Eine Anschrift gibt es nur ganz. Eine halbe -- Ort ohne Strasse --
      // ist im Formular schlechter als keine, weil sie richtig aussieht.
      const a = b.address as Record<string, unknown>
      const line1 = text(a.line1)
      const postalCode = text(a.postalCode)
      const city = text(a.city)
      const land = text(a.country)
      const country = typeof land === 'string' ? land.toUpperCase() : land
      if (typeof line1 !== 'string') falsch('address.line1', 'field.required')
      else if (line1.length > LINE1_MAX) falsch('address.line1', 'field.maxLength')
      if (typeof postalCode !== 'string') falsch('address.postalCode', 'field.required')
      else if (postalCode.length > POSTAL_MAX) falsch('address.postalCode', 'field.maxLength')
      if (typeof city !== 'string') falsch('address.city', 'field.required')
      else if (city.length > CITY_MAX) falsch('address.city', 'field.maxLength')
      if (typeof country !== 'string') falsch('address.country', 'field.required')
      else if (!istLand(country)) falsch('address.country', 'field.country')
      if (typeof line1 === 'string' && typeof postalCode === 'string'
          && typeof city === 'string' && typeof country === 'string') {
        address = { line1, postalCode, city, country }
      }
    }
  }

  let registration: Vermerk | null | undefined
  if (b.registration === null) {
    registration = null
  } else if (b.registration !== undefined) {
    const v = b.registration as Record<string, unknown>
    if (typeof v !== 'object' || Array.isArray(v)) {
      falsch('registration', 'field.invalid')
    } else {
      const system = text(v.system)
      if (typeof system !== 'string') falsch('registration.system', 'field.required')
      else if (system.length > SYSTEM_MAX) falsch('registration.system', 'field.maxLength')
      const invitationSentAt = zeitpunkt(v.invitationSentAt)
      if (invitationSentAt === undefined) falsch('registration.invitationSentAt', 'field.invalid')
      const completedAt = zeitpunkt(v.completedAt)
      if (completedAt === undefined) falsch('registration.completedAt', 'field.invalid')
      const via = v.submittedVia ?? null
      if (via !== null && via !== 'link' && via !== 'reception') {
        falsch('registration.submittedVia', 'field.invalid')
      }
      if (typeof system === 'string' && invitationSentAt !== undefined
          && completedAt !== undefined && (via === null || via === 'link' || via === 'reception')) {
        registration = { system, invitationSentAt, completedAt, submittedVia: via }
      }
    }
  }

  const eingabe = { email, phone, language, address }
  const mitKontakt = Object.values(eingabe).some(v => v !== undefined)

  const s = (b.source ?? null) as Record<string, unknown> | null
  let source: Eingabe['source'] | undefined = null
  if (s === null) {
    if (mitKontakt) falsch('source', 'field.required')
  } else if (typeof s !== 'object' || Array.isArray(s)) {
    falsch('source', 'field.invalid')
  } else {
    source = undefined
    const system = text(s.system)
    if (typeof system !== 'string') falsch('source.system', 'field.required')
    else if (system.length > SYSTEM_MAX) falsch('source.system', 'field.maxLength')
    const reference = s.reference === undefined || s.reference === null
      ? null : typeof s.reference === 'string' || typeof s.reference === 'number'
        ? String(s.reference).trim() || null : undefined
    if (reference === undefined) falsch('source.reference', 'field.invalid')
    else if (reference !== null && reference.length > REFERENCE_MAX) {
      falsch('source.reference', 'field.maxLength')
    }
    const conf = s.matchConfidence
    if (conf !== undefined && conf !== null
        && (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1)) {
      falsch('source.matchConfidence', 'field.invalid')
    }
    if (s.manual !== undefined && typeof s.manual !== 'boolean') {
      falsch('source.manual', 'field.invalid')
    }
    if (typeof system === 'string' && reference !== undefined) {
      source = { system, reference,
                 matchConfidence: typeof conf === 'number' ? conf : null,
                 manual: s.manual === true }
    }
  }

  if (!mitKontakt && b.registration === undefined && Object.keys(fehler).length === 0) {
    falsch('email', 'field.required')
  }
  if (Object.keys(fehler).length > 0 || source === undefined
      || (mitKontakt && source === null)) {
    throw Errors.validation(fehler)
  }
  return { ...eingabe, source, registration }
}

function anschriftVon(g: GastZeile): Anschrift | null {
  if (g.address_line1 === null && g.postal_code === null
      && g.city === null && g.country === null) return null
  return { line1: g.address_line1 ?? '', postalCode: g.postal_code ?? '',
           city: g.city ?? '', country: g.country ?? '' }
}

function gleich(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function guestContactRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/reservations/:reservationRef/guest-contact',
    permission: 'guest:contact_write',
    summary: 'Kontaktdaten des Hauptgastes aus einem Umsystem nachtragen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const eingabe = pruefen(req.body)
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number
                                       primary_guest_id: number | null }>(
          `SELECT id, property_id, primary_guest_id FROM reservation
            WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!
        // Das Recht im Haus der Reservierung: die Route nimmt keine
        // Property, und `registerRoute` prueft dann nur "irgendwo".
        if (!can(principal, 'guest:contact_write', Number(res.property_id))) {
          throw Errors.forbidden('access.missingPermission',
            { permission: 'guest:contact_write' })
        }
        const vermerk = await vermerkSchreiben(client, res, eingabe.registration)
        const kontakt = eingabe.source === null
          ? null : await kontaktSchreiben(client, res, eingabe, eingabe.source, principal)

        return {
          reservationRef,
          guestRef: kontakt?.guestRef ?? null,
          fields: { ...kontakt?.felder, ...(vermerk ? { registration: vermerk } : {}) }
        }
      })
    }
  })
}

/**
 * Ein Meldeschein, den ein Umsystem schon verschickt oder erfasst hat
 * (Migration 0085). Solange es den Vermerk gibt, laedt StayGrid nicht noch
 * einmal ein: zwei Formulare fuer einen Aufenthalt sind fuer den Gast ein
 * Fehler, und welches gilt, wuesste niemand.
 */
async function vermerkSchreiben(
  client: PoolClient, res: { id: number; property_id: number },
  v: Vermerk | null | undefined
): Promise<{ result: Ergebnis } | null> {
  if (v === undefined) return null
  if (v === null) {
    const d = await client.query(
      `DELETE FROM reservation_external_registration WHERE reservation_id = $1`, [res.id])
    return { result: (d.rowCount ?? 0) > 0 ? 'withdrawn' : 'unchanged' }
  }
  const alt = await client.query<{ gleich: boolean }>(
    `SELECT (system, invitation_sent_at, completed_at, submitted_via)
              IS NOT DISTINCT FROM ($2, $3::timestamptz, $4::timestamptz, $5) AS gleich
       FROM reservation_external_registration WHERE reservation_id = $1`,
    [res.id, v.system, v.invitationSentAt, v.completedAt, v.submittedVia])
  if (alt.rows[0]?.gleich === true) return { result: 'unchanged' }
  await client.query(
    `INSERT INTO reservation_external_registration
       (reservation_id, property_id, system, invitation_sent_at, completed_at, submitted_via)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (reservation_id) DO UPDATE
       SET system = EXCLUDED.system, invitation_sent_at = EXCLUDED.invitation_sent_at,
           completed_at = EXCLUDED.completed_at, submitted_via = EXCLUDED.submitted_via,
           updated_at = now()`,
    [res.id, res.property_id, v.system, v.invitationSentAt, v.completedAt, v.submittedVia])
  return { result: 'applied' }
}

async function kontaktSchreiben(
  client: PoolClient,
  res: { id: number; primary_guest_id: number | null },
  eingabe: Eingabe, quelle: NonNullable<Eingabe['source']>, principal: Principal
): Promise<{ guestRef: string
             felder: Partial<Record<Feld, { result: Ergebnis; reason?: Grund
                                             checkinLinkRevoked?: boolean }>> }> {
  if (res.primary_guest_id === null) throw Errors.conflict('reservation.noPrimaryGuest')

  const g = await client.query<GastZeile & { loeschantrag: boolean }>(
    `SELECT id, public_ref, status, erasure_requested_at IS NOT NULL AS loeschantrag,
            email, phone, language,
            address_line1, postal_code, city, country, contact_origin
       FROM guest WHERE id = $1 FOR UPDATE`, [res.primary_guest_id])
  const gast = g.rows[0]!
  if (gast.status === 'anonymized') throw Errors.conflict('guest.anonymizedNotRevived')
  // Nach einem Loeschantrag traegt niemand mehr Kontaktdaten nach --
  // ein Abgleich am wenigsten, der sie aus einer zweiten Quelle hat.
  if (gast.loeschantrag) throw Errors.conflict('guest.erasureRequested')

  const sperre = await client.query<{ erfasst: boolean; link: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM registration WHERE reservation_id = $1) AS erfasst,
            EXISTS (SELECT 1 FROM checkin_token
                     WHERE reservation_id = $1 AND channel = 'mail'
                       AND revoked_at IS NULL) AS link`, [res.id])
  const { erfasst, link } = sperre.rows[0]!

  const herkunft: Herkunft = {
    client: principal.clientKey, ...quelle, at: new Date().toISOString() }
  const origin = { ...gast.contact_origin }
  const neu: { email: string | null; phone: string | null; language: string
               address: Anschrift | null } = {
    email: gast.email, phone: gast.phone, language: gast.language,
    address: anschriftVon(gast) }
  const felder: Partial<Record<Feld, { result: Ergebnis; reason?: Grund
                                       checkinLinkRevoked?: boolean }>> = {}

  const entscheiden = <K extends Feld>(
    feld: K, gewuenscht: (typeof neu)[K] | null | undefined,
    leer: (typeof neu)[K] | null, sperrGrund: Grund | null
  ): void => {
    if (gewuenscht === undefined) return
    const aktuell = neu[feld]
    const eigen = origin[feld]?.client === principal.clientKey
    const istLeer = gleich(aktuell, leer) && origin[feld] === undefined
    if (gewuenscht === null) {
      if (!eigen) {
        felder[feld] = istLeer || gleich(aktuell, leer)
          ? { result: 'unchanged' } : { result: 'kept_existing', reason: 'set_otherwise' }
        return
      }
      if (sperrGrund) { felder[feld] = { result: 'kept_existing', reason: sperrGrund }; return }
      neu[feld] = leer as (typeof neu)[K]
      delete origin[feld]
      felder[feld] = { result: 'withdrawn' }
      return
    }
    if (gleich(aktuell, gewuenscht)) { felder[feld] = { result: 'unchanged' }; return }
    if (!eigen && !istLeer) {
      felder[feld] = { result: 'kept_existing', reason: 'set_otherwise' }
      return
    }
    if (sperrGrund) { felder[feld] = { result: 'kept_existing', reason: sperrGrund }; return }
    neu[feld] = gewuenscht as (typeof neu)[K]
    origin[feld] = herkunft
    felder[feld] = { result: 'applied' }
  }

  const gesperrt: Grund | null = erfasst ? 'registration_recorded' : null
  entscheiden('email', eingabe.email, null, gesperrt)
  entscheiden('phone', eingabe.phone, null, gesperrt)
  entscheiden('language', eingabe.language, SPRACHE_VORGABE, gesperrt)
  entscheiden('address', eingabe.address, null, gesperrt)

  const mail = felder.email
  if (link && mail && (mail.result === 'applied' || mail.result === 'withdrawn')) {
    await client.query(
      `UPDATE checkin_token SET revoked_at = now(), revoke_reason = 'contact_changed'
        WHERE reservation_id = $1 AND channel = 'mail' AND revoked_at IS NULL`,
      [res.id])
    mail.checkinLinkRevoked = true
  }

  const geaendert = Object.values(felder)
    .some(f => f.result === 'applied' || f.result === 'withdrawn')
  if (geaendert) {
    // Wert und Herkunft in einer Anweisung: der Trigger aus 0083
    // laesst den Eintrag nur stehen, wenn er sich mitaendert.
    await client.query(
      `UPDATE guest SET email = $2, phone = $3, language = $4,
              address_line1 = $5, postal_code = $6, city = $7, country = $8,
              contact_origin = $9::jsonb, updated_at = now()
        WHERE id = $1`,
      [gast.id, neu.email, neu.phone, neu.language,
       neu.address?.line1 ?? null, neu.address?.postalCode ?? null,
       neu.address?.city ?? null, neu.address?.country ?? null,
       JSON.stringify(origin)])
  }

  return { guestRef: gast.public_ref, felder }
}
