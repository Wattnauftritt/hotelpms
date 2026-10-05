import { useState } from 'react'
import { istAuslaendisch, type Guest } from '@hotelpms/contracts'
import { useReservation, useRegistrationForm, useSubmitRegistration, useCheckIn,
         useSetReservationGuest, useTerms, useAgreeTerms,
         type Hausbedingung } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { GuestPicker } from '../components/GuestPicker.tsx'
import { Dialog, KNOPF, KNOPF_LEISE } from '../components/Dialog.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { AmTerminal } from '../components/AmTerminal.tsx'
import { useAvsStand, useAvsMelden, useAvsErneut } from '../lib/queries/avs.js'

/**
 * Check-in mit Meldeschein (A9), erreichbar aus dem Plan.
 *
 * Seit dem 1.1.2025 unterschreiben nur noch ausländische Gäste. Für einen
 * inländischen Gast erscheint deshalb **gar kein** Unterschriftsfeld -- es
 * gibt dafür seit dem Stichtag keinen Rechtsgrund mehr, und ein System, das
 * es trotzdem verlangt, hält die Rezeption ohne Grund auf.
 *
 * **Hier fällt die Namensliste an.** Ein Bucher nimmt fünf Zimmer, und die
 * übrigen Namen stehen bis zum Anreisetag nicht fest; geplant wird deshalb
 * mit seinem Namen. Jetzt stehen die Leute am Tresen, und jedes Zimmer
 * bekommt seinen eigenen Gast — § 30 BMG verlangt den tatsächlichen, nicht
 * den, der bestellt hat. Bisher ging das hier nicht: die Maske zeigte den
 * Hauptgast an und konnte ihn nicht ändern, und ohne Gast war sie eine
 * Sackgasse.
 *
 * **Hausbedingungen stehen daneben, nicht darin.** Viele Häuser lassen den
 * Gast am selben Tresen mehr unterschreiben als seine Meldedaten — eine
 * Pauschale bei Verlust der Zimmerkarte etwa. Das ist zulässig und hier
 * vorgesehen, aber als **eigener** Nachweis: der Meldeschein ist
 * öffentlich-rechtlich, zweckgebunden und wird nach einem Jahr vernichtet;
 * eine Vereinbarung über 50 Euro ist privatrechtlich und muss länger halten.
 * Deshalb unterschreibt hier auch ein inländischer Gast — die Bedingung,
 * nicht den Meldeschein.
 *
 * **Mitreisende gehören dazu, nicht in eine zweite Maske.** Die Meldepflicht
 * gilt je Person; bei einer Reisegruppe entsteht daraus ein
 * Sammelmeldeschein, bei dem jeder einen eigenen Datensatz bekommt, der auf
 * den Hauptschein zeigt, und bei dem die Reiseleitung unterschreibt. Die API
 * nimmt `occupantGuestRefs` seit jeher an — geschickt hat sie nie jemand.
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
  const locale = useLocale()
  const reservierung = useReservation(reservationRef)
  const form = useRegistrationForm(reservationRef)
  const [gastWechseln, setGastWechseln] = useState(false)
  const [mitreisende, setMitreisende] = useState<Guest[]>([])
  const [neuerMitreisender, setNeuerMitreisender] = useState<Guest | null>(null)
  const anmelden = useSubmitRegistration(propertyId)
  const einchecken = useCheckIn(reservationRef)
  const gastSetzen = useSetReservationGuest(reservationRef)
  const bedingungen = useTerms(reservationRef)
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
  /*
   * Der Meldeschein selbst -- vorgezogen, weil der Knopf "Einchecken" im
   * Fuss der Maske steht und wissen muss, ob schon angemeldet wurde. Im
   * Rumpf steht er nicht mehr: bei einer Gruppe mit Bedingungen rollte er
   * unter den Rand, und dann sah die Maske aus, als habe sie keinen.
   */
  const f = form.data
  /*
   * Eine auslaendische Person auf dem Schein verlangt die Unterschrift, auch
   * wenn der Hauptgast deutsch ist -- dieselbe Regel wie in der Schnittstelle
   * (`istAuslaendisch`, Dokument 30). Die Maske fragt sie vorher ab, statt
   * den Knopf drueckbar zu machen und dann mit 422 zu scheitern.
   */
  const unterschriftNoetig = f !== undefined && (f.signatureRequired
    || mitreisende.some(m => istAuslaendisch({ nationality: m.nationality,
                                                country: m.address.country })))
  // Vorab per Link erfasst, Unterschrift steht aus: erst unterschreiben,
  // dann einchecken. Sie gehoert an den Anreisetag, und der ist jetzt; der
  // Gast leistet sie am Gaesteterminal, die Maske fragt danach neu.
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
     * `nebenbeiSchliessen={false}`: im Kasten steht eine gezeichnete
     * Unterschrift, die nirgends gespeichert ist. Ein Klick neben den Rand
     * waere sie los, und der Gast unterschriebe ein zweites Mal.
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
             * Ohne Gast war das hier eine Sackgasse: die Maske sagte "kein
             * Gast hinterlegt" und bot nichts an. Genau dieser Fall ist bei
             * einer Gruppe der Normalfall -- vier von fuenf Zimmern haben
             * noch keinen Namen.
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
              <div className="grid grid-cols-2 gap-2 text-sm bg-neutral-50 rounded-sm p-2">
                <div>
                  <div className="text-xs text-neutral-500">{t('plan.guest')}</div>
                  <div className="flex items-center gap-2">
                    <span className="grow truncate">
                      {f.guest.lastName}{f.guest.firstName ? `, ${f.guest.firstName}` : ''}
                    </span>
                    {/* Nach dem Meldeschein nicht mehr: er ist eine Erklaerung
                        dieser Person ueber sich selbst. */}
                    {!f.alreadyRegistered && (
                      <button type="button" onClick={() => setGastWechseln(true)}
                              className="text-xs text-neutral-500 underline shrink-0">
                        {t('guestPicker.change')}
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">{t('plan.stay')}</div>
                  <div>{formatDate(f.arrival, locale)} – {formatDate(f.plannedDeparture, locale)}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">{t('guests.address')}</div>
                  <div>{[f.guest.address.postalCode, f.guest.address.city]
                    .filter(Boolean).join(' ') || '—'}
                    {f.guest.address.country ? ` · ${f.guest.address.country}` : ''}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">{t('guests.nationality')}</div>
                  <div>{f.guest.nationality ?? '—'}</div>
                </div>
              </div>

              {f.alreadyRegistered ? (
                <>
                  <p className="text-sm text-emerald-800">✓ {t('checkin.alreadyRegistered')}</p>
                  {f.signatureRequired && f.signedAt !== null && (
                    <p className="text-sm text-emerald-800">✓ {t('terminal.checkin.signed')}</p>
                  )}
                  {unterschriftOffen && (
                    <p className="text-xs text-amber-900 border border-amber-200 bg-amber-50
                                  rounded-sm p-2">
                      {t('checkin.signAtTerminal')}
                    </p>
                  )}
                  {/* Die Bedingungen bleiben sichtbar: der Meldeschein kann
                      vorliegen und die Unterschrift darunter noch fehlen. */}
                  <AmTerminal reservationRef={reservationRef} />
                  {(bedingungen.data?.terms ?? []).map(b => (
                    <Bedingung key={b.termsRef} bedingung={b}
                               reservationRef={reservationRef} />
                  ))}
                </>
              ) : (
                <>
                  <p className="text-xs text-neutral-600">
                    {unterschriftNoetig
                      ? t('checkin.signatureRequired')
                      : t('checkin.noSignatureNeeded')}
                  </p>
                  <div className="space-y-1">
                    <div className="text-xs text-neutral-600">{t('checkin.occupants')}</div>
                    <p className="text-xs text-neutral-500">{t('checkin.occupantsHint')}</p>
                    {mitreisende.map(m => (
                      <div key={m.guestRef}
                           className="flex items-center gap-2 text-sm border
                                      border-neutral-200 rounded-sm px-2 py-1">
                        <span className="grow truncate">
                          {m.lastName}{m.firstName ? `, ${m.firstName}` : ''}
                        </span>
                        <button type="button" title={t('group.remove')}
                                onClick={() => setMitreisende(
                                  mitreisende.filter(x => x.guestRef !== m.guestRef))}
                                className="text-xs text-neutral-500 hover:text-red-700 px-1">
                          ×
                        </button>
                      </div>
                    ))}
                    <GuestPicker value={neuerMitreisender}
                                 onChange={g => {
                                   if (g === null) { setNeuerMitreisender(null); return }
                                   // Nicht zweimal dieselbe Person, und nicht
                                   // den Hauptgast noch einmal: beides
                                   // erhoehte die Personenzahl auf dem
                                   // Meldeschein um jemanden, der schon
                                   // daraufsteht.
                                   if (g.guestRef !== f.guest?.guestRef
                                       && !mitreisende.some(x => x.guestRef === g.guestRef)) {
                                     setMitreisende([...mitreisende, g])
                                   }
                                   setNeuerMitreisender(null)
                                 }} />
                  </div>
                  <AmTerminal reservationRef={reservationRef} />
                  {(bedingungen.data?.terms ?? []).map(b => (
                    <Bedingung key={b.termsRef} bedingung={b}
                               reservationRef={reservationRef} />
                  ))}
                  {anmelden.isError && <Fehler error={anmelden.error} />}
                  {/*
                   * Keine Unterschrift am Rezeptionsbildschirm (Sven,
                   * 05.10.2026): die Rezeption soll nicht fuer den Gast
                   * unterschreiben. Verlangt der Schein eine, entsteht er
                   * ohne sie, und der Gast leistet sie am Gaesteterminal --
                   * derselbe Weg wie nach dem Link (Dokument 31).
                   */}
                  <button type="button" disabled={anmelden.isPending}
                          title={unterschriftNoetig
                            ? t('terminal.checkin.signLaterHint') : undefined}
                          onClick={() => anmelden.mutate({
                            reservationRef,
                            signatureLater: unterschriftNoetig ? true : undefined,
                            occupantGuestRefs: mitreisende.length === 0
                              ? undefined : mitreisende.map(m => m.guestRef) })}
                          className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                                     disabled:opacity-40">
                    {t('checkin.register')}
                  </button>
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
 * Eine Hausbedingung am Tresen.
 *
 * Der Text steht vollständig da, nicht als Verweis: unterschrieben wird,
 * was man gelesen hat. Verlangt die Fassung keine Unterschrift, genügt ein
 * Klick — eine Unterschrift ohne Anlass wäre eine Erhebung ohne Rechtsgrund,
 * dieselbe Überlegung wie beim Meldeschein des inländischen Gastes.
 *
 * **Unterschreiben tut der Gast, am Gästeterminal** (Sven, 05.10.2026). Ein
 * Zeichenfeld am Rezeptionsbildschirm lud dazu ein, für den Gast zu
 * unterschreiben. Der Auftrag ans Terminal steht im Kasten darüber; hier
 * steht, ob die Unterschrift vorliegt.
 */
function Bedingung({ bedingung, reservationRef }: {
  bedingung: Hausbedingung; reservationRef: string
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const zustimmen = useAgreeTerms(reservationRef)

  return (
    <div className="border border-neutral-200 rounded-sm p-2 space-y-2">
      <div className="text-sm font-medium">{bedingung.title}</div>
      <p className="text-xs text-neutral-600 whitespace-pre-line">{bedingung.body}</p>

      {bedingung.agreed ? (
        <p className="text-sm text-emerald-800">
          ✓ {bedingung.signed
            ? t('terms.signedByGuest', { datum: bedingung.agreedAt === null ? ''
                : formatDate(bedingung.agreedAt.slice(0, 10), locale) })
            : t('terms.accepted')}
        </p>
      ) : bedingung.requiresSignature ? (
        <p className="text-xs text-amber-900">{t('terms.signAtTerminal')}</p>
      ) : (
        <>
          {zustimmen.isError && <Fehler error={zustimmen.error} />}
          <button type="button" disabled={zustimmen.isPending}
                  onClick={() => zustimmen.mutate({ termsRef: bedingung.termsRef })}
                  className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                             disabled:opacity-40">
            {t('terms.accept')}
          </button>
        </>
      )}
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
