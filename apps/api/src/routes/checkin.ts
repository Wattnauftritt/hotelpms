import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { createCheckinToken, renderCheckinInvitationEmail, emailLanguage,
         renderCheckinInvitationTestEmail, isSendableAddress, isIsoDate,
         requiresRegistrationSignature, type CheckinInvitationData,
         type EmailLanguage, type RenderedEmail } from '@hotelpms/domain'
import { checkinLink, istLand, istUnterschriftSvg,
         MAX_MITREISENDE, type CheckinFormView, type CheckinSubmitted,
         type CheckinSettings, type CheckinLink,
         type CheckinMailPreview } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { tooManyRequests } from '../platform/rateLimit.js'
import { checkinTx, type CheckinKontext } from '../platform/checkin.js'
import { erfasseMeldeschein, unterschreibeMeldeschein,
         type Befreiung } from '../platform/meldeschein.js'
import { geltendeBedingungen, stimmeBedingungZu,
         type GeltendeBedingung } from '../platform/hausbedingungen.js'
import { gastAendern, gastAnlegen } from '../platform/gast.js'
import type { Principal } from '../platform/context.js'

/**
 * Online-Check-in (Dokument 30).
 *
 * Zwei Seiten:
 *
 * **Die Gastseite** (`/v1/checkin/*`, oeffentlich). Sie kennt keinen
 * Benutzer, nur einen Link. Der Link reist in der Kopfzeile
 * `x-staygrid-checkin-token`, nie im Pfad: der Serialisierer des
 * Anfrageprotokolls ersetzt Werte der Abfragezeichenfolge, nicht den Pfad,
 * und ein Token als Pfadsegment stuende im Protokoll. Der Kontext kommt aus
 * dem Link (`checkinTx`), die Regeln des Meldescheins aus
 * `platform/meldeschein.ts` -- dieselben wie am Tresen.
 *
 * **Die Rezeption** (`/v1/reservations/:ref/online-checkin/*`). Link
 * kopieren, per Mail erneut senden, zurueckziehen; die Einstellung je Haus.
 *
 * **Ratenbegrenzung.** Die Gastseite ist anonym und faellt damit unter die
 * allgemeine Grenze je Herkunft (300 je Minute, `platform/rateLimit.ts`).
 * Ein Gast braucht drei bis fuenf Anfragen; auch eine Familie im
 * Hotel-WLAN hinter einer Adresse erreicht die Grenze nicht. Einen eigenen
 * Zaehler wie beim Arbeitsplatz-PIN braucht es nicht: dort war das Geheimnis
 * vier Ziffern lang, hier sind es 256 Bit -- Durchprobieren lohnt sich nie.
 */

const config = loadConfig()

/** Zustaende, in denen ein Meldeschein noch erfasst werden kann. */
const OFFEN = new Set(['Optional', 'Confirmed', 'InHouse'])

/*
 * Antworten der Gastseite nicht zwischenspeichern. Darin stehen Name und
 * Zeitraum eines Gastes, und am Terminal steht nach ihm der Naechste vor
 * demselben Browser.
 */
function nichtSpeichern(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store')
}

interface ReservierungZumLink {
  id: number; property_id: number; account_id: number
  arrival: string; departure: string; primary_guest_id: number
  property_name: string; first_name: string | null; last_name: string
  language: string
  reg_id: number | null; signature_required: boolean | null
  signed_at: string | null
}

/** Genau die Reservierung des Links. Mehr laedt die Gastseite nicht. */
async function reservierungZumLink(
  client: PoolClient, k: CheckinKontext
): Promise<ReservierungZumLink> {
  const { rows } = await client.query<ReservierungZumLink>(
    `SELECT r.id, r.property_id, p.account_id, r.arrival::text, r.departure::text,
            r.primary_guest_id, p.name AS property_name,
            g.first_name, g.last_name, g.language,
            reg.id AS reg_id, reg.signature_required, reg.signed_at::text
       FROM reservation r
       JOIN property p ON p.id = r.property_id
       JOIN guest g    ON g.id = r.primary_guest_id
       LEFT JOIN registration reg
              ON reg.reservation_id = r.id AND reg.group_registration_id IS NULL
      WHERE r.id = $1`, [k.reservationId])
  // Kann nur fehlen, wenn der Link zwischen Ausgabe und Einloesen seinen Gast
  // verloren hat; checkin_token_open hat das schon abgefangen.
  if (rows.length === 0) throw Errors.gone('checkin.reservationClosed')
  return rows[0]!
}

function zustand(r: ReservierungZumLink): CheckinFormView['state'] {
  if (r.reg_id === null) return 'open'
  return r.signature_required === true && r.signed_at === null ? 'signatureOnly' : 'done'
}

/**
 * Darf hier unterschrieben werden?
 *
 * § 29 Abs. 2 BMG: "am Tag der Ankunft handschriftlich". Am Terminal im Haus
 * und ab dem Anreisetag ja. Ueber den Mail-Link nie: drei Tage vorher ist
 * nicht der Tag der Ankunft, und eine Linie mit dem Finger auf dem eigenen
 * Telefon ist keines der Verfahren aus Absatz 5, die die Unterschrift
 * ersetzen duerfen. Gegen den Geschaeftstag, nicht gegen now().
 */
function unterschriftHier(k: CheckinKontext, arrival: string): boolean {
  return k.channel === 'terminal' && k.businessDate >= arrival
}

// ------------------------------------------------------------------ Eingabe

interface Person {
  lastName: string; firstName: string; birthDate: string; nationality: string
  /** Nur der Form nach geprueft; ob das Haus den Grund anbietet, im Handler. */
  taxExemption?: { reason: string; proof: string | null }
}
interface Einreichung {
  guest: Person & {
    address: { line1: string; postalCode: string; city: string; country: string }
    idDocumentType?: 'passport' | 'id_card' | 'other'
    idDocumentNumber?: string
  }
  companions: Person[]
  signatureSvg?: string
  termsAccepted: string[]
  termsSignatureSvg?: string
  digitalGuestCard: boolean
}

const GAST_FELDER = new Set(['lastName', 'firstName', 'birthDate', 'nationality',
                             'address', 'idDocumentType', 'idDocumentNumber',
                             'taxExemption'])
const PERSON_FELDER = new Set(['lastName', 'firstName', 'birthDate', 'nationality',
                               'taxExemption'])
const BEFREIUNG_FELDER = new Set(['reason', 'proof'])
const ANSCHRIFT_FELDER = new Set(['line1', 'postalCode', 'city', 'country'])
const WURZEL_FELDER = new Set(['guest', 'companions', 'signatureSvg', 'confirmed',
                               'termsAccepted', 'termsSignatureSvg', 'digitalGuestCard'])

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Die Eingabe pruefen, von Hand und vollstaendig.
 *
 * **Unbekannte Felder werden abgewiesen, nicht still entfernt.** Fastifys
 * Pruefung entfernt sie in der Grundeinstellung stillschweigend; wer eine
 * Ausweiskopie mitschickt, bekaeme dann 201 und glaubte, sie liege jetzt
 * vor. Es gibt kein Feld dafuer (§ 30 BMG erlaubt die Nummer, verbietet die
 * Kopie), und das soll die Antwort sagen.
 */
function pruefe(body: unknown, heute: string): Einreichung {
  const f: Record<string, Meldung[]> = {}
  const fehlt = (k: string, m: Meldung = 'field.required'): void => {
    (f[k] ??= []).push(m)
  }
  if (!istObjekt(body)) throw Errors.validation({ body: ['field.bodyMissing'] })
  for (const k of Object.keys(body)) if (!WURZEL_FELDER.has(k)) fehlt(k, 'field.unknown')
  if (body.confirmed !== true) fehlt('confirmed', 'field.mustConfirm')

  const text = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null

  const person = (v: unknown, pfad: string, felder: Set<string>): Person | null => {
    if (!istObjekt(v)) { fehlt(pfad); return null }
    for (const k of Object.keys(v)) if (!felder.has(k)) fehlt(`${pfad}.${k}`, 'field.unknown')
    const p = {
      lastName: text(v.lastName, 100), firstName: text(v.firstName, 100),
      birthDate: typeof v.birthDate === 'string' ? v.birthDate : null,
      nationality: typeof v.nationality === 'string' ? v.nationality.toUpperCase() : null
    }
    if (p.lastName === null) fehlt(`${pfad}.lastName`)
    if (p.firstName === null) fehlt(`${pfad}.firstName`)
    // Leer ist "fehlt", nicht "falsches Format": das Formular schickt ein
    // Datum, das es nicht lesen konnte, als leer, und der Gast am Terminal
    // bekam dafuer "Datum im Format YYYY-MM-DD erwartet" zu lesen.
    if (p.birthDate === null || p.birthDate === '') fehlt(`${pfad}.birthDate`)
    else if (!isIsoDate(p.birthDate)) fehlt(`${pfad}.birthDate`, 'field.isoDate')
    else if (p.birthDate > heute) fehlt(`${pfad}.birthDate`, 'checkin.birthDateFuture')
    if (!istLand(p.nationality)) fehlt(`${pfad}.nationality`, 'field.country')
    let befreiung: Person['taxExemption']
    const b = v.taxExemption
    if (b !== undefined && b !== null) {
      if (!istObjekt(b)) fehlt(`${pfad}.taxExemption`, 'field.invalid')
      else {
        for (const k of Object.keys(b)) {
          if (!BEFREIUNG_FELDER.has(k)) fehlt(`${pfad}.taxExemption.${k}`, 'field.unknown')
        }
        const grund = text(b.reason, 40)
        if (grund === null) fehlt(`${pfad}.taxExemption.reason`)
        if (b.proof !== undefined && b.proof !== null && typeof b.proof !== 'string') {
          fehlt(`${pfad}.taxExemption.proof`, 'field.invalid')
        } else if (typeof b.proof === 'string' && b.proof.length > 100) {
          fehlt(`${pfad}.taxExemption.proof`, 'field.invalid')
        }
        if (grund !== null) befreiung = { reason: grund, proof: text(b.proof, 100) }
      }
    }
    return p.lastName && p.firstName && p.birthDate && p.nationality
      ? { ...p, ...(befreiung ? { taxExemption: befreiung } : {}) } as Person : null
  }

  const g = person(body.guest, 'guest', GAST_FELDER)
  const roh = istObjekt(body.guest) ? body.guest : {}
  const a = roh.address
  let anschrift: Einreichung['guest']['address'] | null = null
  if (!istObjekt(a)) fehlt('guest.address')
  else {
    for (const k of Object.keys(a)) if (!ANSCHRIFT_FELDER.has(k)) fehlt(`guest.address.${k}`, 'field.unknown')
    const land = typeof a.country === 'string' ? a.country.toUpperCase() : null
    anschrift = { line1: text(a.line1, 200) ?? '', postalCode: text(a.postalCode, 20) ?? '',
                  city: text(a.city, 100) ?? '', country: land ?? '' }
    if (anschrift.line1 === '') fehlt('guest.address.line1')
    if (anschrift.postalCode === '') fehlt('guest.address.postalCode')
    if (anschrift.city === '') fehlt('guest.address.city')
    if (!istLand(land)) fehlt('guest.address.country', 'field.country')
  }

  /*
   * Die Ausweisnummer nur, wo das Gesetz sie verlangt: § 30 Abs. 2 BMG
   * nennt sie fuer auslaendische Personen. Fuer inlaendische wird sie
   * verworfen -- eine Nummer ohne Rechtsgrund ist eine Erhebung ohne
   * Rechtsgrund, auch wenn sie verschluesselt abgelegt wuerde.
   */
  let ausweisTyp: 'passport' | 'id_card' | 'other' | undefined
  let ausweisNr: string | undefined
  if (g !== null && requiresRegistrationSignature({ nationality: g.nationality })) {
    const nr = text(roh.idDocumentNumber, 40)
    if (nr === null) fehlt('guest.idDocumentNumber', 'checkin.idDocumentRequired')
    else ausweisNr = nr
    const typ = roh.idDocumentType ?? 'passport'
    if (typ !== 'passport' && typ !== 'id_card' && typ !== 'other') {
      fehlt('guest.idDocumentType', 'field.invalid')
    } else ausweisTyp = typ
  }

  const begleiter: Person[] = []
  if (body.companions !== undefined) {
    if (!Array.isArray(body.companions)) fehlt('companions', 'field.invalid')
    else if (body.companions.length > MAX_MITREISENDE) {
      fehlt('companions', 'checkin.tooManyCompanions')
    } else {
      body.companions.forEach((c, i) => {
        const p = person(c, `companions.${i}`, PERSON_FELDER)
        if (p !== null) begleiter.push(p)
      })
    }
  }

  let svg: string | undefined
  if (body.signatureSvg !== undefined) {
    if (typeof body.signatureSvg !== 'string') fehlt('signatureSvg', 'field.invalid')
    else svg = body.signatureSvg
  }

  const akzeptiert: string[] = []
  if (body.termsAccepted !== undefined) {
    if (!Array.isArray(body.termsAccepted) || body.termsAccepted.length > 20
        || !body.termsAccepted.every(r => typeof r === 'string' && r.length <= 64)) {
      fehlt('termsAccepted', 'field.invalid')
    } else akzeptiert.push(...body.termsAccepted as string[])
  }
  let termsSvg: string | undefined
  if (body.termsSignatureSvg !== undefined) {
    if (typeof body.termsSignatureSvg !== 'string') fehlt('termsSignatureSvg', 'field.invalid')
    else termsSvg = body.termsSignatureSvg
  }

  if (body.digitalGuestCard !== undefined && typeof body.digitalGuestCard !== 'boolean') {
    fehlt('digitalGuestCard', 'field.invalid')
  }

  if (Object.keys(f).length > 0) throw Errors.validation(f, { max: MAX_MITREISENDE })
  return {
    guest: { ...g!, address: anschrift!, idDocumentType: ausweisTyp,
             idDocumentNumber: ausweisNr },
    companions: begleiter,
    signatureSvg: svg,
    termsAccepted: akzeptiert,
    termsSignatureSvg: termsSvg,
    digitalGuestCard: body.digitalGuestCard === true
  }
}

interface GrundImHaus { id: number; code: string; label: string; needs_proof: boolean }

/** Die Gruende, die das Haus gerade anbietet. Ein Aufruf, nicht einer je Person. */
async function befreiungsgruende(client: PoolClient, propertyId: number): Promise<GrundImHaus[]> {
  const { rows } = await client.query<GrundImHaus>(
    `SELECT id, code, label, needs_proof FROM city_tax_exemption_reason
      WHERE property_id = $1 AND active ORDER BY sort, label`, [propertyId])
  return rows
}

/** Meldet das Haus an AVS (Migration 0090)? */
async function meldetAnAvs(client: PoolClient, propertyId: number): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM avs_setting WHERE property_id = $1`, [propertyId])
  return (r.rowCount ?? 0) > 0
}

/** Die interne Kennung einer Fassung; die Gastseite kennt nur die oeffentliche. */
async function termsId(client: PoolClient, termsRef: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM property_terms WHERE public_ref = $1`, [termsRef])
  return Number(rows[0]!.id)
}

/** Die Hausbedingungen, denen dieser Aufenthalt noch zustimmen muss. */
async function offeneBedingungen(
  client: PoolClient, r: ReservierungZumLink
): Promise<GeltendeBedingung[]> {
  const alle = await geltendeBedingungen(client,
    { id: r.id, propertyId: r.property_id, arrival: r.arrival })
  return alle.filter(b => !b.agreed)
}

/**
 * Befreiungen und Hausbedingungen gegen das Haus pruefen -- vor dem ersten
 * Schreiben, damit ein abgewiesenes Formular keinen halben Meldeschein
 * hinterlaesst.
 *
 * Eine Nummer zu einem Grund, der keine verlangt, wird verworfen, nicht
 * gespeichert: eine Erhebung ohne Anlass, wie bei der Ausweisnummer
 * inlaendischer Gaeste.
 */
function pruefeGegenHaus(
  e: Einreichung, gruende: GrundImHaus[], offen: GeltendeBedingung[]
): { befreiung: (p: Person) => Befreiung | null } {
  const f: Record<string, Meldung[]> = {}
  const nachCode = new Map(gruende.map(g => [g.code, g]))
  const personen: Array<[Person, string]> = [
    [e.guest, 'guest'], ...e.companions.map((c, i): [Person, string] => [c, `companions.${i}`])]
  for (const [p, pfad] of personen) {
    if (p.taxExemption && !nachCode.has(p.taxExemption.reason)) {
      (f[`${pfad}.taxExemption.reason`] ??= []).push('checkin.unknownExemption')
    }
  }
  const akzeptiert = new Set(e.termsAccepted)
  if (offen.some(b => !akzeptiert.has(b.termsRef))) f.termsAccepted = ['checkin.termsRequired']
  if (offen.some(b => b.requiresSignature)
      && (e.termsSignatureSvg === undefined || !istUnterschriftSvg(e.termsSignatureSvg))) {
    f.termsSignatureSvg = ['checkin.termsSignatureRequired']
  }
  if (Object.keys(f).length > 0) throw Errors.validation(f)
  return {
    befreiung: p => {
      if (!p.taxExemption) return null
      const g = nachCode.get(p.taxExemption.reason)!
      return { reasonId: Number(g.id), proof: g.needs_proof ? p.taxExemption.proof : null }
    }
  }
}

// ------------------------------------------------------------------ Rezeption

interface ReservierungAmTresen {
  id: number; property_id: number; status: string; arrival: string; departure: string
  primary_guest_id: number | null; guest_status: string | null
  email: string | null; language: string | null; name: string | null
  property_name: string; is_training: boolean
  reg_id: number | null
}

async function reservierungAmTresen(
  client: PoolClient, reservationRef: string
): Promise<ReservierungAmTresen> {
  const { rows } = await client.query<ReservierungAmTresen>(
    `SELECT r.id, r.property_id, r.status::text, r.arrival::text, r.departure::text,
            r.primary_guest_id, g.status AS guest_status, g.email, g.language,
            nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name,
            p.name AS property_name, p.is_training,
            reg.id AS reg_id
       FROM reservation r
       JOIN property p ON p.id = r.property_id
       LEFT JOIN guest g ON g.id = r.primary_guest_id
       LEFT JOIN registration reg
              ON reg.reservation_id = r.id AND reg.group_registration_id IS NULL
      WHERE r.public_ref = $1`, [reservationRef])
  if (rows.length === 0) throw Errors.notFound('res.reservation')
  const r = rows[0]!
  if (!OFFEN.has(r.status) || r.primary_guest_id === null || r.guest_status !== 'active') {
    throw Errors.unprocessable('checkin.reservationNotOpen')
  }
  // Ein Schein liegt vor: ein Link waere eine Einladung, ihn ein zweites
  // Mal auszufuellen. Steht nur die Unterschrift aus, geschieht das am
  // Anreisetag vor Ort, und dafuer gibt die Station ihren eigenen Link aus.
  if (r.reg_id !== null) {
    throw Errors.conflict('registration.alreadyExists')
  }
  return r
}

// ------------------------------------------------------------------- Routen

export function checkinRoutes(app: FastifyInstance): void {
  /**
   * Was die Gastseite zeigt. Oeffentlich, weil der Gast keinen Zugang hat
   * und keinen braucht: der Link ist der Zugang, und er reicht genau fuer
   * diese eine Reservierung.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/checkin/form',
    // Oeffentlich: der Link in der Kopfzeile ist der Ausweis (Dokument 30).
    permission: null,
    summary: 'Online-Check-in: was die Gastseite zeigt',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      return checkinTx(req, async (client, k): Promise<CheckinFormView> => {
        const r = await reservierungZumLink(client, k)
        return {
          propertyName: r.property_name,
          arrival: r.arrival,
          departure: r.departure,
          firstName: r.first_name,
          lastName: r.last_name,
          channel: k.channel,
          state: zustand(r),
          signatureAllowed: unterschriftHier(k, r.arrival),
          language: r.language,
          maxCompanions: MAX_MITREISENDE,
          terms: (await offeneBedingungen(client, r)).map(b => ({
            termsRef: b.termsRef, title: b.title, body: b.body,
            requiresSignature: b.requiresSignature })),
          digitalGuestCardOffered: await meldetAnAvs(client, r.property_id),
          exemptionReasons: (await befreiungsgruende(client, r.property_id)).map(g => ({
            code: g.code, label: g.label, needsProof: g.needs_proof }))
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/checkin/form',
    // Oeffentlich: der Link in der Kopfzeile ist der Ausweis (Dokument 30).
    permission: null,
    summary: 'Online-Check-in: Meldeschein einreichen',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      return checkinTx(req, async (client, k): Promise<CheckinSubmitted> => {
        const e = pruefe(req.body, k.businessDate)
        const r = await reservierungZumLink(client, k)
        if (r.reg_id !== null) throw Errors.conflict('checkin.alreadyDone')

        const hier = unterschriftHier(k, r.arrival)
        if (hier && e.signatureSvg !== undefined && !istUnterschriftSvg(e.signatureSvg)) {
          throw Errors.validation({ signatureSvg: ['checkin.signatureInvalid'] })
        }
        const offen = await offeneBedingungen(client, r)
        const haus = pruefeGegenHaus(e, await befreiungsgruende(client, r.property_id), offen)

        /*
         * Ins Profil des Gastes, auf demselben Weg wie die Rezeption. E-Mail
         * und Telefon bleiben unberuehrt: an die Adresse ging der Link, und
         * ueber eine Seite ohne Anmeldung soll sie niemand umbiegen koennen.
         */
        await gastAendern(client, r.primary_guest_id, {
          lastName: e.guest.lastName, firstName: e.guest.firstName,
          birthDate: e.guest.birthDate, nationality: e.guest.nationality,
          addressLine1: e.guest.address.line1, postalCode: e.guest.address.postalCode,
          city: e.guest.address.city, country: e.guest.address.country,
          idDocumentType: e.guest.idDocumentType,
          idDocumentNumber: e.guest.idDocumentNumber
        })

        // Mitreisende als eigene Profile: die Meldepflicht gilt je Person.
        const mitreisende: number[] = []
        const befreiungen = new Map<number, Befreiung>()
        const hauptBefreiung = haus.befreiung(e.guest)
        if (hauptBefreiung) befreiungen.set(Number(r.primary_guest_id), hauptBefreiung)
        for (const c of e.companions) {
          const neu = await gastAnlegen(client, r.account_id, {
            lastName: c.lastName, firstName: c.firstName,
            birthDate: c.birthDate, nationality: c.nationality,
            language: r.language })
          mitreisende.push(neu.id)
          const b = haus.befreiung(c)
          if (b) befreiungen.set(Number(neu.id), b)
        }

        const ergebnis = await erfasseMeldeschein(client, {
          propertyId: r.property_id, reservationId: r.id,
          arrival: r.arrival, departure: r.departure,
          primaryGuestId: r.primary_guest_id, mitreisende,
          unterschrift: hier
            ? { art: 'jetzt', svg: e.signatureSvg }
            : { art: 'amAnreisetag' },
          quelle: k.channel === 'terminal' ? 'terminal' : 'online',
          befreiungen,
          // Nur wo das Haus an AVS meldet; sonst ginge die Einwilligung ins Leere.
          digitalGuestCard: e.digitalGuestCard && await meldetAnAvs(client, r.property_id)
        })

        /*
         * Die Hausbedingungen ueber denselben Weg wie Tresen und Terminal
         * (`platform/hausbedingungen.ts`): je Fassung eine Zustimmung, die
         * Unterschrift nur, wo die Fassung sie verlangt. Ohne Benutzer --
         * zugestimmt hat der Gast selbst.
         */
        for (const b of offen) {
          await stimmeBedingungZu(client, {
            reservationId: r.id, propertyId: r.property_id,
            primaryGuestId: r.primary_guest_id, termsId: await termsId(client, b.termsRef),
            signatureSvg: e.termsSignatureSvg, createdBy: null })
        }

        await client.query(
          `UPDATE checkin_token SET completed_at = now() WHERE id = $1`, [k.tokenId])

        reply.status(201)
        return { state: ergebnis.signaturePending ? 'signatureOnly' : 'done' }
      })
    }
  })

  /**
   * Die Unterschrift nachreichen, am Terminal am Anreisetag -- fuer den Gast,
   * der vorab per Link ausgefuellt hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/checkin/signature',
    // Oeffentlich: der Link in der Kopfzeile ist der Ausweis (Dokument 30).
    permission: null,
    summary: 'Online-Check-in: Unterschrift am Anreisetag',
    handler: async (req, reply) => {
      nichtSpeichern(reply)
      const b = req.body as { signatureSvg?: unknown } | undefined
      return checkinTx(req, async (client, k): Promise<CheckinSubmitted> => {
        const r = await reservierungZumLink(client, k)
        if (!unterschriftHier(k, r.arrival)) {
          throw Errors.unprocessable('checkin.signatureOnArrival')
        }
        if (zustand(r) !== 'signatureOnly') throw Errors.conflict('checkin.nothingToSign')
        if (typeof b?.signatureSvg !== 'string' || !istUnterschriftSvg(b.signatureSvg)) {
          throw Errors.validation({ signatureSvg: ['checkin.signatureInvalid'] })
        }
        await unterschreibeMeldeschein(client, r.reg_id!, b.signatureSvg)
        await client.query(
          `UPDATE checkin_token SET completed_at = now() WHERE id = $1`, [k.tokenId])
        return { state: 'done' }
      })
    }
  })

  /**
   * Den Link fuer die Rezeption -- zum Kopieren, etwa wenn der Gast keine
   * Mailadresse hinterlassen hat oder ihn per Telefon will.
   *
   * Unter `reservation:checkin`: wer den Meldeschein am Tresen erfassen darf,
   * darf dem Gast auch den Weg geben, es selbst zu tun.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/online-checkin/link',
    permission: 'reservation:checkin',
    summary: 'Online-Check-in-Link erzeugen',
    handler: async (req, reply) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      nichtSpeichern(reply)
      return tx(req.pool, req, async (client): Promise<CheckinLink> => {
        const r = await reservierungAmTresen(client, reservationRef)
        const t = await createCheckinToken(client, {
          reservationId: r.id, channel: 'mail', createdBy: principal.userId })
        reply.status(201)
        return { link: checkinLink(config.publicAppUrl, t!.token), expiresOn: t!.expiresOn }
      })
    }
  })

  /**
   * Den Link per Mail an den Gast, auf Knopfdruck.
   *
   * **Nur an die Adresse am Gastprofil.** Anders als bei der Rechnung gibt
   * es hier keine abweichende Adresse: der Link oeffnet den Meldeschein
   * dieses Gastes, und eine Route, die ihn an eine frei waehlbare Adresse
   * schickt, waere ein Weg, ihn jemand anderem zu geben.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/online-checkin/send',
    permission: 'email:send',
    summary: 'Online-Check-in-Link per Mail senden',
    handler: async (req, reply) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await reservierungAmTresen(client, reservationRef)
        if (!isSendableAddress(r.email)) {
          throw Errors.unprocessable('mail.noReservationAddress')
        }
        if (r.is_training) throw Errors.unprocessable('training.noEmail')
        /*
         * Vorher fragen, was email_enqueue sonst mit einer Ausnahme
         * beantwortete: die Rezeption soll lesen, dass der Versand aus ist,
         * und nicht "interner Fehler".
         */
        const bereit = await client.query<{ ok: boolean }>(
          `SELECT COALESCE(bool_and(s.enabled AND email_sender_allowed(s.property_id, s.from_email)),
                           false) AS ok
             FROM property_email_setting s WHERE s.property_id = $1`, [r.property_id])
        if (bereit.rows[0]?.ok !== true) throw Errors.unprocessable('checkin.mailNotReady')

        const t = await createCheckinToken(client, {
          reservationId: r.id, channel: 'mail', createdBy: principal.userId })
        const text = renderCheckinInvitationEmail({
          propertyName: r.property_name, guestName: r.name,
          reservationRef, arrival: r.arrival, validUntil: t!.expiresOn,
          link: checkinLink(config.publicAppUrl, t!.token)
        }, emailLanguage(r.language))
        const q = await client.query<{ ref: string }>(
          `SELECT email_enqueue($1,'checkin_invitation',$2,$3,$4,$5,$6,NULL,$7,$8) AS ref`,
          [r.property_id, r.email, r.name, text.subject, text.text, text.html,
           r.id, principal.userId])
        reply.status(202)
        return { messageRef: q.rows[0]!.ref, reservationRef, status: 'pending' }
      })
    }
  })

  /** Alle gueltigen Links dieser Reservierung zurueckziehen. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/online-checkin/revoke',
    permission: 'reservation:checkin',
    summary: 'Online-Check-in-Links zurueckziehen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number }>(
          `SELECT id FROM reservation WHERE public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const u = await client.query(
          `UPDATE checkin_token SET revoked_at = now()
            WHERE reservation_id = $1 AND revoked_at IS NULL`, [r.rows[0]!.id])
        return { reservationRef, revoked: u.rowCount ?? 0 }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/online-checkin-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Online-Check-in: Einstellung des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async (client): Promise<CheckinSettings> => {
        const { rows } = await client.query<{ enabled: boolean; days_before: number }>(
          `SELECT enabled, days_before FROM property_checkin_setting WHERE property_id = $1`,
          [Number(propertyId)])
        // Kein 404: "noch nie eingestellt" ist der Ausgangszustand jedes Hauses.
        return { enabled: rows[0]?.enabled ?? false, daysBefore: rows[0]?.days_before ?? 3 }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/online-checkin-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Online-Check-in: Einstellung festlegen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as { enabled?: unknown; daysBefore?: unknown }
      const principal = req.principal as Principal
      if (typeof b.enabled !== 'boolean') throw Errors.validation({ enabled: ['field.required'] })
      const tage = b.daysBefore ?? 3
      if (typeof tage !== 'number' || !Number.isInteger(tage) || tage < 1 || tage > 14) {
        throw Errors.validation({ daysBefore: ['field.maxValue'] }, { max: 14 })
      }
      return tx(req.pool, req, async (client): Promise<CheckinSettings> => {
        await client.query(
          `INSERT INTO property_checkin_setting (property_id, enabled, days_before, updated_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (property_id) DO UPDATE
             SET enabled = EXCLUDED.enabled, days_before = EXCLUDED.days_before,
                 updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [Number(propertyId), b.enabled, tage, principal.userId])
        return { enabled: b.enabled as boolean, daysBefore: tage }
      })
    }
  })

  /**
   * Vorschau der Einladung, wie der Gast sie bekaeme, mit Beispieldaten.
   *
   * Unter `settings:property` wie die Einstellung daneben: wer entscheidet,
   * ob das Haus vorab schreibt, soll sehen, was es schreibt.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/online-checkin-settings/preview',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Online-Check-in: Vorschau der Einladung',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { language } = req.query as { language?: string }
      return tx(req.pool, req, async (client): Promise<CheckinMailPreview> => {
        const b = await beispielEinladung(client, Number(propertyId), language)
        return { language: b.lang, ...b.text, ready: b.ready }
      })
    }
  })

  /**
   * Die Einladung als Testmail an eine Adresse nach Wahl.
   *
   * **Beispieldaten, kein echter Link.** Die Adresse ist frei; deshalb traegt
   * die Mail weder einen Gast noch ein Token. Was sie prueft, ist der Weg:
   * Gastversand, Absenderdomain, Zustellung beim Anbieter, Darstellung im
   * Postfach. Den Meldeschein selbst prueft man mit einer Testbuchung und
   * dem Link, den die Rezeption dort kopiert.
   *
   * **Unabhaengig vom Vorabversand.** Der Schalter fuer den automatischen
   * Versand bleibt, wie er ist; die Testmail ist gerade dafuer da, ihn erst
   * einzuschalten, wenn sie gut aussieht.
   *
   * **Ein eigener Zaehler.** Die allgemeine Ratenbegrenzung erreicht eine
   * angemeldete Anfrage nicht (CLAUDE.md), und eine Route, die an beliebige
   * Adressen schreibt, ist ohne Grenze ein Werkzeug fuer Spam unter dem
   * Namen des Hauses. Gezaehlt wird im Postausgang selbst: der ist ohnehin
   * da und gilt ueber Neustarts und mehrere Prozesse hinweg.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/online-checkin-settings/test-mail',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Online-Check-in: Testmail an eine Adresse nach Wahl',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as { to?: unknown; language?: unknown }
      const principal = req.principal as Principal
      const to = typeof b.to === 'string' ? b.to.trim() : ''
      if (!isSendableAddress(to)) throw Errors.validation({ to: ['field.email'] })
      const sprache = typeof b.language === 'string' ? b.language : undefined
      return tx(req.pool, req, async client => {
        const id = Number(propertyId)
        const bisher = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbound_email
            WHERE property_id = $1 AND kind = 'checkin_invitation_test'
              AND created_at > now() - interval '1 hour'`, [id])
        if (bisher.rows[0]!.n >= TESTMAILS_JE_STUNDE) throw tooManyRequests(3600)

        const e = await beispielEinladung(client, id, sprache)
        if (e.ready.training) throw Errors.unprocessable('training.noEmail')
        if (!e.ready.mailEnabled) throw Errors.unprocessable('mail.sendingDisabled')
        if (!e.ready.senderAllowed) throw Errors.unprocessable('mail.senderNotActive')
        const text = renderCheckinInvitationTestEmail(e.daten, e.lang)
        const q = await client.query<{ ref: string }>(
          `SELECT email_enqueue($1,'checkin_invitation_test',$2,NULL,$3,$4,$5,NULL,NULL,$6) AS ref`,
          [id, to, text.subject, text.text, text.html, principal.userId])
        reply.status(202)
        return { messageRef: q.rows[0]!.ref, status: 'pending' }
      })
    }
  })
}

/** Genug, um die Darstellung in mehreren Postfaechern zu pruefen; zu wenig fuer Spam. */
const TESTMAILS_JE_STUNDE = 10

/**
 * Die Einladung mit Beispieldaten, wie sie heute hinausginge.
 *
 * Name des Hauses und Abstand zur Anreise sind echt, damit die Vorschau
 * zeigt, was der Gast liest; Gast, Buchungsnummer und Link sind erfunden.
 * Die Anreise liegt so weit nach dem Geschaeftstag, wie das Haus vorab
 * schreibt -- dasselbe Datum, das ein Gast heute bekaeme.
 */
async function beispielEinladung(
  client: PoolClient, propertyId: number, language: string | undefined
): Promise<{
  lang: EmailLanguage; daten: CheckinInvitationData
  text: RenderedEmail; ready: CheckinMailPreview['ready']
}> {
  const { rows } = await client.query<{
    name: string; is_training: boolean; anreise: string; bis: string
    mail_enabled: boolean; sender_allowed: boolean; auto_enabled: boolean
  }>(
    `WITH heute AS (
       SELECT COALESCE((SELECT b.date FROM business_day b
                         WHERE b.property_id = $1 AND b.status = 'open'
                         ORDER BY b.date DESC LIMIT 1), current_date) AS date
     )
     SELECT p.name, p.is_training,
            (heute.date + COALESCE(cs.days_before, 3))::text AS anreise,
            -- Gueltig bis zur Abreise; drei Naechte als Beispiel.
            (heute.date + COALESCE(cs.days_before, 3) + 3)::text AS bis,
            COALESCE(es.enabled, false) AS mail_enabled,
            COALESCE(email_sender_allowed(p.id, es.from_email), false) AS sender_allowed,
            COALESCE(cs.enabled, false) AS auto_enabled
       FROM property p
       CROSS JOIN heute
       LEFT JOIN property_checkin_setting cs ON cs.property_id = p.id
       LEFT JOIN property_email_setting es   ON es.property_id = p.id
      WHERE p.id = $1`, [propertyId])
  const h = rows[0]
  if (h === undefined) throw Errors.notFound('res.property')
  const lang = emailLanguage(language ?? 'de')
  const daten: CheckinInvitationData = {
    propertyName: h.name, guestName: 'Erika Mustermann',
    reservationRef: 'MUSTER1', arrival: h.anreise, validUntil: h.bis,
    // Ein Fragment, das kein Token sein kann (43 Zeichen base64url): die
    // Gastseite sagt "ungueltig", statt einen Meldeschein zu oeffnen.
    link: checkinLink(config.publicAppUrl, 'testmail')
  }
  return {
    lang, daten,
    text: renderCheckinInvitationEmail(daten, lang),
    ready: { training: h.is_training, mailEnabled: h.mail_enabled,
             senderAllowed: h.sender_allowed, autoEnabled: h.auto_enabled }
  }
}
