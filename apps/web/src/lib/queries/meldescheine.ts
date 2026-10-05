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
  useQuery<{ registrations: Meldeschein[] }>({
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
