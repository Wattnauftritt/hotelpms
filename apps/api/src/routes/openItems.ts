import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { isSendableAddress, emailLanguage, renderReminderEmail,
         isIsoDate } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import { rechtImHaus } from './depositRequests.js'
import { invoiceRecipient } from './email.js'

/**
 * Offene Posten und Mahnung (Pruefung des Rechnungssystems vom 13.10.2026).
 *
 * Firmenrechnungen mit Zahlungsziel liessen sich nicht verfolgen: ob eine
 * Rechnung bezahlt ist, stand in der Rechnungsliste, aber nur fuer den
 * gewaehlten Zeitraum, und wann sie faellig war, nirgends gesammelt. Diese
 * Liste kennt keinen Zeitraum: offen ist offen, auch wenn die Rechnung aus
 * dem Fruehjahr stammt.
 *
 * Offen heisst: Zahlbetrag der Rechnung minus die ihr zugeordneten
 * Zahlungsvermerke, nur Schluss- und Zwischenrechnungen, keine stornierte.
 * Faellig ist sie am Zahlungsziel; ohne eines (Privatgast, beim Check-out
 * zu zahlen) am Ausstellungstag.
 */

/** Hoechstens so viele Zeilen; offene Posten sind eine Arbeitsliste. */
const MAX_POSTEN = 500
/** Laengste Frist, die eine Mahnung setzen darf. */
const FRIST_MAX_TAGE = 60
/** Vorgabe fuer die neue Frist. */
const FRIST_TAGE = 7

const OFFENE_POSTEN = `
  WITH heute AS (
    SELECT (now() AT TIME ZONE timezone)::date AS d FROM property WHERE id = $1
  ), bezahlt AS (
    SELECT invoice_id, sum(amount_cent) AS summe
      FROM settlement
     WHERE property_id = $1 AND invoice_id IS NOT NULL
     GROUP BY invoice_id
  ), posten AS (
    SELECT i.id, i.public_ref, i.number, i.kind, i.issued_on, f.public_ref AS folio_ref,
           COALESCE(i.recipient_snapshot->>'name', '') AS recipient,
           (i.totals->>'grossCent')::bigint AS gross,
           COALESCE((i.totals->>'payableCent')::bigint, (i.totals->>'grossCent')::bigint)
             - COALESCE(b.summe, 0) AS offen,
           -- Seit 0159 steht die Faelligkeit an der Rechnung; aeltere leiten
           -- sie aus dem Ziel der Firma ab, ohne eines ist sie sofort faellig.
           COALESCE(i.due_on, i.issued_on + c.payment_terms_days, i.issued_on) AS faellig
      FROM invoice i
      JOIN folio f ON f.id = i.folio_id
      LEFT JOIN company c ON c.id = f.company_id
      LEFT JOIN bezahlt b ON b.invoice_id = i.id
     WHERE i.property_id = $1 AND i.kind IN ('final', 'interim')
       AND NOT EXISTS (SELECT 1 FROM invoice s
                        WHERE s.reverses_id = i.id AND NOT s.partial_reversal)
  )
  SELECT p.id, p.public_ref AS "invoiceRef", p.number, p.kind,
         p.issued_on::text AS "issuedOn", p.faellig::text AS "dueOn",
         p.recipient, p.folio_ref AS "folioRef",
         p.gross AS "grossCent", p.offen AS "openCent",
         GREATEST(h.d - p.faellig, 0) AS "daysOverdue",
         m.level AS "reminderLevel", m.reminded_on::text AS "remindedOn",
         m.due_on::text AS "reminderDueOn", h.d::text AS heute
    FROM posten p
    CROSS JOIN heute h
    LEFT JOIN LATERAL (
      SELECT level, reminded_on, due_on FROM invoice_reminder r
       WHERE r.invoice_id = p.id ORDER BY level DESC LIMIT 1
    ) m ON true
   WHERE p.offen > 0`

interface Posten {
  id: number; invoiceRef: string; number: string; kind: string; issuedOn: string
  dueOn: string; recipient: string; folioRef: string; grossCent: number; openCent: number
  daysOverdue: number; reminderLevel: number | null; remindedOn: string | null
  reminderDueOn: string | null; heute: string
}

/** 2026-10-13 als 13.10.2026, fuer Mailtext; ohne Umweg ueber eine Zeitzone. */
function datumDe(iso: string): string {
  const [j, m, t] = iso.split('-')
  return `${t}.${m}.${j}`
}

export function openItemRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/open-items',
    permission: 'folio:read',
    propertyParam: 'propertyId',
    summary: 'Offene Posten: unbezahlte Rechnungen mit Faelligkeit und Mahnstufe',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Posten>(
          `${OFFENE_POSTEN} ORDER BY p.faellig, p.id LIMIT ${MAX_POSTEN + 1}`,
          [Number(propertyId)])
        const heute = rows[0]?.heute ?? (await client.query<{ d: string }>(
          `SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM property WHERE id = $1`,
          [Number(propertyId)])).rows[0]?.d ?? null
        const items = rows.slice(0, MAX_POSTEN).map(({ id: _id, heute: _h, ...p }) => ({
          ...p, grossCent: Number(p.grossCent), openCent: Number(p.openCent),
          daysOverdue: Number(p.daysOverdue)
        }))
        return {
          today: heute,
          truncated: rows.length > MAX_POSTEN,
          totalOpenCent: items.reduce((s, p) => s + p.openCent, 0),
          totalOverdueCent: items.filter(p => p.daysOverdue > 0)
            .reduce((s, p) => s + p.openCent, 0),
          items
        }
      })
    }
  })

  /**
   * Erinnern oder mahnen: die naechste Stufe mit neuer Frist, auf Wunsch
   * gleich per Mail mit der Rechnung im Anhang.
   *
   * Festgehalten wird die Mahnung auch ohne Mail: gemahnt wird auch am
   * Telefon, und die naechste Stufe soll wissen, dass es eine erste gab.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/invoices/:invoiceRef/reminders',
    permission: 'invoice:issue',
    summary: 'Zahlungserinnerung oder Mahnung zu einer offenen Rechnung',
    handler: async (req, reply) => {
      const { invoiceRef } = req.params as { invoiceRef: string }
      const body = (req.body ?? {}) as { dueOn?: unknown; send?: unknown; to?: unknown }
      if (body.dueOn !== undefined && (typeof body.dueOn !== 'string' || !isIsoDate(body.dueOn))) {
        throw Errors.validation({ dueOn: ['field.invalid'] })
      }
      if (body.send !== undefined && typeof body.send !== 'boolean') {
        throw Errors.validation({ send: ['field.invalid'] })
      }
      if (body.to !== undefined && (typeof body.to !== 'string' || !isSendableAddress(body.to))) {
        throw Errors.validation({ to: ['field.email'] })
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, { invoiceRef, ...body }, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const r = await client.query<{ id: number; property_id: number; folio_id: number }>(
          `SELECT id, property_id, folio_id FROM invoice WHERE public_ref = $1`, [invoiceRef])
        if (r.rowCount === 0) throw Errors.notFound('res.invoice')
        const { id, property_id: propertyId, folio_id: folioId } = r.rows[0]!
        rechtImHaus(principal, 'invoice:issue', propertyId)
        if (body.send === true) rechtImHaus(principal, 'email:send', propertyId)

        // Unter der Sperre des Folios: dort laufen auch Zahlungsvermerke, und
        // eine Mahnung ueber einen gerade bezahlten Betrag ist die
        // peinlichste Post, die ein Haus verschicken kann.
        await client.query(`SELECT 1 FROM folio WHERE id = $1 FOR UPDATE`, [folioId])
        const p = (await client.query<Posten>(`${OFFENE_POSTEN} AND p.id = $2`,
          [propertyId, id])).rows[0]
        if (p === undefined) throw Errors.conflict('reminder.notOpen')
        const stufe = (p.reminderLevel ?? 0) + 1
        if (stufe > 3) throw Errors.conflict('reminder.maxLevel')

        const frist = (body.dueOn as string | undefined) ?? (await client.query<{ d: string }>(
          `SELECT ($1::date + $2::int)::text AS d`, [p.heute, FRIST_TAGE])).rows[0]!.d
        const spaetestens = (await client.query<{ d: string }>(
          `SELECT ($1::date + $2::int)::text AS d`, [p.heute, FRIST_MAX_TAGE])).rows[0]!.d
        if (frist < p.heute || frist > spaetestens) {
          throw Errors.validation({ dueOn: ['field.invalid'] })
        }

        let messageRef: string | null = null
        if (body.send === true) {
          const e = await invoiceRecipient(client, id)
          if (e.anonymized) throw Errors.unprocessable('mail.guestAnonymized')
          const adresse = (body.to as string | undefined) ?? e.email
          if (!isSendableAddress(adresse)) throw Errors.unprocessable('mail.noInvoiceAddress')
          const haus = await client.query<{ name: string; currency: string }>(
            `SELECT p.name, i.currency FROM property p JOIN invoice i ON i.property_id = p.id
              WHERE i.id = $1`, [id])
          const text = renderReminderEmail({
            propertyName: haus.rows[0]!.name, guestName: e.name, invoiceNumber: p.number,
            issuedOn: datumDe(p.issuedOn), openCent: Number(p.openCent),
            currency: haus.rows[0]!.currency, dueDate: datumDe(frist), level: stufe
          }, emailLanguage(e.language))
          // Als Rechnungsmail: so geht die Rechnung noch einmal als Anhang mit.
          messageRef = (await client.query<{ ref: string }>(
            `SELECT email_enqueue($1,'invoice',$2,$3,$4,$5,$6,$7,NULL,$8) AS ref`,
            [propertyId, adresse, e.name, text.subject, text.text, text.html, id,
             principal.userId])).rows[0]!.ref
        }

        await client.query(
          `INSERT INTO invoice_reminder (property_id, invoice_id, level, reminded_on, due_on,
                                         open_cent, emailed, created_by)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8)`,
          [propertyId, id, stufe, p.heute, frist, p.openCent, messageRef !== null,
           principal.userId])

        const result = { invoiceRef, level: stufe, dueOn: frist, openCent: Number(p.openCent),
                         messageRef }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })
}
