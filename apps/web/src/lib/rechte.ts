import { useQuery } from '@tanstack/react-query'
import { api } from './api.js'

/**
 * Die Rechte des angemeldeten Benutzers in einem Haus.
 *
 * `screens.tsx` traegt **ein** Recht je Bildschirm, und das genuegt fuer die
 * Navigation. Ein Bildschirm, der mehrere Bereiche buendelt, braucht mehr:
 * die Berichte zeigen Betrieb (`report:operational`), Umsatz
 * (`report:revenue`) und Ausgaben (`report:export`), und eine Rezeption hat
 * das erste, aber nicht die beiden anderen. Ohne diese Unterscheidung
 * bestuende ihr Bildschirm zu zwei Dritteln aus 403.
 *
 * Das ist **keine** Sicherheitsmassnahme -- die liegt in der API und nirgends
 * sonst. Hier geht es darum, keinen Knopf zu zeigen, der nicht gedrueckt
 * werden darf.
 *
 * Die Abfrage teilt den Schluessel mit der Anmeldung in `main.tsx`: sie ist
 * beim Aufruf eines Bildschirms laengst geladen und kostet keine zweite Runde.
 */

export interface Konto {
  userId: number
  displayName: string
  /** Rechte auf Betriebsebene (Inhaber, Buchhaltung ...). Haengen an keinem Haus. */
  accountPermissions: string[]
  properties: Array<{ id: number; code: string; name: string; isTraining: boolean
                      permissions: string[] }>
}

export interface Hausrechte {
  /** Hat der Benutzer dieses Recht in diesem Haus? */
  darf: (permission: string) => boolean
  /**
   * Hat der Benutzer dieses Recht auf Betriebsebene? Die Benutzerverwaltung
   * braucht beides: wer ein Haus fuehrt, vergibt Rollen im Haus; wer den
   * Betrieb verwaltet, vergibt Rollen fuer den Betrieb (Inhaber,
   * Buchhaltung) -- und nur der darf jemanden mit einer solchen Rolle
   * sperren oder entfernen.
   */
  darfKonto: (permission: string) => boolean
  /** Ein Uebungshaus exportiert nicht nach draussen (C11, Dokument 13). */
  isTraining: boolean
  geladen: boolean
}

/**
 * Alle Haeuser, in denen der Benutzer ein bestimmtes Recht hat.
 *
 * Fuer Bildschirme, die ein Haus **waehlen** lassen statt das aus der
 * Kopfzeile zu nehmen -- die Datenuebernahme etwa, bei der ein falsches
 * Haus drei Jahre Buchungen an die falsche Stelle schreibt. `undefined`,
 * solange nichts geladen ist.
 */
export function useHaeuserMitRecht(
  permission: string
): Array<{ id: number; code: string; name: string }> | undefined {
  const me = useQuery<Konto>({
    queryKey: ['me'],
    queryFn: () => api.get<Konto>('/v1/auth/me'),
    retry: false
  })
  return me.data?.properties
    .filter(p => p.permissions.includes(permission))
    .map(p => ({ id: p.id, code: p.code, name: p.name }))
}

export function useHausrechte(propertyId: number): Hausrechte {
  const me = useQuery<Konto>({
    queryKey: ['me'],
    queryFn: () => api.get<Konto>('/v1/auth/me'),
    retry: false
  })
  const haus = me.data?.properties.find(p => p.id === propertyId)
  return {
    // Solange nichts geladen ist, wird nichts erlaubt. Der umgekehrte Weg
    // zeigte fuer einen Moment Knoepfe, die gleich darauf verschwinden.
    darf: (permission: string) => haus?.permissions.includes(permission) ?? false,
    darfKonto: (permission: string) =>
      me.data?.accountPermissions.includes(permission) ?? false,
    isTraining: haus?.isTraining ?? false,
    geladen: me.isSuccess
  }
}
