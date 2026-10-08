-- ---------------------------------------------------------------------------
-- 0117 VAPID-Schluessel in der Datenbank (Aufgabe 18, Baustein 8, Nachtrag)
--
-- Sven, 08.10.2026, Thread "Personalsystem in StayGrid": "Koennen wir VAPID
-- nicht automatisch generieren und eintragen? Ich habe keinen Zugriff auf
-- das Geraet mit dem Terminalzugriff." Bisher brauchte Push zwei
-- Umgebungsvariablen, die jemand mit `web-push generate-vapid-keys` erzeugt
-- und von Hand in `/opt/hotelpms/shared/env` eintraegt -- ohne sie bot die
-- Personal-App keine Benachrichtigung an.
--
-- Jetzt erzeugt der Worker beim Start ein Schluesselpaar, wenn weder die
-- Umgebung noch diese Tabelle eins hat, und legt es hier ab. Die Umgebung
-- gewinnt weiter: wer die Schluessel selbst setzt, behaelt sie.
--
-- Ein Paar fuer die ganze Plattform, keins je Mandant: der Schluessel
-- weist den Absender gegenueber den Push-Diensten der Browserhersteller aus,
-- und Absender ist StayGrid. Deshalb keine Zeilenrichtlinie -- es gibt
-- keine Mandantenzeile darin.
--
-- Der private Schluessel ist ein Geheimnis. Die Anwendungsrolle liest nur
-- den oeffentlichen (die API gibt ihn der App zum Anmelden); den privaten
-- liest einzig die Eigentuemerrolle, mit der der Worker ihn holt. Kein
-- Audit-Trigger: die Tabelle aendert sich einmal im Leben einer Maschine,
-- und ein Trigger schriebe das Geheimnis sonst ins Protokoll.
--
-- Wechseln heisst: Zeile loeschen und Worker neu starten. Danach muessen
-- sich alle Telefone neu anmelden -- die alten Abos gehoeren zum alten
-- Schluessel, und der Push-Dienst weist sie mit 403 ab.
-- ---------------------------------------------------------------------------

CREATE TABLE platform_vapid_key (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Die Vorgaberechte aus 0001 gaeben der Anwendungsrolle die ganze Tabelle
-- samt privatem Schluessel; erst alles nehmen, dann die eine Spalte geben.
REVOKE ALL ON platform_vapid_key FROM hotelpms_app, hotelpms_readonly;
GRANT SELECT (public_key) ON platform_vapid_key TO hotelpms_app;
