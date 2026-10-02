import { useRef } from 'react'

/**
 * Zeichenfeld fuer eine Unterschrift, per Maus, Stift oder Finger, als Bild
 * exportiert.
 *
 * **Eine Stelle fuer das Format.** Stand bis zum Online-Check-in in
 * `routes/CheckIn.tsx`. Jetzt zeichnen vier Stellen damit -- Tresen,
 * Hausbedingung, Gastseite und Gaesteterminal --, und die Schnittstelle
 * nimmt auf den Wegen ohne Mitarbeiter genau **diese** Form an und keine
 * andere (`istUnterschriftSvg` im Vertrag): ein SVG, das ein PNG der
 * gezeichneten Linie einbettet. Zwei Zeichenfelder, die verschieden
 * exportieren, ergaeben eine Unterschrift, die am Tresen geht und am
 * Terminal abgewiesen wird. Beide Arbeiten (Online-Check-in, Dokument 30;
 * Gaesteterminal, Dokument 31) hatten eines gebaut; das hier ist das
 * zusammengefuehrte.
 *
 * **Die Koordinaten werden auf die Leinwand umgerechnet.** Die Leinwand hat
 * eine feste Aufloesung, angezeigt wird sie in der Breite des Behaelters.
 * Ohne Umrechnung lag die Linie auf einem breiten Bildschirm neben dem
 * Finger -- am Tresen kaum aufgefallen, an einem Terminal nicht zu
 * uebersehen.
 *
 * **Ein blosses Antippen ist keine Unterschrift.** Exportiert wird erst,
 * wenn tatsaechlich eine Linie gezogen wurde; sonst ginge ein leeres Bild
 * als unterschriebener Schein hinaus.
 *
 * Die Beschriftung des Knopfes kommt fertig uebersetzt herein: die
 * Gastseite fuehrt ihre eigene Sprache (die des Gastes), die Rezeption die
 * des Personals.
 */
export function Unterschriftsfeld({ onChange, beschriftungLoeschen, gross = false,
                                    breite, hoehe }: {
  onChange: (svg: string | null) => void
  beschriftungLoeschen: string
  /** Fuer Gastseite und Terminal: groesser, mit dickerer Linie. */
  gross?: boolean
  /** Aufloesung der Leinwand; angezeigt wird sie in der Breite des Rahmens. */
  breite?: number
  hoehe?: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const zeichnet = useRef(false)
  const gezogen = useRef(false)
  const b = breite ?? (gross ? 720 : 360)
  const h = hoehe ?? (gross ? 240 : 120)

  const punkt = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = e.currentTarget
    const rect = c.getBoundingClientRect()
    return { x: (e.clientX - rect.left) * (c.width / rect.width),
             y: (e.clientY - rect.top) * (c.height / rect.height) }
  }

  const exportieren = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const png = canvas.toDataURL('image/png')
    onChange(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" `
      + `height="${canvas.height}"><image href="${png}" width="${canvas.width}" `
      + `height="${canvas.height}"/></svg>`)
  }

  const loeschen = (): void => {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    gezogen.current = false
    onChange(null)
  }

  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} width={b} height={h}
              className="w-full border border-neutral-300 rounded touch-none bg-white"
              onPointerDown={e => {
                zeichnet.current = true
                e.currentTarget.setPointerCapture?.(e.pointerId)
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
              onPointerUp={() => {
                zeichnet.current = false
                if (gezogen.current) exportieren()
              }}
              onPointerCancel={() => { zeichnet.current = false }} />
      <button type="button" onClick={loeschen}
              className={gross
                ? 'px-4 py-2 text-base rounded border border-neutral-300'
                : 'text-xs text-neutral-500 underline'}>
        {beschriftungLoeschen}
      </button>
    </div>
  )
}
