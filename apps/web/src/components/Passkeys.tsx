import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PASSKEY_NAME_MAX, type PasskeyInfo } from '@hotelpms/contracts'
import { nativ } from '@hotelpms/native'
import { api } from '../lib/api.js'
import { useT, useLocale, intlTag } from '../lib/i18n/index.js'
import { passkeyMoeglich, passkeyAnlegen, abgebrochen } from '../lib/passkey.js'
import { Abschnitt, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Die eigenen Passkeys im Arbeitsplatz-Dialog: ansehen, anlegen, entfernen.
 *
 * Hier und nicht in einer eigenen Maske, aus dem Grund, der am
 * Arbeitsplatz-Dialog steht: alles, was jemand „an sich" aendert, liegt
 * hinter einem Knopf, den auch Plattformpersonal erreicht.
 *
 * In der App fehlt der Abschnitt ganz. Ein Passkey laesst sich dort weder
 * anlegen noch benutzen (lib/passkey.ts), und eine Liste, an der man nichts
 * tun kann, lenkt nur ab.
 */
export function Passkeys(): JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [abbruch, setAbbruch] = useState(false)

  const liste = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => api.get<{ passkeys: PasskeyInfo[] }>('/v1/auth/passkeys'),
    enabled: nativ() === undefined
  })

  const anlegen = useMutation({
    mutationFn: () => passkeyAnlegen(kennwort, name.trim()),
    onMutate: () => { setAbbruch(false) },
    onSuccess: async () => {
      setName('')
      setKennwort('')
      await qc.invalidateQueries({ queryKey: ['passkeys'] })
    },
    onError: err => { if (abgebrochen(err)) setAbbruch(true) }
  })

  const entfernen = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/auth/passkeys/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['passkeys'] }) }
  })

  if (nativ() !== undefined) return null

  const datum = (iso: string): string =>
    new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium' }).format(new Date(iso))

  return (
    <Abschnitt titel={t('passkey.title')} hinweis={t('passkey.hint')}>
      {liste.isError && <Fehler error={liste.error} />}
      {liste.data !== undefined && (
        liste.data.passkeys.length === 0
          ? <p className="text-sm text-neutral-500">{t('passkey.none')}</p>
          : (
            <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-sm">
              {liste.data.passkeys.map(k => (
                <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {k.name}
                      {k.backedUp && (
                        <span className="ml-2 text-xs text-neutral-500">{t('passkey.synced')}</span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {k.lastUsedAt === null
                        ? t('passkey.neverUsed')
                        : t('passkey.lastUsed', { date: datum(k.lastUsedAt) })}
                    </div>
                  </div>
                  <button type="button" disabled={entfernen.isPending}
                          onClick={() => entfernen.mutate(k.id)}
                          className={`${KNOPF_LEISE} disabled:text-neutral-400`}>
                    {t('passkey.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )
      )}
      {entfernen.isError && <Fehler error={entfernen.error} />}

      {passkeyMoeglich() ? <>
        <Feld label={t('passkey.name')}>
          <input type="text" value={name} maxLength={PASSKEY_NAME_MAX}
                 onChange={e => setName(e.target.value)} autoComplete="off"
                 className={FELD} />
        </Feld>
        <Feld label={t('konto.currentPassword')}>
          <input type="password" value={kennwort}
                 onChange={e => setKennwort(e.target.value)}
                 autoComplete="current-password" className={FELD} />
        </Feld>
        {anlegen.isError && !abgebrochen(anlegen.error) && <Fehler error={anlegen.error} />}
        {abbruch && <p className="text-sm text-neutral-600">{t('passkey.cancelled')}</p>}
        {anlegen.isSuccess && (
          <p className="text-sm text-emerald-800">✓ {t('passkey.added')}</p>
        )}
        <button type="button" disabled={anlegen.isPending || kennwort === ''}
                onClick={() => anlegen.mutate()} className={KNOPF}>
          {t('passkey.add')}
        </button>
      </> : (
        <p className="text-xs text-neutral-500">{t('passkey.unsupported')}</p>
      )}
    </Abschnitt>
  )
}
