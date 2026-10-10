import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

/**
 * Meldescheine eines Zeitraums, nach Anreise (Bildschirm „Meldescheine").
 *
 * Ein Aufruf für die ganze Liste: Mitreisende kommen als eigene Zeilen mit
 * `groupRegistrationId` und werden hier unter den Hauptschein gehängt,
 * nicht je Schein nachgeladen.
 */
export interface Meldeschein {
  id: number
  arrival: string
  plannedDeparture: string
  occupantCount: number
  isForeign: boolean
  signed: boolean
  signatureRequired: boolean
  source: 'desk' | 'online' | 'terminal' | 'import'
  externalSystem: string | null
  completedAt: string
  avsReportedAt: string | null
  avsExportedHere: boolean
  destroyAfter: string
  groupRegistrationId: number | null
  lastName: string
  firstName: string | null
  nationality: string | null
  city: string | null
  country: string | null
  reservationRef: string
  /** Befreiungsgrund fuer die Kurtaxe, wie das Haus ihn benennt. */
  taxExemption: string | null
}

/** Wie in `routes/registrations.ts`. */
export const MAX_MELDESCHEIN_TAGE = 800

export const useMeldescheine = (propertyId: number, von: string, bis: string) =>
  useQuery<{ registrations: Meldeschein[]; avsReporting: boolean }>({
    queryKey: ['meldescheine', propertyId, von, bis],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/registrations?from=${von}&to=${bis}`)
  })

export interface Hauptschein extends Meldeschein { mitreisende: Meldeschein[] }

/** Mitreisende unter ihren Hauptschein; ein verwaister bleibt eigene Zeile. */
export function nachHauptschein(liste: readonly Meldeschein[]): Hauptschein[] {
  const haupt = new Map<number, Hauptschein>()
  for (const r of liste) {
    if (r.groupRegistrationId === null) haupt.set(Number(r.id), { ...r, mitreisende: [] })
  }
  const ohne: Hauptschein[] = []
  for (const r of liste) {
    if (r.groupRegistrationId === null) continue
    const h = haupt.get(Number(r.groupRegistrationId))
    if (h === undefined) ohne.push({ ...r, mitreisende: [] })
    else h.mitreisende.push(r)
  }
  return [...haupt.values(), ...ohne]
}

/** Eine Person auf dem Schein: der Hauptgast zuerst, dann die Mitreisenden. */
export interface MeldescheinPerson {
  main: boolean
  guestRef: string
  lastName: string
  firstName: string | null
  birthDate: string | null
  nationality: string | null
  address: { line1: string | null; postalCode: string | null
             city: string | null; country: string | null }
  idDocumentType: string | null
  hasIdDocumentNumber: boolean
  taxExemption: string | null
  taxExemptionProof: string | null
}

export interface MeldescheinInhalt {
  id: number
  reservationRef: string
  arrival: string
  plannedDeparture: string
  occupantCount: number
  isForeign: boolean
  signatureRequired: boolean
  signedAt: string | null
  /** Nur in der Form der Gastwege, sonst `null` (siehe Route). */
  signatureSvg: string | null
  source: Meldeschein['source']
  externalSystem: string | null
  completedAt: string
  avsReportedAt: string | null
  destroyAfter: string
  expectedArrival: string | null
  digitalGuestCard: boolean
  persons: MeldescheinPerson[]
}

/**
 * Ein Schein mit Inhalt, erst beim Oeffnen geladen: die Liste bleibt ein
 * Aufruf, und Geburtsdaten und Anschriften stehen nicht in einer Uebersicht.
 */
export const useMeldeschein = (id: number | null) =>
  useQuery<MeldescheinInhalt>({
    queryKey: ['meldeschein', id],
    queryFn: () => api.get(`/v1/registrations/${id!}`),
    enabled: id !== null
  })
