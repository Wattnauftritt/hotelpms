import { useState, type JSX } from 'react'
import { SPRACHNAMEN, type FolderLocale, type FolderPageTranslation,
         type GuestFolderSettings } from '@hotelpms/contracts'
import { useGaestemappeUebersetzung } from '../lib/queries/gaestemappe.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'
import { Inhaltstext } from './Inhaltstext.tsx'

/**
 * Die Uebersetzungen einer Seite der Gaestemappe (Migration 0144): der Stand
 * je Sprache, die deutsche Vorlage daneben, und eine Berichtigung von Hand.
 *
 * Die Vorlage steht oben und nicht in einem Reiter: wer eine Uebersetzung
 * prueft, liest Satz fuer Satz gegen das Original, und das geht nur, wenn
 * beides zugleich sichtbar ist.
 */

type Seite = GuestFolderSettings['pages'][number]

const FARBE: Record<FolderPageTranslation['state'], string> = {
  machine: 'text-emerald-800',
  manual: 'text-emerald-800',
  pending: 'text-neutral-500',
  failed: 'text-red-700'
}

/**
 * Wie die Sprache sich selbst nennt, wie in jeder Sprachwahl des Systems.
 * Die Schnittstelle liefert die Sprache als Zeichenkette; eine, die die
 * Oberflaeche noch nicht kennt, steht als Kuerzel da statt leer.
 */
function sprachname(lang: string): string {
  return SPRACHNAMEN[lang as FolderLocale] ?? lang.toUpperCase()
}

/**
 * Kurz in der Liste der Seiten: je Sprache das Kuerzel und ein Zeichen.
 * Umbrechend, weil es seit 0145 dreizehn sind.
 */
export function UebersetzungsStand({ seite }: { seite: Seite }): JSX.Element {
  const t = useT()
  return (
    <span className="flex flex-wrap gap-x-1.5 text-xs">
      {seite.translations.map(u => (
        <span key={u.lang} className={FARBE[u.state]}
              title={`${sprachname(u.lang)}: `
                + t(`folder.tr.state.${u.state}` as TextKey)}>
          {u.lang.toUpperCase()}{u.state === 'failed' ? ' !' : u.state === 'pending' ? ' …' : ' ✓'}
        </span>
      ))}
    </span>
  )
}

export function GaestemappeUebersetzung({ propertyId, seite, onClose }: {
  propertyId: number; seite: Seite; onClose: () => void
}): JSX.Element {
  const t = useT()
  return (
    <Dialog titel={t('folder.tr.title')} unterzeile={seite.title} breite="breit"
            onClose={onClose}
            fuss={<button type="button" className={KNOPF_LEISE} onClick={onClose}>
                    {t('folder.cardsClose')}</button>}>
      <div className="space-y-5">
        <section className="rounded-sm bg-neutral-50 p-3 space-y-1">
          <div className="text-xs text-neutral-500">{t('folder.tr.original')}</div>
          <div className="font-medium text-sm">{seite.title}</div>
          {seite.body.trim() !== '' && <Inhaltstext text={seite.body} />}
        </section>
        {seite.translations.map(u => (
          // Der Schluessel haengt am Text: kommt eine neue Uebersetzung,
          // stehen ihre Werte im Feld und nicht die der vorigen.
          <Sprache key={`${u.lang}:${u.state}:${u.title ?? ''}:${u.body ?? ''}`}
                   propertyId={propertyId} contentRef={seite.contentRef} u={u} />
        ))}
      </div>
    </Dialog>
  )
}

function Sprache({ propertyId, contentRef, u }: {
  propertyId: number; contentRef: string; u: FolderPageTranslation
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useGaestemappeUebersetzung(propertyId)
  const [titel, setTitel] = useState(u.title ?? '')
  const [text, setText] = useState(u.body ?? '')
  const geaendert = titel !== (u.title ?? '') || text !== (u.body ?? '')

  return (
    <section className="space-y-2 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-medium">
        {sprachname(u.lang)}
        <span className={`ml-2 font-normal ${FARBE[u.state]}`}>
          {t(`folder.tr.state.${u.state}` as TextKey)}
        </span>
      </h3>
      <label className="block text-sm">
        <span className="block text-xs text-neutral-600 mb-1">{t('folder.tr.field.title')}</span>
        <input value={titel} maxLength={300} onChange={e => setTitel(e.target.value)}
               className={FELD} lang={u.lang} />
      </label>
      <label className="block text-sm">
        <span className="block text-xs text-neutral-600 mb-1">{t('folder.tr.field.body')}</span>
        <textarea value={text} maxLength={10000} rows={5} onChange={e => setText(e.target.value)}
                  className={FELD} lang={u.lang} />
      </label>
      {setzen.isError && <Fehler error={setzen.error} />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={KNOPF}
                disabled={!online || !geaendert || titel.trim() === '' || setzen.isPending}
                onClick={() => setzen.mutate({ contentRef, lang: u.lang,
                                               text: { title: titel.trim(), body: text } })}>
          {t('folder.tr.saveManual')}
        </button>
        {(u.state === 'manual' || u.state === 'failed') && (
          <button type="button" className={KNOPF_LEISE} disabled={!online || setzen.isPending}
                  onClick={() => setzen.mutate({ contentRef, lang: u.lang, text: null })}>
            {t('folder.tr.reset')}
          </button>
        )}
      </div>
    </section>
  )
}
