import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { LEGACY_ADAPTERS, LegacyFormatError, type LegacySystem } from '../platform/legacyImport/index.js'
import { runImport } from './import.js'

/**
 * Import aus Altsystemen (Aufgabe 8, Dokument 05: der Zielkunde ist
 * Migrationskandidat).
 *
 * Jede Route uebersetzt nur die Rohform eines Anbieters in die Zeilen, die
 * `runImport`/`importReservations` (routes/import.ts) ohnehin schon
 * verarbeiten: dieselbe Bindung ueber `inventory_reserve`, derselbe
 * Trockenlauf als Regelfall, dasselbe Ganz-oder-gar-nicht, dieselbe
 * Ueberspring-Meldung bei einer schon gesehenen externen Nummer. Eine
 * Stichtagsmigration braucht deshalb keinen eigenen Abgleich-Mechanismus:
 * derselbe Export laesst sich zur Probe, kurz vor und am Stichtag selbst
 * erneut einspielen, ohne Dubletten zu erzeugen, und der Bericht (Zeile,
 * Grund) ist in jedem Lauf derselbe Abgleich.
 */
interface LegacyImportBody {
  propertyId: number
  /** Rohform des Altsystem-Exports, so wie er aus dem System kommt. */
  data: string
  commit?: boolean
}

export function legacyImportRoutes(app: FastifyInstance): void {
  for (const system of Object.keys(LEGACY_ADAPTERS) as LegacySystem[]) {
    registerRoute(app, {
      method: 'POST',
      url: `/v1/imports/legacy/${system}/reservations`,
      permission: 'settings:property',
      propertyParam: 'propertyId',
      summary: `Reservierungen aus ${system} importieren`,
      // Dieselbe Grenze wie der generische Import: mehrere Megabyte fuer
      // einen Altbestand sind der Regelfall, nicht die Ausnahme.
      bodyLimit: 32 * 1024 * 1024,
      handler: async (req) => {
        const body = req.body as LegacyImportBody
        if (typeof body.data !== 'string' || body.data.trim() === '') {
          throw Errors.validation({ data: ['Pflichtfeld'] })
        }

        let records: Array<Record<string, string>>
        try {
          records = LEGACY_ADAPTERS[system](body.data)
        } catch (e) {
          if (e instanceof LegacyFormatError) throw Errors.unprocessable(e.message)
          throw e
        }

        return runImport(req, body.propertyId, body.commit === true, records, 'reservations')
      }
    })
  }

  registerRoute(app, {
    method: 'GET',
    url: '/v1/imports/legacy/templates',
    permission: 'settings:property',
    summary: 'Erwartete Rohform je Altsystem',
    handler: async () => ({
      hinweis: 'Keines dieser drei Formate ist eine veroeffentlichte '
             + 'Spezifikation (Dokument 05, Abschnitt 6). Vor dem ersten '
             + 'echten Kunden gegen eine tatsaechliche Exportdatei pruefen.',
      hotline: {
        delimiter: ';',
        example: 'Belegnummer;Zimmerkategorie;Anreise;Abreise;Nachname;Vorname;'
               + 'Gesamtpreis;Herkunft\r\n'
               + 'HL-10023;DZ;01.07.2026;05.07.2026;Petersen;Jan;480,00;Booking.com\r\n'
      },
      hs3: {
        delimiter: '|',
        example: 'RES_ID|RM_TYPE|ARR|DEP|GUEST_NAME|AMOUNT_CENT|SRC\r\n'
               + 'R-88214|EZ|20260701|20260705|Mueller, Stefan|39600|Expedia\r\n'
      },
      protel: {
        delimiter: ',',
        example: 'ReservationNo,RoomType,CheckIn,CheckOut,GuestName,TotalAmount,Channel\r\n'
               + 'PR-77102,SUI,07/01/2026,07/05/2026,"Fischer, Anna",980.00,Direct\r\n'
      }
    })
  })
}
