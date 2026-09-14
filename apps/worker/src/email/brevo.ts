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

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'

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
}

export function createBrevoAdapter(apiKey: string, opts: BrevoOptions = {}): EmailAdapter {
  const url = opts.baseUrl ?? BREVO_URL
  const timeoutMs = opts.timeoutMs ?? 15_000
  return {
    async send(m: OutgoingEmail): Promise<EmailSendResult> {
      const body = {
        sender: { name: m.from.name ?? undefined, email: m.from.email },
        to: [{ email: m.to.email, name: m.to.name ?? undefined }],
        replyTo: m.replyTo ? { email: m.replyTo.email, name: m.replyTo.name ?? undefined } : undefined,
        bcc: m.bcc ? [{ email: m.bcc.email }] : undefined,
        subject: m.subject,
        textContent: m.text,
        htmlContent: m.html ?? undefined,
        attachment: m.attachments?.length
          ? m.attachments.map(a => ({ name: a.name, content: a.content.toString('base64') }))
          : undefined
      }

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (e) {
        // Zeitueberschreitung, Namensaufloesung, abgelehnte Verbindung: kein
        // Code, also voruebergehend. Die Warteschlange wiederholt.
        throw new EmailSendError(null, (e as Error).message.slice(0, 500))
      }

      if (!res.ok) {
        /*
         * Die Antwort kann Gastdaten enthalten -- Brevo schickt bei einer
         * ungueltigen Adresse die Adresse zurueck. Sie wandert in
         * outbound_email.last_error, das der Zeilenrichtlinie unterliegt,
         * und nie ins Protokoll (C8, Dokument 13).
         */
        throw new EmailSendError(res.status,
          `Brevo hat abgelehnt (${res.status}): ${(await res.text()).slice(0, 500)}`)
      }

      const json = await res.json().catch(() => ({})) as { messageId?: string }
      return { providerMessageId: json.messageId ?? null, statusCode: res.status }
    }
  }
}
