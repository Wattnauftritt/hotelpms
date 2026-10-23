import type { IsoDate } from './dates.js'

/*
 * Die Form eines Kanaladapters (Migration 0198, Thread "Anbindung weiterer
 * Channelmanager").
 *
 * Ein Adapter uebersetzt zwischen StayGrid und genau einem Channel Manager.
 * Er kennt dessen Protokoll und nichts von StayGrid ausser diesen Typen:
 * Zuordnung, Probebetrieb, Protokoll und Abgleich macht der Kern im Worker
 * (`jobs/channelSync.ts`), einmal fuer alle Anbieter. Hier stehen nur Typen,
 * weil die Domaene kein HTTP spricht; die Adapter selbst liegen im Worker.
 */

/** Was der Adapter zum Anmelden beim Anbieter braucht. */
export interface AdapterZugang {
  /** Kennung des Hauses beim Anbieter. */
  externalPropertyId: string
  /** Entschluesselter Inhalt von `credentials_enc`, Form je Anbieter. */
  credentials: string
}

/** Freie Zimmer eines Zimmertyps fuer einen Zeitraum, `to` ausschliesslich. */
export interface AdapterVerfuegbarkeit {
  roomType: string
  from: IsoDate
  to: IsoDate
  available: number
}

/** Ein Aufenthalt einer abgeholten Buchung, in den Begriffen des Anbieters. */
export interface AdapterAbschnitt {
  roomType: string
  arrival: IsoDate
  departure: IsoDate
  adults?: number
  children?: number
  /** Preis dieses Aufenthalts in Cent, wenn der Anbieter ihn je Zimmer nennt. */
  totalCent?: number
}

/**
 * Ein Stand einer Buchung beim Anbieter. Jede Aenderung ist eine neue
 * Revision; bestaetigt wird die Revision, nicht die Buchung.
 *
 * **Keine Kartendaten.** Ein Adapter verwirft Kartennummer, Pruefziffer und
 * Ablaufdatum, bevor er diese Form fuellt (CLAUDE.md: "Nie Kartendaten
 * speichern"). Es gibt hier kein Feld dafuer, und es kommt keines dazu.
 */
export interface AdapterBuchung {
  revisionId: string
  /** Stabile Kennung der Buchung, mit Praefix je Anbieter (`rc-`, `cx-`). */
  externalReference: string
  status: 'booked' | 'cancelled'
  segments: AdapterAbschnitt[]
  totalCent?: number
  /** Portal, ueber das gebucht wurde, etwa `Booking.com`. */
  channelCode?: string
  guest?: { firstName?: string; lastName: string; email?: string; phone?: string }
  notes?: string
  /** Zeitpunkt der Revision beim Anbieter, ISO 8601. */
  sourceUpdatedAt?: string
}

export interface ChannelAdapter {
  /** Sendet absolute Werte; ein wiederholter Aufruf schadet nicht. */
  pushAvailability(z: AdapterZugang, items: AdapterVerfuegbarkeit[]): Promise<void>
  /** Neue Revisionen, die noch nicht bestaetigt sind. */
  fetchBookings(z: AdapterZugang): Promise<AdapterBuchung[]>
  ackBooking(z: AdapterZugang, revisionId: string): Promise<void>
  /**
   * Buchungen lesen, ohne sie beim Anbieter als abgeholt zu markieren. Nur
   * damit vergleicht der Probebetrieb. Bietet ein Anbieter das nicht, holt
   * der Probebetrieb keine Buchungen: bei manchen gilt eine Buchung schon
   * mit dem Lesen als zugestellt, und dann fehlte sie dem Adminpanel.
   */
  peekBookings?(z: AdapterZugang): Promise<AdapterBuchung[]>
}

/**
 * Fehler beim Anbieter. `key` ist ein Schluessel fuer das Kanalprotokoll,
 * nie der Text des Anbieters: der kann Gastnamen enthalten.
 */
export class AdapterError extends Error {
  constructor(readonly key: string, readonly ursache?: unknown) {
    super(key)
    this.name = 'AdapterError'
  }
}

/**
 * Zweck der Verschluesselung von `channel_connection.credentials_enc`
 * (`encryptSecret`). Ein eigener Zweck: ein Chiffrat des Stripe-Schluessels
 * laesst sich so nicht als Zugang eines Channel Managers ausgeben.
 */
export const CHANNEL_CREDENTIALS_PURPOSE = 'channel-credentials'
