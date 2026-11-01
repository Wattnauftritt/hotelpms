import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Principal } from './context.js'
import { koederAdressen, koederInWert, koederKennung } from './koeder.js'

/**
 * Wer fragt, und wie viel (Bedrohungsanalyse 23.10.2026, E1 und E2).
 *
 * **Die Protokollzeile nennt den Aufrufer und die volle Adresse.** Bisher
 * stand dort Methode, Pfad und Status. Wer nach einem Abfluss wissen will,
 * welcher Zugang um 3:12 Uhr die Gaesteliste gezogen hat, fand nichts, das
 * sich einem Menschen, einem Maschinenzugang oder einer Adresse zuordnen
 * liess. Die Adresse ungekuerzt (Sven, 23.10.2026): fuer eine Anzeige und
 * eine Sperre taugt nur die volle. Das Journal haelt sie 30 Tage
 * (`ops/journald/hotelpms.conf`).
 *
 * **Die Routen, die Gaeste in Mengen liefern, zaehlen mit.** Je Aufrufer
 * und Stunde Anfragen und Datensaetze (Migration 0210); der Worker
 * vergleicht jede Stunde mit den vierzehn Tagen davor. Gezaehlt wird am
 * Rueckgabewert, bevor er zu JSON wird, und nicht in jedem Handler: der
 * naechste Endpunkt, der Gaeste liefert, kaeme sonst ohne Zaehler dazu,
 * und niemand merkte es.
 *
 * **Gezaehlt werden verschiedene Datensaetze, nicht Zeilen** (Migration
 * 0221). Dieselbe Liste zehnmal zu laden, ist kein zehnfacher Abfluss; am
 * 01.11.2026 hat genau das einen Alarm ausgeloest. Ein Kennzeichen der
 * eigenen Oberflaeche haette ihn auch verhindert, aber jeder mit einer
 * uebernommenen Sitzung schickt es mit.
 */

declare module 'fastify' {
  interface FastifyRequest {
    abrufKennungen: string[] | null
  }
}

/**
 * Was gezaehlt wird. Nur lesende Routen, die Gaeste, Reservierungen oder
 * Meldescheine liefern; die Exporte als eine Anfrage je Datei, weil ihr
 * Rumpf keine Liste ist -- sie stehen ohnehin als Sicherheitsereignis da.
 */
export const GEZAEHLT: ReadonlySet<string> = new Set([
  '/v1/guests',
  '/v1/guests/:guestRef',
  '/v1/guests/:guestRef/id-document',
  '/v1/guests/:guestRef/data-export',
  '/v1/properties/:propertyId/reservations',
  '/v1/reservations/:reservationRef',
  '/v1/registrations/:registrationId',
  '/v1/properties/:propertyId/registrations',
  '/v1/properties/:propertyId/search',
  '/v1/properties/:propertyId/exports/tenant',
  '/v1/properties/:propertyId/exports/gobd',
  '/v1/properties/:propertyId/exports/guest-levy'
])

/**
 * Die Listen unter den gezaehlten Routen: ihre Antwort traegt viele
 * Datensaetze. Alle anderen liefern einen -- einen Gast, eine Reservierung,
 * eine Exportdatei --, auch wenn darin Listen stecken (Naechte, Posten).
 */
export const LISTEN: ReadonlySet<string> = new Set([
  '/v1/guests',
  '/v1/properties/:propertyId/reservations',
  '/v1/properties/:propertyId/registrations',
  '/v1/properties/:propertyId/search'
])

/** Der Aufrufer als kurze Kennung; `null` fuer anonym. */
export function aufrufer(p: Principal | undefined): string | null {
  if (p === undefined) return null
  if (p.userId !== null) return `user:${p.userId}`
  if (p.terminalDeviceId !== null) return `terminal:${p.terminalDeviceId}`
  if (p.clientKey.startsWith('client:')) return p.clientKey.slice(0, 80)
  return null
}

/** Eine Kennung als vorzeichenbehaftete 64-Bit-Zahl, als Text fuer `bigint[]`. */
function kennung(text: string): string {
  return createHash('sha256').update(text).digest().readBigInt64BE(0).toString()
}

/**
 * Die Kennungen der Datensaetze einer Antwort. Eine Liste traegt je Element
 * eine, gebildet aus dem Inhalt: dasselbe Element zweimal geladen ist eine
 * Kennung, ein geaendertes eine neue. Ein Einzelabruf traegt eine, gebildet
 * aus der Adresse -- denselben Gast zweimal zu oeffnen, ist ein Gast.
 *
 * Grob, mit Absicht: gesucht wird der Sprung von zwanzig auf zwanzigtausend
 * verschiedene Gaeste, nicht die genaue Zahl.
 */
export function datensatzKennungen(route: string, adresse: string, payload: unknown): string[] {
  if (!LISTEN.has(route)) return [kennung(`${route} ${adresse}`)]
  const elemente: unknown[] = Array.isArray(payload) ? payload
    : payload !== null && typeof payload === 'object'
      ? Object.values(payload).flatMap(v => Array.isArray(v) ? v as unknown[] : [])
      : []
  return [...new Set(elemente.map(e => kennung(`${route} ${JSON.stringify(e)}`)))]
}

function gezaehlt(req: FastifyRequest): boolean {
  return req.method === 'GET' && GEZAEHLT.has(req.routeOptions.url ?? '')
}

export function abrufmengeAnmelden(app: FastifyInstance): void {
  app.decorateRequest('abrufKennungen', null)

  /*
   * Nach der Bestimmung des Aufrufers (preValidation), vor dem Handler:
   * ab hier traegt jede Zeile dieser Anfrage, auch "request completed",
   * Aufrufer und Adresse.
   */
  app.addHook('preHandler', async (req, reply) => {
    const wer = aufrufer(req.principal as Principal | undefined) ?? 'anonym'
    req.log = req.log.child({ wer, ip: req.ip })
    reply.log = req.log
  })

  /*
   * Hier auch die Kennzeichnung der Koeder (Migration 0213): dieselben
   * Routen, dieselbe Stelle, an der jede Antwort mit Gaesten vorbeikommt.
   */
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (!gezaehlt(req)) return payload
    req.abrufKennungen = datensatzKennungen(req.routeOptions.url ?? '', req.url, payload)
    const adressen = await koederAdressen(req.pool)
    return koederInWert(payload, adressen,
      koederKennung(req.principal as Principal | undefined, 'api'))
  })

  app.addHook('onResponse', async (req, reply) => {
    if (!gezaehlt(req) || reply.statusCode >= 400) return
    const p = req.principal as Principal | undefined
    const wer = aufrufer(p)
    if (wer === null) return
    try {
      await req.pool.query('SELECT access_volume_add($1, $2, $3::bigint[], $4::inet)',
        [wer, p?.accountIds[0] ?? null,
         req.abrufKennungen ?? [kennung(`${req.routeOptions.url ?? ''} ${req.url}`)],
         req.ip || null])
    } catch (e) {
      // Ein Zaehler, der ausfaellt, darf keine Antwort kosten -- die ist
      // ohnehin schon unterwegs. Aber er soll auffallen.
      req.log.error({ err: e }, 'Abrufzaehler nicht geschrieben')
    }
  })
}
