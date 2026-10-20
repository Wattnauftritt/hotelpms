import { nativ } from '@hotelpms/native'
import { ApiError, apiFetch } from './api.js'

/**
 * Eine Datei an den Benutzer geben, im Browser und in der App.
 *
 * Im Browser wie bisher als Download ueber einen Blob. In der App laedt die
 * WebView nichts herunter, und ein PDF im `iframe` zeigt Android nicht an;
 * dort oeffnet die Huelle die Datei in der Vorschau des Telefons, von wo
 * sie sich teilen, drucken und sichern laesst (Plan app/plan.md). Eine
 * Huelle ohne `datei` faellt auf den Weg des Browsers zurueck, wie vorher.
 */
export async function dateiGeben(blob: Blob, name: string): Promise<void> {
  const datei = nativ()?.datei
  if (datei !== undefined) {
    await datei.oeffnen(blob, name)
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Erst nach dem Durchlauf der Ereignisschleife: wer die Adresse im
  // selben Zug freigibt, nimmt dem Browser die Datei unter dem noch nicht
  // begonnenen Download weg.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/** Ob Dateien ueber die Huelle gehen statt ueber Adressen der Schnittstelle. */
export function dateienUeberApp(): boolean {
  return nativ()?.datei !== undefined
}

/**
 * Eine Datei der Schnittstelle holen. Ein Fehler kommt als `ApiError` mit
 * dem Rumpf nach RFC 9457, damit er am Knopf als Meldung steht und nicht
 * als leere Datei.
 */
export async function holeApiDatei(pfad: string): Promise<Response> {
  const res = await apiFetch(pfad)
  if (res.ok) return res
  let problem: unknown = null
  try { problem = JSON.parse(await res.text()) } catch { /* kein RFC-9457-Rumpf */ }
  throw new ApiError(
    problem !== null && typeof problem === 'object' && 'title' in problem
      ? problem as ApiError['problem']
      : { type: 'urn:staygrid:unknown', title: res.statusText, status: res.status },
    res.status)
}

/** Der Dateiname aus `Content-Disposition`, sonst der mitgegebene. */
export function dateinameAus(res: Response, sonst: string): string {
  return /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? sonst
}
