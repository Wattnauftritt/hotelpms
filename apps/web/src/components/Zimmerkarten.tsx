import { useEffect, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { wifiQrText, type FolderWifi } from '@hotelpms/contracts'
import { useZimmerkarten, useZimmerkarteErneuern } from '../lib/queries/gaestemappe.js'
import { useT } from '../lib/i18n/index.js'
import { useQr } from '../lib/qr.js'
import { mappeText } from '../gast/mappeTexte.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Die Zimmerkarten der Gaestemappe zum Ausdrucken (Sven, 11.10.2026: A6 zum
 * Aufstellen, zwei QR-Codes nebeneinander, darunter Netzname und Passwort
 * ausgeschrieben fuer Gaeste, die keinen QR-Code nutzen).
 *
 * **Drucken aus dem Browser, kein PDF vom Server.** Die Karte ist eine
 * Seite mit zwei Bildern; ein Erzeuger fuer PDF auf dem Server waere eine
 * Abhaengigkeit fuer eine Sache, die der Browser kann. Jede Karte ist ein
 * eigenes Blatt im Format A6 (`@page zimmerkarte` in `styles.css`), und nur
 * diese Ansicht wird gedruckt -- die Rezeption dahinter nicht.
 *
 * **Die Karte spricht Deutsch und Englisch**, fest und unabhaengig von der
 * Sprache der Rezeption: sie liegt im Zimmer fuer jeden Gast. Die Saetze
 * kommen aus dem Katalog der Mappe, damit Karte und Telefon dieselben
 * Woerter benutzen.
 */
export function Zimmerkarten({ propertyId, onClose }: {
  propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const q = useZimmerkarten(propertyId, true)
  const erneuern = useZimmerkarteErneuern(propertyId)

  useEffect(() => {
    const taste = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', taste)
    return () => window.removeEventListener('keydown', taste)
  }, [onClose])

  return createPortal(
    <div className="zimmerkarten-druck fixed inset-0 z-50 overflow-auto bg-neutral-100"
         role="dialog" aria-modal="true" aria-label={t('folder.cards')}>
      <div className="nur-bildschirm sticky top-0 z-10 bg-white border-b border-neutral-200
                      px-4 py-3 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold mr-auto">{t('folder.cards')}</h2>
          <button type="button" onClick={() => window.print()} disabled={q.data === undefined}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('folder.cardsPrint')}
          </button>
          <button type="button" onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300">
            {t('folder.cardsClose')}
          </button>
        </div>
        <p className="text-xs text-neutral-500">{t('folder.cardsPrintHint')}</p>
        {q.data !== undefined && !q.data.enabled && (
          <p className="text-xs text-amber-800">{t('folder.cardsOff')}</p>
        )}
        {erneuern.isError && <Fehler error={erneuern.error} />}
      </div>
      <div className="p-4 flex flex-wrap gap-4 justify-center">
        {q.isError && <Fehler error={q.error} />}
        {q.data === undefined && !q.isError && <Laedt />}
        {q.data?.rooms.map(z => (
          <div key={z.resourceId} className="space-y-1">
            <Karte haus={q.data.propertyName} zimmer={z.name ?? z.code}
                   link={z.link} wifi={q.data.wifi} />
            <div className="nur-bildschirm text-center">
              <button type="button" disabled={erneuern.isPending}
                      onClick={() => {
                        if (window.confirm(t('folder.cardsRenewConfirm',
                          { room: z.name ?? z.code }))) erneuern.mutate(z.resourceId)
                      }}
                      className="text-xs text-neutral-600 underline">
                {t('folder.cardsRenew')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body)
}

/** Zwei Sprachen, eine Zeile: "WLAN · Wi-Fi". */
const zweisprachig = (k: Parameters<typeof mappeText>[0], werte?: Record<string, string>) => {
  const de = mappeText(k, 'de', werte)
  const en = mappeText(k, 'en', werte)
  return de === en ? de : `${de} · ${en}`
}

function Code({ text, titel }: { text: string; titel: string }): JSX.Element {
  const { pfad, groesse } = useQr(text)
  return (
    <figure className="flex flex-col items-center" style={{ width: '44mm' }}>
      <svg viewBox={`0 0 ${groesse} ${groesse}`} role="img" aria-label={titel}
           style={{ width: '44mm', height: '44mm' }} shapeRendering="crispEdges">
        <path d={pfad} fill="#000" />
      </svg>
      <figcaption className="text-center font-semibold" style={{ fontSize: '3.4mm' }}>
        {titel}
      </figcaption>
    </figure>
  )
}

function Karte({ haus, zimmer, link, wifi }: {
  haus: string; zimmer: string; link: string; wifi: FolderWifi | null
}): JSX.Element {
  return (
    <section className="zimmerkarte bg-white shadow-sm border border-neutral-200 text-black
                        flex flex-col items-center justify-between"
             style={{ width: '105mm', height: '148mm', padding: '9mm 7mm' }}>
      <header className="text-center">
        <div className="font-semibold" style={{ fontSize: '5.5mm' }}>{haus}</div>
        <div style={{ fontSize: '3.8mm' }}>{zweisprachig('room', { room: zimmer })}</div>
      </header>
      <div className="flex justify-center" style={{ gap: wifi === null ? 0 : '5mm' }}>
        {wifi !== null && <Code text={wifiQrText(wifi)} titel={zweisprachig('wifi.title')} />}
        <Code text={link} titel={zweisprachig('title')} />
      </div>
      {wifi !== null
        ? (
          <dl className="w-full" style={{ fontSize: '3.4mm', lineHeight: 1.35 }}>
            <dt>{zweisprachig('wifi.network')}</dt>
            <dd className="font-mono font-semibold break-all" style={{ fontSize: '4.2mm' }}>
              {wifi.ssid}
            </dd>
            {wifi.password !== null
              ? (
                <>
                  <dt style={{ marginTop: '2mm' }}>{zweisprachig('wifi.password')}</dt>
                  <dd className="font-mono font-semibold break-all" style={{ fontSize: '4.2mm' }}>
                    {wifi.password}
                  </dd>
                </>
              )
              : <dd style={{ marginTop: '2mm' }}>{zweisprachig('wifi.noPassword')}</dd>}
          </dl>
        )
        : <div />}
    </section>
  )
}

