import { useEffect, useState } from 'react'
import { nativ } from '@hotelpms/native'

/**
 * Ob die App im Store aktualisiert werden muss (Plan app/plan.md §4).
 *
 * Die Huelle laedt neue Staende der Oberflaeche selbst vom Server. Braucht
 * ein Stand eine neuere Huelle, als auf dem Telefon liegt, bleibt die App
 * beim alten und meldet das hier; im Browser und in einer Huelle ohne
 * Aktualisierung bleibt es `false`.
 */
export function useStoreNoetig(): boolean {
  const [noetig, setNoetig] = useState(false)
  useEffect(() => {
    let aktiv = true
    nativ()?.aktualisierung?.storeNoetig(() => { if (aktiv) setNoetig(true) })
    return () => { aktiv = false }
  }, [])
  return noetig
}
