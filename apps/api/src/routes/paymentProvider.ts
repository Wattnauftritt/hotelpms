import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { verlangeBestaetigung, meldeSicherheitsereignis } from '../platform/bestaetigung.js'
import type { Config } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { encryptSecret } from '../platform/crypto.js'
import { ZWECK_SCHLUESSEL, ZWECK_WEBHOOK, type StripeZugangQuelle }
  from '../platform/payments/zugang.js'

/**
 * Den Stripe-Zugang der Plattform im Adminpanel eintragen (Migration 0168).
 *
 * **Ein Geheimnis geht hinein und nie wieder heraus.** Die Antwort nennt
 * vom geheimen Schluessel nur Anfang und Ende, vom Webhook-Geheimnis nur,
 * ob es gesetzt ist. Wer den Schluessel wieder braucht, holt ihn bei
 * Stripe; ein Panel, das ihn zeigt, legt ihn in jedes Bildschirmfoto.
 *
 * **Die Umgebungsdatei geht vor.** Steht ein Wert dort, zeigt das Panel das
 * an und laesst ihn stehen; ein Eintrag hier wirkte sonst nicht, und
 * niemand saehe, warum.
 *
 * Recht `platform:billing`: Plattformverwaltung und Abrechnung, nicht der
 * Support -- wer Support-Sitzungen fuehrt, braucht den Zahlungszugang der
 * Plattform nicht.
 */

type Quelle = 'env' | 'panel' | null

/** "sk_live_…AbCd": genug, um ihn wiederzuerkennen, zu wenig, um ihn zu nutzen. */
function hinweis(schluessel: string): string {
  const praefix = /^(sk|rk)_(live|test)_/.exec(schluessel)?.[0] ?? ''
  return `${praefix}…${schluessel.slice(-4)}`
}

const MUSTER = {
  connectClientId: /^ca_[A-Za-z0-9]{10,}$/,
  secretKey: /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/,
  webhookSecret: /^whsec_[A-Za-z0-9+/=]{10,}$/
} as const

export function paymentProviderRoutes(
  app: FastifyInstance, zugang: StripeZugangQuelle, config: Config
): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/payment-provider',
    permission: 'platform:billing',
    summary: 'Stripe-Zugang der Plattform: was eingetragen ist und woher',
    handler: async (req) => {
      const z = await tx(req.pool, req, async client => {
        const r = await client.query<{ connect_client_id: string | null
                                       secret_key_hint: string | null
                                       webhook_gesetzt: boolean; updated_at: Date }>(
          `SELECT connect_client_id, secret_key_hint,
                  webhook_secret_enc IS NOT NULL AS webhook_gesetzt, updated_at
             FROM platform_payment_provider WHERE id = 1`)
        return r.rows[0] ?? null
      })
      // Was tatsaechlich gilt, nicht nur was in der Zeile steht: ein
      // Chiffrat, das sich nicht oeffnen laesst, zaehlt nicht.
      zugang.vergessen()
      const gilt = await zugang.laden(req.pool)

      const quelle = (env: unknown, panel: unknown): Quelle =>
        env !== null ? 'env' : panel !== null && panel !== false ? 'panel' : null

      return {
        connectClientId: {
          value: gilt.connectClientId,
          source: quelle(config.stripeConnectClientId, z?.connect_client_id ?? null)
        },
        secretKey: {
          hint: config.stripeSecretKey !== null ? hinweis(config.stripeSecretKey)
            : gilt.stripe !== null ? z?.secret_key_hint ?? null : null,
          source: config.stripeSecretKey !== null ? 'env'
            : gilt.stripe !== null ? 'panel' : null
        },
        webhookSecret: {
          set: gilt.webhookSecret !== null,
          source: quelle(config.stripeWebhookSecret,
                         gilt.webhookSecret !== null ? z?.webhook_gesetzt ?? null : null)
        },
        ready: gilt.stripe !== null && gilt.connectClientId !== null
          && gilt.webhookSecret !== null,
        // Was bei Stripe einzutragen ist, damit niemand es abschreiben muss.
        redirectUri: `${config.publicAppUrl}/stripe-verbunden`,
        webhookUrl: `${config.publicAppUrl}/v1/payments/stripe/webhook`,
        updatedAt: z?.updated_at.toISOString() ?? null
      }
    }
  })

  /**
   * Eintragen. Ein fehlendes oder leeres Feld laesst den Wert stehen; so
   * laesst sich das Webhook-Geheimnis nachtragen, ohne den Schluessel noch
   * einmal einzugeben. `null` entfernt ihn.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/platform/payment-provider',
    permission: 'platform:billing',
    summary: 'Stripe-Zugang der Plattform eintragen',
    handler: async (req) => {
      // Plattformhandlung (Bedrohungsanalyse 23.10.2026, T4): nur nach
      // Bestaetigung, und festgehalten, bevor sie wirkt.
      await verlangeBestaetigung(req)
      await tx(req.pool, req, client => meldeSicherheitsereignis(client, req, {
        kind: 'payment_provider_changed', accountId: null, detail: { route: 'PUT /v1/platform/payment-provider' } }))
      const body = (req.body ?? {}) as Record<string, unknown>
      const principal = req.principal as Principal
      const fehler: Record<string, Array<'field.invalid'>> = {}
      const werte: Partial<Record<keyof typeof MUSTER, string | null>> = {}
      for (const feld of Object.keys(MUSTER) as Array<keyof typeof MUSTER>) {
        const v = body[feld]
        if (v === undefined || v === '') continue
        if (v === null) { werte[feld] = null; continue }
        if (typeof v !== 'string' || !MUSTER[feld].test(v.trim())) {
          fehler[feld] = ['field.invalid']
          continue
        }
        werte[feld] = v.trim()
      }
      if (Object.keys(fehler).length > 0) throw Errors.validation(fehler)

      const sk = werte.secretKey
      const wh = werte.webhookSecret
      await tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO platform_payment_provider (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
        await client.query(
          `UPDATE platform_payment_provider SET
              connect_client_id  = CASE WHEN $1 THEN $2 ELSE connect_client_id END,
              secret_key_enc     = CASE WHEN $3 THEN $4::bytea ELSE secret_key_enc END,
              secret_key_hint    = CASE WHEN $3 THEN $5 ELSE secret_key_hint END,
              webhook_secret_enc = CASE WHEN $6 THEN $7::bytea ELSE webhook_secret_enc END,
              updated_by = $8, updated_at = now()
            WHERE id = 1`,
          ['connectClientId' in werte, werte.connectClientId ?? null,
           sk !== undefined,
           sk == null ? null : encryptSecret(sk, config.idDocumentKey, ZWECK_SCHLUESSEL),
           sk == null ? null : hinweis(sk),
           wh !== undefined,
           wh == null ? null : encryptSecret(wh, config.idDocumentKey, ZWECK_WEBHOOK),
           principal.userId])
      })
      // Gilt ab der naechsten Anfrage, ohne Neustart.
      zugang.vergessen()
      return { ok: true }
    }
  })
}
