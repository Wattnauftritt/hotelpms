import { useState, type JSX } from 'react'
import { FOLDER_LOCALES, SPRACHNAMEN, type GuestRequestItemAdmin,
         type GuestRequestItemInput } from '@hotelpms/contracts'
import { useWunschkatalog, useWunschEintragSpeichern } from '../lib/queries/gaestemappe.js'
import { useT, useLocale, formatMoney } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { centAusEingabe, eingabeAusCent } from '../lib/preisraster.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Der Wunschkatalog der Gaestemappe (Migration 0149): was Gaeste in der
 * freigeschalteten Mappe bestellen koennen, mit Preis oder ohne.
 *
 * Ein Eintrag wird abgeschaltet, nie geloescht -- Wuensche verweisen auf
 * ihn, und die Rezeption soll noch sehen, was bestellt war.
 *
 * Die Namen in den anderen Sprachen traegt das Haus von Hand ein; eine
 * leere Sprache zeigt den deutschen Namen. Maschinell uebersetzt wird hier
 * nicht: ein Name hat zwei, drei Woerter, und "Kissen" falsch uebersetzt
 * ist ein Gast, der das Falsche bekommt.
 */

const ANDERE = FOLDER_LOCALES.filter(l => l !== 'de')

type Entwurf = {
  name: Record<string, string>
  handler: GuestRequestItemInput['handler']
  maxQty: number
  preis: string
  taxRuleId: number | null
  revenueAccount: string
  onFolder: boolean
  onTerminal: boolean
  active: boolean
  position: number
}

function entwurfAus(e: GuestRequestItemAdmin | null, position: number,
                    taxRuleId: number | null): Entwurf {
  return {
    name: { ...(e?.name ?? {}) },
    handler: e?.handler ?? 'reception',
    maxQty: e?.maxQty ?? 1,
    preis: e?.price == null ? '' : eingabeAusCent(e.price.grossCent),
    taxRuleId: e?.price?.taxRuleId ?? taxRuleId,
    revenueAccount: e?.price?.revenueAccount ?? '8400',
    onFolder: e?.onFolder ?? true,
    onTerminal: e?.onTerminal ?? false,
    active: e?.active ?? true,
    position: e?.position ?? position
  }
}

export function GaestemappeWuensche({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useWunschkatalog(propertyId)
  const [offen, setOffen] = useState<{ eintrag: GuestRequestItemAdmin | null } | null>(null)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const { items, taxRules } = q.data

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t('folder.req.catalog')}</h2>
      <p className="text-xs text-neutral-500">{t('folder.req.catalogHint')}</p>
      {items.length === 0
        ? <p className="text-sm text-neutral-600">{t('folder.req.none')}</p>
        : (
          <ul className="divide-y divide-neutral-100 rounded-sm border border-neutral-200">
            {items.map(e => (
              <li key={e.itemRef} className={`flex items-center gap-3 px-3 py-1.5 text-sm
                                              ${e.active ? '' : 'text-neutral-400'}`}>
                <span className="grow">{e.name[locale] ?? e.name.de}</span>
                {e.handler === 'housekeeping' && (
                  <span className="text-[11px] px-1 rounded-sm bg-sky-100 text-sky-900">
                    {t('folder.req.housekeeping')}
                  </span>
                )}
                <span className="tabular-nums text-neutral-600">
                  {e.price === null ? t('folder.req.free') : formatMoney(e.price.grossCent, locale)}
                </span>
                <button type="button" disabled={!online} onClick={() => setOffen({ eintrag: e })}
                        className="text-neutral-600 hover:underline disabled:opacity-40">
                  {t('folder.req.edit')}
                </button>
              </li>
            ))}
          </ul>
        )}
      <button type="button" disabled={!online} onClick={() => setOffen({ eintrag: null })}
              className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                         hover:bg-neutral-50 disabled:opacity-40">
        {t('folder.req.add')}
      </button>
      {offen !== null && (
        <Eintrag propertyId={propertyId} eintrag={offen.eintrag} taxRules={taxRules}
                 position={items.length === 0 ? 0 : Math.max(...items.map(i => i.position)) + 1}
                 onClose={() => setOffen(null)} />
      )}
    </section>
  )
}

function Eintrag({ propertyId, eintrag, taxRules, position, onClose }: {
  propertyId: number; eintrag: GuestRequestItemAdmin | null
  taxRules: { id: number; name: string; rateBp: number }[]
  position: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const speichern = useWunschEintragSpeichern(propertyId)
  const [e, setE] = useState<Entwurf>(() => entwurfAus(eintrag, position, taxRules[0]?.id ?? null))
  const setzen = <K extends keyof Entwurf>(k: K, v: Entwurf[K]): void => setE(x => ({ ...x, [k]: v }))

  const mitPreis = e.preis.trim() !== ''
  const cent = mitPreis ? centAusEingabe(e.preis) : null
  const gueltig = (e.name.de ?? '').trim() !== ''
    && (!mitPreis || (cent !== null && cent > 0 && e.taxRuleId !== null
                      && /^[0-9]{4,8}$/.test(e.revenueAccount)))

  const absenden = (): void => {
    const name: Record<string, string> = {}
    for (const [l, v] of Object.entries(e.name)) if (v.trim() !== '') name[l] = v.trim()
    speichern.mutate({ itemRef: eintrag?.itemRef ?? null, eintrag: {
      name, handler: e.handler, maxQty: e.maxQty,
      price: mitPreis && cent !== null && e.taxRuleId !== null
        ? { grossCent: cent, taxRuleId: e.taxRuleId, revenueAccount: e.revenueAccount } : null,
      onFolder: e.onFolder, onTerminal: e.onTerminal, active: e.active, position: e.position
    } }, { onSuccess: onClose })
  }

  const haken = (k: 'onFolder' | 'onTerminal' | 'active', text: string): JSX.Element => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={e[k]} onChange={x => setzen(k, x.target.checked)} />
      {text}
    </label>
  )

  return (
    <Dialog titel={eintrag === null ? t('folder.req.add') : t('folder.req.edit')}
            unterzeile={eintrag?.name.de} breite="mittel" onClose={onClose}
            fuss={<>
              <button type="button" className={KNOPF_LEISE} onClick={onClose}>
                {t('common.cancel')}</button>
              <button type="button" className={KNOPF}
                      disabled={!online || !gueltig || speichern.isPending} onClick={absenden}>
                {t('common.save')}</button>
            </>}>
      <div className="space-y-4">
        <label className="block text-sm">
          {t('folder.req.field.name')}
          <input className={FELD} maxLength={80} value={e.name.de ?? ''}
                 onChange={x => setzen('name', { ...e.name, de: x.target.value })} />
        </label>
        <details>
          <summary className="cursor-pointer text-sm">{t('folder.req.field.otherNames')}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {ANDERE.map(l => (
              <label key={l} className="block text-xs text-neutral-600">
                {SPRACHNAMEN[l]}
                <input className={FELD} maxLength={80} lang={l} value={e.name[l] ?? ''}
                       placeholder={e.name.de ?? ''}
                       onChange={x => setzen('name', { ...e.name, [l]: x.target.value })} />
              </label>
            ))}
          </div>
        </details>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            {t('folder.req.field.handler')}
            <select className={FELD} value={e.handler}
                    onChange={x => setzen('handler', x.target.value as Entwurf['handler'])}>
              <option value="reception">{t('folder.req.handler.reception')}</option>
              <option value="housekeeping">{t('folder.req.housekeeping')}</option>
            </select>
          </label>
          <label className="block text-sm">
            {t('folder.req.field.maxQty')}
            <input type="number" min={1} max={20} className={FELD} value={e.maxQty}
                   onChange={x => setzen('maxQty', Math.min(20, Math.max(1, Number(x.target.value) || 1)))} />
          </label>
          <label className="block text-sm">
            {t('folder.req.field.position')}
            <input type="number" min={0} max={1000} className={FELD} value={e.position}
                   onChange={x => setzen('position', Math.min(1000, Math.max(0, Number(x.target.value) || 0)))} />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            {t('folder.req.field.price')}
            <input className={FELD} inputMode="decimal" value={e.preis}
                   onChange={x => setzen('preis', x.target.value)} />
          </label>
          {mitPreis && (
            <>
              <label className="block text-sm">
                {t('folder.req.field.taxRule')}
                <select className={FELD} value={e.taxRuleId ?? ''}
                        onChange={x => setzen('taxRuleId', x.target.value === '' ? null : Number(x.target.value))}>
                  {taxRules.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                {t('folder.req.field.revenueAccount')}
                <input className={FELD} inputMode="numeric" maxLength={8} value={e.revenueAccount}
                       onChange={x => setzen('revenueAccount', x.target.value.trim())} />
              </label>
            </>
          )}
        </div>
        {mitPreis && taxRules.length === 0 && (
          <p className="text-sm text-amber-900">{t('folder.req.noTaxRule')}</p>
        )}
        <div className="flex flex-wrap gap-4">
          {haken('onFolder', t('folder.req.field.onFolder'))}
          {haken('onTerminal', t('folder.req.field.onTerminal'))}
          {haken('active', t('folder.req.field.active'))}
        </div>
        {speichern.isError && <Fehler error={speichern.error} />}
      </div>
    </Dialog>
  )
}
