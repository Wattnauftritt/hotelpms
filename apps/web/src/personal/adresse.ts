/**
 * Welche Seite der Personal-App in der Adresse steht.
 *
 * Ohne React und ohne `location` als feste Groesse, damit die Auswertung
 * pruefbar ist: ein falsch gelesener Pfad schickte die Rezeption in die
 * Personal-App oder das Personal in die Rezeption.
 */
export type PersonalSeite =
  | { art: 'app' }
  | { art: 'einladung' | 'kennwort'; token: string | null }

/** Gehoert der Pfad zur Personal-App? `/personalien` gehoert nicht dazu. */
export function istPersonalAdresse(pathname: string): boolean {
  return pathname === '/personal' || pathname.startsWith('/personal/')
}

export function personalSeite(pathname: string, search: string): PersonalSeite {
  // Abschliessende Schraegstriche weg, wie in `routes/Zugang.tsx`: ein
  // Messenger haengt gern einen an.
  const pfad = pathname.replace(/\/+$/, '')
  const art = pfad === '/personal/einladung' ? 'einladung'
    : pfad === '/personal/kennwort' ? 'kennwort'
    : null
  if (art === null) return { art: 'app' }
  const token = new URLSearchParams(search).get('token')
  return { art, token: token !== null && token.length > 0 ? token : null }
}
