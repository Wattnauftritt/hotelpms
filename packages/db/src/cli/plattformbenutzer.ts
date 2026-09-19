import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { dbUrl } from '../config.js'

/**
 * Der erste Plattformbenutzer — das Henne-Ei-Problem der Inbetriebnahme.
 *
 * **Warum es dieses Skript geben muss.** Einen Kunden anlegt, wer
 * `platform:accounts` hat; ausgerollt wird von dem, der
 * `platform:operations` hat. Beide Rechte haengen an einer Plattformrolle,
 * und die vergibt man ueber die Oberflaeche — bei der man angemeldet sein
 * muss. Auf einer frischen Maschine gibt es aber niemanden, der sich
 * anmelden koennte. Ohne diesen Weg bleibt nur, die vier Zeilen SQL von Hand
 * zu tippen: app_user anlegen, is_platform_staff setzen, Kennwort mit
 * Argon2 in den richtigen Parametern hashen, die Rolle verknuepfen.
 *
 * Genau das ging in der Vergangenheit schief. Wer `is_platform_staff`
 * vergisst, bekommt einen Benutzer, der sich anmelden kann und nichts sieht
 * — und sucht den Fehler in den Berechtigungen. Wer das Kennwort mit
 * anderen Argon2-Parametern hasht, bekommt einen, der sich nicht anmelden
 * kann, ohne dass irgendwo steht warum.
 *
 * **Warum es kein zweites Mal laeuft.** Ein Skript, das Plattformrechte
 * vergibt, ist die eine Stelle, an der ein Versehen alles aufmacht. Es legt
 * deshalb nur an, was es nicht gibt, und weist einen vorhandenen Benutzer
 * ab, statt ihn stillschweigend zu erhoehen.
 *
 * Aufruf:
 *   PLATTFORM_EMAIL=… PLATTFORM_PASSWORD=… pnpm db:plattformbenutzer
 *   PLATTFORM_EMAIL=… pnpm db:plattformbenutzer   # Kennwort wird erzeugt
 *   PLATTFORM_ROLLE=platform_support …            # abweichende Rolle
 */

/*
 * Mindestlaenge wie ueberall sonst. Sie steht hier als Zahl und nicht als
 * Verweis auf @hotelpms/contracts, weil packages/db nicht daran haengt und
 * eine Abhaengigkeit fuer eine Zwoelf die falsche Antwort waere. Laeuft sie
 * auseinander, faellt es an dieser Stelle auf: das Kennwort wird beim ersten
 * Anmelden abgewiesen.
 */
const KENNWORT_MIN = 12

async function main(): Promise<void> {
  /*
   * Die Umgebung wird beim AUFRUF gelesen, nicht beim Import.
   *
   * Hier standen diese drei Werte einmal als Konstanten am Dateianfang. Fuer
   * den Aufruf als Programm ist das gleichgueltig -- fuer jeden anderen
   * Aufrufer nicht: er haette die Umgebung gesetzt und bekaeme trotzdem das,
   * was beim Laden des Moduls dastand. Aufgefallen ist es am eigenen Test,
   * der "PLATTFORM_EMAIL fehlt" zu hoeren bekam, obwohl er sie gesetzt hatte.
   */
  const EMAIL = process.env.PLATTFORM_EMAIL
  const NAME = process.env.PLATTFORM_NAME ?? EMAIL
  const ROLLE = process.env.PLATTFORM_ROLLE ?? 'platform_admin'

  if (!EMAIL) {
    console.error(
      'PLATTFORM_EMAIL fehlt.\n\n'
      + '  PLATTFORM_EMAIL=betrieb@staygrid.cloud pnpm db:plattformbenutzer\n')
    process.exitCode = 1
    return
  }

  const kennwort = process.env.PLATTFORM_PASSWORD ?? randomBytes(12).toString('base64url')
  if ([...kennwort].length < KENNWORT_MIN) {
    console.error(`Das Kennwort braucht mindestens ${KENNWORT_MIN} Zeichen.`)
    process.exitCode = 1
    return
  }

  const client = new pg.Client({ connectionString: dbUrl('owner') })
  await client.connect()

  try {
    await client.query('BEGIN')

    const rolle = await client.query<{ id: number }>(
      `SELECT id FROM role WHERE key = $1 AND account_id IS NULL AND level = 'platform'`,
      [ROLLE])
    if (rolle.rows.length === 0) {
      console.error(
        `Es gibt keine Plattformrolle mit dem Schluessel ${ROLLE}.\n\n`
        + '  Vorhanden: platform_admin, platform_support, platform_billing, '
        + 'platform_ops\n')
      process.exitCode = 1
      await client.query('ROLLBACK')
      return
    }

    /*
     * Einen vorhandenen Benutzer nicht anfassen. Ihn hier zu erhoehen waere
     * bequem und genau der Weg, auf dem ein Kundenzugang unbemerkt zu einem
     * Plattformzugang wird -- etwa wenn jemand aus Versehen die Adresse
     * eines Hoteliers eintippt.
     */
    const da = await client.query<{ id: number; is_platform_staff: boolean }>(
      `SELECT id, is_platform_staff FROM app_user WHERE lower(email) = lower($1)`,
      [EMAIL])
    if (da.rows.length > 0) {
      console.error(
        `Es gibt schon einen Benutzer mit der Adresse ${EMAIL}`
        + `${da.rows[0]!.is_platform_staff ? ' (bereits Plattformpersonal)' : ''}.\n\n`
        + '  Dieses Skript erhoeht niemanden nachtraeglich -- das waere der Weg,\n'
        + '  auf dem ein Kundenzugang unbemerkt zu einem Plattformzugang wird.\n'
        + '  Nimm eine andere Adresse, oder vergib die Rolle in der Oberflaeche.\n')
      process.exitCode = 1
      await client.query('ROLLBACK')
      return
    }

    const u = await client.query<{ id: number }>(
      `INSERT INTO app_user (email, display_name, status, is_platform_staff,
                             password_hash)
       VALUES ($1, $2, 'active', true, $3) RETURNING id`,
      [EMAIL, NAME,
       await argonHash(kennwort, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })])

    await client.query(
      `INSERT INTO user_platform_role (user_id, role_id) VALUES ($1, $2)`,
      [u.rows[0]!.id, rolle.rows[0]!.id])

    await client.query('COMMIT')

    console.log(`
Plattformbenutzer angelegt.

  Anmeldung     ${EMAIL}
  Kennwort      ${kennwort}${process.env.PLATTFORM_PASSWORD ? ' (aus der Umgebung)' : ' (erzeugt — jetzt notieren)'}
  Rolle         ${ROLLE}

Dieser Zugang sieht KEINE Kundendaten. Plattformpersonal ohne freigegebene
Support-Sitzung hat einen leeren Mandantenkontext; die Zeilenrichtlinie
liefert nichts. Was er kann: Kunden anlegen, Support-Sitzungen anfragen,
ausrollen.
`)
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw fehler
  } finally {
    await client.end()
  }
}

// Nur als Programm, nicht beim Import -- sonst legte ein blosser Import
// einen Plattformzugang in der Testdatenbank an.
if (process.argv[1] !== undefined
    && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((fehler: unknown) => {
    console.error(fehler)
    process.exit(1)
  })
}

export { main as plattformbenutzerAnlegen }
