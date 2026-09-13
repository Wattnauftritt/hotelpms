/** Konfiguration aus der Umgebung. Kein stiller Standardwert fuer Geheimnisse. */
export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Umgebungsvariable ${name} fehlt. Start abgebrochen.`)
  }
  return v
}

export function dbUrl(kind: 'app' | 'direct' | 'owner' = 'app'): string {
  switch (kind) {
    case 'owner':
      return requireEnv('DATABASE_URL_OWNER')
    case 'direct':
      // Der Worker verbindet direkt, nicht ueber PgBouncer: LISTEN/NOTIFY
      // kommt im Transaction Mode nicht an (D1, Dokument 13).
      return process.env.DATABASE_URL_DIRECT ?? requireEnv('DATABASE_URL')
    default:
      return requireEnv('DATABASE_URL')
  }
}
