import { useEffect, useRef } from 'react'

/**
 * Tastenregeln, die mehr als ein Bildschirm braucht.
 *
 * Beides steht hier, weil beides dieselbe Frage beantwortet: **wen** meint
 * der Druck. Bei Escape ist es die oberste Lage, bei Enter und Strg+Z das
 * Feld, in dem gerade jemand tippt.
 */

/**
 * Tippt hier jemand Text?
 *
 * Dann gehoeren Enter und Strg+Z dem Feld und nicht dem Bildschirm
 * dahinter. Ein Ankreuzfeld ist ausdruecklich **kein** Textfeld: der
 * Planungsmodus ist eines, es behaelt nach dem Klick den Fokus, und mit
 * einer Pruefung auf `HTMLInputElement` allein war Strg+Z danach tot --
 * also genau dort, wo man es am noetigsten braucht.
 */
const OHNE_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset',
                           'range', 'color', 'file', 'image'])

export function istTextEingabe(ziel: EventTarget | null): boolean {
  if (ziel instanceof HTMLTextAreaElement) return true
  if (ziel instanceof HTMLElement && ziel.isContentEditable) return true
  if (ziel instanceof HTMLInputElement) return !OHNE_TEXT.has(ziel.type)
  return false
}

/**
 * Escape ist ueberall der Weg hinaus -- und schliesst genau **eine** Lage.
 *
 * **Warum ueberhaupt gemeinsam.** Jede Maske, jedes Menue und jede
 * Markierung horchte fuer sich am Fenster. Solange nur eines offen war,
 * ging das gut; sobald zwei uebereinanderlagen, schlossen sie bei einem
 * Druck beide. Wer im Plan drei Zimmer markiert, das Kontextmenue oeffnet
 * und Escape drueckt, wollte das Menue weg -- und stand danach ohne
 * Markierung da, ohne zu wissen, warum.
 *
 * **Deshalb ein Stapel.** Wer sich zuletzt angemeldet hat, liegt oben und
 * bekommt den Druck; alles darunter bleibt, wie es ist. Das ist dieselbe
 * Reihenfolge, in der die Dinge auf dem Bildschirm liegen, weil React die
 * spaeter eingehaengte Lage auch spaeter anmeldet. Ein zweites Escape
 * nimmt die naechste.
 *
 * **Nur ein Horcher am Fenster**, nicht einer je Lage: das ist nicht die
 * Ersparnis, sondern die einzige Stelle, an der die Reihenfolge
 * entschieden wird. Zwanzig Horcher entscheiden sie gar nicht.
 */

const stapel: Array<() => void> = []
let horcht = false

function aufTaste(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const oben = stapel[stapel.length - 1]
  if (oben === undefined) return
  e.preventDefault()
  oben()
}

/**
 * Meldet `onEscape` als oberste Lage an, solange `aktiv` gilt.
 *
 * `aktiv` statt eines `if` an der Aufrufstelle, weil Hooks nicht in
 * Bedingungen stehen -- und weil eine Maske, die nur eingehaengt ist, aber
 * nichts zeigt (eine geschlossene Klappliste), den Druck nicht schlucken
 * darf.
 *
 * Der Rueckruf liegt in einem `ref` und die Anmeldung haengt nur an
 * `aktiv`: sonst meldete sich die Lage bei jedem Bild neu an und legte
 * sich damit **ueber** eine Maske, die laengst darueber liegt.
 */
export function useEscape(onEscape: () => void, aktiv = true): void {
  const halter = useRef(onEscape)
  halter.current = onEscape

  useEffect(() => {
    if (!aktiv) return
    const eintrag = (): void => halter.current()
    stapel.push(eintrag)
    if (!horcht) {
      window.addEventListener('keydown', aufTaste)
      horcht = true
    }
    return () => {
      const i = stapel.lastIndexOf(eintrag)
      if (i !== -1) stapel.splice(i, 1)
    }
  }, [aktiv])
}
