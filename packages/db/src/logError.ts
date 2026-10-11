/**
 * Felder eines Datenbankfehlers, die Zeileninhalt tragen koennen.
 *
 * `detail` ist der eigentliche Grund (N10, Audit 11.10.2026): bei einer
 * verletzten Bedingung schreibt PostgreSQL dort die ganze fehlgeschlagene
 * Zeile hinein -- `Failing row contains (17, Petersen, Jan, ...)` -- und bei
 * einem doppelten Schluessel dessen Wert. `where` nennt die Stelle in einer
 * PL/pgSQL-Funktion samt eingesetzter Werte, `internalQuery` die Anweisung
 * darin. `parameters`, `query` und `values` setzt pg selbst nicht, aber
 * Wrapper und eigene Fehlerklassen tun es, und die Parameter einer Buchung
 * sind Gastdaten. `hint` ist meist allgemein; eine eigene Funktion kann mit
 * `RAISE ... USING HINT` aber beliebige Werte hineinschreiben.
 *
 * Was bleibt, genuegt zum Suchen: Meldung, SQLSTATE, Tabelle, Spalte,
 * Bedingung und Stapelspur. Ein Protokoll soll sagen, **welche** Bedingung
 * brach, nicht **wessen** Zeile.
 */
const ZEILENINHALT = new Set([
  'detail', 'where', 'internalQuery', 'parameters', 'query', 'values', 'hint'
])

/** Wie tief `cause` verfolgt wird. Eine Kette im Kreis darf nicht haengen. */
const MAX_TIEFE = 5

/** Die Form, die pino und Fastify fuer einen serialisierten Fehler erwarten. */
export interface SerializedLogError {
  [key: string]: unknown
  type: string
  message: string
  stack: string
}

/**
 * Serialisierer fuer pino unter dem Schluessel `err`, fuer API und Worker.
 *
 * Eine eigene Fassung statt `pino.stdSerializers.err` mit nachtraeglichem
 * Loeschen: der Standard kopiert **jede** aufzaehlbare Eigenschaft, auch
 * solche, die erst ein spaeterer Wrapper anhaengt. Hier steht fest, was
 * weggelassen wird, und `cause` geht durch dieselbe Pruefung -- ein pg-Fehler,
 * eingewickelt in einen eigenen, haette seine Zeile sonst eine Ebene tiefer
 * wieder mitgebracht.
 */
export function serializeLogError(err: Error): SerializedLogError {
  // Unter `err` landet gelegentlich etwas, das kein Error ist; das geht
  // unveraendert durch, wie beim Standardserialisierer von pino.
  return bereinigen(err, 0) as SerializedLogError
}

function bereinigen(err: unknown, tiefe: number): unknown {
  if (!(err instanceof Error)) return err
  const aus: Record<string, unknown> = {
    type: err.constructor?.name ?? 'Error',
    message: err.message,
    stack: err.stack ?? ''
  }
  for (const [k, v] of Object.entries(err)) {
    if (ZEILENINHALT.has(k) || k in aus) continue
    aus[k] = v
  }
  if (err.cause !== undefined) {
    aus.cause = tiefe < MAX_TIEFE ? bereinigen(err.cause, tiefe + 1) : '[zu tief]'
  }
  return aus
}
