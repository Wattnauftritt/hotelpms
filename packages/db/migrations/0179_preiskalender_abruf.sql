-- ---------------------------------------------------------------------------
-- 0179 -- Preiskalender mit dem Channel Manager abgleichen: abrufen und
--          auf Knopfdruck senden.
--
-- Anforderung: Sven, 18.10.2026 (Thread "Preise aus RoomCloud abrufen"). Die
-- Preise sollen in StayGrid gepflegt werden, aber nicht von Hand
-- nachgetippt: ein Knopf holt den Kalender (Preise, Mindestaufenthalt,
-- Sperrungen) aus RoomCloud. StayGrid spricht nicht selbst mit RoomCloud;
-- das Adminpanel tut es schon und bleibt der Ort fuer die hotelspezifische
-- Zuordnung von Zimmertyp und Rate (Entwurf "API fuers Adminpanel").
--
-- **Ablauf.** Der Knopf legt einen Auftrag an und reiht das Ereignis
-- `rate.calendar_pull_requested` ein. Das Umsystem holt den Kalender im
-- Hintergrund und liefert ihn an den Auftrag (`PUT /v1/rate-calendar-pulls/
-- :ref`). Uebernommen wird erst nach der Vorschau, von einem Menschen: ein
-- Jahr Preise, die ohne Blick darauf in den Verkauf gehen, ist derselbe
-- Fehler, gegen den die Vorschau im Preisraster steht.
--
-- **Warum die Lieferung hier liegt und nicht gleich in `rate_day`.** Die
-- Vorschau braucht den Vergleich mit dem stehenden Preis, und der Knopf
-- "Uebernehmen" muss genau das schreiben, was die Vorschau gezeigt hat.
-- `version` zaehlt die Lieferungen; die Uebernahme nennt die, die sie
-- gesehen hat, und eine neuere Lieferung dazwischen wird nicht still
-- geschrieben.
--
-- Kein Audit-Trigger: `payload` ist ein Jahr Preise je Plan, und jede
-- Lieferung schriebe es als Kopie ins Protokoll. `rate_day` hat aus
-- demselben Grund keinen (Dokument 32, Abschnitt 9); nachvollziehbar ist
-- der Abruf ueber `requested_by`, `applied_by` und das Ereignis
-- `rate.changed` mit der Herkunft `channel_import`. Personenbezogen ist
-- darin nichts; kein Eintrag in `audit_redaction`.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_calendar_pull (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  -- requested: wartet auf das Umsystem. delivered: Daten da, Vorschau
  -- moeglich. failed: das Umsystem meldet einen Fehler. applied:
  -- uebernommen. superseded: durch einen neueren Abruf ersetzt.
  status       text NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','delivered','failed','applied','superseded')),
  version      integer NOT NULL DEFAULT 0,
  -- [{ "plan": id, "date": "YYYY-MM-DD", "price": [...]?, "minLos"?, ... }]
  -- Ein fehlender Schluessel heisst "nicht geliefert" und laesst den
  -- stehenden Wert in Ruhe.
  payload      jsonb,
  -- Je gelieferter Plancode, was daraus wurde (angenommen, unbekannt, ...).
  plans        jsonb,
  message      text CHECK (char_length(message) <= 500),
  result       jsonb,
  requested_by bigint REFERENCES app_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  applied_by   bigint REFERENCES app_user(id),
  applied_at   timestamptz,
  CONSTRAINT rate_calendar_pull_range CHECK (date_to >= date_from
                                             AND date_to - date_from < 400)
);
CREATE INDEX rate_calendar_pull_property ON rate_calendar_pull (property_id, requested_at DESC);

ALTER TABLE rate_calendar_pull ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_calendar_pull FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON rate_calendar_pull
  USING (property_id = ANY (app_property_ids()));

-- ---------------------------------------------------------------------------
-- Senden auf Knopfdruck.
--
-- Sven, 18.10.2026: "Automatisch wird nichts gepusht sondern nur wenn man
-- einen der Buttons drueckt. So sollte das bei uns auch sein damit nichts
-- ausversehen gepusht wird." Wie in RoomCloud gibt es "nur Aenderungen" und
-- "ganzer Zeitraum", dazu den ganzen Kalender; ein zeitlich geplantes
-- Senden nicht ("hatte nie eine sinnvolle Anwendungsmoeglichkeit").
--
-- Der Auftrag haelt fest, **was** gesendet werden soll, und das Umsystem
-- holt die Werte dazu bei StayGrid ab (`served_at`). "Nur Aenderungen"
-- heisst: geaendert seit dem Abholen des letzten erfolgreichen Sendens.
-- Der Abholzeitpunkt und nicht der Klick ist die Grenze -- was zwischen
-- Klick und Abholen geaendert wurde, ging schon mit hinaus, und was danach
-- kam, faellt nicht durch.
--
-- Ohne ein erfolgreiches Senden davor gibt es keine Aenderungen, nur einen
-- Kalender: "nur Aenderungen" wird dann abgewiesen, statt still ein leeres
-- oder ein volles Jahr zu schicken.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_calendar_push (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  mode          text NOT NULL CHECK (mode IN ('changes','range','all')),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  -- Nur bei "changes": Abholzeitpunkt des letzten erfolgreichen Sendens.
  changed_since timestamptz,
  -- requested: wartet auf das Umsystem. done / failed: Rueckmeldung.
  -- superseded: ein neuerer Knopfdruck kam vor der Rueckmeldung.
  status        text NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','done','failed','superseded')),
  served_at     timestamptz,
  days          integer,
  message       text CHECK (char_length(message) <= 500),
  requested_by  bigint REFERENCES app_user(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT rate_calendar_push_range CHECK (date_to >= date_from
                                             AND date_to - date_from < 400),
  CONSTRAINT rate_calendar_push_since CHECK ((mode = 'changes') = (changed_since IS NOT NULL))
);
CREATE INDEX rate_calendar_push_property ON rate_calendar_push (property_id, requested_at DESC);

ALTER TABLE rate_calendar_push ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_calendar_push FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON rate_calendar_push
  USING (property_id = ANY (app_property_ids()));

/*
 * Ein eigenes Recht und nicht `rate:write`: das Umsystem liefert einen
 * Abruf zur Vorschau und meldet ein Senden zurueck, schreibt aber keinen
 * Preis -- ein Zugang mit diesem Recht kann nichts verkaufen. Keiner Rolle
 * zugeordnet; es ist fuer Maschinenzugaenge.
 */
INSERT INTO permission (key, grp, description) VALUES
  ('rate:channel_sync', 'Raten',
   'Preiskalender mit dem Channel Manager abgleichen (Umsystem: liefern, Senden zurueckmelden)')
ON CONFLICT DO NOTHING;
