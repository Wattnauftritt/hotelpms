import type { PoolClient } from '@hotelpms/db'
import { createCheckinToken } from '@hotelpms/domain'
import { istUnterschriftSvg } from '@hotelpms/contracts'
import { Errors } from './errors.js'
import { unterschreibeMeldeschein } from './meldeschein.js'
import { geltendeBedingungen, stimmeBedingungZu } from './hausbedingungen.js'

/**
 * Die Arten von Auftraegen an das Gaesteterminal (Dokument 31).
 *
 * **Eine Art ist ein Eintrag hier**, ein Wert in der Pruefbedingung von
 * `terminal_job.kind` (Migration 0067) und eine Ansicht am Terminal
 * (`ANSICHTEN` in `apps/web/src/routes/Terminal.tsx`). Abfrage, Oeffnen,
 * Abbrechen, Ablauf und Aufraeumen sind fuer alle Arten dieselben und
 * stehen in `routes/terminal.ts`.
 *
 * **Allgemein, aber kein Scheunentor.** Das Terminal zeigt, was das Haus
 * vorher angelegt hat -- eine Seite (`content`), eine freigegebene Adresse
 * (`url`), einen Meldeschein, eine Hausbedingung --, nie etwas, das erst im
 * Auftrag steht. Ein Rezeptionsrechner, der beliebige Adressen oder
 * beliebiges HTML auf einen Gastbildschirm schicken kann, waere ein
 * Werkzeug fuer Phishing.
 *
 * **Gastdaten nur, wo die Art sie braucht.** Die Frage des Terminals traegt
 * keine; was eine Ansicht braucht, kommt mit dem Oeffnen (`nutzlast`), und
 * nur das. Seiten und Adressen tragen gar keine.
 */

export const TERMINAL_KINDS = ['registration_fill', 'registration_sign', 'terms_sign',
                               'content', 'url'] as const
export type TerminalKind = (typeof TERMINAL_KINDS)[number]

export function istArt(v: unknown): v is TerminalKind {
  return typeof v === 'string' && (TERMINAL_KINDS as readonly string[]).includes(v)
}

/** Was eine Reservierung fuer die Arten hergibt, in einer Abfrage. */
export interface Lage {
  reservationId: number
  propertyId: number
  arrival: string
  primaryGuestId: number | null
  registrationId: number | null
  signatureRequired: boolean
  signed: boolean
}

export interface Auftrag {
  id: number
  propertyId: number
  kind: TerminalKind
  state: string
  reservationId: number | null
  registrationId: number | null
  termsId: number | null
  contentId: number | null
  urlId: number | null
  checkinTokenId: number | null
  createdBy: number | null
}

/** Der Bezug eines neuen Auftrags, wie er in `terminal_job` steht. */
export interface Bezug {
  registrationId: number | null
  termsId: number | null
  contentId: number | null
  urlId: number | null
}

const KEIN_BEZUG: Bezug = { registrationId: null, termsId: null, contentId: null, urlId: null }

/** Was der Auftraggeber mitgeschickt hat: die Kennung des Gemeinten. */
export interface Wunsch {
  termsRef?: unknown
  contentRef?: unknown
  urlRef?: unknown
}

/** Ein Angebot an der Reservierung: eine Art, und wo noetig, was genau. */
export interface Angebot {
  kind: TerminalKind
  ref?: string
  label?: string
}

export interface ArtDefinition {
  /** Ohne Reservierung sinnlos? Dann weist die Schnittstelle ihn ohne ab. */
  mitReservierung: boolean
  /** Prueft beim Anlegen und liefert den Bezug. Wirft, wenn es nicht passt. */
  vorbereiten: (client: PoolClient, propertyId: number, lage: Lage | null, w: Wunsch)
    => Promise<Bezug>
  /** Was das Terminal zeigen muss -- und nichts darueber hinaus. */
  nutzlast: (client: PoolClient, a: Auftrag) => Promise<Record<string, unknown>>
  /**
   * Was der Gast abschliesst. `canceled` heisst: der Gast ging, ohne dass
   * etwas entstanden ist -- die Rezeption soll das unterscheiden koennen.
   */
  abschliessen: (client: PoolClient, a: Auftrag, body: Record<string, unknown>)
    => Promise<'done' | 'canceled'>
}

function referenz(v: unknown, feld: string): string {
  if (typeof v !== 'string' || v === '') throw Errors.validation({ [feld]: ['field.required'] })
  return v
}

/**
 * Vor dem Terminal steht kein Mitarbeiter: angenommen wird genau die Form,
 * die das Zeichenfeld erzeugt, wie auf der Gastseite (Dokument 30).
 */
function unterschriftVomTerminal(v: unknown): string {
  if (typeof v !== 'string' || !istUnterschriftSvg(v)) {
    throw Errors.validation({ signatureSvg: ['checkin.signatureInvalid'] })
  }
  return v
}

export const ARTEN: Record<TerminalKind, ArtDefinition> = {
  /**
   * Meldeformular ausfuellen -- ueber den Online-Check-in (Dokument 30).
   *
   * Das Formular ist dasselbe wie hinter dem Link aus der Buchungsmail, im
   * Modus des Terminals (`<GastCheckin modus="terminal">`). Der Link dazu
   * entsteht **beim Oeffnen**, mit dem Kanal `terminal` und gueltig bis zum
   * Ende des Geschaeftstags, und geht nur in der Antwort an das gekoppelte
   * Geraet. In der Datenbank steht wie immer nur sein Hash
   * (`checkin_token_issue`); der Auftrag haelt seine Kennung, damit er mit
   * dem Auftrag zurueckgezogen wird, wie immer dieser endet.
   *
   * Angeboten wird die Art, solange kein Meldeschein vorliegt. Liegt einer
   * vor und fehlt nur die Unterschrift, ist `registration_sign` der Weg.
   */
  registration_fill: {
    mitReservierung: true,
    vorbereiten: async (_client, _haus, lage) => {
      if (lage === null) throw Errors.validation({ reservationRef: ['field.required'] })
      if (lage.primaryGuestId === null) throw Errors.unprocessable('registration.noPrimaryGuest')
      if (lage.registrationId !== null) throw Errors.conflict('registration.alreadyExists')
      return KEIN_BEZUG
    },
    nutzlast: async (client, a) => {
      if (a.reservationId === null) throw Errors.notFound('res.reservation')
      // Ein zweites Oeffnen (das Terminal wurde neu geladen) bekommt einen
      // neuen Link; der alte faellt.
      await zieheLinksZurueck(client, [a.id])
      const tag = await client.query<{ tag: string }>(
        `SELECT COALESCE((SELECT max(b.date) FROM business_day b
                           WHERE b.property_id = $1 AND b.status = 'open'),
                         current_date)::text AS tag`, [a.propertyId])
      const t = await createCheckinToken(client, {
        reservationId: a.reservationId, channel: 'terminal',
        expiresOn: tag.rows[0]!.tag, createdBy: a.createdBy })
      if (t === null) throw Errors.conflict('terminal.jobNotOpen')
      await client.query(
        `UPDATE terminal_job SET checkin_token_id = $2 WHERE id = $1`, [a.id, t.tokenId])
      return { token: t.token }
    },
    abschliessen: async (client, a) => {
      // Eingereicht ist, was die Gastseite als eingereicht vermerkt hat --
      // nicht, was das Terminal behauptet.
      if (a.checkinTokenId === null) return 'canceled'
      const t = await client.query<{ fertig: boolean }>(
        `SELECT completed_at IS NOT NULL AS fertig FROM checkin_token WHERE id = $1`,
        [a.checkinTokenId])
      return t.rows[0]?.fertig === true ? 'done' : 'canceled'
    }
  },

  /**
   * Meldeschein unterschreiben, fuer einen bereits angelegten Schein.
   *
   * Seit dem 1.1.2025 unterschreiben nur auslaendische Personen, nach
   * Staatsangehoerigkeit (`requiresRegistrationSignature`). Was der Schein
   * verlangt, steht in `registration.signature_required`; fuer einen Schein
   * ohne auslaendische Person wird die Art weder angeboten noch angenommen
   * -- mit derselben Meldung wie am Tresen, denn es ist dieselbe Regel
   * (`unterschreibeMeldeschein`).
   */
  registration_sign: {
    mitReservierung: true,
    vorbereiten: async (_client, _haus, lage) => {
      if (lage === null) throw Errors.validation({ reservationRef: ['field.required'] })
      if (lage.registrationId === null) throw Errors.unprocessable('terminal.noRegistration')
      if (!lage.signatureRequired) throw Errors.unprocessable('registration.signatureNotForeseen')
      if (lage.signed) throw Errors.conflict('registration.alreadySigned')
      return { ...KEIN_BEZUG, registrationId: lage.registrationId }
    },
    nutzlast: async (client, a) => {
      if (a.registrationId === null) throw Errors.notFound('res.registration')
      /*
       * Datenminimierung: was auf dem Meldeschein steht und was der Gast
       * mit seiner Unterschrift bestaetigt -- nicht Mailadresse, Telefon,
       * Preis oder Buchungsnummer. Die Ausweisnummer ebenfalls nicht.
       */
      const { rows, rowCount } = await client.query<{
        arrival: string; planned_departure: string; occupant_count: number
        last_name: string; first_name: string | null; birth_date: string | null
        nationality: string | null; address_line1: string | null
        postal_code: string | null; city: string | null; country: string | null }>(
        `SELECT reg.arrival::text, reg.planned_departure::text, reg.occupant_count,
                g.last_name, g.first_name, g.birth_date::text, g.nationality,
                g.address_line1, g.postal_code, g.city, g.country
           FROM registration reg
           JOIN guest g ON g.id = reg.guest_id
          WHERE reg.id = $1 AND reg.property_id = $2`,
        [a.registrationId, a.propertyId])
      if (rowCount === 0) throw Errors.notFound('res.registration')
      // Mitreisende eines Sammelmeldescheins mit Namen: wer unterschreibt,
      // unterschreibt fuer sie mit (E6, Dokument 13).
      const mit = await client.query<{ last_name: string; first_name: string | null }>(
        `SELECT g.last_name, g.first_name
           FROM registration reg JOIN guest g ON g.id = reg.guest_id
          WHERE reg.group_registration_id = $1 AND reg.property_id = $2
          ORDER BY reg.id`, [a.registrationId, a.propertyId])
      const r = rows[0]!
      return {
        arrival: r.arrival,
        plannedDeparture: r.planned_departure,
        occupantCount: r.occupant_count,
        guest: {
          lastName: r.last_name, firstName: r.first_name, birthDate: r.birth_date,
          nationality: r.nationality,
          address: { line1: r.address_line1, postalCode: r.postal_code,
                     city: r.city, country: r.country }
        },
        companions: mit.rows.map(m => ({ lastName: m.last_name, firstName: m.first_name }))
      }
    },
    abschliessen: async (client, a, body) => {
      if (a.registrationId === null) throw Errors.notFound('res.registration')
      // Derselbe Weg wie am Tresen, mit dem Haus des Auftrags als einzigem
      // erlaubten.
      await unterschreibeMeldeschein(client, a.registrationId,
        unterschriftVomTerminal(body.signatureSvg), haus => haus === a.propertyId)
      return 'done'
    }
  },

  /**
   * Einer Hausbedingung zustimmen oder sie unterschreiben -- ueber
   * denselben Weg wie am Tresen (`stimmeBedingungZu`). Angeboten wird je
   * geltende Fassung, der dieser Aufenthalt noch nicht zugestimmt hat. Eine
   * Hausbedingung ist privatrechtlich und gilt fuer jeden Gast, auch den
   * inlaendischen (routes/terms.ts).
   */
  terms_sign: {
    mitReservierung: true,
    vorbereiten: async (client, _haus, lage, w) => {
      if (lage === null) throw Errors.validation({ reservationRef: ['field.required'] })
      const ref = referenz(w.termsRef, 'termsRef')
      const offen = await geltendeBedingungen(client,
        { id: lage.reservationId, propertyId: lage.propertyId, arrival: lage.arrival })
      const b = offen.find(x => x.termsRef === ref)
      if (b === undefined) throw Errors.notFound('res.terms')
      if (b.agreed) throw Errors.conflict('terms.alreadyAgreed')
      const t = await client.query<{ id: string }>(
        `SELECT id FROM property_terms WHERE public_ref = $1 AND property_id = $2`,
        [ref, lage.propertyId])
      return { ...KEIN_BEZUG, termsId: Number(t.rows[0]!.id) }
    },
    nutzlast: async (client, a) => {
      const t = await client.query<{ title: string; body: string; requires_signature: boolean }>(
        `SELECT title, body, requires_signature FROM property_terms
          WHERE id = $1 AND property_id = $2`, [a.termsId, a.propertyId])
      if (t.rowCount === 0) throw Errors.notFound('res.terms')
      const z = t.rows[0]!
      return { title: z.title, body: z.body, requiresSignature: z.requires_signature }
    },
    abschliessen: async (client, a, body) => {
      if (a.reservationId === null || a.termsId === null) throw Errors.notFound('res.terms')
      const r = await client.query<{ primary_guest_id: string | null }>(
        `SELECT primary_guest_id FROM reservation WHERE id = $1 AND property_id = $2`,
        [a.reservationId, a.propertyId])
      if (r.rowCount === 0) throw Errors.notFound('res.reservation')
      const svg = body.signatureSvg === undefined || body.signatureSvg === null
        ? null : unterschriftVomTerminal(body.signatureSvg)
      await stimmeBedingungZu(client, {
        reservationId: a.reservationId, propertyId: a.propertyId,
        primaryGuestId: r.rows[0]!.primary_guest_id === null
          ? null : Number(r.rows[0]!.primary_guest_id),
        termsId: a.termsId, signatureSvg: svg,
        // Kein Benutzer: im Protokoll steht das Geraet (Migration 0064).
        createdBy: null })
      return 'done'
    }
  },

  /** Eine Seite des Hauses: Information, Hausordnung, WLAN, Werbung. */
  content: {
    mitReservierung: false,
    vorbereiten: async (client, haus, _lage, w) => {
      const ref = referenz(w.contentRef, 'contentRef')
      const c = await client.query<{ id: string }>(
        `SELECT id FROM terminal_content
          WHERE public_ref = $1 AND property_id = $2 AND archived_at IS NULL`, [ref, haus])
      if (c.rowCount === 0) throw Errors.notFound('res.terminalContent')
      return { ...KEIN_BEZUG, contentId: Number(c.rows[0]!.id) }
    },
    nutzlast: async (client, a) => inhaltsseite(client, a.contentId, a.propertyId),
    abschliessen: async () => 'done'
  },

  /**
   * Eine freigegebene externe Seite. Die Adresse kommt aus der Liste des
   * Hauses (`terminal_url`), nie aus dem Auftrag.
   */
  url: {
    mitReservierung: false,
    vorbereiten: async (client, haus, _lage, w) => {
      const ref = referenz(w.urlRef, 'urlRef')
      const u = await client.query<{ id: string }>(
        `SELECT id FROM terminal_url
          WHERE public_ref = $1 AND property_id = $2 AND removed_at IS NULL`, [ref, haus])
      if (u.rowCount === 0) throw Errors.notFound('res.terminalUrl')
      return { ...KEIN_BEZUG, urlId: Number(u.rows[0]!.id) }
    },
    nutzlast: async (client, a) => {
      const u = await client.query<{ label: string; url: string }>(
        `SELECT label, url FROM terminal_url
          WHERE id = $1 AND property_id = $2 AND removed_at IS NULL`, [a.urlId, a.propertyId])
      if (u.rowCount === 0) throw Errors.notFound('res.terminalUrl')
      return { label: u.rows[0]!.label, url: u.rows[0]!.url }
    },
    abschliessen: async () => 'done'
  }
}

/** Eine Seite, wie das Terminal sie zeigt -- im Auftrag und in der Diashow. */
export async function inhaltsseite(
  client: PoolClient, contentId: number | null, propertyId: number
): Promise<{ title: string; body: string; imageRef: string | null }> {
  const c = await client.query<{ title: string; body: string; image_ref: string | null }>(
    `SELECT c.title, c.body, i.public_ref AS image_ref
       FROM terminal_content c
       LEFT JOIN terminal_content_image i ON i.content_id = c.id
      WHERE c.id = $1 AND c.property_id = $2`, [contentId, propertyId])
  if (c.rowCount === 0) throw Errors.notFound('res.terminalContent')
  const z = c.rows[0]!
  return { title: z.title, body: z.body, imageRef: z.image_ref }
}

/**
 * Was die Reservierung anbietet. Eine Abfrage fuer die Hausbedingungen,
 * eine fuer Seiten und Adressen -- nicht eine je Art.
 */
export async function angebote(client: PoolClient, lage: Lage): Promise<Angebot[]> {
  const liste: Angebot[] = []
  if (lage.registrationId === null && lage.primaryGuestId !== null) {
    liste.push({ kind: 'registration_fill' })
  }
  if (lage.registrationId !== null && lage.signatureRequired && !lage.signed) {
    liste.push({ kind: 'registration_sign' })
  }
  const bedingungen = await geltendeBedingungen(client,
    { id: lage.reservationId, propertyId: lage.propertyId, arrival: lage.arrival })
  for (const b of bedingungen) {
    if (!b.agreed) liste.push({ kind: 'terms_sign', ref: b.termsRef, label: b.title })
  }
  liste.push(...await inhalteDesHauses(client, lage.propertyId))
  return liste
}

/** Seiten und freigegebene Adressen eines Hauses, als Angebote. */
export async function inhalteDesHauses(client: PoolClient, propertyId: number): Promise<Angebot[]> {
  const { rows } = await client.query<{ kind: 'content' | 'url'; ref: string; label: string }>(
    `SELECT 'content' AS kind, public_ref AS ref, title AS label, 0 AS o
       FROM terminal_content WHERE property_id = $1 AND archived_at IS NULL
     UNION ALL
     SELECT 'url', public_ref, label, 1
       FROM terminal_url WHERE property_id = $1 AND removed_at IS NULL
     ORDER BY o, label`, [propertyId])
  return rows.map(r => ({ kind: r.kind, ref: r.ref, label: r.label }))
}

/**
 * Den Online-Check-in-Link eines Auftrags zurueckziehen, wie immer der
 * Auftrag endet. Ein Link, der nach dem Auftrag noch gilt, oeffnete den
 * Meldeschein dieses Gastes fuer den naechsten, der an das Terminal tritt.
 */
export async function zieheLinksZurueck(client: PoolClient, jobIds: number[]): Promise<void> {
  if (jobIds.length === 0) return
  await client.query(
    `UPDATE checkin_token SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND id IN (SELECT checkin_token_id FROM terminal_job
                    WHERE id = ANY($1::bigint[]) AND checkin_token_id IS NOT NULL)`,
    [jobIds])
}

/**
 * Die Bezeichnung eines Auftrags fuer die Rezeption: Titel der Bedingung,
 * der Seite oder der Adresse. Als Verbund, nicht als Unterabfrage je Zeile;
 * `j` ist der Auftrag.
 */
export const AUFTRAG_LABEL_JOINS = `
  LEFT JOIN property_terms pt ON pt.id = j.terms_id
  LEFT JOIN terminal_content tc ON tc.id = j.content_id
  LEFT JOIN terminal_url tu ON tu.id = j.url_id`
export const AUFTRAG_LABEL_SQL = `COALESCE(pt.title, tc.title, tu.label)`
