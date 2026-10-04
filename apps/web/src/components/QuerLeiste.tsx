import { useEffect, useRef, useState, type JSX } from 'react'
import { addDays, daysBetween, today } from '../lib/dates.js'
import { leistenBereich } from '../lib/tapeGeometrie.js'
import { useT } from '../lib/i18n/index.js'

/**
 * Eine Scrollleiste zum Querscrollen durch die Zeit.
 *
 * Der Plan selbst scrollt nicht quer: er laedt genau das Fenster, das er
 * zeigt, und passt es in die Breite. Eine echte Leiste bekommt er deshalb
 * nicht von allein. Diese hier ist eine gewoehnliche Scrollleiste des
 * Browsers ueber eine unsichtbare Flaeche, so breit wie drei Jahre in der
 * Spaltenbreite des Plans -- der Schieber ist damit so breit wie der
 * sichtbare Ausschnitt, und Ziehen, Klicken neben den Schieber und das
 * Querrad am Touchpad tun, was man von einer Scrollleiste erwartet.
 *
 * **Der Plan folgt nach einer kurzen Pause, nicht bei jedem Pixel.** Ein
 * Zug ueber ein halbes Jahr sind 180 Tage; jeder waere ein Aufruf. Die
 * Leiste selbst bewegt sich sofort, und das Datum daneben auch, damit man
 * sieht, wohin man zieht.
 */
export function QuerLeiste(
  { von, tage, onVon, links }:
  { von: string; tage: number; onVon: (von: string) => void; links: number }
): JSX.Element {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [breite, setBreite] = useState(0)
  const { anfang, tageGesamt } = leistenBereich(today(), von, tage)
  const jeTag = tage > 0 && breite > 0 ? breite / tage : 0
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Wann zuletzt jemand an der Leiste gezogen hat. Solange der Zug laeuft,
  // folgt der Schieber nicht dem Plan -- sonst sprang er beim Nachladen auf
  // den Tag zurueck, an dem der Plan gerade steht, mitten unter der Hand.
  const zuletztGezogen = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const beobachter = new ResizeObserver(e => { setBreite(e[0]?.contentRect.width ?? 0) })
    beobachter.observe(el)
    return () => { beobachter.disconnect() }
  }, [])

  // Von aussen geblaettert (Pfeile, Datum, Heute): den Schieber nachziehen.
  // Liegt er schon auf dem Tag, nichts tun -- sonst loeste das Setzen ein
  // Scrollereignis aus, das denselben Tag noch einmal meldet.
  useEffect(() => {
    const el = ref.current
    if (el === null || jeTag === 0) return
    if (Date.now() - zuletztGezogen.current < 400) return
    const soll = daysBetween(anfang, von) * jeTag
    if (Math.round(el.scrollLeft / jeTag) !== daysBetween(anfang, von)) el.scrollLeft = soll
  }, [von, anfang, jeTag])

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  return (
    <div className="flex items-center" style={{ paddingLeft: links }}>
      <div ref={ref} aria-label={t('plan.scrollTime')} title={t('plan.scrollTime')}
           className="querleiste grow overflow-x-scroll overflow-y-hidden h-3"
           onScroll={e => {
             if (jeTag === 0) return
             zuletztGezogen.current = Date.now()
             const tag = Math.round(e.currentTarget.scrollLeft / jeTag)
             const ziel = addDays(anfang, tag)
             if (ziel === von) return
             if (timer.current !== null) clearTimeout(timer.current)
             timer.current = setTimeout(() => { onVon(ziel) }, 150)
           }}>
        <div style={{ width: jeTag * tageGesamt, height: 1 }} />
      </div>
    </div>
  )
}
