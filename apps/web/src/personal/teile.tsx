/** Bausteine, die jede Seite der Personal-App teilt. */

export const FELD = `mt-1 w-full border border-neutral-300 rounded-md px-3 py-2.5 text-base
              bg-white`
export const KNOPF = `w-full py-3 text-base font-medium rounded-md bg-neutral-900 text-white
               active:bg-neutral-700 disabled:bg-neutral-300`
export const KNOPF_LEISE = `w-full py-3 text-base rounded-md border border-neutral-300 bg-white
                     active:bg-neutral-100`

export function Fehler({ text }: { text: string }): JSX.Element {
  return <p role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200
                                    rounded-md px-3 py-2">{text}</p>
}

export function Karte({ titel, children }: {
  titel?: string; children: React.ReactNode
}): JSX.Element {
  return <section className="bg-white border border-neutral-200 rounded-lg p-4 space-y-3">
    {titel !== undefined && <h2 className="font-semibold">{titel}</h2>}
    {children}
  </section>
}
