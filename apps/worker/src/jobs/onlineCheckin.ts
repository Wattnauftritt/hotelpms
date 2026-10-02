import { withTransaction, type Pool, type DbContext } from '@hotelpms/db'
import { createCheckinToken, renderCheckinInvitationEmail, emailLanguage,
         isSendableAddress } from '@hotelpms/domain'
import { checkinLink } from '@hotelpms/contracts'

/**
 * Online-Check-in: der Link vor Anreise (Dokument 30).
 *
 * **Wer ihn bekommt.** Eine bestaetigte Reservierung (`Confirmed`), deren
 * Anreise hoechstens so viele Tage nach dem Geschaeftstag liegt, wie das
 * Haus eingestellt hat, und noch nicht heute; mit einem Hauptgast, der eine
 * Mailadresse hat und nicht geloescht ist; ohne Meldeschein; in einem Haus,
 * das kein Uebungshaus ist und dessen Gastversand an und durch eine
 * freigeschaltete Absenderdomain gedeckt ist.
 *
 * **Warum nur `Confirmed` und nicht `Optional`.** Eine Option ist noch keine
 * Buchung; sie verfaellt, wenn niemand bestaetigt. Einen Gast um Geburtsdatum
 * und Passnummer fuer einen Aufenthalt zu bitten, der vielleicht nie
 * zustande kommt, ist eine Erhebung auf Vorrat (Art. 5 Abs. 1 lit. c DSGVO).
 *
 * **Warum nicht am Anreisetag.** Dann steht der Gast im Zweifel schon am
 * Tresen oder vor der Station; eine Mail, die ihn dort einholt, hilft
 * niemandem. Wer erst am Vortag bucht, bekommt sie beim naechsten Lauf.
 *
 * **Genau einmal.** Gegen den Geschaeftstag, nicht gegen `now()`: ein
 * Wiederholungslauf findet dieselben Zeilen und keine anderen. Und eine
 * Reservierung, die schon einen Mail-Link hat -- automatisch oder von der
 * Rezeption --, faellt heraus. Haelt zwei gleichzeitige Laeufe das nicht ab,
 * tut es der eindeutige Index aus Migration 0061: `createCheckinToken` gibt
 * dann `null`, und es wird nichts eingereiht.
 *
 * **Die Bedingungen von `email_enqueue` stehen auch in der Abfrage.** Die
 * Funktion prueft Uebungshaus, Versand und Absenderdomain selbst und bricht
 * sonst ab -- richtig fuer eine Route, falsch fuer einen Stapel: der Abbruch
 * naehme alle anderen Gaeste dieses Hauses mit. Hier wird deshalb gar nicht
 * erst versucht, was scheitern wuerde. Der Zaun in der Funktion bleibt der,
 * der haelt.
 */

export interface OnlineCheckinOptions {
  /** Basis der Oberflaeche, etwa https://app.staygrid.cloud. */
  appUrl: string
  /** Hoechstens so viele je Lauf und Haus; der Rest kommt beim naechsten. */
  batchSize?: number
}

interface Kandidat {
  id: number; public_ref: string; arrival: string
  email: string; language: string; name: string | null; property_name: string
}

export async function inviteOnlineCheckins(
  pool: Pool, ctx: DbContext, propertyId: number, opts: OnlineCheckinOptions
): Promise<{ invited: number }> {
  return withTransaction(pool, ctx, async client => {
    const { rows } = await client.query<Kandidat>(
      `WITH heute AS (
         SELECT b.date FROM business_day b
          WHERE b.property_id = $1 AND b.status = 'open'
          ORDER BY b.date DESC LIMIT 1
       )
       SELECT r.id, r.public_ref, r.arrival::text, g.email, g.language,
              nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name,
              p.name AS property_name
         FROM heute
         JOIN property p                  ON p.id = $1 AND NOT p.is_training
         JOIN property_checkin_setting cs ON cs.property_id = p.id AND cs.enabled
         JOIN property_email_setting es   ON es.property_id = p.id AND es.enabled
         JOIN reservation r               ON r.property_id = p.id
         JOIN guest g                     ON g.id = r.primary_guest_id
        WHERE email_sender_allowed(p.id, es.from_email)
          AND r.status = 'Confirmed'
          AND r.arrival >  heute.date
          AND r.arrival <= heute.date + cs.days_before
          AND g.status = 'active' AND g.erasure_requested_at IS NULL
          AND g.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM registration reg WHERE reg.reservation_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM checkin_token t
                           WHERE t.reservation_id = r.id AND t.channel = 'mail')
        ORDER BY r.arrival, r.id
        LIMIT $2`, [propertyId, opts.batchSize ?? 200])

    let invited = 0
    for (const r of rows) {
      // Grob, wie ueberall: was offensichtlich keine Adresse ist, bekommt
      // keinen Link. Die Reservierung bleibt Kandidat, falls jemand die
      // Adresse korrigiert.
      if (!isSendableAddress(r.email)) continue
      const t = await createCheckinToken(client, { reservationId: r.id, channel: 'mail' })
      if (t === null) continue
      const text = renderCheckinInvitationEmail({
        propertyName: r.property_name, guestName: r.name,
        reservationRef: r.public_ref, arrival: r.arrival,
        validUntil: t.expiresOn, link: checkinLink(opts.appUrl, t.token)
      }, emailLanguage(r.language))
      await client.query(
        `SELECT email_enqueue($1,'checkin_invitation',$2,$3,$4,$5,$6,NULL,$7,NULL)`,
        [propertyId, r.email, r.name, text.subject, text.text, text.html, r.id])
      invited++
    }
    return { invited }
  })
}
