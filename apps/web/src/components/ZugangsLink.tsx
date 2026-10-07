import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import qrcode from 'qrcode-generator'
import { useT, useLocale } from '../lib/i18n/index.js'

/**
 * Ein Zugangslink zum Weitergeben, als QR-Code und als Text (Migration 0105).
 *
 * Fuer Personal ohne Mailadresse: die Leitung haelt der Reinigungskraft den
 * Bildschirm hin, die scannt mit dem Handy und setzt dort ihr Kennwort. Oder
 * der Link geht als Nachricht. Beides zeigt dieselbe Adresse; der QR-Code
 * ist nur die bequemere Form am Tresen.
 *
 * Der Code wird als SVG-Pfad gezeichnet, nicht als HTML-Zeichenkette: die
 * Content-Security-Policy erlaubt kein eingeschleustes Markup, und ein
 * Pfad aus Rechtecken braucht keins.
 */
export function ZugangsLink({ link, gueltigBis }: { link: string; gueltigBis: string }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [kopiert, setKopiert] = useState(false)

  const { pfad, groesse } = useMemo(() => {
    // Fehlerkorrektur M: ein Handybildschirm spiegelt, ein Ausdruck knickt.
    const qr = qrcode(0, 'M')
    qr.addData(link)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`
      }
    }
    // Vier Module Ruhezone ringsum, sonst lesen manche Kameras nicht.
    return { pfad: d, groesse: n + 8 }
  }, [link])

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
