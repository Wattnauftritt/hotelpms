import { execFile } from 'node:child_process'

/**
 * Das Protokoll der Dienste lesen, ueber `journalctl`.
 *
 * Ohne Shell und mit festen Einheiten: der Aufrufer waehlt aus einer Liste,
 * er nennt keinen Befehl. Der Dienst laeuft dafuer in der Gruppe
 * `systemd-journal` (ops/systemd/hotelpms-mcp.service) -- mehr als lesen
 * kann diese Gruppe nicht.
 *
 * Die Protokolle der API tragen keine Gastdaten (CLAUDE.md, "Keine
 * Gastdaten in Protokollen"), wohl aber volle IP-Adressen. Die werden hier
 * gekuerzt, wie in den Sichten ohne Freigabe; eine Freigabe gilt einem
 * Haus, ein Protokoll gehoert keinem.
 */

export const EINHEITEN = ['hotelpms-api', 'hotelpms-worker', 'hotelpms-mcp', 'hotelpms-deploy',
                          'hotelpms-sicherung', 'hotelpms-einsortieren'] as const
export type Einheit = (typeof EINHEITEN)[number]

export interface JournalZeile {
  zeit: string
  einheit: string
  text: string
}

export interface JournalAbfrage {
  einheiten: readonly Einheit[]
  /** Minuten zurueck. */
  seitMinuten?: number
  /** Ab diesem Zeitpunkt (ISO); geht `seitMinuten` vor. */
  von?: string
  bis?: string
  zeilen: number
  /** Wird an journalctl als Muster gereicht (`--grep`), nicht an eine Shell. */
  muster?: string
}

export type JournalLeser = (a: JournalAbfrage) => Promise<JournalZeile[]>

export function ipKuerzen(text: string): string {
  return text
    .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\b/g, '$1.$2.$3.0')
    .replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f:]{2,}\b/gi, '$1::')
}

/** Der echte Leser; in Tests ersetzt. */
export const journalctl: JournalLeser = a => new Promise((resolve, reject) => {
  const args = ['--no-pager', '-o', 'json', '-n', String(a.zeilen),
                '--output-fields=MESSAGE,_SYSTEMD_UNIT,__REALTIME_TIMESTAMP']
  for (const e of a.einheiten) args.push('-u', e)
  if (a.von !== undefined) args.push('--since', a.von.replace('T', ' ').replace(/Z$/, ''))
  else args.push('--since', `-${a.seitMinuten ?? 60}min`)
  if (a.bis !== undefined) args.push('--until', a.bis.replace('T', ' ').replace(/Z$/, ''))
  if (a.muster !== undefined && a.muster !== '') args.push('--grep', a.muster)
  execFile('journalctl', args, { maxBuffer: 32 * 1024 * 1024, timeout: 15_000,
                                 env: { TZ: 'UTC', LANG: 'C.UTF-8' } },
    (err, stdout) => {
      // Ohne Treffer endet journalctl mit --grep auf 1; das ist kein Fehler.
      if (err !== null && stdout === '') {
        if ((err as { code?: unknown }).code === 1) { resolve([]); return }
        reject(err); return
      }
      const zeilen: JournalZeile[] = []
      for (const l of stdout.split('\n')) {
        if (l.trim() === '') continue
        try {
          const j = JSON.parse(l) as Record<string, unknown>
          const msg = Array.isArray(j.MESSAGE)
            ? Buffer.from(j.MESSAGE as number[]).toString('utf8') : String(j.MESSAGE ?? '')
          const us = Number(j.__REALTIME_TIMESTAMP ?? 0)
          zeilen.push({ zeit: new Date(us / 1000).toISOString(),
                        einheit: String(j._SYSTEMD_UNIT ?? '').replace(/\.service$/, ''),
                        text: ipKuerzen(msg) })
        } catch { /* keine JSON-Zeile: auslassen */ }
      }
      resolve(zeilen)
    })
})

/** Eine Protokollzeile der API als pino-JSON, sonst `null`. */
export function pinoZeile(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null
  try { return JSON.parse(text) as Record<string, unknown> } catch { return null }
}
