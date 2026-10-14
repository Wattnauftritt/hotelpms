import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import type { Config } from '../config.js'
import { decryptSecret } from '../crypto.js'
import { createStripeAdapter, type StripeAdapter } from './stripe.js'

/**
 * Woher der Stripe-Zugang der Plattform kommt (Migrationen 0167, 0168).
 *
 * **Die Umgebungsdatei geht vor, das Adminpanel ist der Weg ohne Terminal.**
 * Je Wert: was in der Umgebung steht, gilt; was dort fehlt, kommt aus
 * `platform_payment_provider`. Wer die Maschine betreibt, kann so jeden
 * Wert festnageln, und wer nur das Panel hat, kann trotzdem einschalten.
 *
 * **Gelesen wird je Anfrage, mit kurzem Zwischenspeicher.** Ein Wert, der im
 * Panel gespeichert wird, soll ohne Neustart gelten -- die Speicherroute
 * leert den Zwischenspeicher. Dreissig Sekunden halten die Zahlungsseite und
 * den Webhook davon ab, bei jedem Aufruf zu entschluesseln; scrypt ist
 * absichtlich langsam.
 */

export interface StripeZugang {
  stripe: StripeAdapter | null
  webhookSecret: string | null
  connectClientId: string | null
}

export interface StripeZugangQuelle {
  laden(pool: Pool): Promise<StripeZugang>
  /** Nach dem Speichern im Panel: beim naechsten Aufruf neu lesen. */
  vergessen(): void
}

const HALTBAR_MS = 30_000
export const ZWECK_SCHLUESSEL = 'stripe-secret-key'
export const ZWECK_WEBHOOK = 'stripe-webhook-secret'

interface Zeile {
  connect_client_id: string | null
  secret_key_enc: Buffer | null
  webhook_secret_enc: Buffer | null
}

/** Ein Chiffrat, das sich nicht oeffnen laesst, gilt als nicht eingetragen. */
function oeffnen(enc: Buffer | null, schluessel: string, zweck: string): string | null {
  if (enc === null) return null
  try {
    return decryptSecret(enc, schluessel, zweck)
  } catch {
    // ID_DOCUMENT_KEY gewechselt oder Zeile veraendert. Das Panel zeigt dann
    // "nicht eingerichtet", und der Schluessel wird neu eingetragen.
    return null
  }
}

/**
 * `testAdapter`: ein Adapter ohne Netz fuer Tests. Webhook-Geheimnis und
 * Client-ID kommen dann trotzdem aus Umgebung oder Datenbank.
 */
export function stripeZugangQuelle(
  config: Config, testAdapter?: StripeAdapter
): StripeZugangQuelle {
  let gemerkt: { bis: number; zugang: StripeZugang } | null = null

  return {
    async laden(pool) {
      if (gemerkt !== null && gemerkt.bis > Date.now()) return gemerkt.zugang

      const zeile = await withTransaction(pool, SYSTEM_CONTEXT, async client => {
        const r = await client.query<Zeile>(
          `SELECT connect_client_id, secret_key_enc, webhook_secret_enc
             FROM platform_payment_provider WHERE id = 1`)
        return r.rows[0] ?? null
      })

      const secretKey = config.stripeSecretKey
        ?? oeffnen(zeile?.secret_key_enc ?? null, config.idDocumentKey, ZWECK_SCHLUESSEL)
      const connectClientId = config.stripeConnectClientId ?? zeile?.connect_client_id ?? null
      const webhookSecret = config.stripeWebhookSecret
        ?? oeffnen(zeile?.webhook_secret_enc ?? null, config.idDocumentKey, ZWECK_WEBHOOK)

      const zugang: StripeZugang = {
        stripe: testAdapter
          ?? (secretKey !== null ? createStripeAdapter(secretKey, connectClientId) : null),
        webhookSecret,
        connectClientId
      }
      gemerkt = { bis: Date.now() + HALTBAR_MS, zugang }
      return zugang
    },
    vergessen() {
      gemerkt = null
    }
  }
}
