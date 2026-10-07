import { useEffect, useState } from 'react'
import { useEscape } from '../lib/tasten.js'
import { useT, useLocale, intlTag, type Locale } from '../lib/i18n/index.js'
import { useTerminals, useCreateTerminal, useRepairTerminal, useRevokeTerminal,
         useKioskKey, useTerminalWachzeit, type Kopplungscode,
         type TerminalGeraet, type Kioskschluessel }
  from '../lib/queries/terminal.js'
import { Fehler, Laedt } from './Shell.tsx'
import { TerminalInhalte } from './TerminalInhalte.tsx'

/**
 * Einstellungen → Gaesteterminals (Dokument 31).
 *
 * Koppeln, sehen, widerrufen. Der Code steht genau einmal da: die
 * Schnittstelle legt nur seinen Hash ab und kann ihn nicht noch einmal
 * zeigen. Wer ihn verpasst, koppelt neu -- das kostet einen Klick und
 * macht einen alten Code wertlos. Dasselbe gilt fuer die Kiosk-Adresse:
 * sie traegt das Geheimnis des Geraets und steht nur in der Antwort, die
 * sie erzeugt hat.
 */
export function Gaesteterminals({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [name, setName] = useState('')
  const [code, setCode] = useState<Kopplungscode | null>(null)
  const anlegen = useCreateTerminal(propertyId)
  const neu = useRepairTerminal(propertyId)
  const widerrufen = useRevokeTerminal(propertyId)
  const kiosk = useKioskKey(propertyId)
  const [adresse, setAdresse] = useState<Kioskschluessel | null>(null)
  const [kopiert, setKopiert] = useState(false)
  const liste = useTerminals(propertyId, code !== null)

  // Escape schliesst den angezeigten Code oder die Adresse -- beide sind
  // eine Lage ueber der Liste, und danach braucht sie niemand mehr.
  useEscape(() => { setCode(null); setAdresse(null) }, code !== null || adresse !== null)

  // Code und Adresse schliessen einander aus: beide machen das bisherige
  // Geheimnis des Geraets wertlos, und nur das zuletzt erzeugte gilt.
  const zeigeCode = (c: Kopplungscode): void => { setAdresse(null); setCode(c) }
  const zeigeAdresse = (k: Kioskschluessel): void => {
    setCode(null); setKopiert(false); setAdresse(k)
  }
  /*
   * Das Geheimnis hinter dem `#`: der Browser schickt den Teil nach dem
   * Zeichen nie an einen Server, er landet also in keiner Protokollzeile
   * -- weder hier noch bei einem Proxy dazwischen. Die Seite am Terminal
   * liest ihn und tauscht ihn gegen das Geraetecookie.
   */
  const kioskUrl = adresse === null ? ''
    : `${location.origin}/terminal#k=${adresse.kioskKey}`

  /*
   * Sobald der Code eingeloest ist, faellt er von selbst weg: das Terminal
   * steht dann als gekoppelt in der Liste, und ein stehengebliebener Code
   * saehe aus, als waere noch etwas zu tun.
   *
   * "Eingeloest" heisst: erst wartend gesehen, dann gekoppelt. Beim
   * Neukoppeln steht das Geraet im Zwischenspeicher noch als gekoppelt --
   * vom letzten Mal --, und der frische Code verschwaende, bevor ihn
   * jemand lesen kann.
   */
  const [wartendGesehen, setWartendGesehen] = useState(false)
  const stand = code === null ? undefined
    : liste.data?.terminals.find(d => d.deviceRef === code.deviceRef)?.state
  useEffect(() => {
    if (code === null) { setWartendGesehen(false); return }
    if (stand === 'pairing') setWartendGesehen(true)
    else if (stand === 'paired' && wartendGesehen) setCode(null)
  }, [code, stand, wartendGesehen])

  if (liste.isError) return <Fehler error={liste.error} />
  if (liste.data === undefined) return <Laedt />

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('terminal.settings.hint')}</p>

      {code !== null && (
        <div className="rounded-sm border border-neutral-300 bg-white p-4 space-y-2" role="status">
          <div className="text-sm font-medium">
            {t('terminal.settings.codeTitle', { name: code.name })}
          </div>
          <div className="text-3xl font-mono tracking-widest select-all">{code.pairingCode}</div>
          <p className="text-xs text-neutral-600">
            {t('terminal.settings.codeHint', {
              adresse: `${location.origin}/terminal`,
              zeit: uhrzeit(code.pairingExpiresAt, locale) })}
          </p>
          <button type="button" onClick={() => setCode(null)}
                  className="text-xs text-neutral-600 underline">
            {t('common.close')}
          </button>
        </div>
      )}

      {adresse !== null && (
        <div className="rounded-sm border border-neutral-300 bg-white p-4 space-y-2" role="status">
          <div className="text-sm font-medium">
            {t('terminal.settings.kioskTitle', { name: adresse.name })}
          </div>
          <div className="flex items-center gap-2">
            <input readOnly value={kioskUrl} onFocus={e => e.currentTarget.select()}
                   className="grow border border-neutral-300 rounded-sm px-2 py-1 text-xs
                              font-mono" />
            <button type="button"
                    className="px-2 py-1 text-xs border border-neutral-300 rounded-sm
                               whitespace-nowrap"
                    onClick={() => {
                      void navigator.clipboard?.writeText(kioskUrl)
                        .then(() => setKopiert(true))
                    }}>
              {kopiert ? t('terminal.settings.copied') : t('terminal.settings.copy')}
            </button>
          </div>
          <p className="text-xs text-neutral-600">{t('terminal.settings.kioskHint')}</p>
          <button type="button" onClick={() => setAdresse(null)}
                  className="text-xs text-neutral-600 underline">
            {t('common.close')}
          </button>
        </div>
      )}

      <form className="flex flex-wrap items-end gap-2"
            onSubmit={e => {
              e.preventDefault()
              if (name.trim() === '') return
              anlegen.mutate(name.trim(), { onSuccess: c => { zeigeCode(c); setName('') } })
            }}>
        <label className="text-sm">
          <div className="text-neutral-600">{t('terminal.settings.name')}</div>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
                 placeholder={t('terminal.settings.namePlaceholder')}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-72" />
        </label>
        <button type="submit" disabled={name.trim() === '' || anlegen.isPending}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('terminal.settings.pair')}
        </button>
      </form>
      {anlegen.isError && <Fehler error={anlegen.error} />}
      {neu.isError && <Fehler error={neu.error} />}
      {kiosk.isError && <Fehler error={kiosk.error} />}
      {widerrufen.isError && <Fehler error={widerrufen.error} />}

      {liste.data.terminals.length === 0
        ? <p className="text-sm text-neutral-500">{t('terminal.settings.none')}</p>
        : <ul className="divide-y divide-neutral-100 border border-neutral-200 rounded-sm bg-white">
            {liste.data.terminals.map(d => (
              <li key={d.deviceRef} className="px-3 py-2 flex flex-wrap items-center gap-3">
                <span className="font-medium text-sm grow">{d.name}</span>
                <span className="text-xs text-neutral-600">
                  {d.state === 'pairing' && d.pairingExpiresAt !== null
                    ? t('terminal.settings.state.pairing',
                        { zeit: uhrzeit(d.pairingExpiresAt, locale) })
                    : t(`terminal.settings.state.${d.state}`)}
                </span>
                {d.state === 'paired' && (
                  <span className={`text-xs ${d.online ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {t(d.online ? 'terminal.settings.online' : 'terminal.settings.offline')}
                  </span>
                )}
                <button type="button" disabled={neu.isPending}
                        onClick={() => neu.mutate(d.deviceRef, { onSuccess: zeigeCode })}
                        className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                                   hover:bg-neutral-50">
                  {t('terminal.settings.repair')}
                </button>
                <button type="button" disabled={kiosk.isPending}
                        onClick={() => kiosk.mutate(d.deviceRef, { onSuccess: zeigeAdresse })}
                        className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                                   hover:bg-neutral-50">
                  {t('terminal.settings.kiosk')}
                </button>
                <button type="button" disabled={widerrufen.isPending}
                        onClick={() => {
                          if (confirm(t('terminal.settings.revokeConfirm', { name: d.name }))) {
                            widerrufen.mutate(d.deviceRef)
                          }
                        }}
                        className="text-xs px-2 py-1 rounded-sm border border-red-300 text-red-800
                                   hover:bg-red-50">
                  {t('terminal.settings.revoke')}
                </button>
                <Wachzeit propertyId={propertyId} geraet={d} />
              </li>
            ))}
          </ul>}
      {liste.data.terminals.length > 0 && (
        <p className="text-xs text-neutral-500">{t('terminal.settings.awakeHint')}</p>
      )}

      {/* Was die Terminals zeigen duerfen: Seiten, Diashow, Adressen. */}
      <TerminalInhalte propertyId={propertyId} />
    </div>
  )
}

/**
 * Von wann bis wann das Terminal den Bildschirm wach haelt (Migration 0102).
 * Beide Felder leer heisst: wie bisher, Windows entscheidet.
 */
function Wachzeit({ propertyId, geraet }: { propertyId: number; geraet: TerminalGeraet }
): JSX.Element {
  const t = useT()
  const setzen = useTerminalWachzeit(propertyId)
  const [von, setVon] = useState(geraet.awakeFrom ?? '')
  const [bis, setBis] = useState(geraet.awakeUntil ?? '')
  const geaendert = von !== (geraet.awakeFrom ?? '') || bis !== (geraet.awakeUntil ?? '')
  const feld = 'border border-neutral-300 rounded-sm px-1.5 py-0.5 text-xs tabular-nums'
  return (
    <form className="basis-full flex flex-wrap items-center gap-2 text-xs text-neutral-600"
          onSubmit={e => {
            e.preventDefault()
            setzen.mutate({ deviceRef: geraet.deviceRef,
                            from: von === '' ? null : von, until: bis === '' ? null : bis })
          }}>
      <label className="flex items-center gap-1.5">
        {t('terminal.settings.awake')}
        <input type="time" value={von} onChange={e => setVon(e.target.value)} className={feld} />
      </label>
      <label className="flex items-center gap-1.5">
        {t('terminal.settings.awakeUntil')}
        <input type="time" value={bis} onChange={e => setBis(e.target.value)} className={feld} />
      </label>
      <button type="submit" disabled={!geaendert || setzen.isPending}
              className="px-2 py-0.5 rounded-sm border border-neutral-300 hover:bg-neutral-50
                         disabled:text-neutral-400">
        {t('terminal.settings.awakeSave')}
      </button>
      {setzen.isError && <div className="basis-full"><Fehler error={setzen.error} /></div>}
    </form>
  )
}

/** Ein Zeitpunkt als Uhrzeit des Betrachters. Ein Zeitpunkt, kein Kalendertag. */
function uhrzeit(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
}
