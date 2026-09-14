import { useRef, useState } from 'react'
import { useReservation, useRegistrationForm, useSubmitRegistration, useCheckIn }
  from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Check-in mit Meldeschein (A9), erreichbar aus dem Plan.
 *
 * Seit dem 1.1.2025 unterschreiben nur noch ausländische Gäste. Für einen
 * inländischen Gast erscheint deshalb **gar kein** Unterschriftsfeld -- es
 * gibt dafür seit dem Stichtag keinen Rechtsgrund mehr, und ein System, das
 * es trotzdem verlangt, hält die Rezeption ohne Grund auf.
 */
export function CheckIn({ reservationRef, propertyId, onClose }: {
  reservationRef: string; propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const reservierung = useReservation(reservationRef)
  const form = useRegistrationForm(reservationRef)
  const [signatur, setSignatur] = useState<string | null>(null)
  const anmelden = useSubmitRegistration(propertyId)
  const einchecken = useCheckIn(reservationRef)

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
          if (f.guest === null) {
            return <p className="text-sm text-neutral-500">{t('plan.noGuest')}</p>
          }
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm bg-neutral-50 rounded p-2">
                <div>
                  <div className="text-xs text-neutral-500">{t('plan.guest')}</div>
                  <div>{f.guest.lastName}{f.guest.firstName ? `, ${f.guest.firstName}` : ''}</div>
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
                  {f.signatureRequired && (
                    <Unterschriftsfeld onChange={setSignatur} />
                  )}
                  {anmelden.isError && <Fehler error={anmelden.error} />}
                  <button type="button"
                          disabled={anmelden.isPending
                            || (f.signatureRequired && signatur === null)}
                          onClick={() => anmelden.mutate({ reservationRef, signatureSvg:
                            signatur ?? undefined })}
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
