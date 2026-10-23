import { DomainError } from '@hotelpms/domain'
import { Errors, type Meldung } from './errors.js'

/**
 * Uebersetzt einen fachlichen Fehler aus `@hotelpms/domain` in die Antwort
 * der API. Der Schluessel ist derselbe; nur die Huelle ist eine andere.
 */
export function apiFehler(e: DomainError): Error {
  const key = e.key as Meldung
  switch (e.kind) {
    case 'validation':
      return Errors.validation((e.fields ?? {}) as Record<string, Meldung[]>, e.params)
    case 'conflict': return Errors.conflict(key, e.params)
    case 'notFound': return Errors.notFound(key, e.params)
    case 'unprocessable': return Errors.unprocessable(key, e.params)
    case 'notMaterialized': return Errors.notMaterialized()
  }
}

export function alsApiFehler<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    throw e instanceof DomainError ? apiFehler(e) : e
  }
}

export async function alsApiFehlerAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    throw e instanceof DomainError ? apiFehler(e) : e
  }
}
