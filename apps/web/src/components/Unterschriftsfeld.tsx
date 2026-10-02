import { useRef } from 'react'
import { useT, type TextKey } from '../lib/i18n/index.js'

/**
 * Das Unterschriftsfeld: Zeichnen mit Maus, Stift oder Finger.
 *
 * **Eine Stelle fuer das Format.** Gespeichert wird ein SVG, das ein PNG der
 * gezeichneten Linie einbettet -- so stand es seit jeher im Check-in, und
 * so liegen die Unterschriften in `registration.signature_svg` und
 * `guest_agreement.signature_svg`. Am Gaesteterminal unterschreibt jetzt
 * ein zweiter Ort; zwei Fassungen derselben Umwandlung liefen auseinander,
 * und dann laege dieselbe Art Nachweis in zwei Formen in derselben Spalte.
 *
 * **Mitbehoben: die Linie lag neben dem Finger.** Die Leinwand hatte 360
 * Pixel Breite, wurde per CSS aber auf die volle Breite der Maske gezogen;
 * gezeichnet wurde mit den Koordinaten des Bildschirms. In einer breiten
 * Maske landete der Strich damit nur auf einem Teil des Weges, den der
 * Finger ging. Jetzt wird umgerechnet.
 */

/** Die Leinwand als SVG mit eingebettetem PNG -- das gespeicherte Format. */
export function unterschriftAlsSvg(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL('image/png')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" `
    + `height="${canvas.height}"><image href="${png}" width="${canvas.width}" `
    + `height="${canvas.height}"/></svg>`
}

export function Unterschriftsfeld({ onChange, breite = 360, hoehe = 120, gross = false,
                                    leeren = 'checkin.clear' }: {
  onChange: (svg: string | null) => void
  /** Aufloesung der Leinwand. Angezeigt wird sie in der Breite des Rahmens. */
  breite?: number
  hoehe?: number
  /** Am Touchscreen: dickere Linie, groesserer Knopf. */
  gross?: boolean
  leeren?: TextKey
}): JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const zeichnet = useRef(false)
  const gezogen = useRef(false)

  const punkt = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = e.currentTarget
    const rect = c.getBoundingClientRect()
    return { x: (e.clientX - rect.left) * (c.width / rect.width),
             y: (e.clientY - rect.top) * (c.height / rect.height) }
  }

  const loeschen = (): void => {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    gezogen.current = false
    onChange(null)
  }

  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} width={breite} height={hoehe}
              className="w-full border border-neutral-300 rounded touch-none bg-white"
              onPointerDown={e => {
                zeichnet.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                const ctx = e.currentTarget.getContext('2d')
                if (!ctx) return
                ctx.lineWidth = gross ? 4 : 2
                ctx.lineCap = 'round'
                ctx.lineJoin = 'round'
                const { x, y } = punkt(e)
                ctx.beginPath(); ctx.moveTo(x, y)
              }}
              onPointerMove={e => {
                if (!zeichnet.current) return
                const ctx = e.currentTarget.getContext('2d')
                if (!ctx) return
                const { x, y } = punkt(e)
                ctx.lineTo(x, y); ctx.stroke()
                gezogen.current = true
              }}
              onPointerUp={e => {
                zeichnet.current = false
                // Ein blosses Antippen ist keine Unterschrift. Sonst ginge
                // ein leeres Bild als unterschriebener Schein hinaus.
                if (gezogen.current) onChange(unterschriftAlsSvg(e.currentTarget))
              }}
              onPointerCancel={() => { zeichnet.current = false }} />
      <button type="button" onClick={loeschen}
              className={gross
                ? 'px-4 py-2 text-base rounded border border-neutral-300'
                : 'text-xs text-neutral-500 underline'}>
        {t(leeren)}
      </button>
    </div>
  )
}
