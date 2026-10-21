import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { nativ } from '@hotelpms/native'
import { api } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'

/**
 * Benachrichtigungen auf diesem Telefon (Baustein 8, Migration 0113):
 * Plan geaendert, Zimmer frei, nacharbeiten.
 *
 * Die Berechtigung fragt nur ein Tippen ab -- ein Browser, der beim Oeffnen
 * fragt, wird abgelehnt und fragt nie wieder. Ist sie einmal erteilt, meldet
 * die App das Telefon bei jedem Start still neu an: das Abo gehoert zur
 * Sitzung, und nach dem naechsten Anmelden gaebe es sonst keines mehr.
 *
 * Auf dem iPhone gibt es Push nur fuer die installierte App; im Browser
 * steht deshalb der Weg dorthin statt eines Knopfs, der nichts tut.
 *
 * In der eigenen App gibt es kein Web-Push (0193): dort meldet die Huelle
 * eine Kennung von Firebase, und dieselbe Karte schaltet sie an und aus.
 * Ob sie an ist, weiss der Server, nicht das Telefon: die Erlaubnis des
 * Systems bleibt beim Ausschalten erteilt, und eine Marke auf dem Telefon
 * gehoerte nach dem Abmelden der naechsten Person. Die Sitzung der App
 * ueberdauert den Neustart; der Start erneuert nur die Kennung.
 */

type Stand = 'laedt' | 'nichtMoeglich' | 'iosInstallieren' | 'aus' | 'an' | 'abgelehnt'

function schluessel(base64url: string): ArrayBuffer {
  const b64 = (base64url + '='.repeat((4 - base64url.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/')
  const roh = atob(b64)
  const puffer = new ArrayBuffer(roh.length)
  const sicht = new Uint8Array(puffer)
  for (let i = 0; i < roh.length; i++) sicht[i] = roh.charCodeAt(i)
  return puffer
}

async function registrierung(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  return (await navigator.serviceWorker.getRegistration('/')) ?? null
}

async function anmelden(propertyId: number, abo: PushSubscription): Promise<void> {
  const j = abo.toJSON()
  await api.post(`/v1/properties/${propertyId}/push`,
    { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } })
}

/**
 * Beim Start der App: ist das Telefon schon angemeldet, wird es still an
 * die neue Sitzung gebunden. Scheitert das, bleibt es beim naechsten Start.
 */
export async function pushNeuBinden(propertyId: number): Promise<void> {
  const np = nativ()?.push
  if (np !== undefined) {
    try {
      if (!await np.moeglich() || await np.erlaubnis() !== 'erteilt') return
      if (!(await api.get<{ an: boolean }>(`/v1/properties/${propertyId}/push/app`)).an) return
      const token = await np.anmelden()
      if (token !== null) await api.post(`/v1/properties/${propertyId}/push/app/refresh`, { token })
    } catch { /* naechster Start */ }
    return
  }
  try {
    const reg = await registrierung()
    if (reg === null || Notification.permission !== 'granted') return
    const abo = await reg.pushManager.getSubscription()
    if (abo !== null) await anmelden(propertyId, abo)
  } catch { /* naechster Start */ }
}

export function Benachrichtigung({ propertyId, locale }: {
  propertyId: number; locale: StaffLocale
}): JSX.Element | null {
  const t = usePT()
  const np = nativ()?.push
  const q = useQuery<{ publicKey: string | null }>({
    queryKey: ['push-key', propertyId],
    queryFn: () => api.get(`/v1/properties/${propertyId}/push`),
    staleTime: Infinity,
    // In der App kommt die Meldung ueber Firebase; der Schluessel fuer
    // Web-Push wird dort nicht gebraucht.
    enabled: np === undefined
  })
  const [stand, setStand] = useState<Stand>('laedt')
  const [fehler, setFehler] = useState<string | null>(null)
  const [laeuft, setLaeuft] = useState(false)

  useEffect(() => {
    let weg = false
    void (async () => {
      if (np !== undefined) {
        const erlaubnis = await np.moeglich().then(ja => ja ? np.erlaubnis() : null).catch(() => null)
        const an = erlaubnis === 'erteilt'
          && await api.get<{ an: boolean }>(`/v1/properties/${propertyId}/push/app`)
            .then(r => r.an).catch(() => false)
        if (weg) return
        setStand(erlaubnis === null ? 'nichtMoeglich' : erlaubnis === 'abgelehnt' ? 'abgelehnt'
          : an ? 'an' : 'aus')
        return
      }
      const reg = await registrierung()
      if (reg === null) {
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
        const installiert = window.matchMedia('(display-mode: standalone)').matches
        if (!weg) setStand(ios && !installiert ? 'iosInstallieren' : 'nichtMoeglich')
        return
      }
      if (Notification.permission === 'denied') { if (!weg) setStand('abgelehnt'); return }
      const abo = await reg.pushManager.getSubscription()
      if (!weg) setStand(abo !== null ? 'an' : 'aus')
    })()
    return () => { weg = true }
  }, [propertyId, np])

  if (stand === 'laedt') return null
  // In der App ohne Firebase (iOS bis zum Konto bei Apple) gar keine Karte:
  // „Dieser Browser kann keine Benachrichtigungen empfangen" stimmte dort nicht.
  if (np !== undefined ? stand === 'nichtMoeglich' : q.data?.publicKey == null) return null

  const einschalten = async (): Promise<void> => {
    setLaeuft(true); setFehler(null)
    try {
      if (np !== undefined) {
        const token = await np.anmelden()
        if (token === null) {
          setStand(await np.erlaubnis() === 'abgelehnt' ? 'abgelehnt' : 'aus')
          return
        }
        await api.post(`/v1/properties/${propertyId}/push/app`, { token })
        setStand('an')
        return
      }
      const erlaubt = await Notification.requestPermission()
      if (erlaubt !== 'granted') { setStand(erlaubt === 'denied' ? 'abgelehnt' : 'aus'); return }
      const reg = await registrierung()
      if (reg === null) { setStand('nichtMoeglich'); return }
      const abo = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: schluessel(q.data!.publicKey!) })
      await anmelden(propertyId, abo)
      setStand('an')
    } catch (e) {
      setFehler(fehlerText(e, locale))
    } finally {
      setLaeuft(false)
    }
  }
  const ausschalten = async (): Promise<void> => {
    setLaeuft(true); setFehler(null)
    try {
      if (np !== undefined) {
        // Die Erlaubnis ist erteilt; anmelden() fragt also nicht, es gibt
        // nur die Kennung, die der Server abmelden soll.
        const token = await np.anmelden()
        if (token !== null) await api.post(`/v1/properties/${propertyId}/push/app/off`, { token })
        await np.abmelden()
        setStand('aus')
        return
      }
      const abo = await (await registrierung())?.pushManager.getSubscription()
      if (abo != null) {
        await api.post(`/v1/properties/${propertyId}/push/off`, { endpoint: abo.endpoint })
        await abo.unsubscribe()
      }
      setStand('aus')
    } catch (e) {
      setFehler(fehlerText(e, locale))
    } finally {
      setLaeuft(false)
    }
  }

  return <Karte titel={t('push.title')}>
    {stand === 'an' && <>
      <p className="text-base text-neutral-700">{t('push.on')}</p>
      <button type="button" className={KNOPF_LEISE} disabled={laeuft}
              onClick={() => { void ausschalten() }}>{t('push.disable')}</button>
    </>}
    {stand === 'aus' && <>
      <p className="text-sm text-neutral-600">{t('push.hint')}</p>
      <button type="button" className={KNOPF} disabled={laeuft}
              onClick={() => { void einschalten() }}>{t('push.enable')}</button>
    </>}
    {stand === 'abgelehnt' && <p className="text-sm text-neutral-600">{t('push.denied')}</p>}
    {stand === 'iosInstallieren' && <p className="text-sm text-neutral-600">{t('push.ios')}</p>}
    {stand === 'nichtMoeglich' && <p className="text-sm text-neutral-600">{t('push.unsupported')}</p>}
    {fehler !== null && <Fehler text={fehler} />}
  </Karte>
}
