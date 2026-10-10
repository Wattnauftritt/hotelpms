import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { useMeldescheine, useMeldeschein, nachHauptschein, MAX_MELDESCHEIN_TAGE,
         type Hauptschein, type MeldescheinPerson } from '../lib/queries/meldescheine.js'
import { useT, useLocale, formatDate, type TextKey } from '../lib/i18n/index.js'
import { useSprung } from '../lib/suche.js'
import { today, addDays, daysBetween } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { useAvsMelden, useAvsErneut } from '../lib/queries/avs.js'
import { Dialog, KNOPF_LEISE } from '../components/Dialog.tsx'
import { AusweisFeld } from './Guests.tsx'

/**
 * Meldescheine: alle Scheine eines Zeitraums nach Anreise (Sven, 04.10.2026).
 *
 * Bis hierhin sah man einen Meldeschein nur an seiner Reservierung. Seit die
 * Scheine aus dem Adminpanel übernommen werden, will das Haus sehen, was
 * da ist, und zwar ohne Reservierung für Reservierung aufzuklappen.
 *
 * **Keine Unterschriften und keine Ausweisnummern in der Liste.** Die
 * Schnittstelle gibt sie hier nicht heraus: sie werden der Meldebehörde
 * vorgelegt, nicht in einer Übersicht gezeigt, an der jemand vorbeigeht.
 * Der Knopf an jeder Zeile führt zur Reservierung.
 *
 * **Der Inhalt erst beim Öffnen** (10.10.2026). Sven fragte, warum sich ein
 * Schein hier nicht öffnen lässt -- gesehen hat man bis dahin nur, dass es
 * ihn gibt. „Ansehen" lädt den einen Schein mit Geburtsdaten, Anschriften,
 * Mitreisenden und Unterschrift; die Ausweisnummer bleibt hinter ihrem
 * eigenen Recht und Klick, wie im Gastprofil.
 *
 * Gesucht wird im Zeitraum, nicht über die Schnittstelle: die Liste ist ein
 * Aufruf, und ein Name in der Abfragezeichenfolge wäre ein Gastname im
 * Protokoll gewesen, hätte der Serialisierer ihn nicht ersetzt.
 */

const QUELLE: Record<Hauptschein['source'], TextKey> = {
  desk: 'reg.source.desk', online: 'reg.source.online',
  terminal: 'reg.source.terminal', import: 'reg.source.import'
}

function Unterschrift({ r }: { r: Hauptschein }): JSX.Element {
  const t = useT()
  if (!r.signatureRequired) {
    return <span className="text-neutral-500">{t('reg.signature.notNeeded')}</span>
  }
  return r.signed
    ? <span className="text-emerald-800">{t('reg.signature.done')}</span>
    : <span className="text-amber-800">{t('reg.signature.pending')}</span>
}

function name(r: { lastName: string; firstName: string | null }): string {
  return r.firstName ? `${r.lastName}, ${r.firstName}` : r.lastName
}

export function Meldescheine({ propertyId, permissions }: {
  propertyId: number; permissions: readonly string[]
}): JSX.Element {
  const t = useT()
  const darfInhalt = permissions.includes('guest:read')
  const [offen, setOffen] = useState<number | null>(null)
  const locale = useLocale()
  const { springen } = useSprung()
  const [von, setVon] = useState(addDays(today(), -30))
  const [bis, setBis] = useState(addDays(today(), 30))
  const [suche, setSuche] = useState('')

  const gueltig = von <= bis && daysBetween(von, bis) <= MAX_MELDESCHEIN_TAGE
  const q = useMeldescheine(propertyId, von, bis)
  const zeilen = useMemo(() => {
    const alle = nachHauptschein(q.data?.registrations ?? [])
    const s = suche.trim().toLowerCase()
    return s === '' ? alle : alle.filter(r =>
      [r, ...r.mitreisende].some(p => name(p).toLowerCase().includes(s)))
  }, [q.data, suche])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-lg font-semibold">{t('reg.title')}</h1>
        <div className="grow" />
        <label className="text-sm">
          <div className="text-neutral-600">{t('reg.arrivalFrom')}</div>
          <input type="date" value={von} onChange={e => setVon(e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.to')}</div>
          <input type="date" value={bis} onChange={e => setBis(e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('reg.search')}</div>
          <input value={suche} onChange={e => setSuche(e.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-48" />
        </label>
      </div>

      {!gueltig
        ? <div className="text-sm text-amber-800">
            {t('reg.rangeInvalid', { max: MAX_MELDESCHEIN_TAGE })}
          </div>
        : q.isError
          ? <Fehler error={q.error} />
          : q.data === undefined
            ? <Laedt />
            : zeilen.length === 0
              ? <div className="text-sm text-neutral-500">{t('reg.none')}</div>
              : <>
                  <div className="text-xs text-neutral-500">
                    {t('reg.count', { n: zeilen.length })}
                  </div>
                  <ul className="space-y-2">
                    {zeilen.map(r => (
                      <li key={r.id}
                          className="rounded-sm border border-neutral-200 bg-white p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="tabular-nums text-neutral-600">
                            {formatDate(r.arrival, locale)} – {formatDate(r.plannedDeparture, locale)}
                          </span>
                          <span className="font-medium grow">{name(r)}</span>
                          <span>{r.nationality ?? '–'}</span>
                          <span>{t('reg.persons', { n: r.occupantCount })}</span>
                          <Unterschrift r={r} />
                          {darfInhalt && (
                            <button onClick={() => setOffen(Number(r.id))}
                                    className="px-2 py-1 rounded-sm border border-neutral-300
                                               hover:bg-neutral-50">
                              {t('reg.open')}
                            </button>
                          )}
                          <button onClick={() => springen({ art: 'reservierung',
                                                             ref: r.reservationRef })}
                                  className="px-2 py-1 rounded-sm border border-neutral-300
                                             hover:bg-neutral-50">
                            {t('reg.openReservation')}
                          </button>
                        </div>
                        <div className="mt-1 text-xs text-neutral-500 flex flex-wrap gap-x-4">
                          <span>
                            {t(QUELLE[r.source], { system: r.externalSystem ?? '' })}
                            {', '}{formatDate(r.completedAt.slice(0, 10), locale)}
                          </span>
                          {r.avsReportedAt !== null && (
                            <span>{t('reg.avsReported', {
                              datum: formatDate(r.avsReportedAt.slice(0, 10), locale) })}</span>
                          )}
                          {q.data.avsReporting && <AvsKnopf r={r} />}
                          <span>{t('reg.destroyAfter', {
                            datum: formatDate(r.destroyAfter, locale) })}</span>
                          {r.taxExemption !== null && (
                            <span>{t('reg.taxExemption', { grund: r.taxExemption })}</span>
                          )}
                        </div>
                        {r.mitreisende.length > 0 && (
                          <div className="mt-1 text-xs text-neutral-600">
                            {t('reg.companions')}: {r.mitreisende.map(m =>
                              `${name(m)}${m.nationality ? ` (${m.nationality})` : ''}`
                              + (m.taxExemption !== null
                                ? ` – ${t('reg.taxExemption', { grund: m.taxExemption })}` : ''))
                              .join(' · ')}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </>}
      {offen !== null && (
        <MeldescheinAnsicht id={offen} darfIdentitaet={permissions.includes('guest:read_identity')}
                            onClose={() => setOffen(null)} />
      )}
    </div>
  )
}

/**
 * Der Schein, wie er ausgefuellt wurde. Nur zeigen, nichts aendern: ein
 * Meldeschein ist eine Erklaerung des Gastes, und eine Korrektur gehoert
 * ins Gastprofil, nicht auf das Blatt.
 */
function MeldescheinAnsicht({ id, darfIdentitaet, onClose }: {
  id: number; darfIdentitaet: boolean; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useMeldeschein(id)
  const d = q.data
  const datum = (iso: string | null): string => iso === null ? '–' : formatDate(iso, locale)

  return (
    <Dialog breite="breit" onClose={onClose} titel={t('reg.sheet')}
            unterzeile={d === undefined ? undefined
              : `${name(d.persons[0] ?? { lastName: '', firstName: null })} · ${d.reservationRef}`}
            fuss={<button type="button" onClick={onClose} className={KNOPF_LEISE}>
                    {t('common.close')}
                  </button>}>
      {q.isError
        ? <Fehler error={q.error} />
        : d === undefined
          ? <Laedt />
          : <div className="space-y-4 text-sm">
              <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Angabe label={t('reg.stay')}>
                  {datum(d.arrival)} – {datum(d.plannedDeparture)}
                </Angabe>
                <Angabe label={t('reg.occupants')}>
                  {d.occupantCount}
                </Angabe>
                <Angabe label={t('reg.expectedArrival')}>{d.expectedArrival ?? '–'}</Angabe>
                <Angabe label={t(QUELLE[d.source], { system: d.externalSystem ?? '' })}>
                  {datum(d.completedAt.slice(0, 10))}
                </Angabe>
              </section>

              {d.persons.map(p => (
                <Person key={p.guestRef} p={p} darfIdentitaet={darfIdentitaet} />
              ))}

              <section className="rounded-sm border border-neutral-200 p-3">
                <div className="text-xs text-neutral-500">{t('reg.signature')}</div>
                {!d.signatureRequired
                  ? <div className="text-neutral-500">{t('reg.signature.notNeeded')}</div>
                  : d.signedAt === null
                    ? <div className="text-amber-800">{t('reg.signature.pending')}</div>
                    : <>
                        <div className="text-emerald-800">
                          {t('reg.signedAt', { datum: datum(d.signedAt.slice(0, 10)) })}
                        </div>
                        {/* Als Bild, nie als Markup: ein SVG in <img> fuehrt
                            nichts aus und laedt nichts nach. */}
                        {d.signatureSvg !== null
                          ? <img alt={t('reg.signature')}
                                 src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.signatureSvg)}`}
                                 className="mt-2 max-h-40 border border-neutral-200 bg-white" />
                          : <div className="text-neutral-500">{t('reg.signatureNoImage')}</div>}
                      </>}
              </section>

              <div className="text-xs text-neutral-500 flex flex-wrap gap-x-4">
                {d.digitalGuestCard && <span>{t('reg.digitalGuestCard')}</span>}
                {d.avsReportedAt !== null && (
                  <span>{t('reg.avsReported', { datum: datum(d.avsReportedAt.slice(0, 10)) })}</span>
                )}
                <span>{t('reg.destroyAfter', { datum: datum(d.destroyAfter) })}</span>
              </div>
            </div>}
    </Dialog>
  )
}

function Angabe({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function Person({ p, darfIdentitaet }: {
  p: MeldescheinPerson; darfIdentitaet: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const a = p.address
  const anschrift = [a.line1, [a.postalCode, a.city].filter(Boolean).join(' '), a.country]
    .filter(x => x !== null && x !== '').join(', ')
  return (
    <section className="rounded-sm border border-neutral-200 p-3 space-y-3">
      <div className="text-xs text-neutral-500">
        {p.main ? t('reg.mainGuest') : t('reg.companions')}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Angabe label={t('guests.lastName')}>{p.lastName}</Angabe>
        <Angabe label={t('guests.firstName')}>{p.firstName ?? '–'}</Angabe>
        <Angabe label={t('guests.birthDate')}>
          {p.birthDate === null ? '–' : formatDate(p.birthDate, locale)}
        </Angabe>
        <Angabe label={t('guests.nationality')}>{p.nationality ?? '–'}</Angabe>
        {(p.main || anschrift !== '') && (
          <div className="col-span-2 sm:col-span-4">
            <Angabe label={t('guests.address')}>{anschrift === '' ? '–' : anschrift}</Angabe>
          </div>
        )}
        {p.taxExemption !== null && (
          <div className="col-span-2 sm:col-span-4">
            {t('reg.taxExemption', { grund: p.taxExemption })}
            {p.taxExemptionProof !== null
              && ` · ${t('reg.exemptionProof', { nachweis: p.taxExemptionProof })}`}
          </div>
        )}
      </div>
      {(p.idDocumentType !== null || p.hasIdDocumentNumber) && (
        <AusweisFeld guestRef={p.guestRef} hasIdDocumentNumber={p.hasIdDocumentNumber}
                     idDocumentType={p.idDocumentType} darfLesen={darfIdentitaet} />
      )}
    </section>
  )
}

/**
 * Die AVS-Datei nachtraeglich -- fuer den Gast, der ohne sie eingecheckt
 * wurde, oder wenn der Download im Dialog schiefging. Der Stand kommt aus
 * der Liste, nicht je Zeile nachgeladen; gefragt wird erst beim Klick.
 */
function AvsKnopf({ r }: { r: Hauptschein }): JSX.Element | null {
  const t = useT()
  const melden = useAvsMelden(r.reservationRef)
  const erneut = useAvsErneut(r.reservationRef)
  if (r.avsReportedAt !== null && !r.avsExportedHere) return null
  const fehler = melden.error ?? erneut.error
  return (
    <span className="flex items-center gap-2">
      {r.avsReportedAt === null ? (
        <button type="button" disabled={melden.isPending}
                onClick={() => { if (window.confirm(t('avs.confirmReport'))) melden.mutate({}) }}
                className="underline disabled:opacity-40">
          {t('avs.download')}
        </button>
      ) : (
        <button type="button" disabled={erneut.isPending} onClick={() => erneut.mutate()}
                className="underline disabled:opacity-40">
          {t('avs.downloadAgain')}
        </button>
      )}
      {fehler !== null && <Fehler error={fehler} />}
    </span>
  )
}
