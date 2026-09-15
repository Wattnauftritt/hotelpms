-- Ausrollen auf Anforderung, nicht auf Zuruf und nicht von selbst.
--
-- **Der Befund.** Es gab keinen Weg, die Maschine auf einen neuen Stand zu
-- bringen, ausser sich anzumelden und ops/deploy/deploy.sh von Hand zu
-- starten. Bei mehreren Bearbeitern, die taeglich nach main mergen, heisst
-- das: die Maschine hinkt beliebig weit hinterher, und niemand sieht es.
--
-- **Warum kein Timer, der einfach zieht.** Er rollte mitten im Check-in aus
-- und naehme, was gerade auf main liegt -- auch einen Stand, den niemand
-- fuer die Produktion vorgesehen hat. Das ist bei einem System, an dem eine
-- Rezeption arbeitet, kein theoretischer Einwand.
--
-- Getrennt wird deshalb **was** von **wann**:
--
--   was    Ein Git-Tag `produktion`. Die Maschine holt nur diesen Stand,
--          nie main. Wer ihn verschiebt, gibt frei -- bewusst und sichtbar.
--   wann   Diese Tabelle. Jemand mit platform:operations fordert an, und
--          ein eigener Dienst auf der Maschine fuehrt es aus.
--
-- **Warum die API nicht selbst ausrollt.** Sie laeuft unter
-- NoNewPrivileges=true; sudo ist aus dem Prozess heraus gesperrt, und der
-- Neustart der Dienste braucht genau das. Das ist keine Huerde, die man
-- umgeht, sondern der Grund, warum ein Einbruch in die Anwendung nicht
-- gleich die Maschine ist. Die API schreibt deshalb nur eine Zeile; wer sie
-- ausfuehrt, ist ein anderer Prozess mit anderen Rechten.

CREATE TABLE deploy_request (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  /*
   * Wer angefordert hat. Leer bei einem Lauf von Hand auf der Maschine --
   * dort gibt es keinen angemeldeten Benutzer. Beides gehoert in dieselbe
   * Tabelle: sonst zeigt die Oberflaeche einen Stand, den ein Handlauf
   * laengst ueberholt hat.
   */
  requested_by  bigint REFERENCES app_user(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),

  /** Der Marker, der ausgerollt werden soll. Heute immer 'produktion'. */
  target_ref    text NOT NULL,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed')),
  started_at    timestamptz,
  finished_at   timestamptz,

  /** Welcher Stand lief vorher, welcher danach. Beides fuer die Rueckschau. */
  commit_before text,
  commit_after  text,

  /*
   * Die letzten Zeilen der Ausgabe. Nicht das ganze Protokoll: das steht im
   * journal, und ein Bauprotokoll in einer Fachdatenbank waechst ohne Ende.
   * Was hier steht, soll die Frage "warum ging es schief" beantworten, ohne
   * dass man sich auf der Maschine anmeldet.
   */
  log           text
);

-- Der Abrufpfad des Dienstes: die aelteste offene Anforderung.
CREATE INDEX deploy_request_offen ON deploy_request (id) WHERE status = 'pending';

/*
 * Keine Zeilenrichtlinie: das hier gehoert keinem Mandanten, sondern uns.
 * Die Anwendungsrolle darf anfragen und lesen; der Dienst, der ausrollt,
 * laeuft unter derselben Rolle und muss den Ausgang vermerken duerfen.
 *
 * Kein DELETE. Wer wann welchen Stand auf die Maschine gebracht hat, ist die
 * Art Frage, die Monate spaeter kommt.
 */
GRANT SELECT, INSERT, UPDATE ON deploy_request TO hotelpms_app;

/*
 * Nur eine Anforderung gleichzeitig.
 *
 * Zwei gleichzeitige Laeufe wuerden sich im selben Arbeitsverzeichnis
 * gegenseitig die Dateien unter den Fuessen wegziehen -- und das Ergebnis
 * waere ein halber Stand, den niemand als solchen erkennt. Der Teilindex
 * laesst hoechstens eine Zeile zu, die noch nicht fertig ist.
 */
CREATE UNIQUE INDEX deploy_request_nur_eine
  ON deploy_request ((true)) WHERE status IN ('pending', 'running');
