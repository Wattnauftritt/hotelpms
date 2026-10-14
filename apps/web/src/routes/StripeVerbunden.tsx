import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api } from '../lib/api.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from '../components/Shell.tsx'

/**
 * Die Rueckkehr von Stripe nach dem Verbinden eines Kontos (Migration 0167).
 *
 * Stripe leitet hierher mit `code` und `state` in der Adresse. Die Seite
 * reicht beides an die API weiter und geht danach in die Schnittstellen,
 * Reiter Zahlungen, des verbundenen Hauses. Code und `state` bleiben nicht
 * in der Adresse stehen: `replace`, kein neuer Eintrag in der Geschichte.
 *
 * Eigene Seite statt einer Weiterleitung der API, weil das Sitzungscookie
 * `SameSite=Strict` ist: eine Navigation von stripe.com bringt es nicht mit,
 * ein Aufruf aus dieser Seite schon.
 */
export function istStripeRueckkehr(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === '/stripe-verbunden'
}

export function StripeVerbunden(): JSX.Element {
  const t = useT()
  const [fehler, setFehler] = useState<unknown>(null)
  // StrictMode ruft den Effekt zweimal; ein Code gilt bei Stripe nur einmal.
  const gesendet = useRef(false)

  useEffect(() => {
    if (gesendet.current) return
    gesendet.current = true
    const p = new URLSearchParams(location.search)
    const body = {
      state: p.get('state') ?? '',
      ...(p.get('code') !== null ? { code: p.get('code') } : {}),
      ...(p.get('error') !== null ? { error: p.get('error') } : {})
    }
    api.post<{ propertyId: number }>('/v1/payment-account/complete', body)
      .then(r => {
        location.replace(`/?property=${r.propertyId}&screen=integrations&int=payments`)
      })
      .catch((e: unknown) => {
        history.replaceState(null, '', '/stripe-verbunden')
        setFehler(e)
      })
  }, [])

  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="grid gap-3 justify-items-center text-center max-w-md text-sm">
        {fehler === null
          ? <div className="text-neutral-600">{t('pay.returning')}</div>
          : <>
              <Fehler error={fehler} />
              <a href="/?screen=integrations&int=payments"
                 className="px-3 py-1 border border-neutral-300 rounded-sm bg-white
                            hover:bg-neutral-50">{t('pay.back')}</a>
            </>}
      </div>
    </div>
  )
}
