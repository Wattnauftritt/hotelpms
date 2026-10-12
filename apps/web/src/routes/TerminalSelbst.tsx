import { useEffect, useState } from 'react'
import type { CleaningWaiverView } from '@hotelpms/contracts'
import { useT } from '../lib/i18n/index.js'
import { api } from '../lib/api.js'
import { Fehler } from '../components/Fehler.tsx'
import { Verzicht } from './GastCheckin.tsx'

/**
 * Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14).
 *
 * Ohne Auftrag der Rezeption: Zimmer antippen, "Sind Sie Herr/Frau
 * <Nachname>?" mit Ja oder Nein, danach die Reinigung einzelner Tage
 * abbestellen. Die Rueckfrage schuetzt vor einem vertippten Zimmer, mehr
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
      code: string }

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
               cleaningWaiver?: CleaningWaiverView | null }>(
      `/v1/terminal/self/sessions/${s.sessionRef}/confirm`, { yes })
      .then(r => {
        if (r.confirmed && r.token !== undefined) {
          setSchritt({ art: 'verzicht', sessionRef: s.sessionRef, token: r.token,
                       view: r.cleaningWaiver ?? null, code: s.code })
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
          {schritt.view === null
            ? <p className="text-xl">{t('kiosk.self.nothing')}</p>
            : <Verzicht token={schritt.token} start={schritt.view} gross />}
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
