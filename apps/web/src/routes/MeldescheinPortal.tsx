import { useEffect, useState } from 'react'
import { meldescheinPortalAusPfad, type MeldescheinPortalView,
         type MeldescheinPortalSubmitted } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { Sprache, dokumentSprache, useT, type Locale } from '../lib/i18n/index.js'
import { Datumsfeld } from '../components/Datumsfeld.tsx'
import { Formular, Feld, Kopf, Laden, Meldung, startSprache,
         type FormularView, type FormularFelder } from './GastCheckin.tsx'

/**
 * Meldeschein ueber den festen Link je Haus (`/meldeschein/<Kennung>`, 0216).
 *
 * Booking.com stellt die Einladung an seine Weiterleitungsadressen nicht zu.
 * Gaeste von Booking.com bekommen diesen Link deshalb ueber eine
 * Nachrichtenvorlage von Booking.com, geben Buchungsnummer und Anreisetag
 * ein und fuellen dasselbe Formular aus wie ueber den Link aus der Mail.
 *
 * **Die Seite zeigt nichts zu einer Buchung.** Keinen Namen, keinen
 * Zeitraum, und die Antwort auf die Abgabe ist immer dieselbe. Mit Nummer
 * und Anreisetag allein soll sich nichts erfahren lassen; zugeordnet wird
 * auf dem Server, sofort oder sobald das Adminpanel die Nummer meldet.
 *
 * Wie die uebrigen Gastseiten ohne Zwischenspeicher und ohne
 * `localStorage`: eigener Zustand, der mit der Seite verschwindet.
 */

/** Die Kennung aus der Adresse, oder null, wenn es nicht diese Seite ist. */
export function meldescheinPortalAusAdresse(pathname: string = location.pathname): string | null {
  return meldescheinPortalAusPfad(pathname)
}

export function MeldescheinPortalSeite({ portalRef }: { portalRef: string }): JSX.Element {
  const [locale, setLocale] = useState<Locale>(() => startSprache(navigator.language))
  const [view, setView] = useState<MeldescheinPortalView | null>(null)
  const [ladefehler, setLadefehler] = useState<unknown>(null)
  const [erhalten, setErhalten] = useState(false)
  // Ein neuer Schluessel baut das Formular leer neu auf: fuer das naechste Zimmer.
  const [runde, setRunde] = useState(0)
  const [nummer, setNummer] = useState('')
  const [anreise, setAnreise] = useState('')

  useEffect(() => { dokumentSprache(locale) }, [locale])
  useEffect(() => {
    let aktiv = true
    api.get<MeldescheinPortalView>(`/v1/meldeschein/${portalRef}/form`)
      .then(v => { if (aktiv) setView(v) })
      .catch((e: unknown) => { if (aktiv) setLadefehler(e) })
    return () => { aktiv = false }
  }, [portalRef])

  // Wie der Link aus der Mail: vor der Anreise, ohne Unterschrift, mit Ankunftszeit.
  const formView: FormularView | null = view === null ? null : {
    ...view, channel: 'mail', signatureAllowed: false, firstName: null, lastName: '' }

  return (
    <div className="min-h-screen bg-neutral-50 p-4 sm:p-8">
      <Sprache locale={locale}>
        <div lang={locale} className="mx-auto w-full max-w-xl text-sm space-y-4">
          <Kopf gross={false} onLocale={setLocale} />
          {ladefehler !== null && <Meldung fehler={ladefehler} gross={false} />}
          {view === null && ladefehler === null && <Laden />}
          {formView !== null && erhalten && (
            <Erhalten onWeiter={() => { setErhalten(false); setRunde(runde + 1) }} />
          )}
          {formView !== null && !erhalten && (
            <Formular key={runde} view={formView} gross={false}
                      kopf={<Einleitung haus={formView.propertyName} />}
                      vorne={f => (
                        <Buchung f={f} nummer={nummer} setNummer={setNummer}
                                 anreise={anreise} setAnreise={setAnreise} />
                      )}
                      senden={async body => {
                        await api.post<MeldescheinPortalSubmitted>(
                          `/v1/meldeschein/${portalRef}`,
                          { ...body, bookingNumber: nummer.trim(), arrival: anreise })
                        setErhalten(true)
                        window.scrollTo(0, 0)
                      }} />
          )}
        </div>
      </Sprache>
    </div>
  )
}

function Einleitung({ haus }: { haus: string }): JSX.Element {
  const t = useT()
  return (
    <>
      <p className="font-medium">{haus}</p>
      <p className="text-neutral-600">{t('gastCheckin.portal.intro')}</p>
    </>
  )
}

/**
 * Nummer und Anreisetag, vor dem Formular und immer sichtbar. Sie bleiben
 * stehen, wenn der Gast danach den Schein fuer ein weiteres Zimmer derselben
 * Buchung ausfuellt.
 */
function Buchung({ f, nummer, setNummer, anreise, setAnreise }: {
  f: FormularFelder
  nummer: string; setNummer: (v: string) => void
  anreise: string; setAnreise: (v: string) => void
}): JSX.Element {
  const t = useT()
  return (
    <div className={f.abschnitt}>
      <h2 className="font-semibold">{t('gastCheckin.portal.booking')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Feld label={t('gastCheckin.portal.bookingNumber')} fehler={f.felder.get('bookingNumber')}
              gross={false}>
          <input value={nummer} inputMode="numeric" autoComplete="off" spellCheck={false}
                 maxLength={64} onChange={e => setNummer(e.target.value)}
                 className={`${f.eingabe} ${f.rahmen('bookingNumber')}`} />
          <span className="text-xs text-neutral-500">{t('gastCheckin.portal.bookingNumberHint')}</span>
        </Feld>
        <Feld label={t('gastCheckin.portal.arrival')} fehler={f.felder.get('arrival')} gross={false}>
          <Datumsfeld value={anreise} onChange={setAnreise} art="anreise"
                      className={`${f.eingabe} ${f.rahmen('arrival')}`} />
        </Feld>
      </div>
    </div>
  )
}

function Erhalten({ onWeiter }: { onWeiter: () => void }): JSX.Element {
  const t = useT()
  return (
    <div className="rounded-sm border border-emerald-200 bg-emerald-50 space-y-3 p-6">
      <h2 className="text-lg font-semibold text-emerald-900">{t('gastCheckin.done.title')}</h2>
      <p className="text-emerald-900">{t('gastCheckin.portal.received')}</p>
      <button type="button" onClick={onWeiter}
              className="rounded-sm border border-neutral-300 bg-white px-4 py-2">
        {t('gastCheckin.portal.another')}
      </button>
    </div>
  )
}
