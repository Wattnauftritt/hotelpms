import { useEffect, useState, type ImgHTMLAttributes, type JSX, type ReactNode } from 'react'
import { nativ } from '@hotelpms/native'
import { apiFetch } from '../lib/api.js'
import { dateiGeben, dateienUeberApp, dateinameAus, holeApiDatei } from '../lib/datei.js'
import { Fehler } from './Shell.tsx'

/**
 * Ein Link auf eine Datei der Schnittstelle (Beleg, Export).
 *
 * Im Browser bleibt er, was er war: ein `<a>` auf `/v1/…` unter derselben
 * Herkunft, das Cookie geht mit. In der App fuehrte dieselbe Adresse auf die
 * Herkunft der App und ohne Token ins Leere; dort ist er ein Knopf, der die
 * Datei mit dem Token holt und in der Vorschau des Telefons oeffnet.
 */
export function DateiLink({ pfad, name, neuesFenster = false, className, children }: {
  pfad: string
  /** Dateiname in der App, falls die Antwort keinen nennt. */
  name: string
  neuesFenster?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<unknown>(null)
  if (!dateienUeberApp()) {
    return neuesFenster
      ? <a href={pfad} target="_blank" rel="noreferrer" className={className}>{children}</a>
      : <a href={pfad} className={className}>{children}</a>
  }
  const oeffnen = async (): Promise<void> => {
    setLaedt(true)
    setFehler(null)
    try {
      const res = await holeApiDatei(pfad)
      await dateiGeben(await res.blob(), dateinameAus(res, name))
    } catch (e) {
      setFehler(e)
    } finally {
      setLaedt(false)
    }
  }
  return (
    <>
      <button type="button" disabled={laedt} onClick={() => { void oeffnen() }} className={className}>
        {children}
      </button>
      {fehler !== null && <Fehler error={fehler} />}
    </>
  )
}

/**
 * Ein Bild der Schnittstelle (Logo, Bild einer Terminalseite). In der App
 * mit Token geholt und als Blob gezeigt, aus demselben Grund wie oben; im
 * Browser unveraendert ueber die Adresse.
 */
export function ApiBild({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }): JSX.Element | null {
  const app = nativ() !== undefined
  const [url, setUrl] = useState<string | null>(app ? null : src)
  useEffect(() => {
    if (!app) { setUrl(src); return }
    let vorbei = false
    let blobUrl: string | null = null
    void apiFetch(src)
      .then(r => r.ok ? r.blob() : null)
      .then(b => {
        if (b === null || vorbei) return
        blobUrl = URL.createObjectURL(b)
        setUrl(blobUrl)
      })
      .catch(() => { /* ohne Bild, wie ein kaputtes img */ })
    return () => {
      vorbei = true
      if (blobUrl !== null) URL.revokeObjectURL(blobUrl)
    }
  }, [src, app])
  return url === null ? null : <img src={url} {...rest} />
}
