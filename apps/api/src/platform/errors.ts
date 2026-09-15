import { isMessageKey, type MessageParams } from '@hotelpms/contracts'
import { apiText as text, type Meldung } from './texte.js'

/**
 * Fehler nach RFC 9457 Problem Details.
 * In Produktion enthaelt `detail` nie SQL, Stapelspuren oder interne
 * Bezeichner, nur die Anfrage-ID fuer den Support (S12, Dokument 12).
 *
 * **Jede Meldung ist ein Schluessel, kein Satz.** Der Satz entsteht erst
 * beim Ausgeben, aus dem Katalog in `@hotelpms/contracts`. Das hat zwei
 * Gruende und nicht nur den offensichtlichen: die Oberflaeche kann in der
 * Sprache des Personals antworten, **und** eine Maschine bekommt etwas, das
 * sich nicht aendert, wenn jemand einen Satz umformuliert.
 *
 * Ein Schluessel, den der Katalog nicht kennt, kommt unveraendert durch.
 * Waehrend der Umstellung steht an manchen Stellen noch ein deutscher Satz,
 * und eine leere Fehlermeldung waere schlimmer als eine einsprachige. Ein
 * Test ueber die Quelle haelt fest, wo noch Saetze stehen.
 */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  errors?: Record<string, string[]>
  code?: string
  params?: MessageParams
  errorKeys?: Record<string, string[]>
}

export type { Meldung }

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly titleKey: Meldung,
    readonly detailKey?: Meldung,
    readonly errorKeys?: Record<string, string[]>,
    readonly params?: MessageParams
  ) {
    super(text(titleKey, params))
    this.name = 'AppError'
  }

  /** Der deutsche Titel. `message` traegt ihn ohnehin, hier fuer die Lesbarkeit. */
  get title(): string { return text(this.titleKey, this.params) }

  toProblem(instance?: string): ProblemDetails {
    const p: ProblemDetails = {
      type: this.type, title: this.title, status: this.status
    }
    if (this.detailKey !== undefined) p.detail = text(this.detailKey, this.params)
    if (instance) p.instance = instance
    if (this.errorKeys) {
      p.errors = Object.fromEntries(
        Object.entries(this.errorKeys).map(([feld, keys]) =>
          [feld, keys.map(k => text(k, this.params))]))
      p.errorKeys = this.errorKeys
    }
    // Der Schluessel der Meldung, auf die es ankommt: das ist `detail`, wo es
    // eines gibt, sonst der Titel. Nur was der Katalog kennt -- ein
    // durchgereichter Satz ist kein Schluessel und soll auch nicht so aussehen.
    const code = this.detailKey ?? this.titleKey
    if (isMessageKey(code)) p.code = code
    if (this.params !== undefined) p.params = this.params
    return p
  }
}

export const Errors = {
  unauthorized: (detail?: Meldung, params?: MessageParams) =>
    new AppError(401, 'urn:hotelpms:unauthorized', 'error.unauthorized',
      detail, undefined, params),
  forbidden: (detail?: Meldung, params?: MessageParams) =>
    new AppError(403, 'urn:hotelpms:forbidden', 'error.forbidden',
      detail, undefined, params),
  /**
   * `what` ist ein Ressourcenschluessel, etwa `res.category`. Traegt der
   * Name selbst einen Platzhalter -- "Kassenumsatz mit der Belegnummer
   * {reference}" --, kommen die Werte als zweites Argument dazu.
   */
  notFound: (what: Meldung = 'res.resource', params?: MessageParams) =>
    new AppError(404, 'urn:hotelpms:not_found', 'error.notFound', undefined, undefined,
      { ...params, what: text(what, params) }),
  conflict: (detail: Meldung, params?: MessageParams) =>
    new AppError(409, 'urn:hotelpms:conflict', 'error.conflict',
      detail, undefined, params),
  validation: (errors: Record<string, Meldung[]>, params?: MessageParams) =>
    new AppError(422, 'urn:hotelpms:validation', 'error.validation', undefined,
      errors as Record<string, string[]>, params),
  unprocessable: (detail: Meldung, params?: MessageParams) =>
    new AppError(422, 'urn:hotelpms:unprocessable', 'error.unprocessable',
      detail, undefined, params),
  soldOut: () =>
    new AppError(409, 'urn:hotelpms:sold_out', 'error.soldOut', 'error.soldOut.detail'),
  notMaterialized: () =>
    new AppError(503, 'urn:hotelpms:not_materialized', 'error.notMaterialized',
      'error.notMaterialized.detail'),
  rangeTooLarge: (max: number) =>
    new AppError(422, 'urn:hotelpms:range_too_large', 'error.rangeTooLarge',
      'error.rangeTooLarge.detail', undefined, { max }),
  idempotencyMismatch: () =>
    new AppError(422, 'urn:hotelpms:idempotency_mismatch', 'error.idempotencyMismatch',
      'error.idempotencyMismatch.detail'),
  idempotencyInFlight: () =>
    new AppError(409, 'urn:hotelpms:idempotency_in_flight', 'error.idempotencyInFlight',
      'error.idempotencyInFlight.detail'),
  notConfigured: (detail: Meldung, params?: MessageParams) =>
    new AppError(503, 'urn:hotelpms:not_configured', 'error.notConfigured',
      detail, undefined, params),
  invalidSignature: (detail: Meldung, params?: MessageParams) =>
    new AppError(400, 'urn:hotelpms:invalid_signature', 'error.invalidSignature',
      detail, undefined, params),
  // Der Beleg entsteht nach dem Festschreiben im Worker, nicht in derselben
  // Transaktion: die haelt die Zaehlerzeile der Rechnungsnummer gesperrt.
  // Ein eigener Fehlertyp, damit die Oberflaeche zwischen "gibt es nicht"
  // und "kommt gleich" unterscheiden kann.
  documentPending: () =>
    new AppError(409, 'urn:hotelpms:document_pending', 'error.documentPending',
      'error.documentPending.detail')
}
