import { useEffect, useState } from 'react'

/**
 * Ein Reiter innerhalb eines Bildschirms, abgelegt in der Adresse.
 *
 * Derselbe Grund wie bei Haus und Bildschirm (`adresse.ts`): ein Lesezeichen
 * soll dahin fuehren, wo es gesetzt wurde, und ein Neuladen am geteilten
 * Rechner nicht auf dem ersten Reiter enden. Bewusst ein eigener
 * Abfrageparameter je Bildschirm statt eines gemeinsamen: zwei Bildschirme
 * mit Reitern wuerden sich sonst gegenseitig zuruecksetzen.
 *
 * Geschrieben wird mit `history.replaceState`, nicht `pushState`: ein
 * Reiterwechsel ist keine Station, zu der der Zurueck-Knopf fuehren soll.
 * Sonst braucht man ihn fuenfmal, um den Bildschirm zu verlassen.
 */
function ausAdresse<T extends string>(
  param: string, erlaubt: readonly T[], standard: T
): T {
  const v = new URLSearchParams(location.search).get(param)
  return erlaubt.includes(v as T) ? (v as T) : standard
}

export function useReiter<T extends string>(
  param: string, erlaubt: readonly T[], standard: T
): [T, (wert: T) => void] {
  const [reiter, setReiter] = useState<T>(() => ausAdresse(param, erlaubt, standard))

  // `erlaubt` und `standard` sind Konstanten des Bildschirms, keine Werte,
  // die sich je Darstellung aendern; der Effekt laeuft deshalb einmal.
  useEffect(() => {
    const onPop = (): void => { setReiter(ausAdresse(param, erlaubt, standard)) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [param, erlaubt, standard])

  const setzen = (wert: T): void => {
    const p = new URLSearchParams(location.search)
    p.set(param, wert)
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`)
    setReiter(wert)
  }
  return [reiter, setzen]
}
