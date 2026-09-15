import { renderMessage, type MessageLocale, type MessageParams }
  from '@hotelpms/contracts'
import { ApiError } from './api.js'

/**
 * Die Meldung eines Fehlers in der Sprache des Personals.
 *
 * **Zwei Kataloge, und das mit Absicht.** `lib/i18n/` traegt die Texte
 * *dieser Oberflaeche* -- Beschriftungen, Knoepfe, Hinweise. Der Katalog in
 * `@hotelpms/contracts` traegt die Meldungen *der Schnittstelle*. Sie haben
 * verschiedene Besitzer: eine Beschriftung aendert, wer den Bildschirm baut,
 * eine Fehlermeldung, wer die Route schreibt. Sie in einen Topf zu werfen
 * hiesse, dass jede Aenderung an der API die Oberflaeche anfasst.
 *
 * Kommt ein Fehler ohne Schluessel -- ein Netzausfall, ein Rumpf, der kein
 * Problem Details ist --, bleibt der vorhandene Text stehen. Eine leere
 * Fehlermeldung ist schlimmer als eine einsprachige.
 */
export interface Fehlermeldung {
  /** Der Satz, auf den es ankommt. */
  text: string
  /** Meldungen an einzelnen Feldern, als Paare aus Feldname und Satz. */
  felder: Array<[feld: string, meldung: string]>
}

export function fehlerMeldung(error: unknown, locale: MessageLocale): Fehlermeldung {
  if (!(error instanceof ApiError)) {
    return { text: error instanceof Error ? error.message : String(error), felder: [] }
  }
  const p = error.problem
  const params = p.params
  // `code` zeigt auf `detail`, wo es eines gibt, sonst auf den Titel. Ohne
  // Schluessel bleibt der deutsche Satz der Schnittstelle stehen.
  const text = p.code !== undefined
    ? renderMessage(p.code, locale, params)
    : p.detail ?? p.title

  const keys = p.errorKeys
  const felder: Array<[string, string]> = keys !== undefined
    ? Object.entries(keys).flatMap(([feld, ks]) =>
        ks.map(k => [feld, renderMessage(k, locale, params)] as [string, string]))
    : Object.entries(p.errors ?? {}).flatMap(([feld, texte]) =>
        texte.map(x => [feld, x] as [string, string]))

  return { text, felder }
}

/**
 * Ein Satz der Schnittstelle in der Sprache des Personals.
 *
 * Fehlermeldungen sind nicht das Einzige, was die API in Worten schickt:
 * neben mancher Antwort steht ein Hinweis, der eine Erwartung geraderueckt,
 * und der Einrichtungsstand nennt seine Schritte. Beides kommt mit
 * Schluessel. Ohne Schluessel bleibt der deutsche Satz stehen.
 */
export function apiText(
  key: string | undefined, fallback: string, locale: MessageLocale,
  params?: MessageParams
): string {
  return key === undefined ? fallback : renderMessage(key, locale, params)
}
