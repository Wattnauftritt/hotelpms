import { migrate } from '../migrate.js'

const r = await migrate(m => console.log(m))
console.log(`Migrationen: ${r.applied.length} angewendet, ${r.skipped} bereits vorhanden.`)
