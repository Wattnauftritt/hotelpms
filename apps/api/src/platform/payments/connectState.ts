import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Der `state` beim Verbinden eines Stripe-Kontos (Migration 0167).
 *
 * Er bindet die Rueckkehr von Stripe an das Haus und den Benutzer, der den
 * Knopf gedrueckt hat. Ohne diese Bindung liesse sich ein Angriff bauen, der
 * aus jeder OAuth-Strecke bekannt ist: ein Fremder verbindet bei Stripe sein
 * **eigenes** Konto, schickt die Rueckkehradresse mit seinem Code einem
 * angemeldeten Hotelbenutzer, und ab da gingen die Anzahlungen der Gaeste
 * auf das Konto des Fremden.
 *
 * Signiert statt gespeichert: der Zustand haelt nichts, was ein Neustart
 * verlieren duerfte, und eine Tabelle dafuer muesste jemand aufraeumen. Eine
 * Viertelstunde reicht, um bei Stripe ein Konto anzulegen; wer laenger
 * braucht, drueckt den Knopf noch einmal. Der Code von Stripe gilt ohnehin
 * nur einmal.
 */

const GUELTIG_MS = 15 * 60 * 1000

export interface ConnectState { propertyId: number; userId: number }

function signatur(secret: string, nutzlast: string): string {
  return createHmac('sha256', secret).update(`stripe-connect:${nutzlast}`).digest('base64url')
}

export function connectStateErzeugen(
  secret: string, s: ConnectState, jetzt: number = Date.now()
): string {
  const nutzlast = `${s.propertyId}.${s.userId}.${jetzt + GUELTIG_MS}`
  return `${nutzlast}.${signatur(secret, nutzlast)}`
}

/** `null` bei falscher Signatur, abgelaufen oder unlesbar. */
export function connectStatePruefen(
  secret: string, state: string, jetzt: number = Date.now()
): ConnectState | null {
  const teile = state.split('.')
  if (teile.length !== 4) return null
  const [haus, nutzer, bis, sig] = teile as [string, string, string, string]
  const erwartet = Buffer.from(signatur(secret, `${haus}.${nutzer}.${bis}`))
  const bekommen = Buffer.from(sig)
  if (erwartet.length !== bekommen.length || !timingSafeEqual(erwartet, bekommen)) return null
  const propertyId = Number(haus)
  const userId = Number(nutzer)
  const ablauf = Number(bis)
  if (!Number.isInteger(propertyId) || !Number.isInteger(userId)
      || !Number.isFinite(ablauf) || ablauf < jetzt) return null
  return { propertyId, userId }
}
