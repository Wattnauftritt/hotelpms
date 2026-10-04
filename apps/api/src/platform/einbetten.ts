/**
 * Eine freigegebene Adresse in die Form, die sich in einem Rahmen zeigen
 * laesst (Dokument 31).
 *
 * YouTube verbietet die Anzeige seiner Seiten in fremden Rahmen
 * (`X-Frame-Options: sameorigin`); am Terminal blieb ein Video-Link eine
 * weisse Flaeche. Einbetten erlaubt nur der Player unter `/embed/`. Jede
 * gaengige Form eines Video-Links wird deshalb zu ihm -- unter
 * `youtube-nocookie.com`, das vor dem Abspielen keine Cookies setzt: am
 * Touchscreen steht ein Gast, und das Haus hat ihn nicht nach seiner
 * Einwilligung gefragt.
 *
 * Alles andere bleibt, wie es ist. Ob eine fremde Seite das Einbetten
 * erlaubt, laesst sich nur bei ihr selbst ablesen; die Vorschau in den
 * Einstellungen zeigt es.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com',
                         'music.youtube.com', 'youtube-nocookie.com',
                         'www.youtube-nocookie.com'])

/** Die Kennung eines YouTube-Videos aus einem Link, sonst `null`. */
function videoVon(u: URL): string | null {
  if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] ?? null
  if (!YOUTUBE.has(u.hostname)) return null
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const m = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname)
  return m?.[1] ?? null
}

/** `t=90`, `t=90s` oder `t=1m30s` als Sekunden; sonst `null`. */
function startVon(u: URL): number | null {
  const t = u.searchParams.get('t') ?? u.searchParams.get('start')
  if (t === null) return null
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t)
  if (m === null || t === '') return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

export function einbettbar(adresse: string): string {
  let u: URL
  try { u = new URL(adresse) } catch { return adresse }
  const id = videoVon(u)
  if (id === null || !VIDEO_ID.test(id)) return adresse
  const ziel = new URL(`https://www.youtube-nocookie.com/embed/${id}`)
  const start = startVon(u)
  if (start !== null && start > 0) ziel.searchParams.set('start', String(start))
  return ziel.toString()
}
