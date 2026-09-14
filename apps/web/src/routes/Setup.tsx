import { useState } from 'react'
import type { RoomSeriesReport } from '@hotelpms/contracts'
import { useCategories, useSetupStatus, useCreateCategory, useRoomSeries }
  from '../lib/queries.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Stammdaten } from '../components/Stammdaten.tsx'

/**
 * Einrichtung eines Hauses.
 *
 * Jedes Hotel hat einen anderen Zuschnitt, und es gibt keine Vorlage, die
 * mehr als die Hälfte davon trifft. Deshalb keine Assistenten mit festen
 * Schritten, sondern eine Liste dessen, was noch fehlt, und zwei Formulare:
 * Zimmergruppe anlegen und Zimmer in Serie anlegen.
 *
 * Die Serie zeigt **immer erst eine Vorschau**. 180 Zimmer mit einem
 * Zahlendreher im Muster sind mühsam zurückzunehmen.
 */
export function Setup({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const status = useSetupStatus(propertyId)
  const kategorien = useCategories(propertyId)

  if (status.isError) return <Fehler error={status.error} />
  if (status.data === undefined || kategorien.data === undefined) return <Laedt />

  return (
    <div className="space-y-6 max-w-5xl">
      <section className="bg-white border border-neutral-200 rounded p-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium">{t('setup.title')}</h2>
          <span className={`text-xs px-2 py-0.5 rounded
                            ${status.data.bookable
                              ? 'bg-emerald-100 text-emerald-900'
                              : 'bg-amber-100 text-amber-900'}`}>
            {status.data.bookable ? t('setup.bookable') : t('setup.notBookable')}
          </span>
          {status.data.nextStep !== null && (
            <span className="text-xs text-neutral-500">
              {t('setup.nextStep')}: {status.data.nextStep}
            </span>
          )}
        </div>
        <ol className="mt-3 space-y-1">
          {status.data.steps.map(s => (
            <li key={s.key} className="flex items-start gap-2 text-sm">
              <span className={s.done ? 'text-emerald-600' : 'text-neutral-300'}>
                {s.done ? '✓' : '○'}
              </span>
              <span className="w-56 shrink-0">{s.label}</span>
              <span className="text-neutral-500">{s.hint}</span>
            </li>
          ))}
        </ol>
      </section>

      <NeueGruppe propertyId={propertyId} />
      <Serie propertyId={propertyId}
             kategorien={kategorien.data.categories.map(c => ({ id: c.id, code: c.code,
                                                                name: c.name }))} />

      {/* Anlegen konnte die Einrichtung schon, aendern nicht -- obwohl die
          API es seit jeher kann. Die reine Anzeigetabelle weicht deshalb
          der pflegbaren Liste. */}
      <Stammdaten propertyId={propertyId} />
    </div>
  )
}

function Feld({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs text-neutral-600">{label}</span>
      {children}
      {hint !== undefined && <span className="block text-[11px] text-neutral-400">{hint}</span>}
    </label>
  )
}

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'

function NeueGruppe({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [belegung, setBelegung] = useState(2)
  const anlegen = useCreateCategory(propertyId)

  return (
    <section className="bg-white border border-neutral-200 rounded p-4">
      <h2 className="text-sm font-medium">{t('setup.newCategory')}</h2>
      <form className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={e => {
              e.preventDefault()
              anlegen.mutate({ code, name, maxOccupancy: belegung },
                { onSuccess: () => { setCode(''); setName('') } })
            }}>
        <div className="w-28">
          <Feld label={t('setup.code')}>
            <input required value={code} onChange={e => setCode(e.target.value)}
                   className={eingabe} placeholder="DZ" />
          </Feld>
        </div>
        <div className="w-64">
          <Feld label={t('setup.name')}>
            <input required value={name} onChange={e => setName(e.target.value)}
                   className={eingabe} placeholder="Doppelzimmer" />
          </Feld>
        </div>
        <div className="w-32">
          <Feld label={t('setup.maxOccupancy')}>
            <input type="number" min={1} max={30} value={belegung}
                   onChange={e => setBelegung(Number(e.target.value))} className={eingabe} />
          </Feld>
        </div>
        <button type="submit" disabled={anlegen.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('common.save')}
        </button>
      </form>
      {anlegen.isError && <div className="mt-2"><Fehler error={anlegen.error} /></div>}
    </section>
  )
}

function Serie({ propertyId, kategorien }: {
  propertyId: number; kategorien: Array<{ id: number; code: string; name: string }>
}): JSX.Element {
  const t = useT()
  const [kategorie, setKategorie] = useState<number | ''>('')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [von, setVon] = useState(1)
  const [bis, setBis] = useState(10)
  const [pad, setPad] = useState(0)
  const [etage, setEtage] = useState('')
  const [auslassen, setAuslassen] = useState('')
  const [vorschau, setVorschau] = useState<RoomSeriesReport | null>(null)
  const serie = useRoomSeries(propertyId)

  const rumpf = (commit: boolean) => ({
    propertyId, categoryId: Number(kategorie),
    prefix: prefix === '' ? undefined : prefix,
    suffix: suffix === '' ? undefined : suffix,
    from: von, to: bis,
    pad: pad === 0 ? undefined : pad,
    floor: etage === '' ? undefined : etage,
    skip: auslassen.split(',').map(x => Number(x.trim())).filter(Number.isInteger),
    commit
  })

  const neue = vorschau?.rooms.filter(r => !r.exists) ?? []
  const belegte = vorschau?.rooms.filter(r => r.exists) ?? []

  return (
    <section className="bg-white border border-neutral-200 rounded p-4">
      <h2 className="text-sm font-medium">{t('setup.series')}</h2>
      <form className="mt-3 grid gap-3 sm:grid-cols-4"
            onSubmit={e => {
              e.preventDefault()
              serie.mutate(rumpf(false), { onSuccess: setVorschau })
            }}>
        <div className="sm:col-span-2">
          <Feld label={t('common.category')}>
            <select required value={kategorie} className={eingabe}
                    onChange={e => { setKategorie(Number(e.target.value)); setVorschau(null) }}>
              <option value="">—</option>
              {kategorien.map(c => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
            </select>
          </Feld>
        </div>
        <Feld label={t('setup.prefix')}>
          <input value={prefix} onChange={e => { setPrefix(e.target.value); setVorschau(null) }}
                 className={eingabe} placeholder="1" />
        </Feld>
        <Feld label={t('setup.suffix')}>
          <input value={suffix} onChange={e => { setSuffix(e.target.value); setVorschau(null) }}
                 className={eingabe} />
        </Feld>
        <Feld label={t('setup.numberFrom')}>
          <input type="number" value={von} className={eingabe}
                 onChange={e => { setVon(Number(e.target.value)); setVorschau(null) }} />
        </Feld>
        <Feld label={t('setup.numberTo')}>
          <input type="number" value={bis} className={eingabe}
                 onChange={e => { setBis(Number(e.target.value)); setVorschau(null) }} />
        </Feld>
        <Feld label={t('setup.pad')}>
          <input type="number" min={0} max={6} value={pad} className={eingabe}
                 onChange={e => { setPad(Number(e.target.value)); setVorschau(null) }} />
        </Feld>
        <Feld label={t('setup.floor')}>
          <input value={etage} onChange={e => setEtage(e.target.value)} className={eingabe} />
        </Feld>
        <div className="sm:col-span-2">
          <Feld label={t('setup.skip')} hint={t('setup.skipHint')}>
            <input value={auslassen} className={eingabe}
                   onChange={e => { setAuslassen(e.target.value); setVorschau(null) }} />
          </Feld>
        </div>
        <div className="sm:col-span-2 flex items-end gap-2">
          <button type="submit" disabled={kategorie === '' || serie.isPending}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300
                             disabled:opacity-40">
            {t('common.preview')}
          </button>
          <button type="button"
                  disabled={vorschau === null || neue.length === 0 || serie.isPending}
                  onClick={() => serie.mutate(rumpf(true), { onSuccess: setVorschau })}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('common.apply')}
          </button>
        </div>
      </form>

      {serie.isError && <div className="mt-3"><Fehler error={serie.error} /></div>}

      {vorschau !== null && (
        <div className="mt-4 space-y-2 text-sm">
          {!vorschau.dryRun && (
            <p className="text-emerald-800">
              ✓ {vorschau.created} {t('setup.seriesResult')}
            </p>
          )}
          {vorschau.dryRun && neue.length === 0 && (
            <p className="text-amber-800">{t('setup.seriesEmpty')}</p>
          )}
          {neue.length > 0 && (
            <div>
              <div className="text-xs text-neutral-600">
                {t('setup.seriesPreview')} ({neue.length})
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {neue.map(r => (
                  <span key={r.code}
                        className="px-1.5 py-0.5 rounded bg-emerald-50 border
                                   border-emerald-200 text-xs tabular-nums">
                    {r.code}
                  </span>
                ))}
              </div>
            </div>
          )}
          {belegte.length > 0 && (
            <div>
              <div className="text-xs text-neutral-600">
                {t('setup.seriesExists')} ({belegte.length})
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {belegte.map(r => (
                  <span key={r.code} title={r.reason}
                        className="px-1.5 py-0.5 rounded bg-neutral-100 border
                                   border-neutral-200 text-xs tabular-nums text-neutral-500">
                    {r.code}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
