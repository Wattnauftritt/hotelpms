import type { JSX } from 'react'
import type { SecurityEventKind, SecurityEventRow } from '@hotelpms/contracts'
import { useSecurityEvents, usePlatformSecurityEvents } from '../lib/queries/sicherheit.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { Fehler } from './Fehler.tsx'
import { Laedt } from './Shell.tsx'

/**
 * Das Sicherheitsprotokoll: wer wann von wo eine kritische Handlung
 * ausgeloest hat (Migration 0209, Bedrohungsanalyse 23.10.2026, E3).
 *
 * Die Hinweismail sagt nur, **dass** etwas geschah, und hat bewusst keinen
 * Link. Wer sie bekommt, meldet sich wie gewohnt an und findet hier, was
 * davor und danach geschah -- etwa ob dieselbe Sitzung nach der IBAN auch
 * einen Maschinenzugang angelegt hat.
 *
 * Die Adresse steht ungekuerzt da (Svens Entscheidung, 23.10.2026): fuer
 * eine Anzeige und eine Sperre braucht es die volle.
 */
export function Sicherheitsprotokoll({ plattform = false }: { plattform?: boolean }): JSX.Element {
  const t = useT()
  return (
    <section className="space-y-2 border border-neutral-200 rounded-sm p-4 bg-white">
      <h2 className="text-sm font-medium">{t('sicherheit.log.title')}</h2>
      <p className="text-xs text-neutral-600">{t('sicherheit.log.hint')}</p>
      {plattform ? <PlattformListe /> : <BetriebsListe />}
    </section>
  )
}

function BetriebsListe(): JSX.Element {
  const t = useT()
  const q = useSecurityEvents()
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const zeilen = q.data.pages.flatMap(p => p.events)
  return (
    <>
      <Tabelle zeilen={zeilen} mitBetrieb={false} />
      {q.hasNextPage && (
        <button type="button" disabled={q.isFetchingNextPage}
                onClick={() => { void q.fetchNextPage() }}
                className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('sicherheit.log.more')}
        </button>
      )}
    </>
  )
}

function PlattformListe(): JSX.Element {
  const q = usePlatformSecurityEvents()
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  return <Tabelle zeilen={q.data.events} mitBetrieb />
}

function Tabelle({ zeilen, mitBetrieb }: {
  zeilen: SecurityEventRow[]; mitBetrieb: boolean
}): JSX.Element {
  const t = useT()
  if (zeilen.length === 0) {
    return <p className="text-sm text-neutral-500">{t('sicherheit.log.none')}</p>
  }
  const wer = (z: SecurityEventRow): string =>
    z.actorName ?? (z.actorKind === 'client'
      ? t('sicherheit.log.client', { ref: z.actorRef ?? '' })
      : z.actorKind === 'system' ? t('sicherheit.log.system') : (z.actorRef ?? '–'))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-neutral-500">
          <tr>
            <th className="py-1 pr-3 font-normal">{t('sicherheit.log.when')}</th>
            {mitBetrieb && <th className="py-1 pr-3 font-normal">{t('sicherheit.log.account')}</th>}
            <th className="py-1 pr-3 font-normal">{t('sicherheit.log.what')}</th>
            <th className="py-1 pr-3 font-normal">{t('sicherheit.log.who')}</th>
            <th className="py-1 pr-3 font-normal">{t('sicherheit.log.origin')}</th>
            <th className="py-1 font-normal">{t('sicherheit.log.detail')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {zeilen.map(z => (
            <tr key={z.id} className="align-top">
              <td className="py-1 pr-3 whitespace-nowrap">
                {new Date(z.createdAt).toLocaleString()}
              </td>
              {mitBetrieb && <td className="py-1 pr-3">{z.accountName ?? '–'}</td>}
              <td className="py-1 pr-3">{t(art(z.kind))}</td>
              <td className="py-1 pr-3">{wer(z)}</td>
              <td className="py-1 pr-3 font-mono text-xs">
                {z.origin === null ? '–' : z.originTruncated ? `${z.origin}/…` : z.origin}
              </td>
              <td className="py-1 text-xs text-neutral-600">{angaben(z.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Der Schluessel einer Art. Ohne Umwandlung: fehlt im Katalog die
 * Beschriftung einer neuen Art, ist das hier ein Typfehler und nicht eine
 * leere Zelle.
 */
function art(k: SecurityEventKind): TextKey {
  const key: `sicherheit.kind.${SecurityEventKind}` = `sicherheit.kind.${k}`
  return key
}

/**
 * Die Angaben als kurze Zeile. Es stehen nur Kennungen, Zahlen und
 * gekuerzte Werte darin (der Server schreibt nichts anderes hinein), also
 * darf die Zeile sie so zeigen, wie sie sind.
 */
function angaben(d: Record<string, unknown>): string {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ')
}
