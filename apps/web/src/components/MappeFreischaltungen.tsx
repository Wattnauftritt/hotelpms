import type { JSX } from 'react'
import type { GuestFolderStayStatus } from '@hotelpms/contracts'
import { useMappeFreischaltungenAufheben } from '../lib/queries/gaestemappe.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler } from './Shell.tsx'

/**
 * Freischaltungen der Gaestemappe im Seitenfenster einer Reservierung (0147).
 *
 * Fuer den Fall, dass ein Gast sein Telefon verloren hat oder das Zimmer
 * gewechselt hat und ein fremdes Telefon noch freigeschaltet ist. Der Stand
 * kommt mit der Reservierung, kein eigener Aufruf.
 */
export function MappeFreischaltungen({ reservationRef, stand }: {
  reservationRef: string; stand: GuestFolderStayStatus
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const aufheben = useMappeFreischaltungenAufheben(reservationRef)
  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
      <h3 className="text-sm font-medium">{t('folder.title')}</h3>
      <p className="text-sm text-neutral-700">
        {t('folder.sessions', { n: String(stand.activeSessions) })}
      </p>
      {aufheben.isError && <Fehler error={aufheben.error} />}
      <button type="button" disabled={!online || aufheben.isPending}
              onClick={() => aufheben.mutate()}
              className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                         hover:bg-neutral-50 disabled:opacity-40">
        {t('folder.sessionsRevoke')}
      </button>
    </section>
  )
}
