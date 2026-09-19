/**
 * Absenderdomains beim Anbieter anmelden und nachsehen, ob sie stehen.
 *
 * **Eine zweite Anbindung neben der im Worker, und das ist Absicht.** Der
 * Worker verschickt (`/v3/smtp/email`), hier wird verwaltet
 * (`/v3/senders/domains`). Die beiden haben nichts gemeinsam ausser dem
 * Anbieter: der eine laeuft im Hintergrund und darf wiederholen, der andere
 * haengt an einem Menschen, der auf eine Antwort wartet. Sie zu einer Datei
 * zusammenzuziehen hiesse, `apps/worker` von `apps/api` abhaengig zu machen
 * oder umgekehrt -- quer zwischen Apps, was hier nicht vorkommt.
 *
 * **Warum der Aufruf nicht in der Transaktion steht.** Eine Anfrage nach
 * draussen dauert, und eine offene Transaktion haelt Sperren. Die Routen
 * rufen deshalb erst hier auf und schreiben das Ergebnis danach in einer
 * eigenen Transaktion. Der Preis ist ein Fenster, in dem die Domain beim
 * Anbieter steht und bei uns noch nicht; das ist die guenstigere Haelfte
 * des Tauschs, weil ein zweiter Anlauf sie dort einfach wiederfindet.
 */

/** Ein DNS-Eintrag, so wie ihn ein Mensch abtippen muss. */
export interface DnsEintrag {
  /** Der Name links im Formular des DNS-Anbieters, z. B. `mail._domainkey`. */
  host: string
  type: string
  value: string
  /** Steht er schon? Kommt vom Anbieter, nicht aus einer eigenen Abfrage. */
  ok: boolean
}

export interface DomainStand {
  domain: string
  providerId: string | null
  /** Die Domain gehoert dem Antragsteller (Anbietercode steht). */
  verified: boolean
  /** Wir duerfen in ihrem Namen signieren (DKIM steht). */
  authenticated: boolean
  records: DnsEintrag[]
}

/**
 * Ein abgelehnter Aufruf ist ein Ergebnis, kein Programmfehler: die Route
 * muss den Code sehen, um zwischen "so nicht" und "gerade nicht" zu
 * unterscheiden. Dieselbe Bauart wie beim Versandadapter.
 */
export class DomainApiError extends Error {
  constructor(readonly statusCode: number | null, message: string) {
    super(message)
    this.name = 'DomainApiError'
  }
}

export interface DomainVerwaltung {
  anmelden(domain: string): Promise<DomainStand>
  nachsehen(domain: string): Promise<DomainStand>
  pruefenLassen(domain: string): Promise<DomainStand>
  entfernen(providerId: string): Promise<void>
}

const BREVO_BASIS = 'https://api.brevo.com/v3'

/** Rohform, wie der Anbieter sie ausgibt. Absichtlich nicht durchgereicht. */
interface RohEintrag { host_name?: string; type?: string; value?: string; status?: boolean }
interface RohDomain {
  id?: number | string
  domain_name?: string
  domain?: string
  verified?: boolean
  authenticated?: boolean
  dns_records?: Record<string, RohEintrag>
}

/*
 * Der Anbieter gibt die Eintraege als Objekt mit festen Namen aus
 * (brevo_code, dkim_record, dmarc_record). Hier werden sie zu einer Liste:
 * welche es sind, soll die Oberflaeche nicht wissen muessen, und ein
 * vierter Eintrag waere sonst eine Aenderung an drei Stellen statt an
 * keiner.
 */
function eintraege(roh: Record<string, RohEintrag> | undefined): DnsEintrag[] {
  if (!roh) return []
  return Object.values(roh)
    .filter(r => typeof r?.value === 'string' && r.value.length > 0)
    .map(r => ({
      host: r.host_name ?? '@',
      type: (r.type ?? 'TXT').toUpperCase(),
      value: r.value as string,
      ok: r.status === true
    }))
}

function stand(roh: RohDomain, gefragt: string): DomainStand {
  return {
    domain: roh.domain_name ?? roh.domain ?? gefragt,
    providerId: roh.id === undefined || roh.id === null ? null : String(roh.id),
    verified: roh.verified === true,
    authenticated: roh.authenticated === true,
    records: eintraege(roh.dns_records)
  }
}

export interface DomainOptions {
  timeoutMs?: number
  /**
   * Abweichendes Ziel. Gedacht fuer den Test: nur so laesst sich der
   * **echte** Client gegen einen echten HTTP-Server pruefen, statt ihn
   * durch eine Attrappe zu ersetzen und damit genau das ungeprueft zu
   * lassen, was hier schiefgehen kann -- Pfade, Kopfzeilen, die Form der
   * Antwort.
   */
  baseUrl?: string
}

export function createBrevoDomains(
  apiKey: string, opts: DomainOptions = {}
): DomainVerwaltung {
  const basis = opts.baseUrl ?? BREVO_BASIS
  const timeoutMs = opts.timeoutMs ?? 15_000

  async function ruf(pfad: string, method: string, body?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${basis}${pfad}`, {
        method,
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      // Zeitueberschreitung, Namensaufloesung, abgelehnte Verbindung: kein
      // Code, also voruebergehend. Ein zweiter Klick hilft.
      throw new DomainApiError(null, (e as Error).message.slice(0, 500))
    }
    if (!res.ok) {
      throw new DomainApiError(res.status,
        `Der Anbieter hat abgelehnt (${res.status}): ${(await res.text()).slice(0, 500)}`)
    }
    if (res.status === 204) return {}
    return await res.json().catch(() => ({}))
  }

  return {
    async anmelden(domain: string): Promise<DomainStand> {
      const roh = await ruf('/senders/domains', 'POST', { name: domain })
      return stand(roh as RohDomain, domain)
    },
    async nachsehen(domain: string): Promise<DomainStand> {
      const roh = await ruf(`/senders/domains/${encodeURIComponent(domain)}`, 'GET')
      return stand(roh as RohDomain, domain)
    },
    async pruefenLassen(domain: string): Promise<DomainStand> {
      /*
       * Zwei Aufrufe, und die Reihenfolge ist der Punkt: `authenticate`
       * stoesst die Pruefung an, gibt aber nur eine Meldung zurueck und
       * nicht den neuen Stand. Den holt erst das Nachsehen danach. Wer nur
       * den ersten aufruft, zeigt dem Haus weiterhin "nicht bestaetigt",
       * obwohl es gerade bestaetigt wurde.
       */
      await ruf(`/senders/domains/${encodeURIComponent(domain)}/authenticate`, 'PUT')
        .catch((e: unknown) => {
          // Ein Fehlschlag hier heisst meist "die Eintraege stehen noch
          // nicht" und ist die normale Antwort waehrend der Wartezeit, kein
          // Grund, dem Benutzer einen Fehler zu zeigen. Der Stand danach
          // sagt es ihm genauer.
          if (e instanceof DomainApiError && e.statusCode !== null) return
          throw e
        })
      return this.nachsehen(domain)
    },
    async entfernen(providerId: string): Promise<void> {
      await ruf(`/senders/domains/${encodeURIComponent(providerId)}`, 'DELETE')
    }
  }
}
