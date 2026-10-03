import { useState } from 'react'
import type { DepositRequest, DepositRequestState, PrepaymentView } from '@hotelpms/contracts'
import { usePrepayments, useCreateDepositRequest, useCancelDepositRequest,
         useAssignDepositSettlement, useIssueDepositInvoice } from '../lib/queries/billing.js'
import { anforderungsBetrag, prozentAusEingabe,
         faelligkeitVorschlag } from '../lib/vorauszahlung.js'
import { useHausrechte, type Hausrechte } from '../lib/rechte.js'
import { newIdempotencyKey } from '../lib/api.js'
import { useEscape } from '../lib/tasten.js'
import { useT, useLocale, formatMoney, formatDate, intlTag } from '../lib/i18n/index.js'
import { ZahlungslinkErzeugen, ZahlungslinkListe } from './Zahlungslink.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Anzahlung: anfordern, Link schicken, Eingang sehen.
 *
 * **Warum am Reservierungsfenster.** Eine Anzahlung wird bei der Buchung
 * vereinbart, nicht beim Check-out -- und wer die Reservierung offen hat,
 * sieht dort, ob sie gesichert ist. Das Folio zeigt dieselbe Liste in seiner
 * Vorauszahlung, aus derselben Antwort.
 *
 * **Ein Aufruf**, nicht einer je Anforderung: `GET .../prepayments` bringt
 * Anforderungen, Links, Eingaenge, Geschaeftstag und Postbereitschaft
 * zusammen. Der Zustand jeder Anforderung kommt fertig aus der API; die
 * Maske rechnet ihn nicht nach, denn "ueberfaellig" haengt am Geschaeftstag
 * des Hauses und nicht an der Uhr dieses Rechners.
 *
 * **Die Rechte entscheiden, was zu sehen ist**, nicht was erlaubt ist --
 * das entscheidet die API. Wer nur lesen darf, sieht den Stand ohne Knoepfe.
 */
export function Anzahlung({ folioRef }: { folioRef: string }): JSX.Element {
  const t = useT()
  const q = usePrepayments(folioRef, 0)

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t('anz.title')}</h3>
        <div className="grow" />
        {/* Der Eingang kommt vom Zahlungsdienstleister, nicht von dieser
            Maske. Wer auf ihn wartet, braucht einen Weg, neu zu fragen,
            ohne das Fenster zu schliessen. */}
        <button type="button" onClick={() => void q.refetch()} disabled={q.isFetching}
                className="text-xs px-2 py-0.5 rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('vz.reload')}
        </button>
      </div>
      {q.isError && <Fehler error={q.error} />}
      {q.data === undefined && !q.isError && <p className="text-sm text-neutral-400">…</p>}
      {q.data !== undefined && <Anforderungen folioRef={folioRef} v={q.data} />}
    </section>
  )
}

const ZUSTANDSFARBE: Record<DepositRequestState, string> = {
  requested: 'bg-neutral-100 text-neutral-700',
  link_sent: 'bg-sky-100 text-sky-800',
  partial: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
  overdue: 'bg-red-100 text-red-800',
  canceled: 'bg-neutral-100 text-neutral-500 line-through'
}

/** Die Anforderungen eines Folios. Auch im Folio unter der Vorauszahlung. */
export function Anforderungen({ folioRef, v }: {
  folioRef: string; v: PrepaymentView
}): JSX.Element {
  const t = useT()
  const rechte = useHausrechte(v.propertyId)
  const darfBuchen = rechte.darf('folio:post')

  return (
    <div className="space-y-2">
      {v.isTraining && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-sm p-2">
          {t('anz.trainingHint')}
        </p>
      )}

      {v.requests.length === 0
        ? <p className="text-sm text-neutral-400">{t('anz.none')}</p>
        : (
          <ul className="space-y-2">
            {v.requests.map(r => (
              <li key={r.requestRef}>
                <AnforderungZeile folioRef={folioRef} v={v} r={r} rechte={rechte} />
              </li>
            ))}
          </ul>
        )}

      {darfBuchen && (v.canRequestDeposit
        ? <NeueAnforderung folioRef={folioRef} v={v} />
        : <p className="text-xs text-neutral-500">{t('anz.blocked')}</p>)}
    </div>
  )
}

function AnforderungZeile({ folioRef, v, r, rechte }: {
  folioRef: string; v: PrepaymentView; r: DepositRequest; rechte: Hausrechte
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [offen, setOffen] = useState<'link' | 'zuordnen' | null>(null)
  const zurueckziehen = useCancelDepositRequest(folioRef)

  const aktiv = r.state !== 'canceled' && r.state !== 'received'
  const darfBuchen = rechte.darf('folio:post')
  const links = v.paymentLinks.filter(l => l.depositRequestRef === r.requestRef)
  // Ein gueltiger Link ist unterwegs: dann keinen zweiten anbieten -- die
  // API weist ihn ohnehin ab (payments.linkActive).
  const linkUnterwegs = links.some(l => !l.legacy && l.status === 'pending' && !l.expired)

  return (
    <div className="border border-neutral-200 rounded-sm p-2 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium tabular-nums">{formatMoney(r.amountCent, locale)}</span>
        {r.percentBp !== null && r.basisCent !== null && (
          <span className="text-xs text-neutral-500">
            {t('anz.percentOf', { percent: (r.percentBp / 100).toLocaleString(intlTag(locale)),
                                  stay: formatMoney(r.basisCent, locale) })}
          </span>
        )}
        <span className="text-xs text-neutral-500">
          {t('anz.dueOn', { date: formatDate(r.dueDate, locale) })}
        </span>
        <div className="grow" />
        <span className={`text-xs px-1.5 py-0.5 rounded-sm ${ZUSTANDSFARBE[r.state]}`}>
          {t(`anz.state.${r.state}`)}
        </span>
      </div>

      {r.receivedCent > 0 && (
        <p className="text-xs text-neutral-600 tabular-nums">
          {t('anz.receivedOf', { received: formatMoney(r.receivedCent, locale),
                                 amount: formatMoney(r.amountCent, locale) })}
        </p>
      )}

      {/* Welche Anzahlungsrechnung zu den Eingaengen gehoert: die Nummer
          ist das, wonach der Gast oder die Buchhaltung fragt. */}
      {v.settlements
        .filter(s => r.settlementIds.includes(s.id) && s.depositInvoiceNumber !== null)
        .map(s => (
          <p key={s.id} className="text-xs text-emerald-800 tabular-nums">
            ✓ {t('vz.dep.hasInvoice')} {s.depositInvoiceNumber}
          </p>
        ))}

      {r.depositInvoiceMissing && (
        <RechnungFehlt folioRef={folioRef} v={v} r={r}
                       darf={rechte.darf('invoice:issue')} />
      )}

      {links.length > 0 && (
        <ZahlungslinkListe folioRef={folioRef} links={links} darfBuchen={darfBuchen} />
      )}

      {darfBuchen && aktiv && offen === null && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {!v.isTraining && !linkUnterwegs && (
            <button type="button" onClick={() => setOffen('link')}
                    className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                               hover:bg-neutral-50">
              {t('anz.link')}
            </button>
          )}
          <button type="button" onClick={() => setOffen('zuordnen')}
                  className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                             hover:bg-neutral-50">
            {t('anz.assign')}
          </button>
          <button type="button" disabled={zurueckziehen.isPending}
                  onClick={() => {
                    if (confirm(t('anz.withdrawConfirm'))) zurueckziehen.mutate(r.requestRef)
                  }}
                  className="text-xs px-2 py-1 rounded-sm border border-red-300 text-red-800
                             hover:bg-red-50 disabled:opacity-40">
            {t('anz.withdraw')}
          </button>
        </div>
      )}

      {darfBuchen && aktiv && linkUnterwegs && (
        <p className="text-xs text-neutral-500">{t('anz.linkActive')}</p>
      )}

      {offen === 'link' && (
        <ZahlungslinkErzeugen folioRef={folioRef} v={v} vorschlagCent={r.openCent}
                              depositRequestRef={r.requestRef}
                              darfPost={rechte.darf('email:send')}
                              onSchliessen={() => setOffen(null)} />
      )}
      {offen === 'zuordnen' && (
        <EingangZuordnen folioRef={folioRef} v={v} r={r} onSchliessen={() => setOffen(null)} />
      )}
      {zurueckziehen.isError && <Fehler error={zurueckziehen.error} />}
    </div>
  )
}

/**
 * Ein Eingang ohne Anzahlungsrechnung.
 *
 * Die Rechnung entsteht nicht von selbst, auch nicht beim Eingang ueber den
 * Link: sie zieht eine Nummer aus der lueckenlosen Folge und braucht
 * Pflichtangaben, die ein Mensch pruefen soll (Dokument 16, Aufgabe 3).
 * Deshalb steht hier der Hinweis **und** der Weg -- derselbe Endpunkt wie im
 * Folio, mit aus dem Aufenthalt abgeleiteten Steuersaetzen.
 */
function RechnungFehlt({ folioRef, v, r, darf }: {
  folioRef: string; v: PrepaymentView; r: DepositRequest; darf: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [schluessel, setSchluessel] = useState(newIdempotencyKey)
  const ausstellen = useIssueDepositInvoice(folioRef)
  const ohne = v.settlements.filter(
    s => r.settlementIds.includes(s.id) && s.depositInvoiceRef === null)

  return (
    <div className="text-xs bg-amber-50 border border-amber-200 rounded-sm p-2 space-y-1">
      <p className="text-amber-900">{t('anz.invoiceMissing')}</p>
      {darf && v.canIssueDeposit && ohne.map(s => (
        <div key={s.id} className="flex items-center gap-2">
          <span className="tabular-nums">
            {formatDate(s.businessDate, locale)} · {formatMoney(s.amountCent, locale)}
          </span>
          <button type="button" disabled={ausstellen.isPending}
                  onClick={() => ausstellen.mutate({ settlementId: s.id, key: schluessel },
                    { onSuccess: () => setSchluessel(newIdempotencyKey()) })}
                  className="px-2 py-0.5 rounded-sm bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('anz.issueInvoice')}
          </button>
        </div>
      ))}
      {darf && <p className="text-neutral-600">{t('anz.issueHint')}</p>}
      {ausstellen.isError && <Fehler error={ausstellen.error} />}
    </div>
  )
}

function EingangZuordnen({ folioRef, v, r, onSchliessen }: {
  folioRef: string; v: PrepaymentView; r: DepositRequest; onSchliessen: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [gewaehlt, setGewaehlt] = useState<number | null>(null)
  const zuordnen = useAssignDepositSettlement(folioRef)
  useEscape(onSchliessen)

  // Nur Eingaenge, die noch keiner Anforderung gehoeren. Erstattungen sind
  // keine Eingaenge auf eine Forderung.
  const frei = v.settlements.filter(s => s.amountCent > 0 && s.depositRequestRef === null)

  return (
    <div className="space-y-1.5">
      {frei.length === 0
        ? <p className="text-xs text-neutral-500">{t('anz.assignNone')}</p>
        : (
          <form className="flex flex-wrap items-end gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  if (gewaehlt === null) return
                  zuordnen.mutate({ requestRef: r.requestRef, settlementId: gewaehlt },
                    { onSuccess: onSchliessen })
                }}>
            <select required value={gewaehlt ?? ''}
                    onChange={e => setGewaehlt(e.target.value === '' ? null
                                                                    : Number(e.target.value))}
                    className="border border-neutral-300 rounded-sm px-2 py-1 text-sm">
              <option value="">—</option>
              {frei.map(s => (
                <option key={s.id} value={s.id}>
                  {formatDate(s.businessDate, locale)} · {s.method} ·{' '}
                  {formatMoney(s.amountCent, locale)}
                </option>
              ))}
            </select>
            <button type="submit" disabled={gewaehlt === null || zuordnen.isPending}
                    className="px-3 py-1 text-sm rounded-sm bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('anz.assignDo')}
            </button>
          </form>
        )}
      <div className="flex items-center gap-2">
        <p className="text-xs text-neutral-500 grow">{t('anz.assignHint')}</p>
        <button type="button" onClick={onSchliessen}
                className="px-2 py-1 text-xs border border-neutral-300 rounded-sm">
          {t('vz.close')}
        </button>
      </div>
      {zuordnen.isError && <Fehler error={zuordnen.error} />}
    </div>
  )
}

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

function NeueAnforderung({ folioRef, v }: { folioRef: string; v: PrepaymentView }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [art, setArt] = useState<'amount' | 'percent'>(
    () => v.stayCent !== null && v.stayCent > 0 ? 'percent' : 'amount')
  const [wert, setWert] = useState('')
  const [faellig, setFaellig] = useState(() => faelligkeitVorschlag(v.businessDate, v.arrival))
  const [schluessel, setSchluessel] = useState(newIdempotencyKey)
  const anlegen = useCreateDepositRequest(folioRef)

  const betrag = anforderungsBetrag(art, wert, v.stayCent)
  const bp = art === 'percent' ? prozentAusEingabe(wert) : null
  // Ohne Aufenthaltspreis gibt es keine Grundlage fuer Prozent.
  const prozentMoeglich = v.stayCent !== null && v.stayCent > 0

  return (
    <div className="border-t border-neutral-200 pt-2">
      <h4 className="text-xs font-medium text-neutral-600">{t('anz.new')}</h4>
      <form className="mt-1 space-y-2"
            onSubmit={e => {
              e.preventDefault()
              if (betrag === null || faellig === '') return
              anlegen.mutate(
                { dueDate: faellig, key: schluessel,
                  ...(art === 'percent' ? { percentBp: bp! } : { amountCent: betrag }) },
                { onSuccess: () => { setWert(''); setSchluessel(newIdempotencyKey()) } })
            }}>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="radio" name={`anz-art-${folioRef}`} checked={art === 'percent'}
                   disabled={!prozentMoeglich} onChange={() => setArt('percent')} />
            {t('anz.mode.percent')}
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name={`anz-art-${folioRef}`} checked={art === 'amount'}
                   onChange={() => setArt('amount')} />
            {t('anz.mode.amount')}
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block w-28">
            <span className="block text-xs text-neutral-600">
              {art === 'percent' ? t('anz.percent') : t('anz.amount')}
            </span>
            <input required inputMode="decimal" value={wert} className={eingabe}
                   placeholder={art === 'percent' ? '30' : '0,00'}
                   onChange={e => setWert(e.target.value)} />
          </label>
          <label className="block w-40">
            <span className="block text-xs text-neutral-600">{t('anz.due')}</span>
            {/* Ein Kalendertag, als Zeichenkette weitergereicht -- nie durch
                new Date() in Ortszeit, das verschoebe ihn um einen Tag. */}
            <input required type="date" value={faellig} className={eingabe}
                   min={v.businessDate} max={v.departure ?? undefined}
                   onChange={e => setFaellig(e.target.value)} />
          </label>
          <button type="submit" disabled={betrag === null || anlegen.isPending}
                  className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('anz.create')}
          </button>
        </div>
        {/* Die Vorschau steht neben der Eingabe: bei Prozent ist sie der
            Betrag, den die API festschreiben wird, auf den Cent. */}
        {art === 'percent' && betrag !== null && v.stayCent !== null && (
          <p className="text-xs text-neutral-700 tabular-nums">
            {t('anz.preview', { percent: ((bp ?? 0) / 100).toLocaleString(intlTag(locale)),
                                stay: formatMoney(v.stayCent, locale),
                                amount: formatMoney(betrag, locale) })}
          </p>
        )}
        {art === 'percent' && <p className="text-xs text-neutral-500">{t('anz.roundingHint')}</p>}
        <p className="text-xs text-neutral-500">{t('anz.dueHint')}</p>
      </form>
      {anlegen.isError && <div className="mt-2"><Fehler error={anlegen.error} /></div>}
    </div>
  )
}
