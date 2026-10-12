import { useState } from 'react'
import type { JSX } from 'react'
import { useT, useLocale } from '../lib/i18n/index.js'
import { useQr } from '../lib/qr.js'

/**
 * Ein Zugangslink zum Weitergeben, als QR-Code und als Text (Migration 0105).
 *
 * Fuer Personal ohne Mailadresse: die Leitung haelt der Reinigungskraft den
 * Bildschirm hin, die scannt mit dem Handy und setzt dort ihr Kennwort. Oder
 * der Link geht als Nachricht. Beides zeigt dieselbe Adresse; der QR-Code
 * ist nur die bequemere Form am Tresen.
 *
 * Der Code kommt aus `lib/qr.ts`, als SVG-Pfad.
 */
export function ZugangsLink({ link, gueltigBis }: { link: string; gueltigBis: string }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [kopiert, setKopiert] = useState(false)

  const { pfad, groesse } = useQr(link)

  const kopieren = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link)
      setKopiert(true)
    } catch {
      // Ohne Zwischenablage (kein HTTPS, kein Recht) bleibt das Textfeld,
      // aus dem sich der Link von Hand markieren laesst.
    }
  }

  return (
    <div className="rounded-sm border border-neutral-200 bg-white p-3 space-y-2">
      <div className="font-medium text-sm">{t('user.linkTitle')}</div>
      <p className="text-xs text-neutral-500">{t('user.linkHint')}</p>
      <svg viewBox={`0 0 ${groesse} ${groesse}`} role="img"
           aria-label={t('user.linkQr')}
           className="w-56 h-56 bg-white" shapeRendering="crispEdges">
        <path d={pfad} fill="#000" />
      </svg>
      <div className="flex flex-wrap items-center gap-2">
        <input readOnly value={link} onFocus={e => e.target.select()}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-xs
                          font-mono grow min-w-0" />
        <button type="button" onClick={() => { void kopieren() }}
                className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300
                           hover:bg-neutral-50">
          {t(kopiert ? 'user.linkCopied' : 'user.linkCopy')}
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        {t('user.linkValidUntil', { bis: new Date(gueltigBis).toLocaleString(locale,
          { dateStyle: 'short', timeStyle: 'short' }) })}
      </p>
    </div>
  )
}
