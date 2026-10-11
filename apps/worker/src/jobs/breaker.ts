/**
 * Sicherung gegen einen ausgefallenen Anbieter, je Tick (Performance-Audit
 * 11.10.2026, Befund 9).
 *
 * Die Haeuser laufen im Tick nacheinander. Ist Brevo oder DeepL tot, wartete
 * bisher jede einzelne Nachricht ihre volle Zeitgrenze ab -- 25 x 15 s je
 * Haus mit offener Post, und das fuer jedes Haus. Fuenfhundert Haeuser
 * stuenden damit hinter einem Anbieter, der ohnehin nicht antwortet, und
 * der Nachtlauf des letzten Hauses kaeme Stunden zu spaet.
 *
 * Eine Sicherung je Anbieter und Tick, geteilt ueber alle Haeuser: nach
 * `threshold` Fehlern in Folge, die am Anbieter liegen (Zeitueberschreitung,
 * Netz, 5xx, Ueberlast), wird er fuer den Rest des Ticks nicht mehr
 * gefragt. Ein Erfolg setzt den Zaehler zurueck -- einzelne Aussetzer
 * sollen nicht abschalten. Der naechste Tick beginnt mit einer neuen
 * Sicherung; mehr Zustand braucht es nicht, denn fuenf Minuten Pause sind
 * genau der Abstand, in dem man es wieder versuchen will.
 *
 * Bewusst nicht gezaehlt: eine abgelehnte Adresse oder ein falscher
 * Schluessel. Das liegt an der einzelnen Nachricht oder ist dauerhaft, und
 * in beiden Faellen kostet es keine Wartezeit.
 */
export class TickBreaker {
  private inFolge = 0
  private ausgeloest = false

  constructor(readonly threshold = 3) {}

  /** Ausgeloest: der Anbieter wird in diesem Tick nicht mehr gefragt. */
  tripped(): boolean { return this.ausgeloest }

  success(): void { this.inFolge = 0 }

  failure(): void {
    this.inFolge += 1
    if (this.inFolge >= this.threshold) this.ausgeloest = true
  }
}
