/**
 * Anbindung an Brevo.
 *
 * **Ueber die REST-API, nicht ueber SMTP.** Der Pfad heisst `/v3/smtp/email`
 * und meint trotzdem die HTTP-Schnittstelle; das ist eine Eigenheit der
 * Benennung bei Brevo, kein SMTP-Versand. Der Unterschied ist keine
 * Geschmacksfrage: ueber SMTP bekaeme man eine Zustellung ohne Kennung,
 * ohne verwertbaren Fehlercode und mit einer Verbindung, die der Worker
 * offenhalten muesste. Die API antwortet mit einer `messageId`, an der sich
 * eine Nachricht spaeter im Protokoll des Anbieters wiederfinden laesst --
 * und genau dorthin fuehrt die Frage "der Gast sagt, er habe nichts
 * bekommen".
 *
 * Nur diese Fassade wird benutzt, damit ein Test einen Adapter unterschieben
 * kann, ohne eine Verbindung nach draussen zu brauchen -- dieselbe Bauart
 * wie beim Zahlungsadapter (Aufgabe 6).
 */

export interface EmailAddress {
  email: string
  name?: string | null
}

export interface EmailAttachment {
  /** Dateiname im Postfach des Gastes, z. B. `Rechnung-2026-000123.pdf`. */
  name: string
  content: Buffer
}

export interface OutgoingEmail {
  from: EmailAddress
  to: EmailAddress
  replyTo?: EmailAddress | null
  bcc?: EmailAddress | null
  subject: string
  text: string
  html?: string | null
  attachments?: EmailAttachment[]
}

export interface EmailSendResult {
  /** Kennung beim Anbieter. Null, wenn er keine mitgeschickt hat. */
  providerMessageId: string | null
  statusCode: number
}

/**
 * Ein abgelehnter Versand ist kein Programmfehler, sondern ein Ergebnis:
 * die Warteschlange muss den Code sehen, um zwischen "gleich nochmal" und
 * "nie wieder" zu unterscheiden. Deshalb ein eigener Fehlertyp mit dem Code
 * statt einer allgemeinen Ausnahme.
 */
export class EmailSendError extends Error {
  constructor(readonly statusCode: number | null, message: string) {
    super(message)
    this.name = 'EmailSendError'
  }
}

export interface EmailAdapter {
  send(message: OutgoingEmail): Promise<EmailSendResult>
}

/** Ein Ereignis zu einer Nachricht, wie der Anbieter es meldet. */
export interface DeliveryEvent {
  /** Name beim Anbieter, etwa `delivered`, `hardBounces`, `blocked`. */
  event: string
  /** Zeitpunkt mit Zone, wie geliefert. */
  date: string | null
  /** Freitext des Anbieters; kann die Empfaengeradresse enthalten. */
  reason: string | null
}

/**
 * Nachfrage, was aus einer angenommenen Nachricht wurde (Migration 0187).
 * Eigene Fassade neben `EmailAdapter`, weil die Zugangspost sie nicht
 * braucht und ihre Testattrappen sie nicht nachbauen sollen.
 */
export interface DeliveryLookup {
  events(providerMessageId: string): Promise<DeliveryEvent[]>
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_EVENTS_URL = 'https://api.brevo.com/v3/smtp/statistics/events'

export interface BrevoOptions {
  timeoutMs?: number
  /**
   * Abweichendes Ziel. Gedacht fuer den Test: nur so laesst sich der
   * **echte** Adapter gegen einen echten HTTP-Server pruefen, statt ihn
   * durch eine Attrappe zu ersetzen und damit genau das ungeprueft zu
   * lassen, was hier schiefgehen kann -- Kopfzeilen, Aufbau des Rumpfes,
   * Kodierung des Anhangs.
   */
  baseUrl?: string
  /** Abweichendes Ziel fuer die Ereignisabfrage, ebenfalls fuer den Test. */
  eventsUrl?: string
}

export function createBrevoAdapter(
  apiKey: string, opts: BrevoOptions = {}
): EmailAdapter & DeliveryLookup {
  const url = opts.baseUrl ?? BREVO_URL
  const eventsUrl = opts.eventsUrl ?? BREVO_EVENTS_URL
  const timeoutMs = opts.timeoutMs ?? 15_000
  return {
    async events(providerMessageId: string): Promise<DeliveryEvent[]> {
      // Die Kennung kommt mit spitzen Klammern (`<...@smtp-relay...>`) und
      // wird genau so gesucht; ohne Kodierung bricht sie die Abfrage.
      const q = new URLSearchParams({ messageId: providerMessageId, limit: '100', sort: 'desc' })
      let res: Response
      try {
        res = await fetch(`${eventsUrl}?${q.toString()}`, {
          headers: { 'api-key': apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (e) {
        throw new EmailSendError(null, (e as Error).message.slice(0, 500))
      }
      if (!res.ok) {
        throw new EmailSendError(res.status,
          `Brevo-Ereignisse nicht abrufbar (${res.status})`)
      }
      const json = await res.json().catch(() => ({})) as {
        events?: Array<{ event?: unknown; date?: unknown; reason?: unknown }>
      }
      return (json.events ?? []).flatMap(e => typeof e.event === 'string'
        ? [{ event: e.event,
             date: typeof e.date === 'string' ? e.date : null,
             reason: typeof e.reason === 'string' ? e.reason : null }]
        : [])
    },

    async send(m: OutgoingEmail): Promise<EmailSendResult> {
      const body: Record<string, unknown> = {
        sender: { name: m.from.name ?? undefined, email: m.from.email },
        to: [{ email: m.to.email, name: m.to.name ?? undefined }],
        replyTo: m.replyTo ? { email: m.replyTo.email, name: m.replyTo.name ?? undefined } : undefined,
        bcc: m.bcc ? [{ email: m.bcc.email }] : undefined,
        subject: m.subject,
        textContent: m.text,
        htmlContent: m.html ?? undefined,
        attachment: m.attachments?.length
          ? m.attachments.map(a => ({ name: a.name, content: a.content.toString('base64') }))
          : undefined,
        /*
         * Links bleiben, wie sie sind. Mit Klick-Tracking ersetzt Brevo jeden
         * Link durch eine Weiterleitung ueber eine Domain, die sich alle
         * Brevo-Kunden teilen: Booking.com entfernt solche Links oder
         * verwirft die ganze Nachricht an die Gastadresse (20.10.2026), und
         * das Token im Check-in-Link laege bei einem Dritten. Ob der Gast den
         * Link geoeffnet hat, vermerken wir selbst (Migration 0192). Im
         * Konto laesst sich das Tracking fuer Transaktionsmails nicht
         * abschalten, nur je Nachricht.
         */
        clickTracking: false
      }

      const post = async (b: Record<string, unknown>): Promise<Response> => {
        try {
          return await fetch(url, {
            method: 'POST',
            headers: {
              'api-key': apiKey,
              'content-type': 'application/json',
              accept: 'application/json'
            },
            body: JSON.stringify(b),
            signal: AbortSignal.timeout(timeoutMs)
          })
        } catch (e) {
          // Zeitueberschreitung, Namensaufloesung, abgelehnte Verbindung: kein
          // Code, also voruebergehend. Die Warteschlange wiederholt.
          throw new EmailSendError(null, (e as Error).message.slice(0, 500))
        }
      }

      let res = await post(body)
      let fehler = res.ok ? '' : await res.text()
      if (res.status === 400 && fehler.includes('clickTracking')) {
        // Die Angabe steht nicht in Brevos API-Referenz, nur in der Auskunft
        // ihres Supports. Weist Brevo sie zurueck, geht die Mail ohne sie
        // hinaus -- mit umgeschriebenem Link, aber ueberhaupt.
        const ohne = { ...body }
        delete ohne.clickTracking
        res = await post(ohne)
        fehler = res.ok ? '' : await res.text()
      }

      if (!res.ok) {
        /*
         * Die Antwort kann Gastdaten enthalten -- Brevo schickt bei einer
         * ungueltigen Adresse die Adresse zurueck. Sie wandert in
         * outbound_email.last_error, das der Zeilenrichtlinie unterliegt,
         * und nie ins Protokoll (C8, Dokument 13).
         */
        throw new EmailSendError(res.status,
          `Brevo hat abgelehnt (${res.status}): ${fehler.slice(0, 500)}`)
      }

      const json = await res.json().catch(() => ({})) as { messageId?: string }
      return { providerMessageId: json.messageId ?? null, statusCode: res.status }
    }
  }
}
