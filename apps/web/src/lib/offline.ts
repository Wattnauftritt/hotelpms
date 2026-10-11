import { useEffect, useState } from 'react'
import { addDays, today, type IsoDate } from './dates.js'

/**
 * Lesbare Offline-Kopie der Betriebslisten (E5, Dokument 13).
 *
 * Warum das kein Luxus ist: fällt im Haus das Netz aus, braucht die
 * Rezeption trotzdem die Anreiseliste, die Hausliste und den Zimmerstatus.
 * Diese drei Listen sind **lesend** und ändern sich im Lauf eines Tages
 * wenig. Sie lokal zu halten kostet nichts und rettet den Betrieb.
 *
 * Ausdrücklich **nicht** offline: alles Schreibende. Eine Buchung, die im
 * Browser wartet und später hochgeht, würde Kontingent binden, das
 * inzwischen jemand anders verkauft hat. Ein Kalender, der Doppelbelegungen
 * erzeugt, ist schlimmer als eine Fehlermeldung.
 */
const PRAEFIX = 'staygrid.offline.'

export function cacheRead<T>(key: string): { data: T; at: string } | null {
  try {
    const raw = localStorage.getItem(PRAEFIX + key)
    if (raw === null) return null
    return JSON.parse(raw) as { data: T; at: string }
  } catch {
    // Privates Fenster, gesperrter Speicher, defekter Eintrag: kein Grund,
    // die Oberflaeche scheitern zu lassen.
    return null
  }
}

/*
 * Die Kopie haelt Gastnamen, und sie liegt im Browser, wo `guest_erase_one()`
 * sie nicht erreicht. Deshalb bleibt nur, was der Betrieb bei einem Ausfall
 * wirklich braucht: gestern (die Nacht nach Mitternacht gehoert noch zum
 * alten Geschaeftstag), heute und die Tage voraus. Was davor liegt, braucht
 * niemand offline, und bisher lag jedes einmal aufgerufene Datum fuer immer
 * am geteilten Rezeptionsrechner (Befund M8, Audit vom 11.10.2026).
 */
const TAG_AM_ENDE = /\.(\d{4}-\d{2}-\d{2})$/

function zuAlt(key: string, grenze: IsoDate): boolean {
  const tag = TAG_AM_ENDE.exec(key)?.[1]
  // Kalenderdaten als Zeichenketten vergleichen, nicht ueber `Date`: ISO
  // sortiert lexikographisch richtig und haengt an keiner Zeitzone.
  return tag !== undefined && tag < grenze
}

/** Alle Schluessel der Offline-Kopie; erst sammeln, dann loeschen, weil
 *  `removeItem` die Nummerierung von `key(i)` verschiebt. */
function offlineSchluessel(): string[] {
  const alle: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k !== null && k.startsWith(PRAEFIX)) alle.push(k)
  }
  return alle
}

/**
 * `heute` ist nur fuer den Test einstellbar; im Betrieb gilt das Kalenderdatum
 * des Rechners, an dem die Rezeption sitzt.
 */
export function cacheWrite<T>(key: string, data: T, heute: IsoDate = today()): void {
  const grenze = addDays(heute, -1)
  try {
    for (const k of offlineSchluessel()) {
      if (zuAlt(k.slice(PRAEFIX.length), grenze)) localStorage.removeItem(k)
    }
  } catch { /* Speicher gesperrt: dann gibt es auch nichts Altes darin */ }
  // Ein altes Datum, das jemand gerade nachschlaegt, wird gar nicht erst
  // abgelegt -- sonst laege es bis zum naechsten Schreiben wieder da.
  if (zuAlt(key, grenze)) return
  try {
    localStorage.setItem(PRAEFIX + key,
      JSON.stringify({ data, at: new Date().toISOString() }))
  } catch { /* Speicher voll oder gesperrt */ }
}

/**
 * Entfernt die ganze Offline-Kopie, und nur sie.
 *
 * Gerufen beim Abmelden und wenn die Sitzung abgelaufen ist: am geteilten
 * Rechner oder am Telefon laese sonst der Naechste die Gastnamen der
 * vergangenen Tage (Befund M8). Der Neuaufbau beim Abmelden raeumt den
 * Arbeitsspeicher, nicht den Browserspeicher. Fremde Schluessel -- die
 * Sprachwahl, die Breite des Belegungsplans -- bleiben stehen; sie bezeichnen
 * keinen Menschen, und sie zu verlieren aergert nur.
 */
export function offlineKopieLoeschen(): void {
  try {
    for (const k of offlineSchluessel()) localStorage.removeItem(k)
  } catch { /* Speicher gesperrt: dann liegt auch nichts darin */ }
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const auf = () => setOnline(true)
    const ab = () => setOnline(false)
    window.addEventListener('online', auf)
    window.addEventListener('offline', ab)
    return () => {
      window.removeEventListener('online', auf)
      window.removeEventListener('offline', ab)
    }
  }, [])
  return online
}
