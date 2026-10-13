import { open, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { crc32, createDeflateRaw } from 'node:zlib'
import type { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'

/**
 * Ein ZIP-Archiv, das nicht im Speicher entsteht -- fuer den GoBD-Export,
 * der Tabellen und Belege eines Zeitraums zusammen ausliefert (Pruefung des
 * Rechnungssystems vom 13.10.2026).
 *
 * **Warum selbst geschrieben.** Das Format, das hier gebraucht wird, sind
 * drei Satzarten: Kopf je Eintrag, Verzeichnis, Abschluss. Eine Bibliothek
 * dafuer braechte Entpacken, Verschluesselung und ZIP64 mit, also eine
 * Angriffsflaeche, die groesser ist als diese Datei -- derselbe Grund wie
 * beim CSV-Leser.
 *
 * **Warum eine Datei.** Wie `JsonExportDatei`: die Transaktion soll nicht
 * auf den Empfaenger warten, und die Datei ist sofort nach dem Anlegen ohne
 * Namen, weil sie Gastnamen enthaelt.
 *
 * Jeder Eintrag wird beim Schreiben komprimiert (Deflate) und traegt
 * Pruefsumme und Groesse im Datendeskriptor hinter den Daten (Bit 3); so
 * muss kein Eintrag vorher ganz im Speicher stehen. Das Verzeichnis am Ende
 * traegt beides noch einmal, und danach richten sich alle gaengigen Leser.
 * Kein ZIP64: ueber 4 GiB bricht der Export ab, statt ein Archiv zu
 * liefern, das niemand oeffnen kann.
 */

const GRENZE = 0xffff_ffff

interface Verzeichniseintrag {
  name: Buffer; crc: number; gepackt: number; roh: number; versatz: number
  zeit: number; datum: number
}

/** Zeitpunkt im MS-DOS-Format, wie ZIP ihn verlangt (Ortszeit egal: Ablagezeit). */
function dosZeit(d: Date): { zeit: number; datum: number } {
  return {
    zeit: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    datum: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  }
}

export class ZipDatei {
  private versatz = 0
  private readonly eintraege: Verzeichniseintrag[] = []
  private readonly jetzt = dosZeit(new Date())

  private constructor (private readonly fh: FileHandle) {}

  static async anlegen(): Promise<ZipDatei> {
    const pfad = join(tmpdir(), `staygrid-export-${randomUUID()}.zip`)
    const fh = await open(pfad, 'wx+', 0o600)
    try {
      await unlink(pfad)
    } catch (err) {
      await fh.close()
      throw err
    }
    return new ZipDatei(fh)
  }

  private async roh(b: Buffer): Promise<void> {
    await this.fh.write(b)
    this.versatz += b.length
    if (this.versatz > GRENZE) throw new Error('ZIP-Archiv ueber 4 GiB')
  }

  /**
   * Schreibt einen Eintrag. `teile` liefert den Inhalt stueckweise; ein
   * einzelner Puffer oder Text geht genauso.
   */
  async eintrag(name: string,
                teile: AsyncIterable<Buffer | string> | Iterable<Buffer | string>): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8')
    const kopf = Buffer.alloc(30)
    kopf.writeUInt32LE(0x04034b50, 0)
    kopf.writeUInt16LE(20, 4)               // benoetigte Version 2.0
    kopf.writeUInt16LE(0x0808, 6)           // Bit 3 Datendeskriptor, Bit 11 UTF-8
    kopf.writeUInt16LE(8, 8)                // Deflate
    kopf.writeUInt16LE(this.jetzt.zeit, 10)
    kopf.writeUInt16LE(this.jetzt.datum, 12)
    // Pruefsumme und Groessen stehen im Deskriptor dahinter.
    kopf.writeUInt16LE(nameBytes.length, 26)
    const versatz = this.versatz
    await this.roh(Buffer.concat([kopf, nameBytes]))

    const deflate = createDeflateRaw()
    let crc = 0
    let roh = 0
    let gepackt = 0
    const schreiben = (async () => {
      for await (const stueck of deflate) {
        const b = stueck as Buffer
        gepackt += b.length
        await this.roh(b)
      }
    })()
    try {
      for await (const teil of teile) {
        const b = typeof teil === 'string' ? Buffer.from(teil, 'utf8') : teil
        if (b.length === 0) continue
        crc = crc32(b, crc)
        roh += b.length
        if (roh > GRENZE) throw new Error('ZIP-Eintrag ueber 4 GiB')
        // Gegendruck: erst weiter, wenn der Kompressor wieder aufnimmt.
        if (!deflate.write(b)) await new Promise(r => deflate.once('drain', r))
      }
      deflate.end()
    } catch (err) {
      deflate.destroy()
      await schreiben.catch(() => undefined)
      throw err
    }
    await schreiben

    const deskriptor = Buffer.alloc(16)
    deskriptor.writeUInt32LE(0x08074b50, 0)
    deskriptor.writeUInt32LE(crc >>> 0, 4)
    deskriptor.writeUInt32LE(gepackt, 8)
    deskriptor.writeUInt32LE(roh, 12)
    await this.roh(deskriptor)
    this.eintraege.push({ name: nameBytes, crc: crc >>> 0, gepackt, roh, versatz,
                          ...this.jetzt })
  }

  /** Verzeichnis und Abschluss; danach nimmt die Datei keinen Eintrag mehr. */
  async abschliessen(): Promise<void> {
    if (this.eintraege.length > 0xffff) throw new Error('ZIP-Archiv mit zu vielen Eintraegen')
    const anfang = this.versatz
    for (const e of this.eintraege) {
      const z = Buffer.alloc(46)
      z.writeUInt32LE(0x02014b50, 0)
      z.writeUInt16LE(20, 4)
      z.writeUInt16LE(20, 6)
      z.writeUInt16LE(0x0808, 8)
      z.writeUInt16LE(8, 10)
      z.writeUInt16LE(e.zeit, 12)
      z.writeUInt16LE(e.datum, 14)
      z.writeUInt32LE(e.crc, 16)
      z.writeUInt32LE(e.gepackt, 20)
      z.writeUInt32LE(e.roh, 24)
      z.writeUInt16LE(e.name.length, 28)
      z.writeUInt32LE(e.versatz, 42)
      await this.roh(Buffer.concat([z, e.name]))
    }
    const ende = Buffer.alloc(22)
    ende.writeUInt32LE(0x06054b50, 0)
    ende.writeUInt16LE(this.eintraege.length, 8)
    ende.writeUInt16LE(this.eintraege.length, 10)
    ende.writeUInt32LE(this.versatz - anfang, 12)
    ende.writeUInt32LE(anfang, 16)
    await this.roh(ende)
  }

  async lesen(): Promise<{ strom: Readable; bytes: number }> {
    const { size } = await this.fh.stat()
    return { strom: this.fh.createReadStream({ start: 0, autoClose: true }), bytes: size }
  }

  async verwerfen(): Promise<void> {
    try { await this.fh.close() } catch { /* schon zu */ }
  }
}

/** Fuellt ein Archiv, schliesst es ab und sendet es; wie `sendeJsonExport`. */
export async function sendeZip(
  reply: FastifyReply, dateiname: string, fuellen: (zip: ZipDatei) => Promise<void>
): Promise<FastifyReply> {
  const zip = await ZipDatei.anlegen()
  let strom: Readable
  let bytes: number
  try {
    await fuellen(zip)
    await zip.abschliessen()
    ;({ strom, bytes } = await zip.lesen())
  } catch (err) {
    await zip.verwerfen()
    throw err
  }
  reply.header('content-type', 'application/zip')
  reply.header('content-disposition', `attachment; filename="${dateiname}"`)
  reply.header('content-length', bytes)
  return reply.send(strom)
}
