import { useState } from 'react'
import type { Guest, InvoiceRecipient } from '@hotelpms/contracts'
import { useSetRecipient } from '../lib/queries/billing.js'
import { useSearchCompanies } from '../lib/queries/guests.js'
import { useT } from '../lib/i18n/index.js'
import { GuestPicker } from './GuestPicker.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Wer die Rechnung bekommt.
 *
 * **Warum das eine eigene Zeile verdient.** Die Rechnung geht nicht immer
 * an den, der im Zimmer schläft: die Firma zahlt, der Ehepartner zahlt, die
 * Reisestelle zahlt. Stand der Empfänger falsch, fiel das erst auf dem
 * gedruckten Beleg auf — und der ist Härtegrad 1, die Korrektur eine
 * Stornorechnung.
 *
 * **Die Firma geht vor.** Ist eine gesetzt, geht die Rechnung an sie;
 * derselben Reihenfolge folgt das Festschreiben. Die Maske zeigt deshalb
 * beides und sagt, welches gilt.
 *
 * **Ohne Anschrift keine Rechnung.** § 14 Abs. 4 Nr. 1 UStG verlangt den
 * vollständigen Namen und die Anschrift des Empfängers; fehlt sie, weist
 * das Festschreiben ab. Das steht hier, bevor jemand auf „Rechnung
 * erstellen" drückt, nicht danach.
 */
export function Rechnungsempfaenger({ folioRef, recipient, geschlossen }: {
  folioRef: string
  recipient: InvoiceRecipient
  geschlossen: boolean
}): JSX.Element {
  const t = useT()
  const [auf, setAuf] = useState(false)

  return (
    <section className="bg-white border border-neutral-200 rounded">
      <div className="flex flex-wrap items-baseline gap-2 px-3 py-2">
        <span className="text-sm font-medium">{t('emp.title')}</span>
        {recipient.kind === 'none'
          ? <span className="text-sm text-amber-800">{t('emp.none')}</span>
          : <>
              <span className="text-sm">{recipient.name}</span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600">
                {t(recipient.kind === 'company' ? 'emp.company' : 'emp.guest')}
              </span>
            </>}
        {recipient.kind !== 'none' && !recipient.hasAddress && (
          <span className="text-xs text-amber-800">⚠ {t('emp.noAddress')}</span>
        )}
        <div className="grow" />
        {!geschlossen && (
          <button onClick={() => setAuf(v => !v)}
                  className="text-xs px-2 py-1 border border-neutral-300 rounded">
            {auf ? t('emp.close') : t('emp.change')}
          </button>
        )}
      </div>
      {auf && <Auswahl folioRef={folioRef} recipient={recipient}
                       onFertig={() => setAuf(false)} />}
    </section>
  )
}

function Auswahl({ folioRef, recipient, onFertig }: {
  folioRef: string; recipient: InvoiceRecipient; onFertig: () => void
}): JSX.Element {
  const t = useT()
  const setzen = useSetRecipient(folioRef)

  return (
    <div className="border-t border-neutral-200 px-3 py-2 space-y-3">
      {/* Die Firma zuerst, weil sie vorgeht: wer sie setzt, hat das
          Ergebnis, ohne am Gast etwas zu ändern. */}
      <Firma folioRef={folioRef} recipient={recipient} />

      <div>
        <span className="block text-xs text-neutral-600">{t('emp.guestPick')}</span>
        {/* Die Gastauswahl ist die aus dem Buchungsdialog, nicht eine
            zweite: eine zweite Suche wäre beim dritten Feld eine andere. */}
        <GuestPicker
          value={recipient.guestRef === null ? null
            : ({ guestRef: recipient.guestRef, lastName: recipient.name,
                 firstName: null, status: 'active' } as Guest)}
          onChange={g => {
            setzen.mutate({ guestRef: g?.guestRef ?? null }, { onSuccess: onFertig })
          }} />
        <p className="mt-1 text-xs text-neutral-500">{t('emp.guestHint')}</p>
      </div>

      <p className="text-xs text-neutral-500">{t('emp.snapshotHint')}</p>
      {setzen.isError && <Fehler error={setzen.error} />}
    </div>
  )
}

function Firma({ folioRef, recipient }: {
  folioRef: string; recipient: InvoiceRecipient
}): JSX.Element {
  const t = useT()
  const [begriff, setBegriff] = useState('')
  const treffer = useSearchCompanies(begriff)
  const setzen = useSetRecipient(folioRef)

  if (recipient.companyRef !== null) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs text-neutral-600">{t('emp.company')}:</span>
        <span className="grow">{recipient.name}</span>
        <button type="button"
                onClick={() => setzen.mutate({ companyRef: null })}
                className="text-xs text-neutral-500 underline">
          {t('emp.companyClear')}
        </button>
      </div>
    )
  }

  return (
    <div>
      <label className="block">
        <span className="block text-xs text-neutral-600">{t('emp.companyPick')}</span>
        <input value={begriff} onChange={e => setBegriff(e.target.value)}
               placeholder={t('emp.companySearch')}
               className="mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      </label>
      {treffer.data !== undefined && begriff.trim().length >= 2 && (
        <ul className="mt-1 max-h-40 overflow-y-auto text-sm divide-y divide-neutral-100">
          {treffer.data.companies.map(c => (
            <li key={c.companyRef}>
              <button type="button"
                      onClick={() => {
                        setzen.mutate({ companyRef: c.companyRef })
                        setBegriff('')
                      }}
                      className="w-full text-left px-1 py-1 hover:bg-neutral-50">
                {c.name}
                {c.city !== null && (
                  <span className="ml-1 text-xs text-neutral-500">{c.city}</span>
                )}
              </button>
            </li>
          ))}
          {treffer.data.companies.length === 0 && (
            <li className="px-1 py-1 text-neutral-400">{t('emp.companyNone')}</li>
          )}
        </ul>
      )}
    </div>
  )
}
