import { useState } from 'react'
import type { Guest } from '@hotelpms/contracts'
import { useSearchGuests, useCreateGuest } from '../lib/queries/guests.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Gast suchen oder neu anlegen (A6), aus dem Buchungsdialog heraus.
 *
 * Die Suche lädt nicht je Zeile nach: ein Aufruf für die Trefferliste,
 * ausgelöst erst ab zwei Zeichen. Ein neuer Gast entsteht über dasselbe
 * kleine Formular, ohne den Dialog zu verlassen.
 *
 * **Der eingetippte Name geht nicht verloren.** Vorher war dieses Feld eine
 * reine Suche: wer „Meier" eintippte und nichts fand, musste einen kleinen
 * unterstrichenen Verweis bemerken und den Namen im Formular dahinter noch
 * einmal schreiben. Wer das nicht tat, legte eine Reservierung **ohne Gast**
 * an, und im Plan stand danach die Kennung der Reservierung an der Stelle,
 * an der ein Name hätte stehen sollen. Es sah aus, als erfinde das System
 * Namen wie „HQNQHPXMDTFA".
 *
 * Deshalb steht unter einer leeren Trefferliste jetzt der Satz, der den
 * eingetippten Namen anbietet, und das Formular dahinter ist damit schon
 * gefüllt. Ein Nachname allein genügt — mehr weiß die Rezeption in dem
 * Moment oft nicht, und mehr zu verlangen hieße, sie zum Erfinden zu
 * bringen.
 */
export function GuestPicker({ value, onChange }: {
  value: Guest | null
  onChange: (guest: Guest | null) => void
}): JSX.Element {
  const t = useT()
  const [begriff, setBegriff] = useState('')
  const [formular, setFormular] = useState(false)
  const suche = useSearchGuests(begriff)

  if (value !== null) {
    return (
      <div className="flex items-center gap-2 text-sm border border-neutral-300 rounded px-2 py-1.5">
        <span className="grow">
          {value.lastName}{value.firstName ? `, ${value.firstName}` : ''}
          {value.status === 'anonymized' && (
            <span className="ml-1 text-xs text-neutral-500">
              ({t('guestPicker.anonymized')})
            </span>
          )}
        </span>
        <button type="button" onClick={() => onChange(null)}
                className="text-xs text-neutral-500 underline">
          {t('guestPicker.change')}
        </button>
      </div>
    )
  }

  if (formular) {
    return <NeuerGast
      // Der Suchbegriff ist der Nachname, bis jemand etwas anderes sagt.
      vorgabe={begriff.trim()}
      onCreated={g => { onChange(g); setFormular(false) }}
      onCancel={() => setFormular(false)} />
  }

  return (
    <div className="space-y-1">
      <input value={begriff} onChange={e => setBegriff(e.target.value)}
             placeholder={t('guestPicker.placeholder')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      {begriff.trim().length > 0 && begriff.trim().length < 2 && (
        <div className="text-xs text-neutral-500">{t('guestPicker.hint')}</div>
      )}
      {suche.data !== undefined && (
        suche.data.guests.length === 0
          ? <div className="space-y-1">
              <div className="text-xs text-neutral-500">{t('guestPicker.noResults')}</div>
              {/* Der eingetippte Name als Angebot, nicht als Verweis auf ein
                  leeres Formular. Ein Klick, und der Gast heißt so, wie er
                  gerade geschrieben wurde. */}
              <button type="button" onClick={() => setFormular(true)}
                      className="text-xs text-left underline text-neutral-800">
                {t('guestPicker.createNamed', { name: begriff.trim() })}
              </button>
            </div>
          : <ul className="border border-neutral-200 rounded divide-y divide-neutral-100 max-h-40
                            overflow-auto">
              {suche.data.guests.map(g => (
                <li key={g.guestRef}>
                  <button type="button" onClick={() => onChange(g)}
                          className="w-full text-left px-2 py-1 text-sm hover:bg-neutral-50">
                    {g.lastName}{g.firstName ? `, ${g.firstName}` : ''}
                    {g.email && <span className="text-neutral-400"> · {g.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
      )}
      <button type="button" onClick={() => setFormular(true)}
              className="text-xs text-neutral-600 underline">
        + {t('guestPicker.createNew')}
      </button>
    </div>
  )
}

function NeuerGast({ vorgabe, onCreated, onCancel }: {
  /** Was in der Suche stand. Landet als Nachname im Feld. */
  vorgabe: string
  onCreated: (g: Guest) => void; onCancel: () => void
}): JSX.Element {
  const t = useT()
  const [lastName, setLastName] = useState(vorgabe)
  const [firstName, setFirstName] = useState('')
  const [email, setEmail] = useState('')
  const anlegen = useCreateGuest()

  return (
    <div className="space-y-2 border border-neutral-200 rounded p-2">
      <div className="flex gap-2">
        <input value={lastName} onChange={e => setLastName(e.target.value)} required
               placeholder={t('guests.lastName')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm w-1/2" />
        <input value={firstName} onChange={e => setFirstName(e.target.value)}
               placeholder={t('guests.firstName')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm w-1/2" />
      </div>
      <input value={email} onChange={e => setEmail(e.target.value)} type="email"
             placeholder={t('guests.email')}
             className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      {anlegen.isError && <Fehler error={anlegen.error} />}
      <div className="flex gap-2">
        <button type="button" disabled={lastName.trim() === '' || anlegen.isPending}
                onClick={() => anlegen.mutate(
                  { lastName: lastName.trim(), firstName: firstName.trim() || undefined,
                    email: email.trim() || undefined },
                  { onSuccess: onCreated })}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('guests.new')}
        </button>
        <button type="button" onClick={onCancel}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300">
          {t('booking.close')}
        </button>
      </div>
    </div>
  )
}
