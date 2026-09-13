/**
 * Fehler nach RFC 9457 Problem Details.
 * In Produktion enthaelt `detail` nie SQL, Stapelspuren oder interne
 * Bezeichner, nur die Anfrage-ID fuer den Support (S12, Dokument 12).
 */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  errors?: Record<string, string[]>
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: Record<string, string[]>
  ) {
    super(title)
    this.name = 'AppError'
  }

  toProblem(instance?: string): ProblemDetails {
    const p: ProblemDetails = { type: this.type, title: this.title, status: this.status }
    if (this.detail) p.detail = this.detail
    if (instance) p.instance = instance
    if (this.errors) p.errors = this.errors
    return p
  }
}

export const Errors = {
  unauthorized: (detail?: string) =>
    new AppError(401, 'urn:hotelpms:unauthorized', 'Nicht angemeldet', detail),
  forbidden: (detail?: string) =>
    new AppError(403, 'urn:hotelpms:forbidden', 'Keine Berechtigung', detail),
  notFound: (what = 'Ressource') =>
    new AppError(404, 'urn:hotelpms:not_found', `${what} nicht gefunden`),
  conflict: (detail: string) =>
    new AppError(409, 'urn:hotelpms:conflict', 'Konflikt', detail),
  validation: (errors: Record<string, string[]>) =>
    new AppError(422, 'urn:hotelpms:validation', 'Eingabe ungueltig', undefined, errors),
  unprocessable: (detail: string) =>
    new AppError(422, 'urn:hotelpms:unprocessable', 'Nicht verarbeitbar', detail),
  soldOut: () =>
    new AppError(409, 'urn:hotelpms:sold_out', 'Kein Kontingent verfuegbar',
      'Fuer mindestens eine Nacht des Zeitraums ist die Kapazitaet erschoepft.'),
  notMaterialized: () =>
    new AppError(503, 'urn:hotelpms:not_materialized', 'Zeitraum nicht verfuegbar',
      'Der Zeitraum liegt ausserhalb des vorbereiteten Horizonts. Der Betrieb wurde benachrichtigt.'),
  rangeTooLarge: (max: number) =>
    new AppError(422, 'urn:hotelpms:range_too_large', 'Zeitraum zu gross',
      `Hoechstens ${max} Tage je Anfrage.`),
  idempotencyMismatch: () =>
    new AppError(422, 'urn:hotelpms:idempotency_mismatch', 'Idempotenzschluessel wiederverwendet',
      'Derselbe Schluessel wurde bereits mit einem anderen Rumpf benutzt.'),
  idempotencyInFlight: () =>
    new AppError(409, 'urn:hotelpms:idempotency_in_flight', 'Anfrage laeuft bereits',
      'Eine Anfrage mit diesem Schluessel wird gerade verarbeitet. Bitte wiederholen.'),
  // Der Beleg entsteht nach dem Festschreiben im Worker, nicht in derselben
  // Transaktion: die haelt die Zaehlerzeile der Rechnungsnummer gesperrt.
  // Ein eigener Fehlertyp, damit die Oberflaeche zwischen "gibt es nicht"
  // und "kommt gleich" unterscheiden kann.
  documentPending: () =>
    new AppError(409, 'urn:hotelpms:document_pending', 'Beleg noch nicht erzeugt',
      'Die Rechnung ist festgeschrieben, der Beleg wird gerade erzeugt. '
      + 'Bitte in Kuerze erneut abrufen.')
}
