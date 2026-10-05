import { useEffect, useRef, useState } from 'react'
import { LOCALES, textFor, useLocale, type Locale, type TextKey } from '../lib/i18n/index.js'
import { EBENEN, einfuegen, grossSchreiben, loeschen, startEbene,
         type Ebene, type Feldstand, type Taste } from '../lib/bildschirmtastatur.js'

/**
 * Die Bildschirmtastatur des Gaesteterminals (Dokument 31, Abschnitt 4).
 *
 * Sie haengt einmal an der Terminalseite, nicht an jedem Feld: jedes
 * Textfeld, das dort den Fokus bekommt, holt sie -- im Meldeformular, an
 * der Kopplung, und in jeder Ansicht, die spaeter dazukommt, ohne dass
 * jemand daran denken muss.
 *
 * - **Die Systemtastatur bleibt zu.** Ein fokussiertes Feld bekommt
 *   `inputmode="none"`; sonst schoebe Windows im Tabletmodus seine eigene
 *   Tastatur ueber unsere. Was das Feld vorher wollte (`numeric`), merkt
 *   sich `data-osk-modus` und bestimmt die erste Ebene.
 * - **Der Fokus bleibt im Feld.** Ein `mousedown` auf eine Taste wird
 *   verworfen, also wandert der Fokus nicht auf den Knopf, und die
 *   Schreibmarke steht danach, wo sie stand.
 * - **React bekommt den Wert mit.** Ein schlichtes `el.value = …` sieht
 *   React nicht: es merkt sich den Wert selbst und verwirft beim naechsten
 *   Zeichnen, was daneben geschrieben wurde. Der Wert geht deshalb ueber den
 *   Setter des Prototyps, danach ein `input`-Ereignis -- derselbe Weg, den
 *   der Browser beim Tippen nimmt.
 * - **Das Feld bleibt sichtbar.** Solange sie offen ist, haelt ein
 *   Platzhalter unter der Seite ihre Hoehe frei, und das Feld wird in die
 *   Mitte gerollt; das Adminpanel macht es mit einem Polster ebenso.
 * - **Sie haelt nichts.** Kein eigener Text, kein Verlauf: was getippt
 *   wurde, steht nur im Feld, und mit dem Neuaufbau nach dem Auftrag ist
 *   es weg.
 *
 * **Die Grenze:** in einer freigegebenen fremden Seite (`url`) erreicht sie
 *   kein Feld -- deren Inhalt liegt in einer anderen Herkunft und ist fuer
 *   diese Seite unsichtbar, mit Absicht.
 */
export function Bildschirmtastatur(): JSX.Element {
  const terminalSprache = useLocale()
  const feld = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const tafel = useRef<HTMLDivElement | null>(null)
  const [offen, setOffen] = useState(false)
  const [ebene, setEbene] = useState<Ebene>('buchstaben')
  const [gross, setGross] = useState(false)
  // Die Sprache des Feldes, nicht der Seite: das Meldeformular fuehrt eine
  // eigene Sprachwahl, und die Tasten sollen sprechen wie das Formular.
  const [sprache, setSprache] = useState<Locale>(terminalSprache)
  const [hoehe, setHoehe] = useState(0)

  useEffect(() => {
    const fokus = (e: FocusEvent): void => {
      const el = e.target
      if (!istTextfeld(el)) return
      if (el.dataset.oskModus === undefined) {
        el.dataset.oskModus = el.inputMode
        el.inputMode = 'none'
      }
      feld.current = el
      setEbene(startEbene(el.dataset.oskModus))
      setGross(false)
      setSprache(spracheVon(el, terminalSprache))
      setOffen(true)
    }
    const weg = (): void => {
      // Erst nach dem Wechsel steht fest, wohin der Fokus ging: in ein
      // anderes Textfeld bleibt sie offen, auf eine Auswahl oder ins Leere
      // geht sie zu.
      window.setTimeout(() => {
        if (!istTextfeld(document.activeElement)) {
          feld.current = null
          setOffen(false)
        }
      }, 0)
    }
    document.addEventListener('focusin', fokus)
    document.addEventListener('focusout', weg)
    return () => {
      document.removeEventListener('focusin', fokus)
      document.removeEventListener('focusout', weg)
    }
  }, [terminalSprache])

  // Hoehe freihalten und das Feld in die Mitte holen, sobald sie steht.
  useEffect(() => {
    if (!offen) { setHoehe(0); return }
    const h = tafel.current?.offsetHeight ?? 0
    setHoehe(h)
    const z = window.setTimeout(() => {
      feld.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
    return () => window.clearTimeout(z)
  }, [offen, ebene])

  const t = (key: TextKey): string => textFor(key, sprache)

  const druecken = (taste: Taste): void => {
    const el = feld.current
    if (el === null) return
    switch (taste.art) {
      case 'umschalten': setGross(g => !g); return
      case 'ebene': setEbene(taste.ziel ?? 'buchstaben'); setGross(false); return
      case 'weiter': weiter(el); return
      case 'loeschen': schreiben(el, loeschen(stand(el))); return
      case 'text': {
        const zeichen = gross ? grossSchreiben(taste.zeichen) : taste.zeichen
        schreiben(el, einfuegen(stand(el), zeichen, el.maxLength))
        // Wie das Adminpanel: Umschalten gilt fuer einen Buchstaben.
        setGross(false)
      }
    }
  }

  const beschriftung = (taste: Taste): string => {
    switch (taste.art) {
      case 'loeschen': return t('kiosk.keyboard.backspace')
      case 'weiter': return t('kiosk.keyboard.next')
      case 'umschalten': return t('kiosk.keyboard.shift')
      case 'ebene': return t(taste.ziel === 'akzente' ? 'kiosk.keyboard.accents'
                                                      : 'kiosk.keyboard.letters')
      case 'text': return taste.zeichen === ' ' ? t('kiosk.keyboard.space') : ''
    }
  }

  return (
    <>
      {/* Platzhalter: so weit laesst sich die Seite unter die Tastatur rollen. */}
      <div aria-hidden style={{ height: hoehe }} />
      {offen && (
        <div ref={tafel} role="group" aria-label={t('kiosk.keyboard.title')}
             onMouseDown={e => e.preventDefault()}
             className="fixed inset-x-0 bottom-0 z-50 select-none border-t-2 border-neutral-300
                        bg-neutral-100 px-2 pt-2 pb-3 shadow-[0_-6px_24px_rgba(0,0,0,.18)]">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-sm text-neutral-500">{t('kiosk.keyboard.title')}</span>
            <button type="button" tabIndex={-1}
                    onClick={() => { feld.current?.blur(); setOffen(false) }}
                    className="rounded-lg bg-neutral-200 px-4 py-1.5 text-lg text-neutral-700
                               touch-manipulation active:bg-neutral-300">
              ✕ {t('kiosk.keyboard.close')}
            </button>
          </div>
          <div className="space-y-1.5">
            {EBENEN[ebene].map((reihe, i) => (
              <div key={`${ebene}-${i}`} className="flex justify-center gap-1.5">
                {reihe.map((taste, j) => {
                  const zeichen = taste.art === 'text' && gross
                    ? grossSchreiben(taste.zeichen) : taste.zeichen
                  const name = beschriftung(taste)
                  return (
                    <button key={j} type="button" tabIndex={-1}
                            aria-label={name === '' ? zeichen : name}
                            aria-pressed={taste.art === 'umschalten' ? gross : undefined}
                            onClick={() => druecken(taste)}
                            style={{ flex: taste.breite ?? 1,
                                     maxWidth: `${(taste.breite ?? 1) * 88}px` }}
                            className={tastenKlasse(taste, gross)}>
                      {taste.zeichen === ' ' ? name : zeichen}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function tastenKlasse(taste: Taste, gross: boolean): string {
  const grund = `h-16 min-w-0 rounded-lg border border-b-[3px] text-2xl touch-manipulation
    active:translate-y-0.5 active:border-b`
  if (taste.art === 'loeschen') {
    return `${grund} border-red-300 border-b-red-400 bg-red-100 text-red-800 active:bg-red-200`
  }
  if (taste.art === 'text') {
    return `${grund} border-neutral-300 border-b-neutral-400 bg-white text-neutral-900
      active:bg-neutral-200 ${taste.zeichen === ' ' ? 'text-base text-neutral-500' : ''}`
  }
  const an = taste.art === 'umschalten' && gross
  return `${grund} text-xl ${an
    ? 'border-blue-500 border-b-blue-600 bg-blue-200 text-blue-800'
    : 'border-blue-300 border-b-blue-400 bg-blue-100 text-blue-700'} active:bg-blue-200`
}

type Textfeld = HTMLInputElement | HTMLTextAreaElement

/** Ein Feld, in das sich Text tippen laesst. Datum, Haken, Auswahl nicht. */
const TEXTARTEN = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password'])
function istTextfeld(el: EventTarget | Element | null): el is Textfeld {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  return el instanceof HTMLInputElement && TEXTARTEN.has(el.type)
    && !el.disabled && !el.readOnly
}

function spracheVon(el: Element, sonst: Locale): Locale {
  const lang = el.closest('[lang]')?.getAttribute('lang')?.slice(0, 2)
  return (LOCALES as readonly string[]).includes(lang ?? '') ? lang as Locale : sonst
}

/**
 * Wo die Schreibmarke steht. `email` und `number` geben keine Auswahl her
 * (`selectionStart` ist dort `null`); dann wird hinten angefuegt, wie man
 * dort ohnehin tippt.
 */
function stand(el: Textfeld): Feldstand {
  const ende = el.value.length
  return { wert: el.value, anfang: el.selectionStart ?? ende, ende: el.selectionEnd ?? ende }
}

function schreiben(el: Textfeld, f: Feldstand): void {
  if (f.wert === el.value) return
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, f.wert)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  try { el.setSelectionRange(f.anfang, f.ende) } catch { /* email, number: ohne Marke */ }
}

/**
 * Ins naechste sichtbare Textfeld, am letzten zu. Abgeschickt wird nicht:
 * am Meldeformular haengen Haken und Unterschrift, und ein Tippen auf
 * "Weiter" soll den Gast nicht vor eine Fehlermeldung stellen.
 */
function weiter(el: Textfeld): void {
  const felder = [...document.querySelectorAll<HTMLElement>('input, textarea')]
    .filter((f): f is Textfeld => istTextfeld(f) && f.offsetParent !== null)
  const naechstes = felder[felder.indexOf(el) + 1]
  if (naechstes !== undefined) naechstes.focus()
  else el.blur()
}
