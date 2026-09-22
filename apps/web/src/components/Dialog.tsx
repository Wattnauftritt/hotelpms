import { useEffect, type JSX, type ReactNode } from 'react'
import { useT } from '../lib/i18n/index.js'

/**
 * Der Rahmen jeder Maske: Kopf, Rumpf, Fuss.
 *
 * **Warum es ihn gibt.** Jede Maske hatte ihren eigenen Rahmen, und alle
 * waren `max-w-md` -- 448 Pixel, auf einem Rezeptionsbildschirm etwa ein
 * Fuenftel der Breite. Die Folge war ueberall dieselbe: Felder, die
 * untereinander stehen, obwohl sie zusammengehoeren, eine Gruppenbuchung
 * mit acht Zimmern als lange Rolle, und die Knoepfe irgendwo darunter.
 * Der Platz war da, er wurde nur nicht genommen.
 *
 * **Kopf und Fuss bleiben stehen, der Rumpf rollt.** Vorher rollte der
 * ganze Kasten, und bei einer langen Maske standen "Buchen" und
 * "Schliessen" unterhalb des sichtbaren Bereichs. Wer eine Maske fuer
 * fertig haelt, sucht keinen Knopf, den er nicht sieht -- gemeldet wurde
 * das als "ich klicke und es passiert nichts".
 *
 * **Escape schliesst.** Den Weg mit der Maus gab es (das Kreuz, der Klick
 * daneben), den mit der Tastatur nicht. An einer Rezeption liegt die Hand
 * auf der Tastatur.
 */
export type Dialogbreite = 'schmal' | 'mittel' | 'breit' | 'weit'

/**
 * Die Breiten als Namen, nicht als Klassen an der Aufrufstelle: sonst
 * entstehen fuenf Masken mit fuenf Breiten, und keine zwei sind gleich.
 *
 * `schmal` ist fuer das, was wirklich eine Frage ist (ein PIN); alles mit
 * einem Formular darin faengt bei `mittel` an.
 */
const BREITEN: Record<Dialogbreite, string> = {
  schmal: 'max-w-md',
  mittel: 'max-w-2xl',
  breit: 'max-w-4xl',
  weit: 'max-w-6xl'
}

/**
 * Ein Eingabefeld. Als Konstante, weil dieselbe Zeichenkette sonst in
 * jeder Maske steht und beim naechsten Mal eine davon abweicht.
 *
 * `py-2` statt `py-1`: in einer breiten Maske sieht ein Feld von 26 Pixel
 * Hoehe aus wie ein Versehen, und getroffen wird es auch schlechter.
 */
export const FELD = 'w-full border border-neutral-300 rounded px-3 py-2 text-sm '
  + 'disabled:bg-neutral-100 disabled:text-neutral-500'

/** Der Knopf, der die Maske abschickt. */
export const KNOPF = 'px-4 py-2 text-sm rounded bg-neutral-900 text-white '
  + 'disabled:bg-neutral-300'

/** Der Knopf daneben -- Schliessen, Abbrechen, Zurueck. */
export const KNOPF_LEISE = 'px-4 py-2 text-sm rounded border border-neutral-300 '
  + 'bg-white hover:bg-neutral-50'

export function Dialog({ titel, unterzeile, breite = 'breit', fuss, onClose,
                         nebenbeiSchliessen = true, children }: {
  titel: ReactNode
  /** Was zum Titel gehoert, aber kein Titel ist -- Zimmer, Kennung, Anzahl. */
  unterzeile?: ReactNode
  breite?: Dialogbreite
  /**
   * Die Knopfleiste. Steht im Fuss und rollt deshalb nicht weg; `undefined`
   * laesst den Fuss ganz weg, fuer Masken, die nur zeigen.
   */
  fuss?: ReactNode
  onClose: () => void
  /**
   * Schliesst ein Klick daneben oder Escape die Maske?
   *
   * Fast ueberall ja -- es ist der schnellste Weg hinaus. Nicht beim
   * Check-in: dort steht eine gezeichnete Unterschrift im Kasten, die
   * nirgends gespeichert ist, und ein Klick neben den Rand waere sie los.
   * Der Gast unterschreibt dann ein zweites Mal.
   */
  nebenbeiSchliessen?: boolean
  children: ReactNode
}): JSX.Element {
  const t = useT()

  /*
   * Escape am `window` und nicht am Kasten: der Kasten hat den Fokus nur,
   * solange niemand in ein Feld geklickt hat -- und das ist die halbe
   * Sekunde, in der ohnehin keiner Escape drueckt.
   */
  useEffect(() => {
    if (!nebenbeiSchliessen) return
    const beiTaste = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', beiTaste)
    return () => window.removeEventListener('keydown', beiTaste)
  }, [onClose, nebenbeiSchliessen])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto
                    bg-black/40 p-4"
         onClick={nebenbeiSchliessen ? onClose : undefined}>
      {/*
        * `max-h-[calc(100vh-2rem)]` und nicht `90vh`: die Maske soll den
        * Bildschirm ausnutzen und nur den Rand freilassen, den die
        * Umrandung braucht. Auf einem niedrigen Laptopbildschirm sind zehn
        * Prozent von oben und unten zwei Felder weniger.
        */}
      <div className={`w-full ${BREITEN[breite]} my-auto flex flex-col
                       max-h-[calc(100vh-2rem)] bg-white rounded-lg shadow-xl`}
           role="dialog" aria-modal="true"
           onClick={e => e.stopPropagation()}>
        <header className="flex items-baseline gap-3 border-b border-neutral-200
                           px-5 py-3">
          <h2 className="text-base font-medium">{titel}</h2>
          {unterzeile !== undefined && (
            <span className="text-sm text-neutral-500 grow truncate">{unterzeile}</span>
          )}
          <button type="button" onClick={onClose} aria-label={t('common.close')}
                  className="ml-auto text-xl leading-none text-neutral-400
                             hover:text-neutral-900 px-1">
            ×
          </button>
        </header>

        <div className="grow overflow-y-auto px-5 py-4">{children}</div>

        {fuss !== undefined && (
          <footer className="flex flex-wrap items-center gap-2 border-t
                             border-neutral-200 bg-neutral-50 px-5 py-3 rounded-b-lg">
            {fuss}
          </footer>
        )}
      </div>
    </div>
  )
}

/**
 * Ein Abschnitt in einer Maske: Ueberschrift und was darunter gehoert.
 *
 * In einer breiten Maske stehen mehrere davon nebeneinander, und dann
 * braucht der Blick eine Kante -- ohne sie sind zwei Spalten nur zwei
 * Reihen Felder, die zufaellig nebeneinander liegen.
 */
export function Abschnitt({ titel, hinweis, children, className = '' }: {
  titel: ReactNode
  hinweis?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`space-y-3 ${className}`}>
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {titel}
        </h3>
        {hinweis !== undefined && (
          <p className="text-xs text-neutral-500 mt-0.5">{hinweis}</p>
        )}
      </div>
      {children}
    </section>
  )
}

/** Ein beschriftetes Feld. Die Beschriftung steht darueber, nie daneben. */
export function Feld({ label, hinweis, children, className = '' }: {
  label: ReactNode
  hinweis?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="block text-xs text-neutral-600 mb-1">{label}</span>
      {children}
      {hinweis !== undefined && (
        <span className="block text-xs text-neutral-500 mt-1">{hinweis}</span>
      )}
    </label>
  )
}
