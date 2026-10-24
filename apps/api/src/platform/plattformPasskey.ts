import type { FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { AppError } from './errors.js'
import type { Principal } from './context.js'
import { meldeSicherheitsereignis } from './bestaetigung.js'

/**
 * Passkeys an einem Plattformkonto (Migration 0211, Bedrohungsanalyse
 * 23.10.2026, A3).
 *
 * Plattformrechte wirken nur in einer Sitzung, die mit Passkey begann. Damit
 * wird der Passkey selbst zum Ziel: wer ein Plattformkennwort erbeutet,
 * meldet sich damit an und legt **seinen** Passkey dazu. Deshalb:
 *
 * - **Hat das Konto schon einen Passkey, aendert nur eine Passkey-Sitzung
 *   die Liste.** Anlegen und Entfernen. Entfernen zaehlt mit: wer alle
 *   entfernt, stuende sonst wieder beim ersten Passkey, und den darf das
 *   Kennwort anlegen.
 * - **Der erste Passkey geht mit Kennwort**, sonst kaeme niemand hinein. Er
 *   wird gemeldet, an das Sicherheitspostfach der Plattform, und genau dort
 *   faellt einer auf, den niemand von uns angelegt hat.
 *
 * Verliert jemand alle seine Passkeys, legt ein anderer Plattformbenutzer
 * nichts fuer ihn an: die Zeilen in `user_passkey` entfernt der Betrieb auf
 * der Maschine (Dokument 21), und danach gilt wieder der erste Passkey.
 */

export const PASSKEY_FEHLT = 'urn:staygrid:passkey_required'

export async function plattformPasskeyAendern(req: FastifyRequest, userId: number): Promise<void> {
  const p = req.principal as Principal
  if (!p.isPlatformStaff || p.viaPasskey === true) return
  const { rows } = await req.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM user_passkey WHERE user_id = $1', [userId])
  if ((rows[0]?.n ?? 0) === 0) return
  throw new AppError(403, PASSKEY_FEHLT, 'error.passkeyRequired',
    'error.passkeyRequired.detail')
}

/** Nach dem Anlegen oder Entfernen, in der Transaktion der Route. */
export async function plattformPasskeyMelden(
  client: PoolClient, req: FastifyRequest, aktion: 'added' | 'removed', name: string | null
): Promise<void> {
  const p = req.principal as Principal
  if (!p.isPlatformStaff) return
  await meldeSicherheitsereignis(client, req, {
    kind: 'platform_passkey_changed', accountId: null,
    detail: { action: aktion, viaPasskey: p.viaPasskey === true },
    hint: name ?? aktion })
}
