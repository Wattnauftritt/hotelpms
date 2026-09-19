import { parseCidrList, type Cidr } from '@hotelpms/domain'

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
   * Unterdomain fuer Haeuser ohne eigene Domain. Sie ist beim Anbieter
   * **einmal** hinterlegt; ein Haus bekommt darunter nur einen Namensteil.
   * Steht sie nicht, laesst sich dieser Weg nicht freigeben -- besser als
   * eine Freigabe, nach der die Post im Werbeordner landet.
   */
  relayEmailDomain: string
}

function need(name: string, minLength = 1): string {
  const v = process.env[name]
  if (!v || v.trim().length < minLength) {
    throw new Error(
      `Umgebungsvariable ${name} fehlt oder ist kuerzer als ${minLength} Zeichen. Start abgebrochen.`)
  }
  return v
}

export function loadConfig(): Config {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as Config['nodeEnv']
  return {
    nodeEnv,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    port: Number(process.env.PORT ?? 3000),
    listenSocket: process.env.LISTEN_SOCKET ?? null,
    // 32 Zeichen Mindestlaenge, damit ein zu kurzes Geheimnis auffaellt.
    sessionSecret: need('SESSION_SECRET', 32),
    idDocumentKey: need('ID_DOCUMENT_KEY', 32),
    // Keine Wildcard: ein API mit Cookie-Sitzungen und * ist angreifbar (S9).
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    publicAppUrl: process.env.PUBLIC_APP_URL ?? 'http://localhost:5173',
    // Wirft bei einem Tippfehler, und zwar hier: ein verworfenes Netz faellt
    // sonst erst auf, wenn eine Zustellung ausbleibt.
    allowedWebhookCidrs: parseCidrList(process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS),
    brevoApiKey: process.env.BREVO_API_KEY ?? null,
    platformNoticeEmail: process.env.PLATFORM_NOTICE_EMAIL ?? 'info@staygrid.cloud',
    relayEmailDomain: process.env.RELAY_EMAIL_DOMAIN ?? 'mail.staygrid.cloud'
  }
}
