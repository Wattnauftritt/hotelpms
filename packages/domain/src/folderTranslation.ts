import { FOLDER_LOCALES, type FolderLocale } from '@hotelpms/contracts'

/**
 * Hausseiten der Gaestemappe uebersetzen (Migration 0144).
 *
 * Nur das Reine: wie eine Seite zu DeepL geht und wie sie zurueckkommt. Der
 * Netzaufruf und die Auftraege stehen im Worker.
 *
 * **Warum nicht der rohe Text.** Eine Seite hat ein kleines Format
 * (`Inhaltstext.tsx`): Leerzeilen trennen Absaetze, `- ` beginnt eine
 * Aufzaehlung, `**so**` ist fett. Als Klartext geschickt, verschiebt DeepL die
 * Sternchen in die Satzmitte, setzt ein Leerzeichen hinein oder laesst eines
 * weg -- und auf dem Telefon stehen dann zwei Sternchen statt Fettschrift.
 * Deshalb geht jede Zeile als eigenes Element hinaus, Fettes als `<b>`, mit
 * `tag_handling=xml`. Elemente laesst DeepL stehen und uebersetzt nur, was
 * dazwischen steht.
 */

/**
 * Die Sprachen der Mappe ohne die Vorlage, wie in Migration 0145. Aus
 * `FOLDER_LOCALES` abgeleitet und nicht daneben aufgeschrieben: eine Sprache,
 * die die Mappe anbietet, aber nicht uebersetzt, zeigt dem Gast seine
 * Sprachwahl und darunter die deutsche Seite.
 */
export const FOLDER_TRANSLATION_LANGS =
  FOLDER_LOCALES.filter((l): l is Exclude<FolderLocale, 'de'> => l !== 'de')
export type FolderTranslationLang = Exclude<FolderLocale, 'de'>

function maskieren(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function demaskieren(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** `**x**` wird `<b>x</b>`, wie `fett()` in der Oberflaeche es liest. */
function zeileNachXml(zeile: string): string {
  return zeile.split(/(\*\*[^*]+\*\*)/g).map(teil =>
    teil.startsWith('**') && teil.endsWith('**') && teil.length > 4
      ? `<b>${maskieren(teil.slice(2, -2))}</b>`
      : maskieren(teil)).join('')
}

/**
 * Eine Seite als XML fuer DeepL. Jede Zeile ein `<z>`; eine Zeile der
 * Aufzaehlung traegt `l="1"`, damit `- ` nicht mituebersetzt wird (ein
 * Gedankenstrich am Zeilenanfang wird im Polnischen gern zu einem anderen).
 * Leerzeilen bleiben leere Elemente, damit die Absaetze stehen bleiben.
 */
export function folderTextToDeeplXml(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(zeile => {
    const rest = zeile.trimStart()
    if (rest.startsWith('- ')) return `<z l="1">${zeileNachXml(rest.slice(2))}</z>`
    return `<z>${zeileNachXml(zeile)}</z>`
  }).join('\n')
}

/**
 * Zurueck ins Format der Seite. `null`, wenn die Antwort nicht Zeile fuer
 * Zeile zur Anfrage passt: dann lieber spaeter noch einmal als eine Seite,
 * deren Aufzaehlung mitten im Absatz steht.
 */
export function folderTextFromDeeplXml(xml: string, zeilen: number): string | null {
  const treffer = [...xml.matchAll(/<z( l="1")?>([\s\S]*?)<\/z>/g)]
  if (treffer.length !== zeilen) return null
  return treffer.map(([, liste, inhalt]) => {
    const text = (inhalt ?? '').replace(/<b>([\s\S]*?)<\/b>/g, (_, f: string) =>
      f.trim() === '' ? f : `**${f.trim()}**`)
    // Ein Element, das DeepL hinzugefuegt haette, kommt als Text nicht durch.
    const sauber = demaskieren(text.replace(/<[^>]*>/g, '')).replace(/\n/g, ' ')
    return liste === undefined ? sauber : `- ${sauber.trimStart()}`
  }).join('\n')
}

/** Wie viele Zeilen `folderTextToDeeplXml` aus einem Text macht. */
export function folderTextLines(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').length
}
