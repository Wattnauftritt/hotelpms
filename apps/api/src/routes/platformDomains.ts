import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import { loadConfig } from '../platform/config.js'
import { createBrevoDomains, DomainApiError, type DomainVerwaltung }
  from '../platform/brevoDomains.js'

/**
 * Das Adminpanel, dritter Teil: Freigabe der Absenderdomains.
 *
 * **Warum wir das entscheiden und nicht der Kunde selbst.** Was ein Haus
 * beantragt, landet in unserem Konto beim Versandanbieter, verbraucht dort
 * Kontingent und haengt an unserem Ruf als Versender. Ein Tippfehler oder
 * eine fremde Domain schluege ungeprueft dorthin durch. Der Kunde traegt
 * dafuer keinen Preis -- wir schon.
 *
 * **Der Kunde bekommt unseren Zugang dabei nie zu sehen.** Angemeldet wird
 * mit unserem Schluessel, hier, nach der Freigabe. Zurueck kommen drei
 * oeffentliche TXT-Eintraege, und die traegt das Haus bei seinem **eigenen**
 * DNS-Anbieter ein. Das ist der Punkt, an dem die naheliegende Sorge
 * ("das Hotel kann doch nichts in unserem Konto eintragen") sich aufloest:
 * es muss auch nicht.
 *
 * **Der Grundsatz des Adminpanels bleibt.** Kein Gast, keine Buchung, kein
 * Umsatz. Hier steht ein Domainname und wer ihn beantragt hat.
 */

interface DomainZeile {
  property_id: number; property_name: string
  account_id: number; account_name: string
  mode: string; domain: string; local_part: string | null; status: string
  verified: boolean; authenticated: boolean; dns_records: unknown
  requested_by_name: string | null; requested_at: string
  decided_by_name: string | null; decided_at: string | null
  decision_note: string | null; checked_at: string | null
}

function hinaus(z: DomainZeile): Record<string, unknown> {
  return {
    propertyId: z.property_id, propertyName: z.property_name,
    accountId: z.account_id, accountName: z.account_name,
    mode: z.mode, domain: z.domain, localPart: z.local_part, status: z.status,
    verified: z.verified, authenticated: z.authenticated,
    dnsRecords: z.dns_records,
    requestedByName: z.requested_by_name, requestedAt: z.requested_at,
    decidedByName: z.decided_by_name, decidedAt: z.decided_at,
    decisionNote: z.decision_note, checkedAt: z.checked_at
  }
}

export interface PlatformDomainOverrides {
  /** Fuer Tests: ein Client ohne echten Netzwerkzugriff auf den Anbieter. */
  domains?: DomainVerwaltung
}

export function platformDomainRoutes(
  app: FastifyInstance, overrides: PlatformDomainOverrides = {}
): void {
  const config = loadConfig()
  const brevoDomains = overrides.domains ?? null

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/email-domains',
    permission: 'platform:accounts',
    summary: 'Antraege auf eine Absenderdomain',
    handler: async (req) => {
      const q = req.query as { status?: string }
      return tx(req.pool, req, async client => {
        /*
         * Ueber die Funktion und nicht ueber eine eigene Abfrage: eine
         * Plattformsitzung hat keinen Mandantenkontext, und die Namen von
         * Haus und Kunde stehen in Tabellen mit Zeilenrichtlinie. Ein JOIN
         * dorthin liefert hier nichts -- still und ohne Fehlermeldung
         * (Migrationen 0014, 0018).
         */
        const { rows } = await client.query<DomainZeile>(
          `SELECT * FROM platform_email_domains($1)`, [q.status ?? null])
        return { requests: rows.map(hinaus),
                 // Damit das Panel beim Ablehnen sagen kann, welcher Weg
                 // dem Haus stattdessen offensteht.
                 relayDomain: config.relayEmailDomain }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/email-domains/:propertyId/approve',
    permission: 'platform:accounts',
    summary: 'Absenderdomain freigeben',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const id = Number(propertyId)

      // Erst lesen, was zu tun ist, dann draussen anmelden, dann schreiben.
      const antrag = await tx(req.pool, req, async client => {
        const { rows } = await client.query<DomainZeile>(
          `SELECT * FROM platform_email_domains(NULL) WHERE property_id = $1`, [id])
        if (rows.length === 0) throw Errors.notFound('domain.notRequested')
        if (rows[0]!.status !== 'requested') throw Errors.conflict('domain.notDecidable')
        return rows[0]!
      })

      /*
       * relay braucht keine Anmeldung: unsere Unterdomain ist beim Anbieter
       * einmal hinterlegt, das Haus bekommt darunter nur einen Namensteil.
       * Eine zweite Anmeldung derselben Domain je Kunde waere eine Zeile,
       * die nichts tut und beim Aufraeumen falsch aussieht.
       */
      let providerId: string | null = null
      let records: unknown[] = []

      if (antrag.mode === 'own') {
        // Der Schluessel wird nur gebraucht, wenn wirklich der echte Client
        // entsteht. Ihn auch dann zu verlangen, wenn einer untergeschoben
        // ist, hiesse: der Test prueft den Weg nur mit einer Umgebung, die
        // in Produktion anders aussieht.
        if (brevoDomains === null && config.brevoApiKey === null) {
          throw Errors.notConfigured('domain.providerNotConfigured')
        }
        /*
         * Der Aufruf nach draussen liegt **zwischen** den Transaktionen.
         * Eine offene Transaktion haelt Sperren, und der Anbieter braucht,
         * was er braucht -- bis zu fuenfzehn Sekunden im schlechten Fall.
         */
        const anbieter = brevoDomains
          ?? createBrevoDomains(config.brevoApiKey as string)
        try {
          /*
           * Schon angemeldet? Dann nicht noch einmal. Das passiert nach
           * einem Fehlschlag zwischen den beiden Schritten: die Domain
           * steht beim Anbieter, der Status bei uns noch auf 'requested',
           * und der zweite Anlauf soll sie wiederfinden statt an einem
           * Duplikat zu scheitern.
           */
          const stand = await anbieter.nachsehen(antrag.domain)
            .catch(async (e: unknown) => {
              if (e instanceof DomainApiError && e.statusCode === 404) {
                return anbieter.anmelden(antrag.domain)
              }
              throw e
            })
          providerId = stand.providerId
          records = stand.records
        } catch (e) {
          if (e instanceof DomainApiError) {
            // Der Antrag bleibt offen. Ein halb freigegebener Antrag waere
            // schlimmer als ein offener: das Haus saehe DNS-Eintraege, die
            // es nie gab.
            throw Errors.upstreamFailed('domain.providerUnavailable')
          }
          throw e
        }
      }

      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT platform_email_domain_approve($1,$2,$3::jsonb) AS status`,
          [id, providerId, JSON.stringify(records)])
        return { propertyId: id, status: rows[0]!.status, dnsRecords: records }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/email-domains/:propertyId/reject',
    permission: 'platform:accounts',
    summary: 'Absenderdomain ablehnen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as { note?: string }
      const grund = (b.note ?? '').trim()
      // Der Grund geht an den Kunden hinaus. Eine Ablehnung ohne Grund
      // erzeugt eine Rueckfrage, und die kostet mehr Zeit als der Satz.
      if (grund === '') throw Errors.validation({ note: ['domain.rejectNeedsNote'] })

      return tx(req.pool, req, async client => {
        const vorher = await client.query<{ status: string }>(
          `SELECT status FROM platform_email_domains(NULL) WHERE property_id = $1`,
          [Number(propertyId)])
        if (vorher.rowCount === 0) throw Errors.notFound('domain.notRequested')
        if (vorher.rows[0]!.status !== 'requested') {
          throw Errors.conflict('domain.notDecidable')
        }
        await client.query(`SELECT platform_email_domain_reject($1,$2)`,
          [Number(propertyId), grund])
        return { propertyId: Number(propertyId), status: 'rejected', note: grund }
      })
    }
  })
}
