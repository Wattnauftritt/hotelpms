import { useRef, useState } from 'react'

/**
 * Zeichenfeld fuer eine Unterschrift, per Maus oder Finger, als Bild exportiert.
 *
 * Stand bis zum Online-Check-in in `routes/CheckIn.tsx`. Jetzt zeichnen drei
 * Stellen damit -- Tresen, Hausbedingung, Gastseite am Terminal --, und die
 * Schnittstelle nimmt auf der oeffentlichen Seite genau **diese** Form an
 * und keine andere (`istUnterschriftSvg` im Vertrag). Zwei Zeichenfelder,
 * die verschieden exportieren, ergaeben eine Unterschrift, die am Tresen
 * geht und am Terminal abgewiesen wird.
 *
 * **Die Koordinaten werden auf die Leinwand umgerechnet.** Die Leinwand hat
 * eine feste Aufloesung, angezeigt wird sie in der Breite des Behaelters.
 * Ohne Umrechnung lag die Linie auf einem breiten Bildschirm neben dem
 * Finger -- am Tresen kaum aufgefallen, an einem Terminal mit doppelter
 * Breite nicht zu uebersehen.
 */
export function Unterschriftsfeld({ onChange, beschriftungLoeschen, gross = false }: {
  onChange: (svg: string | null) => void
  beschriftungLoeschen: string
  /** Fuer das Terminal: groesser, mit dickerer Linie. */
  gross?: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [zeichnet, setZeichnet] = useState(false)
  const breite = gross ? 720 : 360
  const hoehe = gross ? 240 : 120

  const punkt = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (e.currentTarget.width / rect.width),
      y: (e.clientY - rect.top) * (e.currentTarget.height / rect.height)
    }
  }

  const exportieren = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const png = canvas.toDataURL('image/png')
    onChange(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" `
      + `height="${canvas.height}"><image href="${png}" width="${canvas.width}" `
      + `height="${canvas.height}"/></svg>`)
  }

  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} width={breite} height={hoehe}
              className="w-full border border-neutral-300 rounded touch-none bg-white"
              onPointerDown={e => {
                setZeichnet(true)
                const ctx = e.currentTarget.getContext('2d')
                const { x, y } = punkt(e)
                if (!ctx) return
                ctx.lineWidth = gross ? 3 : 1.5
                ctx.lineCap = 'round'
                ctx.beginPath(); ctx.moveTo(x, y)
              }}
              onPointerMove={e => {
                if (!zeichnet) return
                const ctx = e.currentTarget.getContext('2d')
                const { x, y } = punkt(e)
                if (!ctx) return
                ctx.lineTo(x, y); ctx.stroke()
              }}
              onPointerUp={() => { setZeichnet(false); exportieren() }} />
      <button type="button"
              onClick={() => {
                const canvas = canvasRef.current
                canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
                onChange(null)
              }}
              className={`${gross ? 'text-base' : 'text-xs'} text-neutral-500 underline`}>
        {beschriftungLoeschen}
      </button>
    </div>
  )
}
