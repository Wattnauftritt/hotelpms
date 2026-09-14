import { useState } from 'react'
import type { Block } from '@hotelpms/contracts'
import { useBlocks, useCreateBlock, useReleaseBlock, useCategories } from '../lib/queries.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Gruppen und Kontingente.
 *
 * Die Zahl, auf die es an der Rezeption ankommt, ist **noch frei**: wie viele
 * Zimmer die Gruppe hält, aber noch nicht abgerufen hat. Sie steht deshalb
 * groß und nicht als dritte Spalte in einer Tabelle.
 *
 * Es gibt bewusst **keinen Löschknopf**. Ein Kontingent wird freigegeben, und
 * das ist eine fachliche Handlung mit Folgen im Bestand: die nicht
 * abgerufenen Zimmer gehen zurück in den freien Verkauf. Löschen würde
 * dagegen die Frage offenlassen, was mit dem Gehaltenen geschieht.
 */

const STATUS_LABEL = {
  active: 'block.status.active',
  released: 'block.status.released',
  closed: 'block.status.closed'
} as const

function Fortschritt({ block }: { block: Block }): JSX.Element {
  const t = useT()
  const anteil = block.quantity === 0 ? 0 : (block.pickedUp / block.quantity) * 100
  return (
    <div className="min-w-40">
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{block.remaining}</span>
        <span className="text-sm text-neutral-500">{t('block.remaining')}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded bg-neutral-200" role="presentation">
        <div className="h-1.5 rounded bg-neutral-900" style={{ width: `${anteil}%` }} />
      </div>
      <div className="mt-1 text-xs text-neutral-500 tabular-nums">
        {block.pickedUp} / {block.quantity} {t('block.pickedUp')}
      </div>
    </div>
  )
}

function Karte(
  { block, propertyId }: { block: Block; propertyId: number }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const freigeben = useReleaseBlock(propertyId)

  return (
    <li className="rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="grow">
          <div className="flex items-center gap-2">
            <span className="font-medium">{block.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${
              block.status === 'active'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-neutral-300 bg-neutral-100 text-neutral-600'}`}>
              {t(STATUS_LABEL[block.status])}
            </span>
          </div>
          <div className="mt-0.5 text-sm text-neutral-600">
            {formatDate(block.fromDate, locale)} – {formatDate(block.toDate, locale)}
            {' · '}{block.categoryName}
            {block.companyName !== null && <> · {block.companyName}</>}
          </div>
          {block.releaseDate !== null && (
            <div className="mt-0.5 text-xs text-neutral-500">
              {t('block.releaseDate')}: {formatDate(block.releaseDate, locale)}
            </div>
          )}
        </div>

        <Fortschritt block={block} />

        {block.status === 'active' && (
          <button
            onClick={() => {
              if (confirm(t('block.releaseConfirm'))) freigeben.mutate(block.blockRef)
            }}
            disabled={!online || freigeben.isPending}
            className="text-sm px-3 py-1.5 rounded border border-neutral-300
                       hover:bg-neutral-50 disabled:opacity-40">
            {t('block.release')}
          </button>
        )}
      </div>

      {freigeben.isError && <div className="mt-2"><Fehler error={freigeben.error} /></div>}

      <details className="mt-2">
        <summary className="text-sm text-neutral-600 cursor-pointer">
          {t('block.pickups')} ({block.pickups.length})
        </summary>
        {block.pickups.length === 0
          ? <div className="mt-1 text-sm text-neutral-500">{t('block.noPickups')}</div>
          : <ul className="mt-1 space-y-0.5">
              {block.pickups.map(p => (
                <li key={p.reservationRef}
                    className="text-sm flex flex-wrap gap-x-3 text-neutral-700">
                  <span className="font-mono text-xs text-neutral-500">{p.reservationRef}</span>
                  <span>{p.guest === '' ? '—' : p.guest}</span>
                  <span className="text-neutral-500">
                    {formatDate(p.arrival, locale)} – {formatDate(p.departure, locale)}
                  </span>
                  <span className="text-neutral-500">{t(`status.${p.status}`)}</span>
                </li>
              ))}
            </ul>}
      </details>
    </li>
  )
}

function Formular({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const kategorien = useCategories(propertyId)
  const anlegen = useCreateBlock(propertyId)

  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState(0)
  const [fromDate, setFromDate] = useState(today())
  const [toDate, setToDate] = useState(addDays(today(), 2))
  const [quantity, setQuantity] = useState(10)
  const [releaseDate, setReleaseDate] = useState('')

  const kats = kategorien.data?.categories ?? []
  const gewaehlt = categoryId !== 0 ? categoryId : kats[0]?.id ?? 0
  const bereit = name.trim() !== '' && gewaehlt !== 0 && quantity > 0 && toDate > fromDate

  const absenden = (e: React.FormEvent) => {
    e.preventDefault()
    if (!bereit) return
    anlegen.mutate(
      { name: name.trim(), categoryId: gewaehlt, fromDate, toDate, quantity,
        ...(releaseDate === '' ? {} : { releaseDate }) },
      { onSuccess: () => { setName(''); setReleaseDate('') } })
  }

  return (
    <form onSubmit={absenden}
          className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="font-medium">{t('block.new')}</div>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('block.name')}</div>
          <input value={name} onChange={e => setName(e.target.value)} required
                 className="border border-neutral-300 rounded px-2 py-1 w-56" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.category')}</div>
          <select value={gewaehlt} onChange={e => setCategoryId(Number(e.target.value))}
                  className="border border-neutral-300 rounded px-2 py-1">
            {kats.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('block.quantity')}</div>
          <input type="number" min={1} value={quantity}
                 onChange={e => setQuantity(Number(e.target.value))}
                 className="border border-neutral-300 rounded px-2 py-1 w-24" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('block.releaseDate')}</div>
          <input type="date" value={releaseDate} onChange={e => setReleaseDate(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
      </div>

      {/* Beide Hinweise stehen am Formular, nicht in einer Fussnote: wer hier
          tippt, trifft gerade die Entscheidung, die sie betreffen. */}
      <div className="text-xs text-neutral-500">
        {t('block.releaseHint')} {t('block.rangeHint')}
      </div>

      {anlegen.isError && <Fehler error={anlegen.error} />}

      <button type="submit" disabled={!online || !bereit || anlegen.isPending}
              className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                         disabled:opacity-40">
        {t('common.save')}
      </button>
    </form>
  )
}

export function Blocks({ propertyId }: { propertyId: number }): JSX.Element {
  const [auchFreigegebene, setAuchFreigegebene] = useState(false)
  const t = useT()
  const q = useBlocks(propertyId, auchFreigegebene ? undefined : 'active')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('block.title')}</h1>
        <div className="grow" />
        <label className="text-sm flex items-center gap-1.5 text-neutral-600">
          <input type="checkbox" checked={auchFreigegebene}
                 onChange={e => setAuchFreigegebene(e.target.checked)} />
          {t('block.showReleased')}
        </label>
      </div>

      <Formular propertyId={propertyId} />

      {q.isError && q.data === undefined
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : q.data.blocks.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {q.data.blocks.map(b => (
                  <Karte key={b.blockRef} block={b} propertyId={propertyId} />
                ))}
              </ul>}
    </div>
  )
}
