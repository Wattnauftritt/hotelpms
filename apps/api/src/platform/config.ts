import { parseCidrList, domainOf, type Cidr } from '@hotelpms/domain'

/**
 * Konfiguration aus der Umgebung, beim Start validiert.
 * Kein stiller Standardwert fuer Geheimnisse: lieber gar nicht starten als
 * mit einem Entwicklungsschluessel in Produktion laufen.
 */
export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  logLevel: string
  port: number
  listenSocket: string | null
  sessionSecret: string
  idDocumentKey: string
  allowedOrigins: string[]
  /**
   * Zugang zum Payment-Adapter (Aufgabe 6). Bewusst kein need(): anders als
   * SESSION_SECRET ist Stripe nicht fuer jeden Betrieb Pflicht. Ohne
   * Konfiguration meldet die betroffene Route einen klaren Fehler, statt den
   * Serverstart fuer alle abzubrechen.
   */
  stripeSecretKey: string | null
  stripeWebhookSecret: string | null
  /**
   * Kennung der Plattform bei Stripe Connect (`ca_...`, Migration 0167).
   * Ohne sie kann kein Haus sein Konto verbinden; keine geheime Angabe.
   */
  stripeConnectClientId: string | null
  /** Ziel fuer Erfolgs- und Abbruchseite nach Pay-by-Link. Keine geheime Angabe. */
  publicAppUrl: string
  /**
   * Netze, in die ein Webhook trotz Sperrliste zugestellt werden darf.
   *
   * Leer in jeder gehosteten Installation, und das ist der Normalfall. Wer
   * selbst betreibt und die Schnittstelle an ein System im eigenen Netz
   * haengt, traegt genau dieses Netz ein -- `10.0.1.0/24`, nicht `10.0.0.0/8`.
   * Die Freigabe erlaubt dort als einzige Stelle auch `http`, denn ein
   * eigenes Zertifikat fuer ein Kassensystem im Serverraum zu verlangen ist
   * der zuverlaessigste Weg, die Pruefung ganz abschalten zu lassen.
   */
  allowedWebhookCidrs: Cidr[]
  /**
   * Zugang zum Versandanbieter, hier nur fuer die Verwaltung der
   * Absenderdomains. Bewusst kein need(): ohne Gastpost laeuft das System,
   * und der Serverstart fuer alle abzubrechen, weil ein Haus keine Rechnung
   * per Mail schickt, waere die falsche Reihenfolge. Die betroffene Route
   * meldet stattdessen klar, dass nichts eingerichtet ist.
   */
  brevoApiKey: string | null
  /**
   * Postfach fuer Hinweise an uns selbst, etwa auf einen offenen Antrag auf
   * eine Absenderdomain. Ein Postfach und keine Personenliste: wer
   * ausscheidet, muss sonst aus einer Verteilerliste im Code entfernt
   * werden, und das geschieht nie.
   */
  platformNoticeEmail: string
  /**
   * Die Catch-all-Domain der Koedergaeste (Migration 0213). Unauffaellig
   * und ohne Bezug zu StayGrid: eine Adresse unter staygrid.cloud sortiert
   * jeder Angreifer aus. Ohne sie lassen sich keine Koeder anlegen.
   */
  decoyEmailDomain: string | null
  /**
   * Postfach, an das ein neues Ticket und jede Antwort eines Kunden gemeldet
   * werden (0208). Getrennt vom Hinweispostfach, weil hier ein Kunde wartet
   * und dort ein Antrag.
   */
  platformSupportEmail: string
  /**
   * Unterdomain fuer Haeuser ohne eigene Domain. Sie ist beim Anbieter
   * **einmal** hinterlegt; ein Haus bekommt darunter nur einen Namensteil.
   * Steht sie nicht, laesst sich dieser Weg nicht freigeben -- besser als
   * eine Freigabe, nach der die Post im Werbeordner landet.
   */
  relayEmailDomain: string
  /**
   * Oeffentlicher VAPID-Schluessel fuer Web-Push an das Personal (Baustein 8).
   * Das Telefon braucht ihn zum Abonnieren; den privaten Teil hat nur der
   * Worker. Ohne ihn bietet die Personal-App keine Benachrichtigung an.
   */
  vapidPublicKey: string | null
  /**
   * Ob Cookies nur ueber https gehen (`Secure`) und ein 500er seine
   * Fehlermeldung verschweigt.
   *
   * Nicht allein an `NODE_ENV` gehaengt (N6, Audit 11.10.2026): die Unit
   * setzt `production`, aber eine `EnvironmentFile`, die aus `.env.example`
   * kopiert wurde, bringt `NODE_ENV=development` mit und gewinnt. Dann gingen
   * Sitzungscookies ohne `Secure` hinaus. Die oeffentliche Adresse ist die
   * Angabe, die auf der echten Maschine stimmen **muss** -- sonst fuehren die
   * Zahlungslinks ins Leere --, und steht sie auf https, ist die Lage klar.
   */
  secureTransport: boolean
  /**
   * Domains, die der Plattform gehoeren. Ein Haus darf keine davon und
   * nichts darunter als eigene Absenderdomain beantragen (N5, Audit
   * 11.10.2026). Hergeleitet aus der Konfiguration, die es schon gibt, statt
   * aus einer eigenen Liste: die Unterdomain fuer `relay`, die Domain des
   * Hinweispostfachs und die Produktdomain. Eine zweite Liste wuerde beim
   * Umzug der Relay-Domain nicht mitgezogen.
   */
  platformDomains: string[]
}

/**
 * Die Produktdomain. Steht fest, weil sie der Name des Produkts ist und
 * nicht Einstellung einer Maschine (CLAUDE.md): auch eine selbst betriebene
 * Installation soll niemandem erlauben, unter `staygrid.cloud` zu senden.
 */
const PRODUKTDOMAIN = 'staygrid.cloud'

/**
 * Praefix der Beispielgeheimnisse in `.env.example`. Wer die Datei auf die
 * Produktivmaschine kopiert und die beiden Zeilen stehen laesst, besteht die
 * Laengenpruefung -- und jeder Klon des Repositorys kennt dann den
 * `ID_DOCUMENT_KEY`, mit dem die Ausweisnummern in jedem Backup
 * verschluesselt sind (N7, Audit 11.10.2026; dasselbe Muster wie S1 in
 * Dokument 28).
 */
const BEISPIEL_PRAEFIX = 'entwicklung-'

function need(name: string, minLength = 1): string {
  const v = process.env[name]
  if (!v || v.trim().length < minLength) {
    throw new Error(
      `Umgebungsvariable ${name} fehlt oder ist kuerzer als ${minLength} Zeichen. Start abgebrochen.`)
  }
  return v
}

/**
 * Ein Geheimnis, das in Produktion nicht aus `.env.example` stammen darf.
 *
 * Abgewiesen wird nur in Produktion: in der Entwicklung und im Test sind die
 * Beispielwerte genau richtig, und ein Start, der dort abbricht, wuerde
 * dazu verleiten, die Pruefung abzuschalten.
 */
export function needSecret(
  name: string, nodeEnv: Config['nodeEnv'], minLength = 32
): string {
  const v = need(name, minLength)
  if (nodeEnv === 'production' && v.trim().toLowerCase().startsWith(BEISPIEL_PRAEFIX)) {
    throw new Error(
      `Umgebungsvariable ${name} enthaelt den Beispielwert aus .env.example. `
      + 'In Produktion ein eigenes Geheimnis setzen. Start abgebrochen.')
  }
  return v
}

/** Siehe `Config.secureTransport`. */
export function isSecureTransport(nodeEnv: Config['nodeEnv'], publicAppUrl: string): boolean {
  return nodeEnv === 'production' || /^https:\/\//i.test(publicAppUrl.trim())
}

/** Siehe `Config.platformDomains`. Leere Angaben fallen heraus. */
export function platformDomainsOf(relayEmailDomain: string, platformNoticeEmail: string): string[] {
  return [...new Set([PRODUKTDOMAIN, relayEmailDomain.trim().toLowerCase(),
                      domainOf(platformNoticeEmail)].filter(d => d !== ''))]
}

export function loadConfig(): Config {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as Config['nodeEnv']
  const publicAppUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  const platformNoticeEmail = process.env.PLATFORM_NOTICE_EMAIL ?? 'info@staygrid.cloud'
  const relayEmailDomain = process.env.RELAY_EMAIL_DOMAIN ?? 'mail.staygrid.cloud'
  return {
    nodeEnv,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    port: Number(process.env.PORT ?? 3000),
    listenSocket: process.env.LISTEN_SOCKET ?? null,
    // 32 Zeichen Mindestlaenge, damit ein zu kurzes Geheimnis auffaellt.
    sessionSecret: needSecret('SESSION_SECRET', nodeEnv),
    idDocumentKey: needSecret('ID_DOCUMENT_KEY', nodeEnv),
    // Keine Wildcard: ein API mit Cookie-Sitzungen und * ist angreifbar (S9).
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    stripeConnectClientId: process.env.STRIPE_CONNECT_CLIENT_ID ?? null,
    publicAppUrl,
    // Wirft bei einem Tippfehler, und zwar hier: ein verworfenes Netz faellt
    // sonst erst auf, wenn eine Zustellung ausbleibt.
    allowedWebhookCidrs: parseCidrList(process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS),
    brevoApiKey: process.env.BREVO_API_KEY ?? null,
    platformNoticeEmail,
    decoyEmailDomain: process.env.DECOY_EMAIL_DOMAIN?.trim().toLowerCase() || null,
    platformSupportEmail: process.env.PLATFORM_SUPPORT_EMAIL ?? 'support@staygrid.cloud',
    relayEmailDomain,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    secureTransport: isSecureTransport(nodeEnv, publicAppUrl),
    platformDomains: platformDomainsOf(relayEmailDomain, platformNoticeEmail)
  }
}
