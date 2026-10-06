import { useEffect, useState } from 'react'
import { EMAIL_LANGUAGES } from '@hotelpms/contracts'
import { useCheckinSettings, useSaveCheckinSettings, useCheckinMailPreview,
         useSendCheckinTestMail, useTestMailStatus } from '../lib/queries/checkin.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Einstellung je Haus: Link zum Online-Check-in vor Anreise (Dokument 30).
 *
 * Aus als Vorgabe. Ein Haus soll nicht durch eine Auslieferung ploetzlich
 * Gaeste anschreiben -- dieselbe Ueberlegung wie beim Gastversand selbst.
 * Die Bedingungen (bestaetigt, Adresse, Absenderdomain, kein Uebungshaus)
 * stehen im Hinweis, damit niemand auf eine Mail wartet, die nie kommen kann.
 */
export function OnlineCheckinEinstellung({ propertyId, isTraining }: {
  propertyId: number; isTraining: boolean
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useCheckinSettings(propertyId)
  const speichern = useSaveCheckinSettings(propertyId)
  const [enabled, setEnabled] = useState(false)
  const [tage, setTage] = useState(3)

  useEffect(() => {
    if (q.data === undefined) return
    setEnabled(q.data.enabled)
    setTage(q.data.daysBefore)
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  return (
    <div className="space-y-3">
      <form className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3 max-w-2xl"
            onSubmit={e => {
              e.preventDefault()
              speichern.mutate({ enabled, daysBefore: tage })
            }}>
        <h2 className="text-sm font-medium">{t('onlineCheckin.settings.title')}</h2>
        <label className="text-sm flex items-center gap-1.5 text-neutral-700">
          <input type="checkbox" checked={enabled} disabled={isTraining}
                 onChange={e => setEnabled(e.target.checked)} />
          {t('onlineCheckin.settings.enabled')}
        </label>
        <label className="text-sm block">
          <span className="text-neutral-600">{t('onlineCheckin.settings.days')}</span>
          <input type="number" min={1} max={14} value={tage}
                 onChange={e => setTage(Math.min(14, Math.max(1, Number(e.target.value) || 1)))}
                 className="ml-2 border border-neutral-300 rounded-sm px-2 py-1 w-20" />
        </label>
        <p className="text-xs text-neutral-500">
          {isTraining ? t('mail.training') : t('onlineCheckin.settings.hint')}
        </p>
        {speichern.isError && <Fehler error={speichern.error} />}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={!online || speichern.isPending}
                  className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
          {speichern.isSuccess && <span className="text-xs text-emerald-700">✓</span>}
        </div>
      </form>
      <OnlineCheckinTestmail propertyId={propertyId} isTraining={isTraining} />
    </div>
  )
}

/**
 * Vorschau der Einladung und Testmail an eine Adresse nach Wahl.
 *
 * Steht neben dem Schalter, nicht hinter ihm: man soll sehen und pruefen
 * koennen, was hinausginge, **bevor** man den Vorabversand einschaltet.
 * Die Voraussetzungen stehen einzeln da, damit "warum kommt nichts an"
 * eine Antwort auf dem Bildschirm hat und keinen Anruf braucht.
 *
 * Die Vorschau steht in einem Rahmen ohne Rechte (`sandbox` leer): kein
 * Skript, keine Formulare, keine Navigation. Der Text ist zwar unsere
 * Vorlage, aber der Hausname darin kommt aus einer Eingabe.
 */
function OnlineCheckinTestmail({ propertyId, isTraining }: {
  propertyId: number; isTraining: boolean
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [sprache, setSprache] = useState<string>('de')
  const [an, setAn] = useState('')
  const [messageRef, setMessageRef] = useState<string | null>(null)
  const vorschau = useCheckinMailPreview(propertyId, sprache)
  const senden = useSendCheckinTestMail(propertyId)
  const stand = useTestMailStatus(propertyId, messageRef)

  const r = vorschau.data?.ready
  const bereit = r !== undefined && !r.training && r.mailEnabled && r.senderAllowed
  const zeile = (ok: boolean, text: string): JSX.Element => (
    <li className={ok ? 'text-emerald-700' : 'text-red-700'}>{ok ? '✓' : '✗'} {text}</li>
  )

  return (
    <section className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3 max-w-2xl">
      <h2 className="text-sm font-medium">{t('onlineCheckin.test.title')}</h2>
      <p className="text-xs text-neutral-500">{t('onlineCheckin.test.intro')}</p>
      {vorschau.isError && <Fehler error={vorschau.error} />}
      {r !== undefined && (
        <div className="text-sm">
          <div className="text-neutral-600">{t('onlineCheckin.ready.title')}</div>
          <ul className="mt-1 space-y-0.5">
            {zeile(!r.training, t('onlineCheckin.ready.notTraining'))}
            {zeile(r.mailEnabled, t('onlineCheckin.ready.mail'))}
            {zeile(r.senderAllowed, t('onlineCheckin.ready.sender'))}
          </ul>
          <p className={`mt-1 text-xs ${r.autoEnabled ? 'text-amber-700' : 'text-neutral-500'}`}>
            {t(r.autoEnabled ? 'onlineCheckin.ready.autoOn' : 'onlineCheckin.ready.autoOff')}
          </p>
        </div>
      )}
      <label className="text-sm block">
        <span className="text-neutral-600">{t('onlineCheckin.test.language')}</span>
        <select value={sprache} onChange={e => setSprache(e.target.value)}
                className="ml-2 border border-neutral-300 rounded-sm px-2 py-1 text-sm">
          {EMAIL_LANGUAGES.map(l => (
            <option key={l} value={l}>{t(`guests.language.${l}`)}</option>
          ))}
        </select>
      </label>
      {vorschau.data === undefined ? (!vorschau.isError && <Laedt />) : (
        <div className="space-y-1">
          <div className="text-sm">
            <span className="text-neutral-600">{t('onlineCheckin.test.subject')}: </span>
            {vorschau.data.subject}
          </div>
          <iframe sandbox="" srcDoc={vorschau.data.html}
                  title={t('onlineCheckin.test.title')}
                  className="w-full h-96 border border-neutral-200 rounded-sm bg-white" />
        </div>
      )}
      <p className="text-xs text-neutral-500">{t('onlineCheckin.test.linkHint')}</p>
      <form className="flex flex-wrap items-end gap-2"
            onSubmit={e => {
              e.preventDefault()
              setMessageRef(null)
              senden.mutate({ to: an.trim(), language: sprache },
                { onSuccess: d => setMessageRef(d.messageRef) })
            }}>
        <label className="text-sm grow">
          <span className="block text-neutral-600">{t('onlineCheckin.test.to')}</span>
          <input type="email" required value={an} onChange={e => setAn(e.target.value)}
                 autoComplete="email"
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <button type="submit" disabled={!online || isTraining || !bereit || senden.isPending}
                className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('onlineCheckin.test.send')}
        </button>
      </form>
      {senden.isError && <Fehler error={senden.error} />}
      {messageRef !== null && (
        stand.data?.status === 'sent'
          ? <p className="text-sm text-emerald-700">{t('onlineCheckin.test.sent')}</p>
          : stand.data?.status === 'failed'
            ? <p className="text-sm text-red-700">
                {t('onlineCheckin.test.failed', { error: stand.data.lastError ?? '' })}
              </p>
            : <p className="text-sm text-neutral-600">{t('onlineCheckin.test.pending')}</p>
      )}
    </section>
  )
}
