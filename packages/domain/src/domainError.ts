/**
 * Ein fachlicher Fehler ohne HTTP.
 *
 * Die Fachlogik laeuft seit der Kanalanbindung (Migration 0198) an zwei
 * Stellen: in der API, wenn ein Umsystem eine Buchung schickt, und im
 * Worker, wenn StayGrid sie beim Channel Manager abholt. `Errors` gehoert
 * der API; der Worker kennt es nicht und soll es nicht kennen. Die Fachlogik
 * wirft deshalb diesen Fehler mit dem Schluessel der Meldung, und die API
 * uebersetzt ihn in ihre Antwort (`platform/domainError.ts`). Der Worker
 * schreibt den Schluessel ins Kanalprotokoll -- ein Schluessel, kein Satz und
 * vor allem kein Gastname.
 */
export type DomainErrorKind =
  | 'validation' | 'conflict' | 'notFound' | 'unprocessable' | 'notMaterialized'

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    /** Schluessel aus `messages.ts`; bei `validation` steht er in `fields`. */
    readonly key: string | null,
    readonly fields?: Record<string, string[]>,
    readonly params?: Record<string, string | number>
  ) {
    super(key ?? Object.values(fields ?? {}).flat()[0] ?? kind)
    this.name = 'DomainError'
  }

  static validation(fields: Record<string, string[]>,
                    params?: Record<string, string | number>): DomainError {
    return new DomainError('validation', null, fields, params)
  }
}
