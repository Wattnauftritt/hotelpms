import { useState } from 'react'
import type { PaymentLink, PrepaymentView } from '@hotelpms/contracts'
import { useCreatePaymentLink, useCancelPaymentLink,
         istNichtEingerichtet } from '../lib/queries/billing.js'
import { centAusEingabe, eingabeAusCent } from '../lib/preisraster.js'
import { newIdempotencyKey } from '../lib/api.js'
import { useEscape } from '../lib/tasten.js'
import { useT, useLocale, formatMoney, formatDate, intlTag,
         type TextKey } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Zahlungslink: erzeugen, anzeigen, kopieren, verschicken, ungültig machen.
 *
 * Steht in einer eigenen Datei, weil zwei Masken ihn brauchen -- das Folio
 * (ein freier Betrag) und die Anzahlung am Reservierungsfenster (der offene
 * Rest einer Anforderung). Zwei Fassungen desselben Formulars liefen
 * auseinander, und die eine schickte irgendwann etwas mit, das die andere
 * vergessen hat.
 *
 * **Kartendaten gibt es hier nicht**, nicht einmal ein Feld, das danach
 * aussieht. Der Gast gibt sie beim Zahlungsdienstleister ein; das Haus sieht
 * nur, ob bezahlt ist.
 */

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

/** Warum ein Link nicht verschickt werden kann -- als Satz, nicht als 422. */
function versandHindernis(
  v: PrepaymentView, darfPost: boolean
): TextKey | null {
  if (v.mail.reason === 'training') return 'vz.link.mail.training'
  if (!darfPost) return 'vz.link.mail.noRight'
  if (v.mail.reason === 'disabled') return 'vz.link.mail.disabled'
  if (v.mail.reason === 'sender') return 'vz.link.mail.sender'
  if (!v.mail.guestAddress) return 'vz.link.mail.noAddress'
  return null
}

export function ZahlungslinkErzeugen({ folioRef, v, vorschlagCent, depositRequestRef,
                                       darfPost, onSchliessen }: {
  folioRef: string
  v: PrepaymentView
  /** Vorbelegung des Betrags: der offene Saldo oder der offene Rest der Anforderung. */
  vorschlagCent: number
  depositRequestRef?: string
  /** Darf der Benutzer Gastpost verschicken (`email:send`)? */
  darfPost: boolean
  /** Gesetzt, wenn das Formular aufgeklappt ist und sich schliessen laesst. */
  onSchliessen?: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [betrag, setBetrag] = useState(() => vorschlagCent > 0 ? eingabeAusCent(vorschlagCent) : '')
  const hindernis = versandHindernis(v, darfPost)
  // Vorausgewaehlt, wenn es geht: wer an einer Anforderung einen Link
  // erzeugt, will ihn fast immer dem Gast schicken.
  const [senden, setSenden] = useState(hindernis === null && depositRequestRef !== undefined)
  // Einmal je Absicht, nicht je Versuch: ein zweiter Klick nach einer
  // Zeitueberschreitung soll denselben Link bekommen, keinen zweiten Checkout.
  const [schluessel, setSchluessel] = useState(newIdempotencyKey)
  const [kopiert, setKopiert] = useState(false)
  const erzeugen = useCreatePaymentLink(folioRef)

  useEscape(() => onSchliessen?.(), onSchliessen !== undefined)

  /*
   * Ein Uebungshaus bekommt keinen Knopf, der danach mit einem Fehler
   * antwortet, sondern den Satz, warum es keinen gibt. Die API weist es
   * trotzdem ab; das hier ist die Auskunft, nicht der Zaun.
   */
  if (v.isTraining) {
    return <p className="text-xs text-amber-800">{t('vz.link.training')}</p>
  }

  const cent = centAusEingabe(betrag)
  const nichtEingerichtet = istNichtEingerichtet(erzeugen.error)

  return (
    <div className="space-y-2">
      {/* Nach dem Anlegen verschwindet das Formular: ein zweiter Druck
          legte einen zweiten Link an (oder wuerde bei einer Anforderung
          abgewiesen), und die Adresse darunter ist das, worum es jetzt geht. */}
      {!erzeugen.isSuccess && <>
      <form className="flex flex-wrap items-end gap-2"
            onSubmit={e => {
              e.preventDefault()
              if (cent === null || cent <= 0) return
              setKopiert(false)
              erzeugen.mutate(
                { amountCent: cent, key: schluessel,
                  ...(depositRequestRef === undefined ? {} : { depositRequestRef }),
                  sendEmail: senden && hindernis === null },
                { onSuccess: () => { setSchluessel(newIdempotencyKey()) } })
            }}>
        <label className="block w-32">
          <span className="block text-xs text-neutral-600">{t('vz.link.amount')}</span>
          <input required inputMode="decimal" value={betrag} className={eingabe}
                 onChange={e => setBetrag(e.target.value)} />
        </label>
        <label className={`flex items-center gap-1 text-xs pb-1.5
                           ${hindernis === null ? '' : 'text-neutral-400'}`}>
          <input type="checkbox" checked={senden && hindernis === null}
                 disabled={hindernis !== null}
                 onChange={e => setSenden(e.target.checked)} />
          {t('vz.link.send')}
        </label>
        <button type="submit" disabled={cent === null || cent <= 0 || erzeugen.isPending}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('vz.link.create')}
        </button>
        {onSchliessen !== undefined && (
          <button type="button" onClick={onSchliessen}
                  className="px-2 py-1.5 text-xs border border-neutral-300 rounded-sm">
            {t('vz.close')}
          </button>
        )}
      </form>

      {hindernis !== null
        ? <p className="text-xs text-neutral-500">{t(hindernis)}</p>
        : <p className="text-xs text-neutral-500">{t('vz.link.sendHint')}</p>}
      </>}

      {/* Eine fehlende Einrichtung ist kein Fehler der Rezeption. Sie
          bekommt den Satz, der sagt, was fehlt, statt einer 503. */}
      {nichtEingerichtet && (
        <p className="text-xs text-amber-800">{t('vz.link.notConfigured')}</p>
      )}
      {erzeugen.isError && !nichtEingerichtet && <Fehler error={erzeugen.error} />}

      {erzeugen.isSuccess && (
        <div className="p-2 bg-neutral-50 border border-neutral-200 rounded-sm">
          <span className="block text-xs text-neutral-600">{t('vz.link.address')}</span>
          {/* Null nur bei einer Wiederholung: der Idempotenzspeicher haelt
              das Token nicht, also gibt es die Adresse kein zweites Mal. */}
          {erzeugen.data.url === null
            ? <p className="text-xs text-amber-800">{t('vz.link.replayed')}</p>
            : (
              <div className="flex items-center gap-2">
                <input readOnly value={erzeugen.data.url}
                       onFocus={e => e.currentTarget.select()}
                       className="grow border border-neutral-300 rounded-sm px-2 py-1 text-xs" />
                <button type="button"
                        className="px-2 py-1 text-xs border border-neutral-300 rounded-sm
                                   whitespace-nowrap"
                        onClick={() => {
                          const url = erzeugen.data.url
                          if (url === null) return
                          void navigator.clipboard.writeText(url)
                            .then(() => setKopiert(true))
                        }}>
                  {kopiert ? t('vz.link.copied') : t('vz.link.copy')}
                </button>
              </div>
            )}
          <p className="mt-1 text-xs text-neutral-600">
            {t('vz.link.validUntilDay', { date: formatDate(erzeugen.data.validUntil, locale) })}
          </p>
          {erzeugen.data.messageRef !== null && (
            <p className="mt-1 text-xs text-emerald-800">✓ {t('vz.link.mailed')}</p>
          )}
          <p className="mt-1 text-xs text-neutral-500">{t('vz.link.once')}</p>
          <button type="button"
                  onClick={() => { if (onSchliessen !== undefined) onSchliessen()
                                   else { setKopiert(false); erzeugen.reset() } }}
                  className="mt-1 px-2 py-1 text-xs border border-neutral-300 rounded-sm">
            {onSchliessen !== undefined ? t('vz.close') : t('vz.link.another')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Der Zustand eines Links, wie ihn die Rezeption lesen soll. */
function linkZustand(l: PaymentLink): 'pending' | 'succeeded' | 'failed' | 'canceled'
                                       | 'expired' {
  // Ein offener Link, dessen Frist um ist, ist nicht mehr "offen":
  // bezahlen kann ihn niemand mehr. Beim dauerhaften Link ist die Frist ein
  // Geschaeftstag, bei einem alten Checkout ein Zeitpunkt beim Anbieter.
  return l.expired ? 'expired' : l.status
}

const ZUSTANDSFARBE: Record<ReturnType<typeof linkZustand>, string> = {
  pending: 'bg-amber-100 text-amber-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  canceled: 'bg-neutral-100 text-neutral-600',
  expired: 'bg-neutral-100 text-neutral-600'
}

export function ZahlungslinkListe({ folioRef, links, darfBuchen }: {
  folioRef: string; links: readonly PaymentLink[]; darfBuchen: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const ungueltig = useCancelPaymentLink(folioRef)
  const zeit = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'short', timeStyle: 'short' })

  if (links.length === 0) {
    return <p className="text-sm text-neutral-400">{t('vz.link.none')}</p>
  }
  return (
    <div>
      <ul className="space-y-1 text-sm">
        {links.map(l => {
          const zustand = linkZustand(l)
          return (
            <li key={`${l.legacy ? 'c' : 'l'}${l.id}`}
                className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs text-neutral-500 tabular-nums">
                {zeit.format(new Date(l.createdAt))}
              </span>
              <span className="tabular-nums">{formatMoney(l.amountCent, locale)}</span>
              <span className={`text-xs px-1.5 rounded-sm ${ZUSTANDSFARBE[zustand]}`}>
                {t(`vz.link.status.${zustand}`)}
              </span>
              {l.mailStatus !== null && (
                <span className="text-xs text-neutral-500">
                  {t(`vz.link.mail.${l.mailStatus}`)}
                </span>
              )}
              {zustand === 'pending' && l.validUntil !== null && (
                <span className="text-xs text-neutral-500">
                  {t('vz.link.validUntilDay', { date: formatDate(l.validUntil, locale) })}
                </span>
              )}
              {zustand === 'pending' && l.legacy && l.expiresAt !== null && (
                <span className="text-xs text-neutral-500">
                  {t('vz.link.validUntil', { time: zeit.format(new Date(l.expiresAt)) })}
                </span>
              )}
              {/* Ob der Gast den Link schon bis zum Anbieter geoeffnet hat:
                  die Frage, die vor einer Erinnerung kommt. */}
              {!l.legacy && l.openedAt !== null && l.status === 'pending' && (
                <span className="text-xs text-neutral-500">{t('vz.link.opened')}</span>
              )}
              <div className="grow" />
              {/* Widerrufen auch nach Ablauf der Frist: ein schon geoeffneter
                  Checkout nimmt beim Anbieter noch bis zu 24 Stunden Geld an,
                  und erst der Widerruf beendet ihn. Alte Checkouts ohne
                  eigenen Link laufen von selbst ab. */}
              {darfBuchen && !l.legacy && l.status === 'pending' && (
                <button type="button" disabled={ungueltig.isPending}
                        onClick={() => {
                          if (confirm(t('vz.link.cancelConfirm'))) ungueltig.mutate(l.id)
                        }}
                        className="text-xs px-2 py-0.5 rounded-sm border border-neutral-300
                                   hover:bg-neutral-50 disabled:opacity-40">
                  {t('vz.link.cancel')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {ungueltig.isError && <div className="mt-2"><Fehler error={ungueltig.error} /></div>}
    </div>
  )
}
