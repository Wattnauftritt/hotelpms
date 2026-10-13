import type { MessageLocale } from '@hotelpms/contracts'
import { api, ApiError } from './api.js'
import { fehlerMeldung } from './meldungen.js'

/**
 * Check-out mit Rueckfrage bei offenem Saldo.
 *
 * Die Schnittstelle weist einen Check-out ab, solange am Folio Geld offen
 * ist oder Positionen ohne Rechnung stehen (Pruefung 13.10.2026, Befund 6).
 * Gesperrt ist er damit nicht: wer bestaetigt, checkt aus. Die Frage steht
 * hier und nicht an jedem Knopf, weil es fuenf Knoepfe sind -- Tagesliste,
 * Mobilansicht, Plan, Seitenfenster und Gruppe --, und an einem davon
 * vergaesse man sie.
 */
export async function auschecken<T>(
  url: string, locale: MessageLocale
): Promise<T> {
  try {
    return await api.post<T>(url)
  } catch (e) {
    if (e instanceof ApiError && e.problem.code === 'checkout.openBalance'
        && window.confirm(fehlerMeldung(e, locale).text)) {
      return api.post<T>(url, { openBalance: 'accept' })
    }
    throw e
  }
}
