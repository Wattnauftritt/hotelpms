import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { useT, useLocale, intlTag } from '../lib/i18n/index.js'
import { Abschnitt, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

interface Sitzung {
  ref: string
  client: 'web' | 'app'
  createdAt: string
  lastSeenAt: string
  ip: string | null
  userAgent: string | null
  viaPasskey: boolean
  current: boolean
}

/**
 * Grob, mit Absicht: „Chrome auf Windows" erkennt man wieder, eine
 * vollstaendige Kennung des Browsers nicht. Produktnamen werden nicht
 * uebersetzt.
 */
function geraet(s: Sitzung): string | null {
  if (s.client === 'app') return 'StayGrid-App'
  const ua = s.userAgent ?? ''
  const system = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  if (system === null && browser === null) return null
  return [browser, system].filter(x => x !== null).join(' · ')
}

/**
 * Wo das eigene Konto angemeldet ist (Bedrohungsanalyse 23.10.2026, A5).
 * Eine gestohlene Sitzung faellt hier auf -- an einer Adresse oder einem
 * Geraet, das niemand kennt -- und laesst sich beenden, ohne dass der
 * Kennwortwechsel alle anderen Geraete mit hinauswirft.
 */
export function EigeneSitzungen(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const liste = useQuery({
    queryKey: ['eigeneSitzungen'],
    queryFn: () => api.get<{ sessions: Sitzung[] }>('/v1/auth/sessions')
  })
  const neu = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['eigeneSitzungen'] })
  }
  const beenden = useMutation({
    mutationFn: (ref: string) => api.post(`/v1/auth/sessions/${ref}/revoke`),
    onSuccess: neu
  })
  const andere = useMutation({
    mutationFn: () => api.post('/v1/auth/sessions/revoke-others'),
    onSuccess: neu
  })
  const zeit = (iso: string): string => new Intl.DateTimeFormat(intlTag(locale),
    { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  const sitzungen = liste.data?.sessions ?? []

  return (
    <Abschnitt titel={t('sitzung.title')} hinweis={t('sitzung.hint')}>
      {liste.isError && <Fehler error={liste.error} />}
      {sitzungen.length > 0 && (
        <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-sm">
          {sitzungen.map(s => (
            <li key={s.ref} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {geraet(s) ?? t('sitzung.unknownDevice')}
                  {s.current && (
                    <span className="ml-2 text-xs text-emerald-800">{t('sitzung.current')}</span>
                  )}
                  {s.viaPasskey && (
                    <span className="ml-2 text-xs text-neutral-500">{t('sitzung.passkey')}</span>
                  )}
                </div>
                <div className="text-xs text-neutral-500">
                  {s.ip ?? '–'} · {t('sitzung.lastSeen', { date: zeit(s.lastSeenAt) })}
                </div>
              </div>
              {!s.current && (
                <button type="button" disabled={beenden.isPending}
                        onClick={() => beenden.mutate(s.ref)}
                        className={`${KNOPF_LEISE} disabled:text-neutral-400`}>
                  {t('sitzung.end')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {beenden.isError && <Fehler error={beenden.error} />}
      {andere.isError && <Fehler error={andere.error} />}
      {sitzungen.some(s => !s.current) && (
        <button type="button" disabled={andere.isPending}
                onClick={() => andere.mutate()} className={KNOPF}>
          {t('sitzung.endOthers')}
        </button>
      )}
    </Abschnitt>
  )
}
