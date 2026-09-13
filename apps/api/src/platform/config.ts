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
    publicAppUrl: process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'
  }
}
