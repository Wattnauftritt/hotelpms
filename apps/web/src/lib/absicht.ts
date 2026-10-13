import { useMemo, useRef } from 'react'
import { newIdempotencyKey } from './api.js'

/**
 * Ein Idempotenzschluessel je Absicht, nicht je Klick.
 *
 * Bisher erzeugten mehrere Hooks den Schluessel in `mutationFn`, also bei
 * jedem Versuch neu. Lief eine Anfrage in eine Zeitueberschreitung, war
 * aber auf dem Server durchgegangen, buchte der zweite Klick ein zweites
 * Mal -- eine doppelte Position, eine doppelte Zahlung (Pruefung des
 * Rechnungssystems vom 13.10.2026).
 *
 * Der Schluessel bleibt, bis die Absicht erledigt ist: nach einem Fehler
 * wiederholt derselbe Klick dieselbe Absicht. Ist die erste Anfrage doch
 * durchgegangen, antwortet der Server mit ihrem Ergebnis; hat jemand
 * inzwischen die Eingabe geaendert, mit 422 statt einer zweiten Buchung.
 * Eine abgewiesene Anfrage hinterlaesst nichts, ihr Schluessel ist frei.
 */
export function useAbsicht(): { schluessel: (teil?: string) => string; erledigt: () => void } {
  const ref = useRef<string | null>(null)
  return useMemo(() => ({
    schluessel: (teil?: string) => {
      ref.current ??= newIdempotencyKey()
      return teil === undefined ? ref.current : `${ref.current}-${teil}`
    },
    erledigt: () => { ref.current = null }
  }), [])
}
