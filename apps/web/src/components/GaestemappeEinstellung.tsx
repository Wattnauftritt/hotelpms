import { useEffect, useState, type JSX } from 'react'
import type { FolderWifi, WifiSecurity } from '@hotelpms/contracts'
import { useGaestemappe, useGaestemappeSpeichern,
         useGaestemappeSeiten } from '../lib/queries/gaestemappe.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'
import { Zimmerkarten } from './Zimmerkarten.tsx'
import { GaestemappeUebersetzung, UebersetzungsStand } from './GaestemappeUebersetzung.tsx'
import { GaestemappeWuensche } from './GaestemappeWuensche.tsx'

/**
 * Einstellungen der digitalen Gaestemappe (Migration 0143): an/aus, das WLAN
 * des Hauses, welche Seiten in der Mappe stehen, der Wunschkatalog (0149)
 * und die Zimmerkarten.
 *
 * Die Seiten selbst werden am Gaesteterminal gepflegt, nicht hier: zwei
 * Pflegestellen fuer dieselbe Fruehstueckszeit laufen auseinander.
 */

const ARTEN: WifiSecurity[] = ['WPA', 'WEP', 'nopass']
const eingabe = 'w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'
const knopf = 'px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white disabled:opacity-40'

export function GaestemappeEinstellung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useGaestemappe(propertyId)
  const speichern = useGaestemappeSpeichern(propertyId)
  const seitenSpeichern = useGaestemappeSeiten(propertyId)
  const [an, setAn] = useState(false)
  const [nachrichten, setNachrichten] = useState(false)
  const [abreiseSeite, setAbreiseSeite] = useState('')
  const [bewertung, setBewertung] = useState('')
  const [mitWlan, setMitWlan] = useState(true)
  const [wlan, setWlan] = useState<FolderWifi>(
    { ssid: '', password: '', security: 'WPA', hidden: false })
  const [auswahl, setAuswahl] = useState<string[]>([])
  const [karten, setKarten] = useState(false)
  const [uebersetzen, setUebersetzen] = useState<string | null>(null)

  useEffect(() => {
    if (q.data === undefined) return
    setAn(q.data.enabled)
    setNachrichten(q.data.messagesEnabled)
    setAbreiseSeite(q.data.departurePage ?? '')
    setBewertung(q.data.reviewUrl ?? '')
    setMitWlan(q.data.wifi !== null)
    if (q.data.wifi !== null) setWlan({ ...q.data.wifi, password: q.data.wifi.password ?? '' })
    setAuswahl(q.data.pages.filter(s => s.folderPosition !== null)
      .sort((a, b) => a.folderPosition! - b.folderPosition!).map(s => s.contentRef))
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const seiten = q.data.pages
  const titel = new Map(seiten.map(s => [s.contentRef, s.title]))
  // Uebersetzt wird, was gespeichert in der Mappe steht -- nicht die Auswahl
  // auf dem Bildschirm, die noch niemand gespeichert hat.
  const gespeichert = new Map(seiten.filter(s => s.folderPosition !== null)
    .map(s => [s.contentRef, s]))
  const offeneSeite = uebersetzen === null ? undefined : gespeichert.get(uebersetzen)

  function verschieben(i: number, um: number): void {
    setAuswahl(a => {
      const n = [...a]
      const [x] = n.splice(i, 1)
      n.splice(i + um, 0, x!)
      return n
    })
  }

  const offen = wlan.security === 'nopass'
  const passwort = wlan.password ?? ''
  const wlanGueltig = !mitWlan || (wlan.ssid.trim() !== ''
    && (offen
      || (wlan.security === 'WPA' && passwort.length >= 8 && passwort.length <= 63)
      || (wlan.security === 'WEP' && passwort.length >= 5 && passwort.length <= 26)))

  return (
    <div className="space-y-6 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('folder.hint')}</p>

      <section className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={an} onChange={e => setAn(e.target.checked)} />
          {t('folder.enabled')}
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={nachrichten}
                 onChange={e => setNachrichten(e.target.checked)} />
          <span>
            {t('folder.messages')}
            <span className="block text-xs text-neutral-500">{t('folder.messagesHint')}</span>
          </span>
        </label>

        <fieldset className="space-y-2 rounded-sm border border-neutral-200 p-3">
          <legend className="text-xs text-neutral-600 px-1">{t('folder.wifi')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mitWlan} onChange={e => setMitWlan(e.target.checked)} />
            {t('folder.wifi.show')}
          </label>
          {mitWlan && (
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="block text-xs text-neutral-600 mb-1">{t('folder.wifi.ssid')}</span>
                <input value={wlan.ssid} maxLength={32} autoComplete="off"
                       onChange={e => setWlan(w => ({ ...w, ssid: e.target.value }))}
                       className={eingabe} />
              </label>
              <label className="block text-sm">
                <span className="block text-xs text-neutral-600 mb-1">
                  {t('folder.wifi.security')}
                </span>
                <select value={wlan.security} className={eingabe}
                        onChange={e => setWlan(w => ({ ...w,
                          security: e.target.value as WifiSecurity }))}>
                  {ARTEN.map(a => (
                    <option key={a} value={a}>{t(`folder.wifi.sec.${a}` as TextKey)}</option>
                  ))}
                </select>
              </label>
              {!offen && (
                <label className="block text-sm">
                  <span className="block text-xs text-neutral-600 mb-1">
                    {t('folder.wifi.password')}
                  </span>
                  <input value={passwort} maxLength={63} autoComplete="off" spellCheck={false}
                         onChange={e => setWlan(w => ({ ...w, password: e.target.value }))}
                         className={`${eingabe} font-mono`} />
                </label>
              )}
              <label className="flex items-center gap-2 text-sm self-end pb-1">
                <input type="checkbox" checked={wlan.hidden}
                       onChange={e => setWlan(w => ({ ...w, hidden: e.target.checked }))} />
                {t('folder.wifi.hidden')}
              </label>
            </div>
          )}
        </fieldset>

        {/* Seite und Adresse pflegt das Haus am Gaesteterminal; hier wird nur
            gewaehlt, welche zur Abreise gehoert (0154). */}
        <fieldset className="space-y-2 rounded-sm border border-neutral-200 p-3">
          <legend className="text-xs text-neutral-600 px-1">{t('folder.departure')}</legend>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('folder.departurePage')}</span>
            <select value={abreiseSeite} className={eingabe}
                    onChange={e => setAbreiseSeite(e.target.value)}>
              <option value="">{t('folder.none')}</option>
              {seiten.filter(s => s.folderPosition !== null || s.contentRef === abreiseSeite)
                .map(s => <option key={s.contentRef} value={s.contentRef}>{s.title}</option>)}
            </select>
            <span className="block text-xs text-neutral-500 mt-1">
              {t('folder.departurePageHint')}
            </span>
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('folder.reviewUrl')}</span>
            <select value={bewertung} className={eingabe}
                    onChange={e => setBewertung(e.target.value)}>
              <option value="">{t('folder.none')}</option>
              {q.data.urls.map(u => (
                <option key={u.urlRef} value={u.urlRef}>{u.label} · {u.url}</option>
              ))}
            </select>
            <span className="block text-xs text-neutral-500 mt-1">{t('folder.reviewUrlHint')}</span>
          </label>
        </fieldset>

        {speichern.isError && <Fehler error={speichern.error} />}
        <div className="flex items-center gap-3">
          <button type="button" className={knopf}
                  disabled={!online || !wlanGueltig || speichern.isPending}
                  onClick={() => speichern.mutate({
                    enabled: an,
                    messagesEnabled: nachrichten,
                    departurePage: abreiseSeite === '' ? null : abreiseSeite,
                    reviewUrl: bewertung === '' ? null : bewertung,
                    wifi: mitWlan
                      ? { ssid: wlan.ssid.trim(), security: wlan.security, hidden: wlan.hidden,
                          password: offen ? null : passwort }
                      : null })}>
            {t('common.save')}
          </button>
          {speichern.isSuccess && (
            <span className="text-sm text-emerald-800">✓ {t('folder.saved')}</span>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('folder.pages')}</h2>
        <p className="text-xs text-neutral-500">{t('folder.pagesHint')}</p>
        <p className="text-xs text-neutral-500">{t('folder.tr.hint')}</p>
        {seiten.length === 0
          ? <p className="text-sm text-neutral-600">{t('folder.pagesNone')}</p>
          : (
            <ul className="divide-y divide-neutral-100 rounded-sm border border-neutral-200">
              {auswahl.map((ref, i) => (
                <li key={ref} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <input type="checkbox" checked aria-label={titel.get(ref)}
                         onChange={() => setAuswahl(a => a.filter(x => x !== ref))} />
                  <span className="grow">{titel.get(ref)}</span>
                  {gespeichert.has(ref) && (
                    <button type="button" onClick={() => setUebersetzen(ref)}
                            title={t('folder.tr.open')} aria-label={t('folder.tr.open')}
                            className="flex items-center gap-2 px-1.5 text-neutral-600
                                       hover:text-neutral-900">
                      <UebersetzungsStand seite={gespeichert.get(ref)!} />
                    </button>
                  )}
                  <button type="button" disabled={i === 0} onClick={() => verschieben(i, -1)}
                          aria-label={t('folder.up')} title={t('folder.up')}
                          className="px-1.5 text-neutral-600 disabled:opacity-30">↑</button>
                  <button type="button" disabled={i === auswahl.length - 1}
                          onClick={() => verschieben(i, 1)}
                          aria-label={t('folder.down')} title={t('folder.down')}
                          className="px-1.5 text-neutral-600 disabled:opacity-30">↓</button>
                </li>
              ))}
              {seiten.filter(s => !auswahl.includes(s.contentRef)).map(s => (
                <li key={s.contentRef} className="flex items-center gap-2 px-3 py-1.5 text-sm
                                                  text-neutral-500">
                  <input type="checkbox" checked={false} aria-label={s.title}
                         onChange={() => setAuswahl(a => [...a, s.contentRef])} />
                  <span className="grow">{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        {seitenSpeichern.isError && <Fehler error={seitenSpeichern.error} />}
        {seiten.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" className={knopf}
                    disabled={!online || seitenSpeichern.isPending}
                    onClick={() => seitenSpeichern.mutate(auswahl)}>
              {t('common.save')}
            </button>
            {seitenSpeichern.isSuccess && (
              <span className="text-sm text-emerald-800">✓ {t('folder.saved')}</span>
            )}
          </div>
        )}
      </section>

      <GaestemappeWuensche propertyId={propertyId} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('folder.cards')}</h2>
        <p className="text-xs text-neutral-500">{t('folder.cardsHint')}</p>
        <button type="button" disabled={!online} onClick={() => setKarten(true)}
                className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('folder.cardsOpen')}
        </button>
      </section>

      {karten && <Zimmerkarten propertyId={propertyId} onClose={() => setKarten(false)} />}
      {offeneSeite !== undefined && (
        <GaestemappeUebersetzung propertyId={propertyId} seite={offeneSeite}
                                 onClose={() => setUebersetzen(null)} />
      )}
    </div>
  )
}
