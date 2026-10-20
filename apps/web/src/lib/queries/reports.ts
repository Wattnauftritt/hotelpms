import { useQuery, useMutation } from '@tanstack/react-query'
import type { KpiReport, NightAuditStatus, AccommodationStatistics }
  from '@hotelpms/contracts'
import { api } from '../api.js'
import { dateiGeben, holeApiDatei } from '../datei.js'

/**
 * Abfragen der Berichte.
 *
 * **Ein Aufruf je Bildschirm.** Der Vorjahresvergleich kommt im selben
 * Aufruf mit (`compare=previous-year`) statt als zweite Anfrage; der
 * Nachtlauf-Stand bringt Schritte und Tageskennzahlen als Feld mit, nicht
 * als eine Nachfrage je Tag.
 *
 * **Kein Zwischenspeicher fuer die Offline-Ansicht.** Ein Bericht ist keine
 * Betriebsliste: wer bei Netzausfall eine alte Belegungszahl sieht, trifft
 * daran eine Entscheidung, die auf einem Stand von gestern beruht. Die
 * Anreiseliste braucht das, eine Kennzahl nicht.
 */

export const useKpi = (
  propertyId: number, from: string, to: string, vergleich: boolean
) =>
  useQuery<KpiReport>({
    queryKey: ['kpi', propertyId, from, to, vergleich],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/kpi?from=${from}&to=${to}`
      + (vergleich ? '&compare=previous-year' : '')),
    retry: false
  })

export const useNightAuditStatus = (propertyId: number, tage = 14) =>
  useQuery<NightAuditStatus>({
    queryKey: ['nightAudit', propertyId, tage],
    queryFn: () => api.get(`/v1/properties/${propertyId}/night-audit-status?days=${tage}`),
    // Ein Rueckstand entsteht ueber Nacht, nicht ueber Minuten.
    staleTime: 5 * 60_000,
    retry: false
  })

export const useAccommodationStatistics = (
  propertyId: number, month: string, aktiv: boolean
) =>
  useQuery<AccommodationStatistics>({
    queryKey: ['beherbergung', propertyId, month],
    queryFn: () => api.get(
      `/v1/properties/${propertyId}/accommodation-statistics?month=${month}`),
    enabled: aktiv,
    retry: false
  })

/**
 * Eine Ausgabe holen und dem Betrachter geben.
 *
 * Bewusst ueber `fetch` und nicht ueber einen Verweis mit `download`: bei
 * einem Verweis wandert ein Fehler in ein leeres Browserfenster, und das
 * Uebungshaus wird mit 422 abgewiesen. So steht die Meldung am Knopf.
 *
 * Der Aufruf laeuft neben der Oberflaeche: der Rest des Bildschirms bleibt
 * waehrenddessen bedienbar, und ein Export ueber ein Jahr dauert.
 */
export interface Ausgabe { pfad: string; dateiname: string }

async function holeDatei({ pfad, dateiname }: Ausgabe): Promise<void> {
  const res = await holeApiDatei(pfad)
  await dateiGeben(await res.blob(), dateiname)
}

export const useAusgabe = () => useMutation({ mutationFn: holeDatei })
