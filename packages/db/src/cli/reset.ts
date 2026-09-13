import pg from 'pg'
import { dbUrl } from '../config.js'
import { migrate } from '../migrate.js'

/** Schema vollstaendig neu aufbauen. Nur fuer Entwicklung und Tests. */
if (process.env.NODE_ENV === 'production') {
  throw new Error('reset ist in Produktion nicht erlaubt.')
}
const client = new pg.Client({ connectionString: dbUrl('owner') })
await client.connect()
await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
await client.query('GRANT USAGE ON SCHEMA public TO hotelpms_app, hotelpms_readonly')
await client.end()
const r = await migrate(m => console.log(m))
console.log(`Schema neu aufgebaut, ${r.applied.length} Migrationen.`)
