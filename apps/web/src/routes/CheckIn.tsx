import { useRef, useState } from 'react'
import type { Guest } from '@hotelpms/contracts'
import { useReservation, useRegistrationForm, useSubmitRegistration, useCheckIn,
         useSetReservationGuest } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { GuestPicker } from '../components/GuestPicker.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'

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

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          <button onClick={onClose}
                  className="text-sm px-2 py-1 border border-neutral-300 rounded">
            ← {t('common.back')}
          </button>
          <h2 className="text-sm font-medium">{t('checkin.title')} {reservationRef}</h2>
        </div>

        {ohneZimmer && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200
                        rounded p-2">
            {t('checkin.needsRoom')}
          </p>
        )}

        {form.isError && <Fehler error={form.error} />}
        {form.data === undefined && !form.isError && <Laedt />}
        {form.data !== undefined && (() => {
          const f = form.data
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
                <p className="text-sm text-emerald-800">✓ {t('checkin.alreadyRegistered')}</p>
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
                  {anmelden.isError && <Fehler error={anmelden.error} />}
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
                </>
              )}

              {einchecken.isError && <Fehler error={einchecken.error} />}
              <button type="button"
                      disabled={ohneZimmer || einchecken.isPending
                        || (!f.alreadyRegistered && !anmelden.isSuccess)}
                      onClick={() => void einchecken_und_schliessen()}
                      className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                                 disabled:bg-neutral-300">
                {t('checkin.submit')}
              </button>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

/** Minimales Unterschriftsfeld: Zeichnen per Maus oder Finger, als Bild exportiert. */
function Unterschriftsfeld({ onChange }: { onChange: (svg: string | null) => void }): JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [zeichnet, setZeichnet] = useState(false)

  const punkt = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const exportieren = (): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const png = canvas.toDataURL('image/png')
    onChange(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" `
      + `height="${canvas.height}"><image href="${png}" width="${canvas.width}" `
      + `height="${canvas.height}"/></svg>`)
  }

  return (
    <div className="space-y-1">
      <canvas ref={canvasRef} width={360} height={120}
              className="w-full border border-neutral-300 rounded touch-none bg-white"
              onPointerDown={e => {
                setZeichnet(true)
                const ctx = e.currentTarget.getContext('2d')
                const { x, y } = punkt(e)
                ctx?.beginPath(); ctx?.moveTo(x, y)
              }}
              onPointerMove={e => {
                if (!zeichnet) return
                const ctx = e.currentTarget.getContext('2d')
                const { x, y } = punkt(e)
                if (!ctx) return
                ctx.lineTo(x, y); ctx.stroke()
              }}
              onPointerUp={() => { setZeichnet(false); exportieren() }} />
      <button type="button"
              onClick={() => {
                const canvas = canvasRef.current
                canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
                onChange(null)
              }}
              className="text-xs text-neutral-500 underline">
        {t('checkin.clear')}
      </button>
    </div>
  )
}
