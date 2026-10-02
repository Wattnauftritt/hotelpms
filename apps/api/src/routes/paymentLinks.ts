import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT, type PoolClient } from '@hotelpms/db'
import { EMAIL_LANGUAGES, emailLanguage, isSendableAddress, depositRequestOpenCent,
         renderPaymentLinkEmail, renderPayPage, paymentLinkValidUntil, paymentLinkValid,
         neuesToken, hashToken, type EmailLanguage, type PayPageKind,
         type PayPageData } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import type { Config } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { isTrainingProperty } from '../platform/training.js'
import { ProviderRefused, type StripeAdapter } from '../platform/payments/stripe.js'
import { rechtImHaus, anforderungSperren, postBereitschaft,
         geschaeftstag } from './depositRequests.js'

/**
 * Der dauerhafte Zahlungslink (Migration 0068).
 *
 * **Warum ein Link von uns und nicht der des Anbieters.** Ein Stripe-
 * Checkout gilt hoechstens 24 Stunden. Fuer eine Anzahlung mit zwei Wochen
 * Frist war die Adresse in der Mail damit am zweiten Tag tot -- und der Gast
 * merkte es beim Bezahlen. Der Gast bekommt deshalb `/v1/pay?t=<token>`:
 * gueltig bis zur Frist (`paymentLinkValidUntil`), jederzeit widerrufbar.
 * Erst beim Oeffnen entsteht ein Checkout, ueber den Betrag, der **dann**
 * noch offen ist -- hat der Gast zwischendurch einen Teil ueberwiesen,
 * zahlt er nur den Rest.
 *
 * **Das Token steht in der Abfragezeichenfolge, nicht im Pfad.** Der
 * Protokoll-Serialisierer in `platform/app.ts` ersetzt jeden Wert der
 * Abfragezeichenfolge; der Pfad stuende im Klartext im Protokoll. Caddy
 * schreibt kein Zugriffsprotokoll (siehe Caddyfile). In der Datenbank liegt
 * nur der Hash, und der steht auf der Redaktionsliste des Audits.
 *
 * **Doppelzahlung.** Je Link hoechstens ein offener Checkout -- ein
 * eindeutiger Index in der Datenbank und eine Zeilensperre hier, damit zwei
 * gleichzeitig geoeffnete Tabs denselben bekommen. Ein neuer entsteht erst,
 * wenn der Anbieter den alten fuer abgelaufen erklaert oder ihn auf unsere
 * Bitte beendet hat; meldet er ihn als abgeschlossen, bekommt der Gast die
 * Seite "wird verarbeitet" und keinen zweiten. Der Webhook nimmt dagegen
 * jede echte Zahlung an (`payments.ts`): Geld, das da ist, wird vermerkt.
 */

const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/

/** Ein alter Checkout, der in weniger als dieser Zeit ablaeuft, wird ersetzt. */
const MINDESTRESTZEIT_MS = 10 * 60_000

/** Die Sprache aus dem Browser, wenn kein Gast bekannt ist. */
function spracheAusKopf(kopf: string | undefined): EmailLanguage {
  for (const teil of (kopf ?? '').split(',')) {
    const kurz = teil.trim().slice(0, 2).toLowerCase()
    if ((EMAIL_LANGUAGES as readonly string[]).includes(kurz)) return kurz as EmailLanguage
  }
  return 'de'
}

function seite(
  reply: FastifyReply, status: number, kind: PayPageKind, daten: PayPageData,
  lang: EmailLanguage
): string {
  /*
   * Nicht zwischenspeichern: die Seite sagt, ob bezahlt ist, und ein Zurueck
   * im Browser zeigte sonst den Knopf eines laengst bezahlten Links.
   * Nicht indizieren: ein Link, der irgendwo veroeffentlicht wurde, soll
   * nicht in einer Suchmaschine landen. Kein Referrer: der Weg zum Anbieter
   * soll das Token nicht mitnehmen (Caddy setzt das ohnehin, die Entwicklung
   * ohne Caddy nicht).
   */
  void reply.status(status)
    .header('cache-control', 'no-store')
    .header('x-robots-tag', 'noindex, nofollow')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8')
  return renderPayPage(kind, daten, lang)
}

interface Lage {
  kind: PayPageKind
  lang: EmailLanguage
  daten: PayPageData
  /** Nur bei `open`: was jetzt zu zahlen ist, und wofuer. */
  offenCent?: number
  linkId?: number
  propertyId?: number
  folioId?: number
  folioRef?: string
  depositRequestId?: number | null
}

/**
 * Was hinter einem Token steht. Laeuft in **einer** Transaktion: der
 * Kontext wird erst gesetzt, wenn `payment_link_scope` das Haus genannt
 * hat, und bleibt bis zum Ende dieselbe Transaktion -- wie im Webhook.
 *
 * `sperren` haelt die Zeile des Links bis zum Ende der Transaktion fest. Der
 * Weg zum Anbieter braucht das, damit zwei gleichzeitige Aufrufe nicht
 * zwei Checkouts anlegen; die Seite allein braucht es nicht.
 */
async function lage(
  client: PoolClient, token: string | undefined, sprache: EmailLanguage, sperren: boolean
): Promise<Lage> {
  if (token === undefined || !TOKEN_FORM.test(token)) {
    return { kind: 'unknown', lang: sprache, daten: {} }
  }
  const scope = await client.query<{ link_id: number; property_id: number
                                     account_id: number }>(
    `SELECT link_id, property_id, account_id FROM payment_link_scope($1)`,
    [hashToken(token)])
  const s = scope.rows[0]
  if (s === undefined) return { kind: 'unknown', lang: sprache, daten: {} }

  // Ab hier unter der Zeilenrichtlinie, fuer genau dieses Haus.
  await client.query(
    `SELECT set_config('app.property_ids', $1, true),
            set_config('app.account_ids',  $2, true)`,
    [String(s.property_id), String(s.account_id)])

  const l = await client.query<{
    id: number; folio_id: number; folio_ref: string; deposit_request_id: number | null
    amount_cent: string; valid_until: string; revoked: boolean
    property_name: string; currency: string; is_training: boolean
    arrival: string | null; departure: string | null; language: string | null
    bezahlt: boolean }>(
    `SELECT l.id, l.folio_id, f.public_ref AS folio_ref, l.deposit_request_id,
            l.amount_cent, l.valid_until::text, l.revoked_at IS NOT NULL AS revoked,
            p.name AS property_name, p.currency, p.is_training,
            r.arrival::text, r.departure::text, g.language,
            EXISTS (SELECT 1 FROM payment_intent b
                     WHERE b.payment_link_id = l.id AND b.status = 'succeeded') AS bezahlt
       FROM payment_link l
       JOIN folio f    ON f.id = l.folio_id
       JOIN property p ON p.id = l.property_id
       LEFT JOIN reservation r ON r.id = f.reservation_id
       LEFT JOIN guest g       ON g.id = r.primary_guest_id
      WHERE l.id = $1
      ${sperren ? 'FOR UPDATE OF l' : ''}`, [s.link_id])
  const z = l.rows[0]
  if (z === undefined) return { kind: 'unknown', lang: sprache, daten: {} }

  const lang = emailLanguage(z.language)
  const daten: PayPageData = {
    propertyName: z.property_name, currency: z.currency,
    ...(z.arrival === null ? {} : { arrival: z.arrival }),
    ...(z.departure === null ? {} : { departure: z.departure }),
    deposit: z.deposit_request_id !== null, validUntil: z.valid_until
  }
  const grund = { lang, daten, linkId: z.id, propertyId: s.property_id,
                  folioId: z.folio_id, folioRef: z.folio_ref,
                  depositRequestId: z.deposit_request_id }

  if (z.revoked) return { ...grund, kind: 'revoked' }
  // Auch wenn das Haus erst nach dem Anlegen zum Uebungshaus wurde: beim
  // Anbieter entsteht von hier nie ein Checkout.
  if (z.is_training) return { ...grund, kind: 'training' }

  let offen = Number(z.amount_cent)
  if (z.deposit_request_id !== null) {
    const a = await client.query<{ amount_cent: string; due_date: string; canceled: boolean
                                   received: string }>(
      `SELECT d.amount_cent, d.due_date::text, d.canceled_at IS NOT NULL AS canceled,
              COALESCE((SELECT sum(s.amount_cent) FROM deposit_request_settlement x
                          JOIN settlement s ON s.id = x.settlement_id
                         WHERE x.deposit_request_id = d.id), 0)::bigint AS received
         FROM deposit_request d WHERE d.id = $1`, [z.deposit_request_id])
    const d = a.rows[0]
    if (d === undefined || d.canceled) return { ...grund, kind: 'revoked' }
    offen = depositRequestOpenCent(Number(d.amount_cent), Number(d.received))
    daten.dueDate = d.due_date
    if (offen <= 0) return { ...grund, kind: 'paid' }
  } else if (z.bezahlt) {
    return { ...grund, kind: 'paid' }
  }

  // Gegen den Geschaeftstag, wie jede Frist (CLAUDE.md).
  const heute = await geschaeftstag(client, s.property_id)
  if (!paymentLinkValid(z.valid_until, heute)) return { ...grund, kind: 'expired' }

  daten.amountCent = offen
  return { ...grund, kind: 'open', offenCent: offen }
}

export function paymentLinkRoutes(
  app: FastifyInstance, stripe: StripeAdapter | null, config: Config
): void {
  /**
   * Einen Zahlungslink anlegen, auf Wunsch zu einer Anzahlungsanforderung
   * und in derselben Anfrage per Gastpost an den Gast.
   *
   * **Beim Anlegen wird der Anbieter nicht gefragt.** Der Checkout entsteht
   * erst, wenn der Gast den Link oeffnet. Ohne eingerichteten Anbieter
   * wird trotzdem abgewiesen: ein Link, der beim Gast mit "nicht moeglich"
   * endet, ist schlimmer als keiner.
   *
   * **Die Adresse wird einmal ausgegeben**, wie bisher: in der Datenbank
   * liegt nur der Hash des Tokens. Auch der Idempotenzspeicher bekommt sie
   * nicht -- ein Wiederholungsversuch erfaehrt, dass der Link angelegt ist,
   * aber nicht seine Adresse. Wer sie verloren hat, widerruft und legt neu
   * an. Deshalb geht ein Link auch nur hier per Gastpost hinaus, nie
   * nachtraeglich: eine Route "diesen Link schicken" muesste die Adresse
   * vom Aufrufer bekommen, und dann bestimmte er den Inhalt der Post.
   *
   * **Je Anforderung hoechstens ein gueltiger Link.** Zwei gueltige Links
   * derselben Anforderung waeren zwei Wege, sie zu bezahlen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/payment-links',
    permission: 'folio:post',
    summary: 'Dauerhaften Zahlungslink anlegen, optional per Gastpost schicken',
    handler: async (req, reply) => {
      if (!stripe) throw Errors.notConfigured('payments.stripeKeyMissing')

      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as {
        amountCent: number
        depositRequestRef?: string
        sendEmail?: boolean
        to?: string
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      if (!Number.isInteger(body.amountCent) || body.amountCent <= 0) {
        throw Errors.validation({ amountCent: ['field.positiveCent'] })
      }
      if (body.to !== undefined && !isSendableAddress(body.to)) {
        throw Errors.validation({ to: ['field.email'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string
                                       reservation_id: number | null }>(
          `SELECT id, property_id, status, reservation_id FROM folio WHERE public_ref = $1`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        // Kein Link im Uebungshaus: er fuehrte zu einem echten Anbieter, und
        // ein Gast mit echter Adresse koennte echtes Geld zahlen.
        if (await isTrainingProperty(client, folio.property_id)) {
          throw Errors.unprocessable('training.noPaymentLink')
        }

        const businessDate = await geschaeftstag(client, folio.property_id)
        let anforderung: { id: number; dueDate: string } | null = null
        if (body.depositRequestRef !== undefined) {
          // Gesperrt: zwei gleichzeitige Anlagen sollen nicht beide sehen,
          // dass noch kein gueltiger Link da ist.
          const a = await anforderungSperren(client, body.depositRequestRef)
          if (a.folio_id !== folio.id) throw Errors.notFound('res.depositRequest')
          if (a.canceled) throw Errors.conflict('deposit.requestCanceled')
          const offen = depositRequestOpenCent(a.amount_cent, a.received_cent)
          if (offen <= 0) throw Errors.conflict('deposit.requestFulfilled')
          if (body.amountCent > offen) {
            throw Errors.unprocessable('deposit.linkExceedsOpen',
              { amount: body.amountCent, open: offen })
          }
          const aktiv = await client.query(
            `SELECT 1 FROM payment_link
              WHERE deposit_request_id = $1 AND revoked_at IS NULL
                AND valid_until >= $2::date LIMIT 1`, [a.id, businessDate])
          if ((aktiv.rowCount ?? 0) > 0) throw Errors.conflict('payments.linkActive')
          anforderung = { id: a.id, dueDate: a.due_date }
        }

        const r = folio.reservation_id === null ? null
          : (await client.query<{
              public_ref: string; arrival: string; departure: string
              property_name: string; currency: string; email: string | null
              name: string | null; language: string | null; anonymized: boolean }>(
              `SELECT r.public_ref, r.arrival::text, r.departure::text,
                      p.name AS property_name, p.currency, g.email, g.language,
                      nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name,
                      COALESCE(g.status = 'anonymized', false) AS anonymized
                 FROM reservation r
                 JOIN property p   ON p.id = r.property_id
                 LEFT JOIN guest g ON g.id = r.primary_guest_id
                WHERE r.id = $1`, [folio.reservation_id])).rows[0] ?? null

        /*
         * Alles, was die Post braucht, bevor etwas angelegt wird. Empfaenger
         * ist der Gast der Reservierung, wie bei der Buchungsbestaetigung:
         * die Loeschung eines Gastes findet seine Post ueber die
         * Reservierung (0046).
         */
        let empfaenger: string | null = null
        if (body.sendEmail === true) {
          rechtImHaus(principal, 'email:send', folio.property_id)
          if (r === null) throw Errors.unprocessable('deposit.needsReservation')
          const bereit = await postBereitschaft(client, folio.property_id, false)
          if (bereit.reason === 'disabled') throw Errors.unprocessable('mail.sendingDisabled')
          if (bereit.reason === 'sender') throw Errors.unprocessable('mail.senderNotActive')
          if (r.anonymized) throw Errors.unprocessable('mail.guestAnonymized')
          empfaenger = body.to ?? r.email
          if (!isSendableAddress(empfaenger)) {
            throw Errors.unprocessable('mail.noReservationAddress')
          }
        }

        const validUntil = paymentLinkValidUntil({
          businessDate,
          dueDate: anforderung?.dueDate ?? null,
          departure: anforderung === null ? null : r?.departure ?? null
        })

        const { token, hash } = neuesToken()
        const ins = await client.query<{ id: number }>(
          `INSERT INTO payment_link (property_id, folio_id, token_hash, deposit_request_id,
                                     amount_cent, valid_until, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7) RETURNING id`,
          [folio.property_id, folio.id, hash, anforderung?.id ?? null, body.amountCent,
           validUntil, principal.userId])
        const linkId = ins.rows[0]!.id
        const url = `${config.publicAppUrl}/v1/pay?t=${token}`

        let messageRef: string | null = null
        if (empfaenger !== null && r !== null) {
          const text = renderPaymentLinkEmail({
            propertyName: r.property_name,
            guestName: r.name,
            reservationRef: r.public_ref,
            arrival: r.arrival,
            departure: r.departure,
            amountCent: body.amountCent,
            currency: r.currency,
            dueDate: anforderung?.dueDate ?? null,
            deposit: anforderung !== null,
            validUntil,
            url
          }, emailLanguage(r.language))
          const q = await client.query<{ ref: string }>(
            `SELECT email_enqueue($1,'payment_link',$2,$3,$4,$5,$6,NULL,$7,$8) AS ref`,
            [folio.property_id, empfaenger, r.name, text.subject, text.text, text.html,
             folio.reservation_id, principal.userId])
          messageRef = q.rows[0]!.ref
          await client.query(
            `UPDATE payment_link
                SET email_id = (SELECT id FROM outbound_email WHERE public_ref = $2)
              WHERE id = $1`, [linkId, messageRef])
        }

        const result = { url, linkId, validUntil, messageRef }
        // Ohne Adresse in den Idempotenzspeicher: dort laege das Token
        // sonst im Klartext neben seinem Hash.
        await completeIdempotent(client, principal.clientKey, key, 201,
          { ...result, url: null })
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Einen Link widerrufen -- und einen offenen Checkout dazu beim Anbieter
   * beenden. Ein Link, den nur unsere Datenbank fuer ungueltig haelt, waere
   * ueber einen schon geoeffneten Checkout noch bezahlbar.
   *
   * Lehnt der Anbieter ab oder meldet er den Checkout als abgeschlossen,
   * aendert sich hier nichts: dann ist meist gerade bezahlt worden, und die
   * Zahlung kommt ueber den Webhook herein.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/payment-links/:linkId/cancel',
    permission: 'folio:post',
    summary: 'Zahlungslink widerrufen, offenen Checkout beim Anbieter beenden',
    handler: async (req) => {
      const { linkId } = req.params as { linkId: string }
      const principal = req.principal as Principal
      const id = Number(linkId)
      if (!Number.isInteger(id) || id <= 0) throw Errors.notFound('res.paymentLink')

      return tx(req.pool, req, async client => {
        const l = await client.query<{ id: number; property_id: number; revoked: boolean }>(
          `SELECT id, property_id, revoked_at IS NOT NULL AS revoked
             FROM payment_link WHERE id = $1 FOR UPDATE`, [id])
        if (l.rowCount === 0) throw Errors.notFound('res.paymentLink')
        const link = l.rows[0]!
        rechtImHaus(principal, 'folio:post', link.property_id)
        if (link.revoked) throw Errors.conflict('payments.linkNotOpen')

        const offen = await client.query<{ id: number; provider_reference: string }>(
          `SELECT id, provider_reference FROM payment_intent
            WHERE payment_link_id = $1 AND property_id = $2 AND status = 'pending'`,
          [link.id, link.property_id])
        for (const c of offen.rows) {
          if (!stripe) throw Errors.notConfigured('payments.stripeKeyMissing')
          await checkoutSchliessen(client, stripe, c, req, 'conflict')
        }

        await client.query(
          `UPDATE payment_link SET revoked_at = now(), revoked_by = $2, token_hash = NULL
            WHERE id = $1`, [link.id, principal.userId])
        // Wartet die Mail mit diesem Link noch auf den Versand, geht sie
        // nicht mehr hinaus: sie truege einen Link, der ins Leere fuehrt.
        // Zurueckgezogen wird sie, nicht geloescht; der Trigger aus 0068
        // nimmt das Token dabei aus dem Rumpf.
        await client.query(
          `UPDATE outbound_email SET status = 'canceled'
            WHERE id = (SELECT email_id FROM payment_link WHERE id = $1)
              AND status = 'pending'`, [link.id])
        return { linkId: link.id, status: 'canceled' }
      })
    }
  })

  // ------------------------------------------------------------ fuer den Gast

  /**
   * Die Seite hinter dem Link.
   *
   * **Oeffentlich**, weil der Gast kein Konto hat und keines braucht: das
   * Token ist der Ausweis, mit 256 Bit Zufall und widerrufbar. Die anonyme
   * Ratenbegrenzung gilt (`platform/rateLimit.ts`). Diese Seite legt beim
   * Anbieter nichts an -- Mailprogramme rufen Links vorab auf, und jeder
   * Scan waere sonst ein Checkout. Das tut erst der Knopf.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/pay',
    permission: null,
    summary: 'Zahlungsseite fuer den Gast (oeffentlich, Token in der Abfrage)',
    handler: async (req, reply) => {
      const { t } = (req.query ?? {}) as { t?: string }
      const sprache = spracheAusKopf(req.headers['accept-language'])
      try {
        const x = await withTransaction(req.pool, SYSTEM_CONTEXT,
          client => lage(client, t, sprache, false))
        const daten = x.kind === 'open'
          ? { ...x.daten, checkoutHref: `/v1/pay/checkout?t=${t}` } : x.daten
        return seite(reply, x.kind === 'unknown' ? 404 : 200, x.kind, daten, x.lang)
      } catch (err) {
        req.log.error({ err }, 'Zahlungsseite nicht aufgebaut')
        return seite(reply, 503, 'unavailable', {}, sprache)
      }
    }
  })

  /**
   * Der Knopf: einen Checkout beim Anbieter oeffnen oder den offenen
   * wiederverwenden, und dorthin weiterleiten.
   *
   * GET und kein Formular: die Inhaltsrichtlinie (`form-action 'self'`)
   * verbietet einem Formular die Weiterleitung zum Anbieter. Ein Link nicht.
   * Oeffentlich aus demselben Grund wie die Seite.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/pay/checkout',
    permission: null,
    summary: 'Checkout beim Anbieter oeffnen und weiterleiten (oeffentlich)',
    handler: async (req, reply) => {
      const { t } = (req.query ?? {}) as { t?: string }
      const sprache = spracheAusKopf(req.headers['accept-language'])
      try {
        const ziel = await withTransaction(req.pool, SYSTEM_CONTEXT, async client => {
          const x = await lage(client, t, sprache, true)
          if (x.kind !== 'open') return x
          if (!stripe) return { ...x, kind: 'unavailable' as const }
          return await checkoutOeffnen(client, stripe, x, config, req)
        })
        if ('url' in ziel) {
          void reply.status(303).header('location', ziel.url)
            .header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
          return ''
        }
        return seite(reply, ziel.kind === 'unknown' ? 404 : 200, ziel.kind, ziel.daten, ziel.lang)
      } catch (err) {
        req.log.error({ err }, 'Checkout nicht geoeffnet')
        return seite(reply, 503, 'unavailable', {}, sprache)
      }
    }
  })

  /**
   * Wohin der Anbieter zurueckschickt. Ohne Token: der Anbieter soll den
   * Ausweis des Gastes nicht kennen, und fuer "danke" oder "abgebrochen"
   * braucht es ihn nicht. Oeffentlich wie die beiden anderen.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/pay/done',
    permission: null,
    summary: 'Rueckkehr vom Anbieter (oeffentlich, ohne Token)',
    handler: async (req, reply) => {
      const q = (req.query ?? {}) as { lang?: string; ergebnis?: string }
      const lang = q.lang !== undefined
        && (EMAIL_LANGUAGES as readonly string[]).includes(q.lang)
        ? q.lang as EmailLanguage : spracheAusKopf(req.headers['accept-language'])
      return seite(reply, 200, q.ergebnis === 'abgebrochen' ? 'abandoned' : 'returned',
        {}, lang)
    }
  })
}

/**
 * Einen offenen Checkout beim Anbieter schliessen, bevor etwas anderes
 * geschieht. Der Anbieter ist die einzige Stelle, die verlaesslich weiss,
 * ob er noch bezahlt werden kann.
 *
 * `bei_abschluss`: was geschehen soll, wenn der Anbieter ihn als
 * abgeschlossen meldet -- beim Widerruf eine Antwort an die Rezeption, beim
 * Oeffnen durch den Gast die Seite "wird verarbeitet".
 */
async function checkoutSchliessen(
  client: PoolClient, stripe: StripeAdapter,
  c: { id: number; provider_reference: string }, req: FastifyRequest,
  beiAbschluss: 'conflict' | 'melden'
): Promise<'geschlossen' | 'abgeschlossen'> {
  let stand
  try {
    stand = await stripe.getCheckoutSession(c.provider_reference)
  } catch (err) {
    req.log.warn({ err }, 'Checkout beim Anbieter nicht abgefragt')
    throw Errors.upstreamFailed('payments.providerUnavailable')
  }
  if (stand.status === 'complete') {
    if (beiAbschluss === 'conflict') throw Errors.conflict('payments.linkNotCancelable')
    return 'abgeschlossen'
  }
  if (stand.status === 'open') {
    try {
      await stripe.expireCheckoutSession(c.provider_reference)
    } catch (err) {
      if (err instanceof ProviderRefused) {
        if (beiAbschluss === 'conflict') throw Errors.conflict('payments.linkNotCancelable')
        return 'abgeschlossen'
      }
      req.log.warn({ err }, 'Checkout beim Anbieter nicht beendet')
      throw Errors.upstreamFailed('payments.providerUnavailable')
    }
    await client.query(
      `UPDATE payment_intent SET status = 'canceled', canceled_at = now()
        WHERE id = $1 AND status = 'pending'`, [c.id])
    return 'geschlossen'
  }
  // Beim Anbieter abgelaufen: dieselbe Markierung, die seine Ablaufmeldung
  // setzen wuerde. Kommt sie spaeter noch, aendert sie nichts mehr.
  await client.query(
    `UPDATE payment_intent SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
    [c.id])
  return 'geschlossen'
}

async function checkoutOeffnen(
  client: PoolClient, stripe: StripeAdapter, x: Lage, config: Config, req: FastifyRequest
): Promise<{ url: string } | Lage> {
  const offenCent = x.offenCent!
  const vorhanden = await client.query<{ id: number; provider_reference: string
                                         amount_cent: string }>(
    `SELECT id, provider_reference, amount_cent FROM payment_intent
      WHERE payment_link_id = $1 AND property_id = $2 AND status = 'pending'`,
    [x.linkId, x.propertyId])

  for (const c of vorhanden.rows) {
    let stand
    try {
      stand = await stripe.getCheckoutSession(c.provider_reference)
    } catch (err) {
      req.log.warn({ err }, 'Checkout beim Anbieter nicht abgefragt')
      return { ...x, kind: 'unavailable' }
    }
    /*
     * Wiederverwenden, wenn derselbe Betrag offen ist und noch Zeit bleibt.
     * Zwei Tabs, ein Doppelklick, ein Gast, der morgen weitermacht -- sie
     * landen alle im selben Checkout.
     */
    if (stand.status === 'open' && stand.url !== null
        && Number(c.amount_cent) === offenCent
        && (stand.expiresAt === undefined
            || stand.expiresAt.getTime() - Date.now() > MINDESTRESTZEIT_MS)) {
      return { url: stand.url }
    }
    if (stand.status === 'complete') return { ...x, kind: 'processing' }
    // Anderer Betrag oder bald abgelaufen: erst beim Anbieter schliessen,
    // dann einen neuen. Meldet er ihn dabei als abgeschlossen, keinen neuen.
    try {
      const r = await checkoutSchliessen(client, stripe, c, req, 'melden')
      if (r === 'abgeschlossen') return { ...x, kind: 'processing' }
    } catch {
      return { ...x, kind: 'unavailable' }
    }
  }

  let session
  try {
    session = await stripe.createCheckoutSession({
      amountCent: offenCent,
      reference: x.folioRef!,
      // Ohne Token: der Anbieter soll den Ausweis des Gastes nicht kennen.
      successUrl: `${config.publicAppUrl}/v1/pay/done?lang=${x.lang}`,
      cancelUrl: `${config.publicAppUrl}/v1/pay/done?lang=${x.lang}&ergebnis=abgebrochen`
    })
  } catch (err) {
    req.log.warn({ err }, 'Checkout beim Anbieter nicht angelegt')
    return { ...x, kind: 'unavailable' }
  }

  // Der eindeutige Index (ein offener Checkout je Link) haelt fest, was die
  // Sperre auf der Linkzeile schon sicherstellt.
  await client.query(
    `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                 amount_cent, deposit_request_id, expires_at, payment_link_id)
     VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7)`,
    [x.propertyId, x.folioId, session.providerReference, offenCent,
     x.depositRequestId ?? null, session.expiresAt ?? null, x.linkId])
  return { url: session.url }
}
