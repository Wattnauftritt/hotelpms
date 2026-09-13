import { createPool, requireEnv } from '@hotelpms/db'
import { encryptIdDocument, decryptIdDocument } from '../platform/crypto.js'

/**
 * Schluesselrotation fuer verschluesselte Felder (C4, Dokument 13).
 *
 * **Warum das ein Werkzeug braucht und keine Anleitung.** An jedem
 * verschluesselten Feld steht seit Beginn eine Schluesselversion. Das allein
 * nuetzt nichts: ohne einen Weg, die Datensaetze auf eine neue Version zu
 * heben, bleibt die alte fuer immer in Gebrauch, und die Version ist ein
 * Feld, das nie einen anderen Wert traegt. Eine Rotation, die nicht erprobt
 * ist, findet im Ernstfall nicht statt.
 *
 * **Beide Schluessel muessen gleichzeitig bekannt sein**: der alte zum Lesen,
 * der neue zum Schreiben. Ein Ablauf, der den alten vorher wegwirft, macht
 * die Daten unlesbar, und das faellt erst auf, wenn jemand sie braucht.
 *
 *   DRY_RUN=true ID_DOCUMENT_KEY_OLD=... ID_DOCUMENT_KEY=... \
 *     pnpm --filter @hotelpms/api rotate-keys
 *
 * Erst wenn der Lauf meldet, dass keine Datensaetze der alten Version uebrig
 * sind, darf der alte Schluessel verschwinden.
 *
 * **In Stapeln, nicht in einer Transaktion.** Eine Rotation ueber
 * Zehntausende Gastprofile in einer Transaktion sperrt die Tabelle, solange
 * sie laeuft. In Stapeln ist der Zustand zwischendurch gemischt, manche
 * Datensaetze alt, manche neu, und genau deshalb steht die Version an jedem
 * einzelnen: gemischt ist ein gueltiger Zustand, kein kaputter.
 */

const STAPEL = 500

const alt = requireEnv('ID_DOCUMENT_KEY_OLD')
const neu = requireEnv('ID_DOCUMENT_KEY')
const zielVersion = Number(process.env.ID_DOCUMENT_KEY_VERSION ?? 2)
const trocken = process.env.DRY_RUN === 'true'

if (alt === neu) {
  throw new Error('Alter und neuer Schluessel sind gleich. Nichts zu tun.')
}
if (!Number.isInteger(zielVersion) || zielVersion < 2) {
  throw new Error('ID_DOCUMENT_KEY_VERSION muss eine ganze Zahl ab 2 sein.')
}

// Ueber die Eigentuemerrolle: die Anwendungsrolle darf `guest` zwar
// aendern, aber die Rotation laeuft ohne Mandantenkontext ueber alle
// Accounts, und das ist Bereitstellungsarbeit (Dokument 10).
const pool = createPool({ kind: 'owner', max: 2, applicationName: 'hotelpms-rotate' })
const client = await pool.connect()

const offen = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM guest
    WHERE id_document_number_enc IS NOT NULL
      AND id_document_key_version IS DISTINCT FROM $1`, [zielVersion])
console.log(`Zu rotieren: ${offen.rows[0]!.n} Ausweisnummern auf Version ${zielVersion}.`)
if (trocken) console.log('Trockenlauf, es wird nichts geschrieben.')

let erledigt = 0
let fehler = 0

for (;;) {
  const { rows } = await client.query<{ id: number; enc: Buffer; version: number | null }>(
    `SELECT id, id_document_number_enc AS enc, id_document_key_version AS version
       FROM guest
      WHERE id_document_number_enc IS NOT NULL
        AND id_document_key_version IS DISTINCT FROM $1
      ORDER BY id LIMIT $2`, [zielVersion, STAPEL])
  if (rows.length === 0) break

  for (const g of rows) {
    let klartext: string
    try {
      klartext = decryptIdDocument(g.enc, alt, g.version ?? 1)
    } catch {
      /*
       * Ein Datensatz, der sich mit dem alten Schluessel nicht oeffnen
       * laesst, wird uebersprungen und gemeldet, nicht verworfen. Er
       * koennte mit einem noch aelteren Schluessel verschluesselt sein, und
       * ihn zu loeschen waere der Verlust eines Ausweismerkmals, das das
       * Haus vielleicht noch braucht.
       */
      console.error(`  Gast ${g.id}: laesst sich mit dem alten Schluessel nicht oeffnen.`)
      fehler++
      continue
    }
    if (!trocken) {
      const { ciphertext, keyVersion } = encryptIdDocument(klartext, neu, zielVersion)
      await client.query(
        `UPDATE guest SET id_document_number_enc = $2, id_document_key_version = $3
          WHERE id = $1`, [g.id, ciphertext, keyVersion])
    }
    erledigt++
  }
  console.log(`  ${erledigt} erledigt...`)
  if (trocken) break
}

const rest = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM guest
    WHERE id_document_number_enc IS NOT NULL
      AND id_document_key_version IS DISTINCT FROM $1`, [zielVersion])

console.log(`\nFertig. ${erledigt} rotiert, ${fehler} uebersprungen.`)
console.log(`Verbleibend auf alter Version: ${rest.rows[0]!.n}`)
if (!trocken) {
  console.log(Number(rest.rows[0]!.n) === 0
    ? '\nDer alte Schluessel wird nicht mehr gebraucht und darf entfernt werden.'
    : '\nDen alten Schluessel NICHT entfernen: es sind Datensaetze uebrig.')
}
client.release()
await pool.end()
