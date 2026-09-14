import { useState } from 'react'
import type { JSX } from 'react'
import type { Category, Room } from '@hotelpms/contracts'
import { useCategories, useRooms } from '../lib/queries.js'
import { useUpdateCategory, useUpdateRoom } from '../lib/queries/settings.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Zimmergruppen und Zimmer **ändern und stilllegen**.
 *
 * Anlegen konnte die Einrichtung schon; ändern nicht, obwohl
 * `PATCH /v1/categories/:id` und `PATCH /v1/rooms/:id` seit jeher da sind.
 * Ein Haus ohne diese Maske muss für einen Tippfehler im Zimmergruppennamen
 * den Betreiber anrufen.
 *
 * **Stilllegen statt löschen**, und das ist keine Bequemlichkeit: an einem
 * Zimmer hängen Reservierungen, Belege und Statistik. Die API weist das
 * Stilllegen ab, solange künftige Reservierungen darauf liegen — die
 * Meldung wird hier gezeigt, statt sie zu verstecken.
 *
 * Alle Felder des Modells, nicht nur die drei der Anlage. Jedes hat einen
 * Zweck: `description` geht an den Channel Manager, `sortOrder` bestimmt die
 * Reihenfolge im Zimmerplan, `overbookingLimit` die bewusste Überbuchung,
 * und `attributes` am Zimmer ist das, woran später die Zimmerzuweisung hängt.
 */

const eingabe = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'

function Feld(
  { label, hint, children }:
  { label: string; hint?: string; children: React.ReactNode }
): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs text-neutral-600">{label}</span>
      {children}
      {hint !== undefined && (
        <span className="block text-[11px] text-neutral-400">{hint}</span>
      )}
    </label>
  )
}

/** Merkmale sind eine Liste, im Formular aber eine Zeile. */
export function merkmaleLesen(text: string): string[] {
  return [...new Set(
    text.split(',').map(x => x.trim().toLowerCase()).filter(x => x !== ''))]
}

function GruppeAendern(
  { gruppe, propertyId, onClose }:
  { gruppe: Category; propertyId: number; onClose: () => void }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const aendern = useUpdateCategory(propertyId)
  const [code, setCode] = useState(gruppe.code)
  const [name, setName] = useState(gruppe.name)
  const [description, setDescription] = useState(gruppe.description ?? '')
  const [maxOccupancy, setMaxOccupancy] = useState(gruppe.maxOccupancy)
  const [sortOrder, setSortOrder] = useState(gruppe.sortOrder)
  const [overbookingLimit, setOverbookingLimit] = useState(gruppe.overbookingLimit)

  return (
    <form className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={e => {
            e.preventDefault()
            aendern.mutate(
              { id: gruppe.id, code: code.trim(), name: name.trim(),
                description, maxOccupancy, sortOrder, overbookingLimit },
              { onSuccess: onClose })
          }}>
      <Feld label={t('setup.code')}>
        <input required value={code} onChange={e => setCode(e.target.value)}
               className={eingabe} />
      </Feld>
      <div className="sm:col-span-3">
        <Feld label={t('setup.name')}>
          <input required value={name} onChange={e => setName(e.target.value)}
                 className={eingabe} />
        </Feld>
      </div>
      <div className="sm:col-span-4">
        <Feld label={t('master.description')} hint={t('master.descriptionHint')}>
          <input value={description} onChange={e => setDescription(e.target.value)}
                 className={eingabe} />
        </Feld>
      </div>
      <Feld label={t('setup.maxOccupancy')} hint={t('master.occupancyHint')}>
        <input type="number" min={1} max={30} value={maxOccupancy}
               onChange={e => setMaxOccupancy(Number(e.target.value))}
               className={eingabe} />
      </Feld>
      <Feld label={t('master.sortOrder')} hint={t('master.sortOrderHint')}>
        <input type="number" value={sortOrder}
               onChange={e => setSortOrder(Number(e.target.value))} className={eingabe} />
      </Feld>
      <Feld label={t('master.overbooking')} hint={t('master.overbookingHint')}>
        <input type="number" min={0} value={overbookingLimit}
               onChange={e => setOverbookingLimit(Number(e.target.value))}
               className={eingabe} />
      </Feld>
      <div className="flex items-start gap-2">
        <button type="submit" disabled={!online || aendern.isPending}
                className="mt-4 px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
        <button type="button" onClick={onClose}
                className="mt-4 px-3 py-1.5 text-sm rounded border border-neutral-300">
          {t('common.cancel')}
        </button>
      </div>
      {aendern.isError && (
        <div className="sm:col-span-4"><Fehler error={aendern.error} /></div>
      )}
    </form>
  )
}

function Gruppe(
  { gruppe, propertyId }: { gruppe: Category; propertyId: number }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [offen, setOffen] = useState(false)
  const stilllegen = useUpdateCategory(propertyId)

  return (
    <li className={`border-b border-neutral-100 px-4 py-2 ${
      gruppe.active ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium w-16">{gruppe.code}</span>
        <span className="grow">{gruppe.name}</span>
        <span className="text-neutral-500 tabular-nums">{gruppe.maxOccupancy} P.</span>
        <span className="text-neutral-500 tabular-nums">
          {gruppe.activeRooms} {t('setup.activeRooms')}
          {gruppe.inactiveRooms > 0 && (
            <span className="text-neutral-400"> (+{gruppe.inactiveRooms})</span>
          )}
        </span>
        {!gruppe.active && (
          <span className="text-xs px-1.5 py-0.5 rounded border border-neutral-300
                           bg-neutral-100 text-neutral-600">
            {t('master.inactive')}
          </span>
        )}
        <button onClick={() => setOffen(o => !o)}
                className="px-3 py-1 text-sm rounded border border-neutral-300
                           hover:bg-neutral-50">
          {t(offen ? 'master.close' : 'master.edit')}
        </button>
        <button onClick={() => stilllegen.mutate({ id: gruppe.id, active: !gruppe.active })}
                disabled={!online || stilllegen.isPending}
                className="px-3 py-1 text-sm rounded border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t(gruppe.active ? 'master.deactivate' : 'master.activate')}
        </button>
      </div>
      {/* Die Absage der API steht an der Zeile, an der sie entstanden ist:
          sie nennt die Zahl der künftigen Reservierungen. */}
      {stilllegen.isError && (
        <div className="mt-2"><Fehler error={stilllegen.error} /></div>
      )}
      {offen && (
        <GruppeAendern gruppe={gruppe} propertyId={propertyId}
                       onClose={() => setOffen(false)} />
      )}
    </li>
  )
}

function ZimmerAendern(
  { zimmer, gruppen, propertyId, onClose }:
  { zimmer: Room; gruppen: Category[]; propertyId: number; onClose: () => void }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const aendern = useUpdateRoom(propertyId)
  const [code, setCode] = useState(zimmer.code)
  const [floor, setFloor] = useState(zimmer.floor ?? '')
  const [attributes, setAttributes] = useState(zimmer.attributes.join(', '))
  const [categoryId, setCategoryId] = useState(zimmer.categoryId)

  return (
    <form className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={e => {
            e.preventDefault()
            aendern.mutate(
              { id: zimmer.id, code: code.trim(), floor,
                attributes: merkmaleLesen(attributes), categoryId },
              { onSuccess: onClose })
          }}>
      <Feld label={t('common.room')}>
        <input required value={code} onChange={e => setCode(e.target.value)}
               className={eingabe} />
      </Feld>
      <Feld label={t('master.floor')}>
        <input value={floor} onChange={e => setFloor(e.target.value)}
               className={eingabe} />
      </Feld>
      <div className="sm:col-span-2">
        <Feld label={t('common.category')}>
          <select value={categoryId} className={eingabe}
                  onChange={e => setCategoryId(Number(e.target.value))}>
            {gruppen.map(c => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </Feld>
      </div>
      <div className="sm:col-span-4">
        <Feld label={t('master.attributes')} hint={t('master.attributesHint')}>
          <input value={attributes} onChange={e => setAttributes(e.target.value)}
                 className={eingabe} />
        </Feld>
      </div>
      <div className="sm:col-span-4 flex gap-2">
        <button type="submit" disabled={!online || aendern.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
        <button type="button" onClick={onClose}
                className="px-3 py-1.5 text-sm rounded border border-neutral-300">
          {t('common.cancel')}
        </button>
      </div>
      {aendern.isError && (
        <div className="sm:col-span-4"><Fehler error={aendern.error} /></div>
      )}
    </form>
  )
}

function Zimmer(
  { zimmer, gruppen, propertyId }:
  { zimmer: Room; gruppen: Category[]; propertyId: number }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [offen, setOffen] = useState(false)
  const stilllegen = useUpdateRoom(propertyId)

  return (
    <li className={`border-b border-neutral-100 px-4 py-2 ${
      zimmer.active ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium w-16 tabular-nums">{zimmer.code}</span>
        <span className="w-24 text-neutral-500">{zimmer.categoryCode}</span>
        <span className="w-16 text-neutral-500">{zimmer.floor ?? ''}</span>
        <span className="grow text-neutral-500">{zimmer.attributes.join(', ')}</span>
        {zimmer.outOfOrderBlocks > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded border border-amber-300
                           bg-amber-50 text-amber-900">
            {t('maint.blocked')}
          </span>
        )}
        {!zimmer.active && (
          <span className="text-xs px-1.5 py-0.5 rounded border border-neutral-300
                           bg-neutral-100 text-neutral-600">
            {t('master.inactive')}
          </span>
        )}
        <button onClick={() => setOffen(o => !o)}
                className="px-3 py-1 text-sm rounded border border-neutral-300
                           hover:bg-neutral-50">
          {t(offen ? 'master.close' : 'master.edit')}
        </button>
        <button onClick={() => stilllegen.mutate({ id: zimmer.id, active: !zimmer.active })}
                disabled={!online || stilllegen.isPending}
                className="px-3 py-1 text-sm rounded border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t(zimmer.active ? 'master.deactivate' : 'master.activate')}
        </button>
      </div>
      {stilllegen.isError && (
        <div className="mt-2"><Fehler error={stilllegen.error} /></div>
      )}
      {offen && (
        <ZimmerAendern zimmer={zimmer} gruppen={gruppen} propertyId={propertyId}
                       onClose={() => setOffen(false)} />
      )}
    </li>
  )
}

/**
 * So viele Zimmerzeilen werden hoechstens gezeichnet.
 *
 * Ein Haus mit 300 Zimmern ist keine Seltenheit, und eine Liste, die alle
 * auf einmal zeichnet, ist auf dem Rechner an der Rezeption traege. Wer ein
 * bestimmtes Zimmer sucht, sucht es; wer blaettert, sieht die ersten.
 */
const ZIMMER_MAX = 60

export function Stammdaten({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [zeigeStillgelegte, setZeigeStillgelegte] = useState(false)
  const [suche, setSuche] = useState('')
  const gruppen = useCategories(propertyId)
  const zimmer = useRooms(propertyId, zeigeStillgelegte)

  if (gruppen.isError) return <Fehler error={gruppen.error} />
  if (gruppen.data === undefined) return <Laedt />

  const alleGruppen = gruppen.data.categories
  const sichtbareGruppen = alleGruppen.filter(c => zeigeStillgelegte || c.active)

  const suchbegriff = suche.trim().toLowerCase()
  const gefundeneZimmer = (zimmer.data?.rooms ?? []).filter(r =>
    suchbegriff === ''
    || r.code.toLowerCase().includes(suchbegriff)
    || r.categoryCode.toLowerCase().includes(suchbegriff)
    || (r.floor ?? '').toLowerCase().includes(suchbegriff)
    || r.attributes.some(a => a.includes(suchbegriff)))

  return (
    <section className="bg-white border border-neutral-200 rounded">
      <div className="px-4 py-2 border-b border-neutral-200 flex flex-wrap
                      items-center gap-3">
        <h2 className="text-sm font-medium">{t('master.title')}</h2>
        <div className="grow" />
        <label className="text-sm flex items-center gap-1.5 text-neutral-600">
          <input type="checkbox" checked={zeigeStillgelegte}
                 onChange={e => setZeigeStillgelegte(e.target.checked)} />
          {t('master.showInactive')}
        </label>
      </div>

      <div className="px-4 py-2 text-xs text-neutral-500">
        {t('master.deactivateHint')}
      </div>

      <div className="px-4 py-1 text-xs font-medium text-neutral-600">
        {t('master.categories')}
      </div>
      <ul>
        {sichtbareGruppen.map(c => (
          <Gruppe key={c.id} gruppe={c} propertyId={propertyId} />
        ))}
        {sichtbareGruppen.length === 0 && (
          <li className="px-4 py-3 text-sm text-neutral-400">{t('common.none')}</li>
        )}
      </ul>

      <div className="px-4 py-1 mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-neutral-600">{t('master.rooms')}</span>
        <input value={suche} onChange={e => setSuche(e.target.value)}
               placeholder={t('master.filter')}
               className="border border-neutral-300 rounded px-2 py-1 text-sm w-48" />
      </div>
      <ul>
        {gefundeneZimmer.slice(0, ZIMMER_MAX).map(r => (
          <Zimmer key={r.id} zimmer={r} gruppen={alleGruppen} propertyId={propertyId} />
        ))}
        {zimmer.data !== undefined && gefundeneZimmer.length === 0 && (
          <li className="px-4 py-3 text-sm text-neutral-400">{t('common.none')}</li>
        )}
        {gefundeneZimmer.length > ZIMMER_MAX && (
          <li className="px-4 py-2 text-xs text-neutral-500">
            {gefundeneZimmer.length - ZIMMER_MAX} {t('master.more')}
          </li>
        )}
      </ul>
    </section>
  )
}
