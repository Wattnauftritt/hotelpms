import { useState } from 'react'
import { useReservation, useRegistrationForm, useSubmitRegistration, useCheckIn,
         useSetReservationGuest, useTerms,
         type RegistrationForm } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { GuestPicker } from '../components/GuestPicker.tsx'
import { Dialog, KNOPF, KNOPF_LEISE } from '../components/Dialog.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { TerminalAuftrag } from '../components/AmTerminal.tsx'
import { useAvsStand, useAvsMelden, useAvsErneut } from '../lib/queries/avs.js'
import type { Guest } from '@hotelpms/contracts'

/**
 * Check-in mit Meldeschein (A9), erreichbar aus dem Plan und aus "Heute".
 *
 * **Der Dialog zeigt eins von zwei Dingen** (Sven, 05.10.2026): den schon
 * ausgefuellten Meldeschein mit Inhalt, oder einen grossen Knopf
 * "Meldeformular auf Gaesteterminal oeffnen". Alles andere ist dorthin
 * gewandert, wo der Gast steht:
 *
 * - **Mitreisende** traegt der Gast im Formular selbst ein. Die Gastsuche,
 *   ueber die die Rezeption sie hier anhaengte, verwirrte mehr, als sie half.
 * - **Hausbedingungen** stehen am Ende des Meldeformulars und werden dort
 *   mit derselben Unterschrift unterschrieben -- kein eigener Kasten, kein
 *   eigener Auftrag.
 * - **Unterschreiben** tut nur der Gast, am Terminal. Ein Zeichenfeld am
 *   Rezeptionsbildschirm lud dazu ein, fuer ihn zu unterschreiben.
 *
 * Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste den
 * Meldeschein; fehlt deren Unterschrift nach einer Vorab-Erfassung per Link,
 * fordert der Knopf sie am Terminal an.
 *
 * **Ohne gekoppeltes Terminal** bleibt ein leiser Ausweg: der Schein aus den
 * vorhandenen Daten. Sonst waere ein Haus ohne Geraet hier in einer
 * Sackgasse.
 *
 * **Die AVS-Datei entsteht im selben Ablauf** (Sven, 05.10.2026): Einchecken
 * klicken, Meldeschein erfassen, falls er fehlt, Datei herunterladen und in
 * AVS einlesen -- dort entsteht in diesem Moment die Kurkarte. Ist das Haus
 * eingerichtet, heisst der Knopf deshalb "Einchecken und AVS-Datei". Erst
 * die Datei, dann der Check-in: scheitert die Datei, ist noch nichts
 * geschehen, und "Nur einchecken" bleibt als Ausweg.
 */
export function CheckIn({ reservationRef, propertyId, onClose }: {
  reservationRef: string; propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const reservierung = useReservation(reservationRef)
  const form = useRegistrationForm(reservationRef)
  const [gastWechseln, setGastWechseln] = useState(false)
  const anmelden = useSubmitRegistration(propertyId)
  const einchecken = useCheckIn(reservationRef)
  const gastSetzen = useSetReservationGuest(reservationRef)
  const avsMelden = useAvsMelden(reservationRef)
  const [gaestekarte, setGaestekarte] = useState<boolean | null>(null)

  const uebernehmen = (g: Guest | null): void => {
    if (g === null) return
    gastSetzen.mutate(g.guestRef, { onSuccess: () => setGastWechseln(false) })
  }

  const einchecken_und_schliessen = async (): Promise<void> => {
    await einchecken.mutateAsync()
    onClose()
  }

  // Ohne zugewiesenes Zimmer lehnt die API den Check-in ab -- das sagt die
  // Maske vorher, statt den Knopf drueckbar zu machen und dann zu scheitern.
  const ohneZimmer = reservierung.data !== undefined && reservierung.data.resourceId === null
  const f = form.data
  // Vorab per Link erfasst, Unterschrift steht aus: erst unterschreiben,
  // dann einchecken. Sie gehoert an den Anreisetag, und der ist jetzt.
  const unterschriftOffen = f?.signaturePending === true
  const angemeldet = f !== undefined && (f.alreadyRegistered || anmelden.isSuccess)
  // Neu fragen, sobald der Schein hier entsteht oder unterschrieben wird.
  const avs = useAvsStand(reservationRef,
                          [angemeldet, f?.signedAt ?? null])
  const avsBereit = avs.data !== undefined && avs.data.configured && !avs.data.training
    && avs.data.reportedAt === null
  const mitKarte = gaestekarte ?? avs.data?.digitalGuestCard ?? false
  const eincheckenGesperrt = ohneZimmer || einchecken.isPending || avsMelden.isPending
    || f === undefined || !angemeldet || unterschriftOffen

  const melden_einchecken_schliessen = async (): Promise<void> => {
    await avsMelden.mutateAsync({ digitalGuestCard: mitKarte })
    await einchecken_und_schliessen()
  }

  return (
    /*
     * `nebenbeiSchliessen={false}`: waehrend der Gast am Terminal ausfuellt,
     * zeigt der Dialog den Stand des Auftrags. Ein Klick neben den Rand waere
     * er los, und die Rezeption saehe nicht, wann der Schein steht.
     */
    <Dialog breite="breit" nebenbeiSchliessen={false} onClose={onClose}
            titel={t('checkin.title')} unterzeile={reservationRef}
            fuss={
              <>
                {avsBereit ? (
                  <>
                    <button type="button" disabled={eincheckenGesperrt}
                            onClick={() => void melden_einchecken_schliessen()}
                            className={KNOPF}>
                      {t('checkin.submitWithAvs')}
                    </button>
                    <button type="button" disabled={eincheckenGesperrt}
                            onClick={() => void einchecken_und_schliessen()}
                            className={KNOPF_LEISE}>
                      {t('checkin.submitWithoutAvs')}
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={eincheckenGesperrt}
                          onClick={() => void einchecken_und_schliessen()}
                          className={KNOPF}>
                    {t('checkin.submit')}
                  </button>
                )}
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                {avsMelden.isError && <Fehler error={avsMelden.error} />}
                {einchecken.isError && <Fehler error={einchecken.error} />}
              </>
            }>
      <div className="space-y-3">
        {ohneZimmer && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200
                        rounded-sm p-2">
            {t('checkin.needsRoom')}
          </p>
        )}

        {form.isError && <Fehler error={form.error} />}
        {f === undefined && !form.isError && <Laedt />}
        {f !== undefined && (() => {
          if (f.guest === null || gastWechseln) {
            /*
             * Ohne Gast gibt es kein Meldeformular: das Terminal fuellt es
             * fuer den Gast der Reservierung aus. Bei einer Gruppe ist das der
             * Normalfall -- vier von fuenf Zimmern haben noch keinen Namen.
             */
            return (
              <div className="space-y-2">
                <p className="text-xs text-neutral-600">{t('checkin.whoStaysHere')}</p>
                <GuestPicker value={null} onChange={uebernehmen} />
                {gastSetzen.isError && <Fehler error={gastSetzen.error} />}
                {gastWechseln && (
                  <button type="button" onClick={() => setGastWechseln(false)}
                          className="text-xs text-neutral-500 underline">
                    {t('booking.close')}
                  </button>
                )}
              </div>
            )
          }
          return (
            <div className="space-y-3">
              {angemeldet ? (
                <>
                  <Meldeschein f={f} reservationRef={reservationRef} />
                  {unterschriftOffen && (
                    <>
                      <p className="text-xs text-amber-900 border border-amber-200 bg-amber-50
                                    rounded-sm p-2">
                        {t('checkin.signAtTerminal')}
                      </p>
                      <TerminalAuftrag reservationRef={reservationRef} kind="registration_sign"
                                       beschriftung={t('checkin.requestSignature')} />
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm bg-neutral-50 rounded-sm p-2">
                    <span className="grow truncate">
                      {f.guest.lastName}{f.guest.firstName ? `, ${f.guest.firstName}` : ''}
                    </span>
                    <button type="button" onClick={() => setGastWechseln(true)}
                            className="text-xs text-neutral-500 underline shrink-0">
                      {t('guestPicker.change')}
                    </button>
                  </div>
                  <TerminalAuftrag reservationRef={reservationRef} kind="registration_fill"
                                   beschriftung={t('checkin.openFormAtTerminal')}
                                   ohneTerminal={
                                     <div className="space-y-2 text-center py-4">
                                       <p className="text-sm text-neutral-600">
                                         {t('checkin.noTerminal')}
                                       </p>
                                       {/* Der Schein aus den vorhandenen Daten.
                                           Verlangt er eine Unterschrift, entsteht
                                           er ohne sie; der Gast leistet sie
                                           spaeter am Terminal. */}
                                       <button type="button" disabled={anmelden.isPending}
                                               onClick={() => anmelden.mutate({
                                                 reservationRef,
                                                 signatureLater: f.signatureRequired
                                                   ? true : undefined })}
                                               className="text-xs text-neutral-600 underline
                                                          disabled:opacity-40">
                                         {t('checkin.registerWithoutTerminal')}
                                       </button>
                                       {anmelden.isError && <Fehler error={anmelden.error} />}
                                     </div>
                                   } />
                  <p className="text-xs text-neutral-500 text-center">
                    {t('checkin.openFormHint')}
                  </p>
                </>
              )}

              {angemeldet && avs.data !== undefined && avs.data.configured && (
                <AvsAbschnitt reservationRef={reservationRef} training={avs.data.training}
                              reportedAt={avs.data.reportedAt}
                              exportedHere={avs.data.exportedHere}
                              hasEmail={avs.data.hasEmail}
                              mitKarte={mitKarte} setMitKarte={setGaestekarte} />
              )}
            </div>
          )
        })()}
      </div>
    </Dialog>
  )
}

/**
 * Der ausgefuellte Meldeschein, wie er vorliegt: Gast, Anschrift,
 * Mitreisende, Unterschrift und die Hausbedingungen, die mit ihm
 * unterschrieben wurden. Nur Anzeige -- geaendert wird er hier nicht mehr,
 * er ist eine Erklaerung des Gastes ueber sich selbst.
 */
function Meldeschein({ f, reservationRef }: {
  f: RegistrationForm; reservationRef: string
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const bedingungen = useTerms(reservationRef)
  const g = f.guest!
  const datum = (d: string | null): string => d === null ? '—' : formatDate(d.slice(0, 10), locale)
  const name = (p: { lastName: string; firstName: string | null }): string =>
    `${p.lastName}${p.firstName ? `, ${p.firstName}` : ''}`

  return (
    <div className="border border-emerald-200 rounded-sm text-sm">
      {/* Auf einen Blick (Sven, 05.10.2026): liegt der Schein vor, geht es
          einfach weiter -- der Kopf sagt das, bevor jemand den Inhalt liest. */}
      <div className="bg-emerald-50 text-emerald-900 font-medium px-3 py-2 rounded-t-sm">
        ✓ {t('checkin.alreadyRegistered')}
      </div>
      <div className="p-3 space-y-3">
        {/* Wer auf dem Schein steht, zuerst und als Liste (Sven, 05.10.2026):
            daran sieht die Rezeption, ob alle Personen des Zimmers gemeldet sind. */}
        <div>
          <div className="text-xs text-neutral-500">
            {t('checkin.persons', { n: 1 + f.companions.length })}
          </div>
          <ul className="space-y-0.5">
            {[{ ...g, hauptgast: true }, ...f.companions.map(m => ({ ...m, hauptgast: false }))]
              .map((p, i) => (
                <li key={i}>
                  <span className={p.hauptgast ? 'font-medium' : ''}>{name(p)}</span>
                  <span className="text-neutral-500">
                    {' · '}{datum(p.birthDate)}{p.nationality ? ` · ${p.nationality}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Angabe titel={t('plan.stay')}>
            {formatDate(f.arrival, locale)} – {formatDate(f.plannedDeparture, locale)}
          </Angabe>
          <Angabe titel={t('guests.address')}>
            {[g.address.line1, [g.address.postalCode, g.address.city].filter(Boolean).join(' '),
              g.address.country].filter(Boolean).join(', ') || '—'}
          </Angabe>
        </div>

        <div className="space-y-1">
          {f.signatureRequired ? (
            f.signedAt !== null && (
              <p className="text-emerald-800">
                ✓ {t('terms.signedByGuest', { datum: datum(f.signedAt) })}
              </p>
            )
          ) : (
            <p className="text-xs text-neutral-600">{t('checkin.noSignatureNeeded')}</p>
          )}
          {(bedingungen.data?.terms ?? []).map(b => (
            <p key={b.termsRef} className={b.agreed ? 'text-emerald-800' : 'text-neutral-600'}>
              {b.agreed ? '✓ ' : ''}{b.title}
              {': '}
              {b.agreed
                ? b.signed
                  ? t('terms.signedByGuest', { datum: datum(b.agreedAt) })
                  : t('terms.accepted')
                : t('terms.notSigned')}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

function Angabe({ titel, children }: { titel: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-xs text-neutral-500">{titel}</div>
      <div>{children}</div>
    </div>
  )
}

/**
 * Der AVS-Teil des Dialogs: gemeldet oder nicht, und die Einwilligung in die
 * Gaestekarte per Mail. Gemeldet wird ueber den Knopf im Fuss, nicht hier --
 * ein zweiter Knopf mit derselben Wirkung waere ein Weg, die Datei ohne
 * Check-in zu erzeugen und dann den Check-in zu vergessen.
 */
function AvsAbschnitt({ reservationRef, training, reportedAt, exportedHere, hasEmail,
                        mitKarte, setMitKarte }: {
  reservationRef: string; training: boolean; reportedAt: string | null
  exportedHere: boolean; hasEmail: boolean
  mitKarte: boolean; setMitKarte: (v: boolean) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const erneut = useAvsErneut(reservationRef)

  return (
    <div className="border border-neutral-200 rounded-sm p-2 space-y-1 text-sm">
      <div className="text-xs text-neutral-500">{t('avs.title')}</div>
      {training ? (
        <p className="text-xs text-neutral-600">{t('avs.training')}</p>
      ) : reportedAt !== null ? (
        <>
          <p className="text-emerald-800">
            ✓ {t('avs.reportedAt', { datum: formatDate(reportedAt.slice(0, 10), locale) })}
          </p>
          {exportedHere && (
            <button type="button" disabled={erneut.isPending}
                    onClick={() => erneut.mutate()}
                    className="text-xs text-neutral-600 underline disabled:opacity-40">
              {t('avs.downloadAgain')}
            </button>
          )}
          {erneut.isError && <Fehler error={erneut.error} />}
        </>
      ) : (
        <>
          {/* Nur mit Mailadresse: ohne sie gibt es nichts, wohin die Karte
              ginge, und ein Haekchen ohne Wirkung ist eine Falle. */}
          {hasEmail && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={mitKarte}
                     onChange={e => setMitKarte(e.target.checked)} />
              {t('avs.digitalGuestCard')}
            </label>
          )}
          <p className="text-xs text-neutral-500">{t('avs.finalHint')}</p>
        </>
      )}
    </div>
  )
}
