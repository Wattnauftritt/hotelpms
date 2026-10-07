import { useEffect } from 'react'

/**
 * Haelt den Bildschirm wach, solange `an` gilt (Screen Wake Lock).
 *
 * Mehr kann ein Browser nicht: er haelt einen Bildschirm an, der an ist,
 * und laesst ihn danach los -- einschalten kann er ihn nicht. Ist er nach
 * Feierabend aus, macht ihn morgens eine Beruehrung an oder die
 * Energieeinstellung des Rechners (Dokument 31).
 *
 * Der Browser gibt die Sperre selbst frei, sobald die Seite unsichtbar
 * wird (minimiert, gesperrt); sie wird beim Zurueckkommen neu geholt.
 * Ohne Wake Lock (alter Browser, keine sichere Herkunft) geschieht nichts:
 * dann entscheidet Windows wie bisher.
 */
export function useBildschirmWach(an: boolean): void {
  useEffect(() => {
    if (!an || !('wakeLock' in navigator)) return
    let sperre: WakeLockSentinel | null = null
    let aus = false
    const holen = (): void => {
      if (document.visibilityState !== 'visible') return
      if (sperre !== null && !sperre.released) return
      navigator.wakeLock.request('screen')
        .then(s => { if (aus) void s.release(); else sperre = s })
        .catch(() => { /* abgelehnt: dann eben Windows */ })
    }
    holen()
    document.addEventListener('visibilitychange', holen)
    return () => {
      aus = true
      document.removeEventListener('visibilitychange', holen)
      void sperre?.release()
    }
  }, [an])
}
