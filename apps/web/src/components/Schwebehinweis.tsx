import { useEffect, useState, type JSX, type RefObject } from 'react'

/**
 * Der Hinweis ueber einem Balken im Belegungsplan, sofort statt nach einer
 * Sekunde.
 *
 * Vorher war es das `title`-Attribut. Dessen Verzoegerung legt der Browser
 * fest, nicht die Seite -- in Chrome rund eine Sekunde, und wer den Zeiger
 * ein wenig bewegt, wartet von vorn. Am Plan faehrt man mit der Maus die
 * Balken ab, um zu sehen, wer wann kommt; eine Sekunde je Balken ist dort
 * "traege" (Sven, 04.10.2026).
 *
 * **Ein Hinweis fuer den ganzen Plan, nicht einer je Balken.** Er haengt
 * mit eigenen Ereignissen am Raster und liest den Text aus `data-tip` am
 * Balken. Damit bleibt der Zustand hier: ein Zustand im Plan liesse ihn
 * bei jeder Mausbewegung neu zeichnen, und die gemerkten Zimmerzeilen
 * bekaemen eine Eigenschaft, die sich staendig aendert. Der Text liegt
 * schon im Balken; nachgeladen wird nichts.
 *
 * Beim Druecken verschwindet er: wer einen Balken zieht, braucht die Flaeche
 * darunter, nicht einen Kasten, der mitwandert.
 */
const VERZOEGERUNG_MS = 120
const ABSTAND = 14

export function Schwebehinweis({ bereich }: { bereich: RefObject<HTMLElement | null> })
  : JSX.Element | null {
  const [hinweis, setHinweis] = useState<{ text: string; x: number; y: number } | null>(null)

  useEffect(() => {
    const el = bereich.current
    if (el === null) return
    let wartet: ReturnType<typeof setTimeout> | undefined
    let gedrueckt = false
    let sichtbar = false
    let letzte: { text: string; x: number; y: number } | null = null
    const ziel = (e: Event): HTMLElement | null =>
      (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null

    const weg = (): void => { clearTimeout(wartet); sichtbar = false; setHinweis(null) }
    const bewegt = (e: PointerEvent): void => {
      if (gedrueckt) return
      const balken = ziel(e)
      const text = balken?.dataset.tip
      if (text === undefined || text === '') { weg(); return }
      letzte = { text, x: e.clientX, y: e.clientY }
      // Steht schon einer, wandert er mit, ohne neue Wartezeit: wer von
      // Balken zu Balken faehrt, soll nicht bei jedem neu warten.
      if (sichtbar) { setHinweis(letzte); return }
      clearTimeout(wartet)
      wartet = setTimeout(() => { sichtbar = true; setHinweis(letzte) }, VERZOEGERUNG_MS)
    }
    const runter = (): void => { gedrueckt = true; weg() }
    const hoch = (): void => { gedrueckt = false }

    el.addEventListener('pointermove', bewegt)
    el.addEventListener('pointerleave', weg)
    el.addEventListener('pointerdown', runter)
    el.addEventListener('scroll', weg, { passive: true })
    window.addEventListener('pointerup', hoch)
    return () => {
      clearTimeout(wartet)
      el.removeEventListener('pointermove', bewegt)
      el.removeEventListener('pointerleave', weg)
      el.removeEventListener('pointerdown', runter)
      el.removeEventListener('scroll', weg)
      window.removeEventListener('pointerup', hoch)
    }
  }, [bereich])

  if (hinweis === null) return null
  // Am rechten und unteren Rand nach innen geklappt, statt aus dem Fenster
  // zu laufen. Die Masse sind geschaetzt; der Kasten ist nie breiter als
  // `max-w-sm`.
  const links = hinweis.x + ABSTAND + 384 > window.innerWidth
    ? Math.max(4, hinweis.x - ABSTAND - 384) : hinweis.x + ABSTAND
  const zeilen = hinweis.text.split('\n').length
  const oben = hinweis.y + ABSTAND + zeilen * 18 + 16 > window.innerHeight
    ? Math.max(4, hinweis.y - ABSTAND - zeilen * 18 - 16) : hinweis.y + ABSTAND
  return (
    <div role="tooltip" style={{ left: links, top: oben }}
         className="fixed z-50 max-w-sm pointer-events-none whitespace-pre-line
                    rounded-sm border border-neutral-300 bg-white px-2 py-1 text-xs
                    leading-[18px] text-neutral-800 shadow-md">
      {hinweis.text}
    </div>
  )
}
