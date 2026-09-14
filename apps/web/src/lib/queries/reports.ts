import { useQuery, useMutation } from '@tanstack/react-query'
import type { KpiReport, NightAuditStatus, AccommodationStatistics }
  from '@hotelpms/contracts'
import { api, ApiError } from '../api.js'

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
  const res = await fetch(pfad, { credentials: 'same-origin' })
  if (!res.ok) {
    const text = await res.text()
    let problem: unknown = null
    try { problem = JSON.parse(text) } catch { /* kein RFC-9457-Rumpf */ }
    throw new ApiError(
      problem !== null && typeof problem === 'object' && 'title' in problem
        ? problem as ApiError['problem']
        : { type: 'urn:hotelpms:unknown', title: res.statusText, status: res.status },
      res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname
  a.click()
  // Ohne Freigabe bleibt der ganze Export im Speicher des Fensters liegen,
  // und ein Mandantenexport ist kein kleiner Rumpf. Erst nach dem
  // Durchlauf der Ereignisschleife: wer die Adresse im selben Zug
  // freigibt, nimmt dem Browser die Datei unter dem noch nicht
  // begonnenen Download weg.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

export const useAusgabe = () => useMutation({ mutationFn: holeDatei })
