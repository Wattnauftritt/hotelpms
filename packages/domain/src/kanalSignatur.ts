import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signatur einer Nachricht, die ein Channel Manager uns schickt
 * (Bedrohungsanalyse 23.10.2026, T10), nach dem Muster des Stripe-Webhooks.
 *
 * Signiert ist `<zeitstempel>.<rumpf>` mit HMAC-SHA256, als Hex. Geprueft
 * wird in konstanter Zeit -- ein Vergleich, der beim ersten falschen
 * Zeichen aufhoert, verraet die Signatur Zeichen fuer Zeichen -- und gegen
 * ein Zeitfenster: eine mitgeschnittene Nachricht soll sich nach fuenf
 * Minuten nicht wieder einspielen lassen. Innerhalb des Fensters entdoppelt
 * der Empfaenger ueber die Kennung der Nachricht (wie `channel_booking_revision`).
 *
 * Bietet ein Anbieter keine Signatur, nimmt der Adapter keine Nachrichten
 * entgegen, sondern holt ab: ein Webhook ohne Signatur ist ein offener
 * Eingang fuer erfundene Buchungen.
 */
export const KANAL_SIGNATUR_FENSTER_S = 300

export function kanalSignatur(geheimnis: string, zeitstempel: number, rumpf: string): string {
  return createHmac('sha256', geheimnis).update(`${zeitstempel}.${rumpf}`).digest('hex')
}

export function kanalSignaturGueltig(p: {
  geheimnis: string; rumpf: string; zeitstempel: string | undefined
  signatur: string | undefined; jetztS?: number
}): boolean {
  if (p.geheimnis.length < 16 || p.signatur === undefined || p.zeitstempel === undefined) {
    return false
  }
  if (!/^[0-9]{1,12}$/.test(p.zeitstempel) || !/^[0-9a-f]{64}$/i.test(p.signatur)) return false
  const ts = Number(p.zeitstempel)
  const jetzt = p.jetztS ?? Math.floor(Date.now() / 1000)
  if (Math.abs(jetzt - ts) > KANAL_SIGNATUR_FENSTER_S) return false
  const soll = Buffer.from(kanalSignatur(p.geheimnis, ts, p.rumpf), 'hex')
  const ist = Buffer.from(p.signatur, 'hex')
  return soll.length === ist.length && timingSafeEqual(soll, ist)
}
