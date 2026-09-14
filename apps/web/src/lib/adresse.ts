import { useEffect, useState } from 'react'

/**
 * Haus und Bildschirm stehen in der Adresse, nicht in einem verborgenen
 * Zustand.
 *
 * Drei Gründe, und alle drei kommen an einer Rezeption täglich vor: ein
 * Lesezeichen soll dahin führen, wo es gesetzt wurde; ein Link an die
 * Kollegin soll bei ihr dasselbe zeigen; und ein versehentliches Neuladen —
 * an einem geteilten Rechner der Normalfall — soll nicht auf dem Startbild
 * enden, wenn jemand mitten in der Arbeit war.
 *
 * `history.pushState` statt `location.href`: die Anwendung soll nicht neu
 * laden, sonst wäre der geladene Stand weg und der Bildschirm für einen
 * Moment leer.
 */

export interface Adresse {
  property: number | null
  screen: string | null
}

function lesen(): Adresse {
  const p = new URLSearchParams(location.search)
  const n = Number(p.get('property'))
  return {
    property: Number.isFinite(n) && n > 0 ? n : null,
    screen: p.get('screen')
  }
}

export function useAdresse(): [Adresse, (next: Partial<Adresse>) => void] {
  const [adresse, setAdresse] = useState<Adresse>(lesen)

  // Der Zurück-Knopf des Browsers muss funktionieren. Wer ihn an einer
  // Rezeption drückt, erwartet den vorigen Bildschirm und nicht die
  // vorige Website.
  useEffect(() => {
    const onPop = (): void => { setAdresse(lesen()) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [])

  const setzen = (next: Partial<Adresse>): void => {
    const ziel = { ...adresse, ...next }
    const p = new URLSearchParams(location.search)
    if (ziel.property === null) p.delete('property')
    else p.set('property', String(ziel.property))
    if (ziel.screen === null) p.delete('screen')
    else p.set('screen', ziel.screen)
    history.pushState(null, '', `${location.pathname}?${p.toString()}`)
    setAdresse(ziel)
  }

  return [adresse, setzen]
}
