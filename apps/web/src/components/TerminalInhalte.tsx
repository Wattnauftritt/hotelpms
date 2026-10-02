import { useEffect, useState } from 'react'
import { useEscape } from '../lib/tasten.js'
import { useT } from '../lib/i18n/index.js'
import { useTerminalInhalte, useCreateSeite, useAendereSeite, useArchiviereSeite,
         useSeitenbild, useDiashow, useCreateAdresse, useEntferneAdresse,
         type Seite } from '../lib/queries/terminal.js'
import { Inhaltstext } from './Inhaltstext.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Was das Gaesteterminal zeigen darf: Seiten, die Diashow des Ruhezustands
 * und die freigegebenen externen Adressen (Dokument 31, §11).
 *
 * Das Haus legt hier vorher fest, was auf einem Gastbildschirm erscheinen
 * kann; die Rezeption waehlt danach nur noch aus. Kein freies HTML, keine
 * beliebige Adresse -- die Gruende stehen an den Routen
 * (`routes/terminalInhalte.ts`).
 */
export function TerminalInhalte({ propertyId }: { propertyId: number }): JSX.Element {
  const q = useTerminalInhalte(propertyId)
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  return (
    <div className="space-y-6">
      <Seiten propertyId={propertyId} seiten={q.data.contents} />
      <Diashow propertyId={propertyId} seiten={q.data.contents} />
      <Adressen propertyId={propertyId} adressen={q.data.urls} />
    </div>
  )
}

const FELD = 'w-full border border-neutral-300 rounded px-2 py-1 text-sm'
const KNOPF_KLEIN = 'text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50'

/** Datei als data-URL lesen. Die Schnittstelle prueft die Art an den Bytes. */
function alsDataUrl(datei: File): Promise<string> {
  return new Promise((ok, fehler) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fehler(r.error)
    r.readAsDataURL(datei)
  })
}

function Seiten({ propertyId, seiten }: { propertyId: number; seiten: Seite[] }): JSX.Element {
  const t = useT()
  const anlegen = useCreateSeite(propertyId)
  const [titel, setTitel] = useState('')
  const [text, setText] = useState('')
  const [bearbeitet, setBearbeitet] = useState<string | null>(null)

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <h2 className="text-sm font-medium">{t('inhalte.title')}</h2>
      <p className="text-xs text-neutral-600">{t('inhalte.hint')}</p>

      {seiten.length === 0 && <p className="text-sm text-neutral-500">{t('inhalte.keine')}</p>}
      <ul className="space-y-2">
        {seiten.map(s => bearbeitet === s.contentRef
          ? <SeiteBearbeiten key={s.contentRef} propertyId={propertyId} seite={s}
                             onFertig={() => setBearbeitet(null)} />
          : <SeiteKarte key={s.contentRef} propertyId={propertyId} seite={s}
                        onBearbeiten={() => setBearbeitet(s.contentRef)} />)}
      </ul>

      <form className="space-y-2 border-t border-neutral-100 pt-3"
            onSubmit={e => {
              e.preventDefault()
              if (titel.trim() === '') return
              anlegen.mutate({ title: titel.trim(), body: text },
                { onSuccess: () => { setTitel(''); setText('') } })
            }}>
        <input value={titel} onChange={e => setTitel(e.target.value)} maxLength={120}
               placeholder={t('inhalte.titel')} aria-label={t('inhalte.titel')} className={FELD} />
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={5000} rows={4}
                  placeholder={t('inhalte.text')} aria-label={t('inhalte.text')} className={FELD} />
        {anlegen.isError && <Fehler error={anlegen.error} />}
        <button type="submit" disabled={titel.trim() === '' || anlegen.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:bg-neutral-300">
          {t('inhalte.neu')}
        </button>
      </form>
    </section>
  )
}

function SeiteKarte({ propertyId, seite, onBearbeiten }: {
  propertyId: number; seite: Seite; onBearbeiten: () => void
}): JSX.Element {
  const t = useT()
  const bild = useSeitenbild(propertyId)
  const archivieren = useArchiviereSeite(propertyId)
  return (
    <li className="border border-neutral-200 rounded p-2 space-y-2">
      <div className="flex items-start gap-3">
        {seite.imageRef !== null && (
          <img src={`/v1/properties/${propertyId}/terminal-images/${seite.imageRef}`} alt=""
               className="w-20 h-14 object-cover rounded border border-neutral-200" />
        )}
        <div className="grow min-w-0">
          <div className="text-sm font-medium">{seite.title}</div>
          <div className="text-neutral-600 line-clamp-3"><Inhaltstext text={seite.body} /></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBearbeiten} className={KNOPF_KLEIN}>
          {t('inhalte.bearbeiten')}
        </button>
        <label className={`${KNOPF_KLEIN} cursor-pointer`}>
          {t('inhalte.bild')}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                 onChange={e => {
                   const f = e.target.files?.[0]
                   e.target.value = ''
                   if (f === undefined) return
                   void alsDataUrl(f).then(data =>
                     bild.mutate({ contentRef: seite.contentRef, data }))
                 }} />
        </label>
        {seite.imageRef !== null && (
          <button type="button" className={KNOPF_KLEIN}
                  onClick={() => bild.mutate({ contentRef: seite.contentRef, data: null })}>
            {t('inhalte.bildEntfernen')}
          </button>
        )}
        <button type="button" className={`${KNOPF_KLEIN} text-red-800 border-red-300`}
                onClick={() => {
                  if (confirm(t('inhalte.archivierenConfirm', { titel: seite.title }))) {
                    archivieren.mutate(seite.contentRef)
                  }
                }}>
          {t('inhalte.archivieren')}
        </button>
        <span className="text-xs text-neutral-500">{t('inhalte.bildHint')}</span>
      </div>
      {bild.isError && <Fehler error={bild.error} />}
      {archivieren.isError && <Fehler error={archivieren.error} />}
    </li>
  )
}

/** Bearbeiten an Ort und Stelle; Escape verwirft. */
function SeiteBearbeiten({ propertyId, seite, onFertig }: {
  propertyId: number; seite: Seite; onFertig: () => void
}): JSX.Element {
  const t = useT()
  const aendern = useAendereSeite(propertyId)
  const [titel, setTitel] = useState(seite.title)
  const [text, setText] = useState(seite.body)
  useEscape(onFertig)
  return (
    <li className="border border-neutral-300 rounded p-2 space-y-2">
      <input value={titel} onChange={e => setTitel(e.target.value)} maxLength={120}
             aria-label={t('inhalte.titel')} className={FELD} autoFocus />
      <textarea value={text} onChange={e => setText(e.target.value)} maxLength={5000} rows={6}
                aria-label={t('inhalte.text')} className={FELD} />
      {aendern.isError && <Fehler error={aendern.error} />}
      <div className="flex gap-2">
        <button type="button" disabled={titel.trim() === '' || aendern.isPending}
                onClick={() => aendern.mutate(
                  { contentRef: seite.contentRef, title: titel.trim(), body: text },
                  { onSuccess: onFertig })}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:bg-neutral-300">
          {t('inhalte.speichern')}
        </button>
        <button type="button" onClick={onFertig}
                className="px-3 py-1.5 text-sm rounded border border-neutral-300">
          {t('common.cancel')}
        </button>
      </div>
    </li>
  )
}

/**
 * Die Diashow: Seiten in einer Reihenfolge, jede mit ihrer Dauer. Bearbeitet
 * wird eine Abschrift, gespeichert die ganze Folge auf einmal -- eine Folge,
 * die halb gespeichert ist, zeigt am Terminal etwas, das niemand wollte.
 */
function Diashow({ propertyId, seiten }: { propertyId: number; seiten: Seite[] }): JSX.Element {
  const t = useT()
  const speichern = useDiashow(propertyId)
  const ausDaten = (): Array<{ contentRef: string; seconds: number }> => seiten
    .filter(s => s.idlePosition !== null)
    .sort((a, b) => (a.idlePosition ?? 0) - (b.idlePosition ?? 0))
    .map(s => ({ contentRef: s.contentRef, seconds: s.idleSeconds ?? 10 }))
  const [folge, setFolge] = useState(ausDaten)
  const stand = JSON.stringify(ausDaten())
  // Neu geladen (gespeichert, Seite archiviert): die Abschrift folgt dem Stand.
  useEffect(() => {
    setFolge(JSON.parse(stand) as Array<{ contentRef: string; seconds: number }>)
  }, [stand])
  const titel = (ref: string): string => seiten.find(s => s.contentRef === ref)?.title ?? ref
  const frei = seiten.filter(s => !folge.some(f => f.contentRef === s.contentRef))

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <h2 className="text-sm font-medium">{t('diashow.title')}</h2>
      <p className="text-xs text-neutral-600">{t('diashow.hint')}</p>
      <ol className="space-y-1">
        {folge.map((f, i) => (
          <li key={f.contentRef} className="flex items-center gap-2 text-sm">
            <span className="w-6 text-neutral-400 tabular-nums">{i + 1}.</span>
            <span className="grow">{titel(f.contentRef)}</span>
            <input type="number" min={3} max={600} value={f.seconds}
                   aria-label={t('diashow.sekunden')}
                   onChange={e => setFolge(folge.map(x => x.contentRef === f.contentRef
                     ? { ...x, seconds: Number(e.target.value) } : x))}
                   className="w-20 border border-neutral-300 rounded px-2 py-1 text-sm" />
            <span className="text-xs text-neutral-500">{t('diashow.sekunden')}</span>
            {i > 0 && (
              <button type="button" className={KNOPF_KLEIN} aria-label={t('diashow.hoch')}
                      onClick={() => {
                        const n = [...folge]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setFolge(n)
                      }}>↑</button>
            )}
            <button type="button" className={KNOPF_KLEIN}
                    onClick={() => setFolge(folge.filter(x => x.contentRef !== f.contentRef))}>
              {t('diashow.entfernen')}
            </button>
          </li>
        ))}
      </ol>
      {frei.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {frei.map(s => (
            <button key={s.contentRef} type="button" className={KNOPF_KLEIN}
                    onClick={() => setFolge([...folge, { contentRef: s.contentRef, seconds: 10 }])}>
              + {s.title}
            </button>
          ))}
        </div>
      )}
      {speichern.isError && <Fehler error={speichern.error} />}
      <button type="button" disabled={speichern.isPending || JSON.stringify(folge) === stand}
              onClick={() => speichern.mutate(folge)}
              className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:bg-neutral-300">
        {t('diashow.speichern')}
      </button>
    </section>
  )
}

/**
 * Die Freigabeliste. Die Vorschau zeigt die Seite im selben abgeschotteten
 * Rahmen wie das Terminal -- bleibt sie hier leer, bleibt sie dort leer
 * (X-Frame-Options), und das soll das Haus beim Freigeben sehen, nicht der
 * Gast am Terminal.
 */
function Adressen({ propertyId, adressen }: {
  propertyId: number; adressen: Array<{ urlRef: string; label: string; url: string }>
}): JSX.Element {
  const t = useT()
  const anlegen = useCreateAdresse(propertyId)
  const entfernen = useEntferneAdresse(propertyId)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [vorschau, setVorschau] = useState<string | null>(null)
  useEscape(() => setVorschau(null), vorschau !== null)

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <h2 className="text-sm font-medium">{t('adressen.title')}</h2>
      <p className="text-xs text-neutral-600">{t('adressen.hint')}</p>
      {adressen.length === 0 && <p className="text-sm text-neutral-500">{t('adressen.keine')}</p>}
      <ul className="space-y-1">
        {adressen.map(a => (
          <li key={a.urlRef} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{a.label}</span>
            <span className="text-neutral-500 truncate grow">{a.url}</span>
            <button type="button" className={KNOPF_KLEIN}
                    onClick={() => setVorschau(vorschau === a.url ? null : a.url)}>
              {t('adressen.vorschau')}
            </button>
            <button type="button" className={`${KNOPF_KLEIN} text-red-800 border-red-300`}
                    onClick={() => entfernen.mutate(a.urlRef)}>
              {t('adressen.entfernen')}
            </button>
          </li>
        ))}
      </ul>
      {vorschau !== null && (
        <iframe src={vorschau} title={t('adressen.vorschau')} referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms"
                className="w-full h-80 border border-neutral-300 rounded" />
      )}
      <form className="flex flex-wrap gap-2 items-end"
            onSubmit={e => {
              e.preventDefault()
              anlegen.mutate({ label: label.trim(), url: url.trim() },
                { onSuccess: () => { setLabel(''); setUrl('') } })
            }}>
        <input value={label} onChange={e => setLabel(e.target.value)} maxLength={80}
               placeholder={t('adressen.label')} aria-label={t('adressen.label')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm w-48" />
        <input value={url} onChange={e => setUrl(e.target.value)} maxLength={2000} type="url"
               placeholder={t('adressen.url')} aria-label={t('adressen.url')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm grow" />
        <button type="submit" disabled={label.trim() === '' || url.trim() === '' || anlegen.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:bg-neutral-300">
          {t('adressen.freigeben')}
        </button>
      </form>
      {anlegen.isError && <Fehler error={anlegen.error} />}
      {entfernen.isError && <Fehler error={entfernen.error} />}
    </section>
  )
}
