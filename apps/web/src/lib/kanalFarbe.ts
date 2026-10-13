/**
 * Farbe der Marke fuer den Buchungskanal (Sven, 13.10.2026: "Booking blau,
 * Email rot, Expedia gelb, HRS grau").
 *
 * Der Kanal ist Freitext, so wie das Umsystem ihn nennt (Migration 0155):
 * RoomCloud fuehrt Booking.com unter "Booking 02" bis "Booking 07", das
 * Adminpanel schreibt "Email", der Gaestehaus-Push "E-Mail". Erkannt wird
 * deshalb am Anfang des Namens, ohne Gross- und Kleinschreibung, nicht am
 * genauen Wert -- sonst bliebe jede neue Booking-Nummer farblos.
 *
 * Die Klassen stehen ausgeschrieben, weil Tailwind nur findet, was im
 * Quelltext als Ganzes steht.
 */
const REGELN: Array<{ muster: RegExp; klassen: string }> = [
  { muster: /^booking(\b|\.|\s|$)/i, klassen: 'bg-blue-100 text-blue-800' },
  { muster: /^e-?mail\b/i, klassen: 'bg-red-100 text-red-800' },
  { muster: /^expedia\b/i, klassen: 'bg-yellow-100 text-yellow-900' },
  { muster: /^hrs\b/i, klassen: 'bg-neutral-300 text-neutral-800' }
]

/** Alle uebrigen Kanaele: dieselbe zurueckhaltende Marke wie bisher. */
export const KANAL_NEUTRAL = 'bg-neutral-100 text-neutral-700'

export function kanalFarbe(kanal: string): string {
  const k = kanal.trim()
  return REGELN.find(r => r.muster.test(k))?.klassen ?? KANAL_NEUTRAL
}
