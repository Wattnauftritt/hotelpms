import { useState } from 'react'
import type { Guest } from '@hotelpms/contracts'
import { useReservation, useRegistrationForm, useSubmitRegistration, useCheckIn,
         useSetReservationGuest, useTerms, useAgreeTerms,
         type Hausbedingung } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { GuestPicker } from '../components/GuestPicker.tsx'
import { Dialog, KNOPF, KNOPF_LEISE } from '../components/Dialog.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Unterschriftsfeld } from '../components/Unterschriftsfeld.tsx'
import { AmTerminal } from '../components/AmTerminal.tsx'
import { useSignRegistration } from '../lib/queries/terminal.js'

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
 */
export function CheckIn({ reservationRef, propertyId, onClose }: {
  reservationRef: string; propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const reservierung = useReservation(reservationRef)
  const form = useRegistrationForm(reservationRef)
  const [signatur, setSignatur] = useState<string | null>(null)
  const [gastWechseln, setGastWechseln] = useState(false)
  const [mitreisende, setMitreisende] = useState<Guest[]>([])
  const [neuerMitreisender, setNeuerMitreisender] = useState<Guest | null>(null)
  const anmelden = useSubmitRegistration(propertyId)
  const einchecken = useCheckIn(reservationRef)
  const gastSetzen = useSetReservationGuest(reservationRef)
  const bedingungen = useTerms(reservationRef)

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
   * Ein auslaendischer Gast, dessen Schein schon steht, dessen Unterschrift
   * aber noch fehlt -- weil sie am Gaesteterminal folgt (Dokument 31).
   * Eingecheckt wird erst danach: das Meldegesetz verlangt sie am Tag der
   * Ankunft, und ein Weg, der sie ueberspringt, wird an einem vollen Abend
   * genau einmal zu oft genommen. Die vorsichtigere Lesart; die
   * Schnittstelle selbst prueft beim Check-in den Meldeschein nicht und tat
   * es nie.
   */
  const unterschriftFehlt = f !== undefined && f.alreadyRegistered
    && f.signatureRequired && f.signedAt === null

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
                <button type="button"
                        disabled={ohneZimmer || einchecken.isPending
                          || f === undefined || unterschriftFehlt
                          || (!f.alreadyRegistered && !anmelden.isSuccess)}
                        onClick={() => void einchecken_und_schliessen()}
                        className={KNOPF}>
                  {t('checkin.submit')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                {einchecken.isError && <Fehler error={einchecken.error} />}
              </>
            }>
      <div className="space-y-3">
        {ohneZimmer && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200
                        rounded p-2">
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
              <div className="grid grid-cols-2 gap-2 text-sm bg-neutral-50 rounded p-2">
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
                  {unterschriftFehlt && f.registrationId !== null && (
                    <NachtraeglichUnterschreiben reservationRef={reservationRef}
                                                 registrationId={f.registrationId} />
                  )}
                  {/* Auch nach der Unterschrift: dort steht dann "erledigt am
                      Terminal", und die Rezeption sieht, woher sie kam. */}
                  {f.signatureRequired && <AmTerminal reservationRef={reservationRef} />}
                  {/* Die Bedingungen bleiben sichtbar: der Meldeschein kann
                      vorliegen und die Unterschrift darunter noch fehlen. */}
                  {(bedingungen.data?.terms ?? []).map(b => (
                    <Bedingung key={b.termsRef} bedingung={b}
                               reservationRef={reservationRef} />
                  ))}
                </>
              ) : (
                <>
                  <p className="text-xs text-neutral-600">
                    {f.signatureRequired
                      ? t('checkin.signatureRequired')
                      : t('checkin.noSignatureNeeded')}
                  </p>
                  <div className="space-y-1">
                    <div className="text-xs text-neutral-600">{t('checkin.occupants')}</div>
                    <p className="text-xs text-neutral-500">{t('checkin.occupantsHint')}</p>
                    {mitreisende.map(m => (
                      <div key={m.guestRef}
                           className="flex items-center gap-2 text-sm border
                                      border-neutral-200 rounded px-2 py-1">
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
                  {f.signatureRequired && (
                    <Unterschriftsfeld onChange={setSignatur} />
                  )}
                  {(bedingungen.data?.terms ?? []).map(b => (
                    <Bedingung key={b.termsRef} bedingung={b}
                               reservationRef={reservationRef} />
                  ))}
                  {anmelden.isError && <Fehler error={anmelden.error} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button"
                            disabled={anmelden.isPending
                              || (f.signatureRequired && signatur === null)}
                            onClick={() => anmelden.mutate({
                              reservationRef,
                              signatureSvg: signatur ?? undefined,
                              occupantGuestRefs: mitreisende.length === 0
                                ? undefined : mitreisende.map(m => m.guestRef) })}
                            className="px-3 py-1.5 text-sm rounded border border-neutral-300
                                       disabled:opacity-40">
                      {t('checkin.register')}
                    </button>
                    {/* Der Gast unterschreibt am Touchscreen, nicht auf dem
                        Rezeptionsbildschirm: der Schein entsteht hier ohne
                        Unterschrift, und der Auftrag ans Terminal folgt
                        gleich darunter. */}
                    {f.signatureRequired && signatur === null && (
                      <button type="button" disabled={anmelden.isPending}
                              title={t('terminal.checkin.signLaterHint')}
                              onClick={() => anmelden.mutate({
                                reservationRef, signatureLater: true,
                                occupantGuestRefs: mitreisende.length === 0
                                  ? undefined : mitreisende.map(m => m.guestRef) })}
                              className="px-3 py-1.5 text-sm rounded border border-neutral-300
                                         disabled:opacity-40">
                        {t('terminal.checkin.signLater')}
                      </button>
                    )}
                  </div>
                </>
              )}

            </div>
          )
        })()}
      </div>
    </Dialog>
  )
}

/**
 * Die Unterschrift, die beim Anlegen nicht geleistet wurde: hier, falls der
 * Gast doch am Tresen steht oder das Terminal aus ist. Der Weg ueber das
 * Terminal steht direkt darunter (`AmTerminal`); beide gehen ueber
 * dieselbe Regel (`signRegistration` in der Schnittstelle).
 */
function NachtraeglichUnterschreiben({ reservationRef, registrationId }: {
  reservationRef: string; registrationId: number
}): JSX.Element {
  const t = useT()
  const [hier, setHier] = useState(false)
  const [signatur, setSignatur] = useState<string | null>(null)
  const unterschreiben = useSignRegistration(reservationRef)

  return (
    <div className="space-y-2 border border-amber-200 bg-amber-50 rounded p-2">
      <p className="text-sm text-amber-900">{t('terminal.checkin.signaturePending')}</p>
      {hier ? (
        <div className="space-y-2 bg-white rounded p-2">
          <Unterschriftsfeld onChange={setSignatur} />
          {unterschreiben.isError && <Fehler error={unterschreiben.error} />}
          <button type="button" disabled={signatur === null || unterschreiben.isPending}
                  onClick={() => {
                    if (signatur !== null) {
                      unterschreiben.mutate({ registrationId, signatureSvg: signatur })
                    }
                  }}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300
                             disabled:opacity-40">
            {t('terminal.checkin.signSubmit')}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setHier(true)}
                className="text-xs text-neutral-600 underline">
          {t('terminal.checkin.signHere')}
        </button>
      )}
    </div>
  )
}

/**
 * Eine Hausbedingung am Tresen.
 *
 * Der Text steht vollständig da, nicht als Verweis: unterschrieben wird,
 * was man gelesen hat. Verlangt die Fassung keine Unterschrift, genügt ein
 * Klick — eine Unterschrift ohne Anlass wäre eine Erhebung ohne Rechtsgrund,
 * dieselbe Überlegung wie beim Meldeschein des inländischen Gastes.
 */
function Bedingung({ bedingung, reservationRef }: {
  bedingung: Hausbedingung; reservationRef: string
}): JSX.Element {
  const t = useT()
  const [signatur, setSignatur] = useState<string | null>(null)
  const zustimmen = useAgreeTerms(reservationRef)

  return (
    <div className="border border-neutral-200 rounded p-2 space-y-2">
      <div className="text-sm font-medium">{bedingung.title}</div>
      <p className="text-xs text-neutral-600 whitespace-pre-line">{bedingung.body}</p>

      {bedingung.agreed ? (
        <p className="text-sm text-emerald-800">
          ✓ {bedingung.signed ? t('terms.signed') : t('terms.accepted')}
        </p>
      ) : (
        <>
          {bedingung.requiresSignature && <Unterschriftsfeld onChange={setSignatur} />}
          {zustimmen.isError && <Fehler error={zustimmen.error} />}
          <button type="button"
                  disabled={zustimmen.isPending
                    || (bedingung.requiresSignature && signatur === null)}
                  onClick={() => zustimmen.mutate({
                    termsRef: bedingung.termsRef,
                    signatureSvg: signatur ?? undefined })}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300
                             disabled:opacity-40">
            {bedingung.requiresSignature ? t('terms.sign') : t('terms.accept')}
          </button>
        </>
      )}
    </div>
  )
}
