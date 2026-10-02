import { neuesToken } from './authToken.js'

/**
 * Online-Check-in-Link ausgeben (Dokument 30).
 *
 * **Warum in der Domaene und nicht in der API.** Zwei Seiten geben Links
 * aus: die Schnittstelle (Rezeption: "Link kopieren", "erneut senden"; die
 * Station im Haus fuer den Terminalmodus) und der Worker (Versand vor
 * Anreise). Apps duerfen einander nicht importieren; was beide brauchen,
 * steht hier. Die eigentliche Regel -- spaetestens Abreisetag, genau ein
 * automatischer Versand, nur im eigenen Haus -- steht in der SQL-Funktion
 * `checkin_token_issue` (Migration 0061), damit sie auch der befolgt, der
 * an dieser Funktion vorbeigeht.
 *
 * **Das Token verlaesst diese Funktion genau einmal**, als Rueckgabewert. In
 * der Datenbank steht nur sein Hash, und die Datenbank sieht den Klartext
 * nicht einmal als Parameter. Wer es danach braucht, muss es in dem Moment
 * weitergeben, in dem er es bekommt: in die Mail, in die Antwort an die
 * Rezeption oder an die Station.
 */

export type CheckinChannel = 'mail' | 'terminal'

/**
 * Was ein Datenbankclient hier koennen muss. Strukturell und nicht als
 * Import von `pg`: die Domaene haengt an keinem Treiber, und ein
 * `PoolClient` aus `@hotelpms/db` passt hinein.
 */
export interface CheckinSqlClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

export interface CreateCheckinTokenOptions {
  /** Die interne id der Reservierung, nicht die oeffentliche Referenz. */
  reservationId: number
  channel: CheckinChannel
  /**
   * Bis wann der Link gilt, als Kalendertag. Ohne Angabe der Abreisetag;
   * mehr als der Abreisetag wird nie vergeben, auch wenn hier mehr steht.
   * Die Station im Haus gibt hier sinnvollerweise den Geschaeftstag an.
   */
  expiresOn?: string | null
  /** Wer ausgibt. Leer heisst: der automatische Versand vor Anreise. */
  createdBy?: number | null
}

export interface CheckinTokenIssued {
  /** Der Klartext. Nur hier, nur jetzt. */
  token: string
  tokenId: number
  /** Kalendertag, bis zu dem der Link gilt. */
  expiresOn: string
}

/**
 * Gibt einen Link aus, in der laufenden Transaktion des Aufrufers.
 *
 * Der Aufrufer muss die Reservierung im Mandantenkontext haben -- sonst
 * bricht die SQL-Funktion mit `insufficient_privilege` ab. Gibt `null`
 * zurueck, wenn der automatische Versand fuer diese Reservierung schon
 * stattgefunden hat (nur bei `createdBy` leer und `channel = 'mail'`).
 */
export async function createCheckinToken(
  client: CheckinSqlClient, opts: CreateCheckinTokenOptions
): Promise<CheckinTokenIssued | null> {
  const { token, hash } = neuesToken()
  const r = await client.query(
    `SELECT issued_id, issued_until::text AS issued_until
       FROM checkin_token_issue($1, $2, $3, $4::date, $5)`,
    [opts.reservationId, opts.channel, hash, opts.expiresOn ?? null,
     opts.createdBy ?? null])
  const zeile = r.rows[0] as { issued_id: number | string; issued_until: string } | undefined
  if (zeile === undefined) return null
  return { token, tokenId: Number(zeile.issued_id), expiresOn: zeile.issued_until }
}
