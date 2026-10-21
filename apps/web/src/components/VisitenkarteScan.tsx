import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../lib/i18n/index.js'
import { anschriftAusKarte, vorschlagErgaenzen, type AnschriftVorschlag, type KartenZeile }
  from '../lib/visitenkarte.js'
import { leserAnlegen, type Fortschritt, type Leser } from '../lib/leser.js'

/**
 * Ein Knopf, der die Kamera oeffnet.
 *
 * Ein Dateifeld mit `capture` und kein eigener Kamerabildschirm: das Telefon
 * oeffnet damit seine eigene Kamera mit Schaerfe, Blitz und Ausloeser, die
 * jeder kennt, und am Rechner kommt die Dateiauswahl. Als `label` um das
 * Feld, damit der Druck selbst die Kamera oeffnet; ein Klick, der erst nach
 * einem Neuzeichnen ausgeloest wird, laesst Safari nicht durch.
 */
export function KarteFotografieren({ onBild, className, children, sofort }: {
  onBild: (bild: File) => void
  className?: string
  children: ReactNode
  /**
   * Gleich die Kamera oeffnen (Schnellaktion am App-Symbol). Ohne Tippen
   * laesst das System sie nicht immer zu; dann bleibt der Knopf, und ein
   * Tippen genuegt.
   */
  sofort?: boolean
}): JSX.Element {
  const feld = useRef<HTMLInputElement>(null)
  useEffect(() => { if (sofort === true) feld.current?.click() }, [])
  return (
    <label className={`cursor-pointer ${className ?? ''}`}>
      {children}
      <input ref={feld} type="file" accept="image/*" capture="environment" className="sr-only"
             onChange={e => {
               const bild = e.target.files?.[0]
               // Leeren, damit dieselbe Datei ein zweites Mal ausloest.
               e.target.value = ''
               if (bild !== undefined) onBild(bild)
             }} />
    </label>
  )
}

const LEER: AnschriftVorschlag = {
  name: '', addressLine1: '', postalCode: '', city: '', country: '', vatId: ''
}

/**
 * Visitenkarte lesen und die erkannte Anschrift zur Pruefung vorlegen.
 *
 * **Erst bestaetigen, dann uebernehmen.** Die Erkennung schlaegt vor, die
 * Rezeption sieht den Vorschlag in eigenen Feldern, korrigiert ihn und
 * uebernimmt ihn dann ins Formular; gespeichert wird weiter nur ueber
 * „Speichern" dort. Ein Foto, das unbemerkt eine falsche Anschrift in die
 * Firma schreibt, faellt erst auf der Rechnung auf.
 *
 * **Vorder- und Rueckseite.** Manche Karten tragen den Namen vorn und die
 * Anschrift hinten. Jede weitere Seite wird gelesen und fuellt nur Felder,
 * die noch leer sind -- was schon korrigiert wurde, bleibt.
 *
 * **Nichts bleibt liegen.** Das Foto wird im Geraet gelesen (`lib/leser.ts`:
 * in der App von iOS oder Android, im Browser von Tesseract), nicht hochgeladen und nicht gespeichert; mit dem
 * Schliessen ist es weg.
 */
export function VisitenkarteScan({ erstesBild, onUebernehmen, onSchliessen }: {
  erstesBild: File
  onUebernehmen: (v: AnschriftVorschlag) => void
  onSchliessen: () => void
}): JSX.Element {
  const t = useT()
  const leser = useRef<Promise<Leser> | null>(null)
  const zeilen = useRef<KartenZeile[]>([])
  const [texte, setTexte] = useState<string[]>([])
  const [vorschlag, setVorschlag] = useState<AnschriftVorschlag | null>(null)
  const [stand, setStand] = useState<Fortschritt | null>(null)
  const [fehler, setFehler] = useState(false)

  // Jeder Aufbau bekommt eine eigene Runde. Was eine abgebaute Runde noch
  // zurueckliefert, wird verworfen: der StrictMode baut im Entwicklungsbetrieb
  // gleich nach dem ersten Aufbau ab und wieder auf, und das Ergebnis der
  // ersten Runde kaeme sonst aus einem schon beendeten Leser.
  const runde = useRef(0)

  const lesen = async (bild: File): Promise<void> => {
    const meine = runde.current
    const aktuell = (): boolean => meine === runde.current
    setFehler(false)
    setStand({ schritt: 'laden' })
    try {
      leser.current ??= leserAnlegen()
      const l = await leser.current
      // Haengt die Erkennung trotz allem, steht nach zwei Minuten der
      // Fehler da und nicht endlos „wird gelesen"; der Leser faengt neu an.
      let uhr: ReturnType<typeof setTimeout> | undefined
      const ergebnis = await Promise.race([
        l.lesen(bild, f => { if (aktuell()) setStand(f) }),
        new Promise<never>((_, nein) => { uhr = setTimeout(() => nein(new Error('Zeit')), 120_000) })
      ]).catch(async (e: unknown) => {
        if (aktuell()) leser.current = null
        await l.beenden()
        throw e
      }).finally(() => clearTimeout(uhr))
      if (!aktuell()) return
      zeilen.current = [...zeilen.current, ...ergebnis.zeilen]
      const neu = anschriftAusKarte(zeilen.current)
      setTexte(v => [...v, ergebnis.text])
      setVorschlag(v => (v === null ? neu : vorschlagErgaenzen(v, neu)))
    } catch {
      if (!aktuell()) return
      leser.current = null
      setFehler(true)
    } finally {
      if (aktuell()) setStand(null)
    }
  }

  // Die erste Seite liest sich von selbst; beim Abbau wird der Leser
  // beendet, damit kein Worker mit dem Bild im Speicher weiterlaeuft.
  useEffect(() => {
    void lesen(erstesBild)
    return () => {
      runde.current++
      const l = leser.current
      leser.current = null
      zeilen.current = []
      void l?.then(x => x.beenden())
    }
  }, [])

  const feld = (schluessel: keyof AnschriftVorschlag, beschriftung: string,
                extra = ''): JSX.Element => (
    <label className={`block ${extra}`}>
      <span className="block text-xs text-neutral-600">{beschriftung}</span>
      <input value={vorschlag?.[schluessel] ?? ''}
             onChange={e => setVorschlag(v => ({ ...(v ?? LEER), [schluessel]: e.target.value }))}
             className="mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
    </label>
  )

  const nichts = vorschlag !== null && Object.values(vorschlag).every(w => w.trim() === '')

  return (
    <div className="space-y-2 border border-sky-200 bg-sky-50/50 rounded-sm p-3">
      {stand !== null && (
        <p className="text-sm text-neutral-700" role="status">
          {stand.schritt === 'laden'
            ? t('visitenkarte.laden')
            : t('visitenkarte.lesen', { prozent: Math.round(stand.anteil * 100) })}
        </p>
      )}
      {fehler && <p className="text-sm text-red-700">{t('visitenkarte.fehler')}</p>}

      {vorschlag !== null && (
        <>
          <h3 className="text-sm font-medium">{t('visitenkarte.vorschlag')}</h3>
          {nichts && <p className="text-xs text-amber-800">{t('visitenkarte.nichtsErkannt')}</p>}
          {feld('name', t('companies.name'))}
          {feld('addressLine1', t('companies.address'))}
          <div className="grid grid-cols-3 gap-2">
            {feld('postalCode', t('companies.postalCode'))}
            {feld('city', t('companies.city'), 'col-span-2')}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {feld('country', t('companies.country'))}
            {feld('vatId', t('companies.vatId'), 'col-span-2')}
          </div>
          <p className="text-xs text-neutral-500">
            {t('visitenkarte.seiten', { anzahl: texte.length })}
          </p>
          {texte.some(x => x.trim() !== '') && (
            <details className="text-xs text-neutral-600">
              <summary className="cursor-pointer">{t('visitenkarte.text')}</summary>
              {/* Zum Abschreiben, was der Vorschlag verfehlt hat. */}
              <pre className="mt-1 whitespace-pre-wrap font-sans">{texte.join('\n\n')}</pre>
            </details>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {vorschlag !== null && (
          <button type="button" disabled={stand !== null}
                  onClick={() => onUebernehmen(vorschlag)}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('visitenkarte.uebernehmen')}
          </button>
        )}
        {stand === null && (
          <KarteFotografieren onBild={b => void lesen(b)}
                              className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300 bg-white">
            📷 {vorschlag === null ? t('visitenkarte.scan') : t('visitenkarte.weitereSeite')}
          </KarteFotografieren>
        )}
        <button type="button" onClick={onSchliessen}
                className="text-sm text-neutral-500 underline">
          {t('visitenkarte.verwerfen')}
        </button>
      </div>
      <p className="text-xs text-neutral-500">{t('visitenkarte.hinweis')}</p>
    </div>
  )
}
