import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool,
         makeProperty, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * Die Mailsuche unter der Zeilenrichtlinie (Migration 0069).
 *
 * Was hier festgehalten wird, ist kein Ergebnis, sondern die Bedingung,
 * unter der es schnell bleibt: die Bedingung des Aufrufers muss **vor** der
 * Richtlinie laufen duerfen, und das darf sie nur, wenn jede Funktion darin,
 * die eine Spalte beruehrt, LEAKPROOF ist. `lower(email) LIKE ...` war es
 * nicht und lief als Filter ueber jeden Gast des Accounts; mit wenigen
 * Testzeilen sieht das genauso schnell aus wie ein Indexscan. Deshalb wird
 * der Plan geprueft und nicht die Zeit.
 *
 * Die Bedingung ist dieselbe wie im Zweig `nach_email` von `GET /v1/guests`
 * (`apps/api/src/routes/guests.ts`) und im Zweig `nach_mail` der
 * Detailsuche (`apps/api/src/routes/search.ts`, dort mit schon
 * kleingeschriebenem Begriff). Wer sie dort aendert, aendert sie hier.
 */

let owner: Pool
let app: Pool
let fx: Fixture

beforeAll(async () => { await ensureSchema(); owner = ownerPool(); app = appPool(5) })
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  // Genug Zeilen, dass der Planer einen Index fuer lohnend haelt.
  await owner.query(
    `INSERT INTO guest (account_id, last_name, email)
     SELECT $1, 'Gast ' || i, 'Gast' || i || '@Example.de' FROM generate_series(1, 2000) i`,
    [fx.accountId])
  await owner.query(`ANALYZE guest`)
})

const BEDINGUNG = `email_lower ~>=~ lower($1)
               AND email_lower ~<~ text_prefix_end(lower($1))`

async function alsAnwendung<T>(fn: (q: Pool['query']) => Promise<T>): Promise<T> {
  const client = await app.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.account_ids',$1,true)`, [String(fx.accountId)])
    const r = await fn(client.query.bind(client) as Pool['query'])
    await client.query('COMMIT')
    return r
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('Mailsuche unter der Zeilenrichtlinie', () => {
  it('ist eine Indexbedingung und kein Filter hinter der Richtlinie', async () => {
    const plan = await alsAnwendung(async q => {
      const r = await q<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT id FROM guest WHERE ${BEDINGUNG} LIMIT 20`, ['gast17@'])
      return r.rows.map(z => z['QUERY PLAN']).join('\n')
    })
    expect(plan).toMatch(/Index Cond: \(\(email_lower ~>=~/)
    expect(plan).not.toMatch(/Filter:[^\n]*email/)
  })

  it('findet Anfaenge ohne Ruecksicht auf Gross- und Kleinschreibung', async () => {
    const treffer = await alsAnwendung(async q =>
      (await q<{ email: string }>(
        `SELECT email FROM guest WHERE ${BEDINGUNG} ORDER BY email`, ['GAST17@'])).rows
        .map(z => z.email))
    expect(treffer).toEqual(['Gast17@Example.de'])
  })

  it('nimmt _ und % woertlich, nicht als Platzhalter', async () => {
    const treffer = await alsAnwendung(async q =>
      (await q(`SELECT 1 FROM guest WHERE ${BEDINGUNG}`, ['gast1_@'])).rowCount)
    expect(treffer).toBe(0)
  })

  it('gibt an den Raendern des Zeichenvorrats eine Grenze statt eines Fehlers', async () => {
    // Hinter U+D7FF beginnen die Ersatzzeichen, hinter U+10FFFF nichts mehr;
    // `chr(n + 1)` wirft dort.
    const r = await owner.query<{ d7ff: boolean; max: boolean; normal: string }>(
      `SELECT text_prefix_end('a' || chr(55295)) = 'a' || chr(57344)     AS d7ff,
              text_prefix_end('a' || chr(1114111)) = 'a' || chr(1114111) AS max,
              text_prefix_end('anke@')                                   AS normal`)
    // '@' ist U+0040, das naechste Zeichen 'A'.
    expect(r.rows[0]).toEqual({ d7ff: true, max: true, normal: 'ankeA' })
  })
})
