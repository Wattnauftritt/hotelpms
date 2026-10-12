import { useEffect, useState } from 'react'
import type { CleaningWaiverView, FolderRequests } from '@hotelpms/contracts'
import { useT, useLocale } from '../lib/i18n/index.js'
import { mappeText } from '../gast/mappeTexte.js'
import { api } from '../lib/api.js'
import { Fehler } from '../components/Fehler.tsx'
import { Verzicht } from './GastCheckin.tsx'

/**
 * Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14).
 *
 * Ohne Auftrag der Rezeption: Zimmer antippen, "Sind Sie Herr/Frau
 * <Nachname>?" mit Ja oder Nein, danach die Reinigung einzelner Tage
 * abbestellen und Kopfkissen bestellen. Die Rueckfrage schuetzt vor einem vertippten Zimmer, mehr
 * soll sie nicht (Sven, 12.10.2026).
 *
 * Fuer diese Ansicht gilt, was fuer jeden Auftrag gilt (`Terminal.tsx`):
 * kein Zwischenspeicher, Name und Link nur im Zustand dieser Komponente,
 * am Ende ein Neuaufbau. Das Abraeumen gehoert dem Aufrufer; hier wird nur
 * gemeldet, wie es endete.
 *
 * Den Verzicht speichert dieselbe Komponente wie auf der Gastseite, mit
 * dem Link, den die Schnittstelle nach "Ja" ausgibt: ein Endpunkt fuer
 * Telefon und Touchscreen.
 */

interface Haus {
  property: string
  rooms: Array<{ resourceId: number; code: string; floor: string | null }>
}

type Schritt =
  | { art: 'zimmer' }
  | { art: 'frage'; sessionRef: string; lastName: string; code: string }
  | { art: 'verzicht'; sessionRef: string; token: string; view: CleaningWaiverView | null
      requests: FolderRequests | null; code: string }

export type SelbstEnde = 'done' | 'canceled'

export function Selbstbedienung({ onSitzung, onEnde }: {
  /** Die offene Sitzung, damit der Aufrufer sie bei Stille beenden kann. */
  onSitzung: (sessionRef: string | null) => void
  onEnde: (ende: SelbstEnde) => void
}): JSX.Element {
  const t = useT()
  const [haeuser, setHaeuser] = useState<Haus[] | null>(null)
  const [schritt, setSchritt] = useState<Schritt>({ art: 'zimmer' })
  const [fehler, setFehler] = useState<unknown>(null)
  const [hinweis, setHinweis] = useState(false)
  const [laeuft, setLaeuft] = useState(false)

  useEffect(() => {
    let aus = false
    api.get<{ properties: Haus[] }>('/v1/terminal/self/rooms')
      .then(r => { if (!aus) setHaeuser(r.properties) })
      .catch((e: unknown) => { if (!aus) setFehler(e) })
    return () => { aus = true }
  }, [])

  const offen = schritt.art === 'zimmer' ? null : schritt.sessionRef
  useEffect(() => { onSitzung(offen) }, [offen, onSitzung])

  const antippen = (resourceId: number, code: string): void => {
    setLaeuft(true); setFehler(null); setHinweis(false)
    api.post<{ sessionRef: string; lastName: string }>('/v1/terminal/self/sessions',
      { resourceId })
      .then(r => setSchritt({ art: 'frage', sessionRef: r.sessionRef, lastName: r.lastName,
                              code }))
      .catch((e: unknown) => setFehler(e))
      .finally(() => setLaeuft(false))
  }

  const antworten = (s: Extract<Schritt, { art: 'frage' }>, yes: boolean): void => {
    setLaeuft(true); setFehler(null)
    api.post<{ confirmed: boolean; lastName?: string | null; token?: string
               cleaningWaiver?: CleaningWaiverView | null
               requests?: FolderRequests | null }>(
      `/v1/terminal/self/sessions/${s.sessionRef}/confirm`, { yes })
      .then(r => {
        if (r.confirmed && r.token !== undefined) {
          setSchritt({ art: 'verzicht', sessionRef: s.sessionRef, token: r.token,
                       view: r.cleaningWaiver ?? null, requests: r.requests ?? null,
                       code: s.code })
        } else if (typeof r.lastName === 'string') {
          // Ein zweiter Aufenthalt im selben Zimmer: nach ihm fragen.
          setSchritt({ ...s, lastName: r.lastName })
        } else {
          setSchritt({ art: 'zimmer' })
          setHinweis(true)
        }
      })
      .catch((e: unknown) => { setFehler(e); setSchritt({ art: 'zimmer' }) })
      .finally(() => setLaeuft(false))
  }

  return (
    <div className="w-full max-w-5xl space-y-6">
      {schritt.art === 'zimmer' && (
        <>
          <h1 className="text-3xl font-semibold">{t('kiosk.self.chooseRoom')}</h1>
          {hinweis && <p className="text-lg text-amber-800">{t('kiosk.self.wrongRoom')}</p>}
          {haeuser !== null && haeuser.length === 0 && (
            <p className="text-lg text-neutral-600">{t('kiosk.self.noRooms')}</p>
          )}
          {haeuser?.map(h => (
            <section key={h.property} className="space-y-3">
              {haeuser.length > 1 && <h2 className="text-xl text-neutral-600">{h.property}</h2>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
                {h.rooms.map(z => (
                  <button key={z.resourceId} type="button" disabled={laeuft}
                          onClick={() => antippen(z.resourceId, z.code)}
                          className="py-6 text-3xl font-semibold rounded-sm border
                                     border-neutral-300 bg-white active:bg-neutral-100
                                     disabled:opacity-50">
                    {z.code}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {schritt.art === 'frage' && (
        <div className="max-w-2xl mx-auto text-center space-y-8">
          <div className="text-xl text-neutral-500">{t('kiosk.self.room', { room: schritt.code })}</div>
          <div className="space-y-2">
            <h1 className="text-4xl font-semibold">
              {t('kiosk.self.question', { name: schritt.lastName })}
            </h1>
            <p className="text-xl text-neutral-600">
              {t('kiosk.self.companion', { name: schritt.lastName })}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <button type="button" disabled={laeuft} onClick={() => antworten(schritt, true)}
                    className="py-8 text-3xl rounded-sm bg-neutral-900 text-white
                               disabled:bg-neutral-400">
              {t('kiosk.self.yes')}
            </button>
            <button type="button" disabled={laeuft} onClick={() => antworten(schritt, false)}
                    className="py-8 text-3xl rounded-sm border border-neutral-300 bg-white">
              {t('kiosk.self.no')}
            </button>
          </div>
        </div>
      )}

      {schritt.art === 'verzicht' && (
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="text-xl text-neutral-500">{t('kiosk.self.room', { room: schritt.code })}</div>
          {schritt.view === null && (schritt.requests?.items.length ?? 0) === 0
            ? <p className="text-xl">{t('kiosk.self.nothing')}</p>
            : (
              <>
                {schritt.view !== null && <Verzicht token={schritt.token} start={schritt.view} gross />}
                {schritt.requests !== null && schritt.requests.items.length > 0 && (
                  <Wuensche sessionRef={schritt.sessionRef} start={schritt.requests} />
                )}
              </>
            )}
          <button type="button" onClick={() => onEnde('done')}
                  className="w-full py-5 text-2xl rounded-sm bg-neutral-900 text-white">
            {t('kiosk.done')}
          </button>
        </div>
      )}

      {fehler !== null && <Fehler error={fehler} />}
      {schritt.art !== 'verzicht' && (
        <button type="button" onClick={() => onEnde('canceled')}
                className="w-full py-4 text-lg rounded-sm border border-neutral-300 bg-white">
          {t('kiosk.abort')}
        </button>
      )}
    </div>
  )
}

/**
 * Kopfkissen und was das Haus sonst am Terminal anbietet (Katalog der
 * Gaestemappe, Migration 0149): nur kostenlose Eintraege, ohne Wunschtag.
 * Die Saetze sind die der Mappe -- ein Wunsch, eine Sprache, ob am Telefon
 * oder hier.
 */
function Wuensche({ sessionRef, start }: {
  sessionRef: string; start: FolderRequests
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [view, setView] = useState<FolderRequests>(start)
  const [menge, setMenge] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [meldung, setMeldung] = useState<'ok' | 'fehler' | null>(null)
  // Leer bei einer Nachricht aus der Mappe (0153); das Terminal zeigt keine.
  const name = (n: Record<string, string> | null): string =>
    n === null ? '' : n[locale] ?? n.de ?? ''

  const bestellen = (itemRef: string, qty: number): void => {
    setBusy(true); setMeldung(null)
    api.post<FolderRequests | null>(`/v1/terminal/self/sessions/${sessionRef}/requests`,
      { itemRef, qty })
      .then(v => { if (v !== null) setView(v); setMeldung('ok') })
      .catch(() => setMeldung('fehler'))
      .finally(() => setBusy(false))
  }

  return (
    <section className="space-y-4 rounded-sm border border-neutral-300 bg-white p-6">
      <h2 className="text-2xl font-semibold">{mappeText('req.title', locale)}</h2>
      <ul className="divide-y divide-neutral-200">
        {view.items.map(i => {
          const q = menge[i.itemRef] ?? 1
          return (
            <li key={i.itemRef} className="flex flex-wrap items-center gap-4 py-4">
              <span className="grow text-2xl">{name(i.name)}</span>
              {i.maxQty > 1 && (
                <div className="flex items-center gap-2" aria-label={mappeText('req.qty', locale)}>
                  {Array.from({ length: i.maxQty }, (_, n) => n + 1).map(n => (
                    <button key={n} type="button" aria-pressed={q === n}
                            onClick={() => setMenge({ ...menge, [i.itemRef]: n })}
                            className={`h-14 w-14 rounded-sm border text-2xl
                              ${q === n ? 'border-neutral-900 bg-neutral-900 text-white'
                                        : 'border-neutral-300 bg-white'}`}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" disabled={busy} onClick={() => bestellen(i.itemRef, q)}
                      className="rounded-sm bg-[#e8891c] px-6 py-3 text-2xl text-white
                                 disabled:opacity-50">
                {mappeText('req.send', locale)}
              </button>
            </li>
          )
        })}
      </ul>
      {meldung !== null && (
        <p role={meldung === 'fehler' ? 'alert' : 'status'}
           className={`text-xl ${meldung === 'fehler' ? 'text-red-800' : 'text-green-800'}`}>
          {meldung === 'fehler' ? mappeText('req.failed', locale) : t('kiosk.self.thanks')}
        </p>
      )}
      {view.mine.length > 0 && (
        <div className="space-y-2 border-t border-neutral-200 pt-4">
          <h3 className="text-xl font-medium">{mappeText('req.mine', locale)}</h3>
          <ul className="space-y-1 text-lg">
            {view.mine.map(w => (
              <li key={w.requestRef}>
                {w.qty} × {name(w.name)}
                <span className={w.status === 'declined' ? ' text-red-800'
                  : w.status === 'done' ? ' text-green-800' : ' text-neutral-600'}>
                  {' · '}{mappeText(`req.status.${w.status}`, locale)}
                </span>
                {w.declineReason !== null && (
                  <span className="block text-neutral-700">
                    {mappeText(`req.reason.${w.declineReason}`, locale)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
