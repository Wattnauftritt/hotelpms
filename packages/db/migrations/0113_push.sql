-- ---------------------------------------------------------------------------
-- 0113 Web-Push an das Personal (Aufgabe 18, Baustein 8)
--
-- Drei Anlaesse, mehr nicht (Plan, Abschnitt 3):
--
--   plan       die Hausdame hat den Plan eines Tages fuer diese Kraft geaendert
--   room_free  der letzte abreisende Gast eines Zimmers der Kraft ist weg
--   rework     die Hausdame hat ein Zimmer der Kraft auf "nacharbeiten" gesetzt
--
-- **Ein Abo gehoert zu einer Sitzung, nicht nur zu einer Person.** Die alte
-- App hielt Abos ueber das Abmelden hinaus: wer abends das Telefon einer
-- Kollegin nahm, bekam deren Zimmer gemeldet. Hier faellt das Abo mit der
-- Sitzung -- beim Abmelden, beim Ablauf, beim Loeschen. Ein neues Anmelden
-- auf demselben Geraet meldet das Geraet still neu an.
--
-- **Gesendet wird aus einer Warteschlange im Worker,** nicht aus der Route:
-- der Push-Dienst des Telefonherstellers soll keine Anfrage der Hausdame
-- aufhalten. Der Text wird erst beim Senden in der Sprache der Kraft gebaut;
-- in der Warteschlange stehen nur Art und Zimmernummer bzw. Datum. Der Inhalt
-- geht verschluesselt an den Dienst (RFC 8291), und er traegt nie einen
-- Gastnamen.
--
-- **Das Ziel kommt vom Telefon und wird geprueft.** Ein Abo ist eine Adresse,
-- an die der Worker POST schickt; ungeprueft waere es ein Weg ins eigene
-- Netz (wie bei den Webhooks, Befund B1). Zugelassen sind nur die Dienste
-- der Browserhersteller (`isPushEndpoint` in @hotelpms/domain).
-- ---------------------------------------------------------------------------

CREATE TABLE push_subscription (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id    text   NOT NULL REFERENCES user_session(id) ON DELETE CASCADE,
  endpoint      text   NOT NULL UNIQUE CHECK (length(endpoint) <= 1000),
  p256dh        text   NOT NULL CHECK (length(p256dh) <= 200),
  auth          text   NOT NULL CHECK (length(auth) <= 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX push_subscription_user ON push_subscription (user_id);
CREATE INDEX push_subscription_session ON push_subscription (session_id);

-- Wer das Ziel und die Schluessel hat, kann dem Geraet schreiben.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('push_subscription', 'endpoint', 'Zustelladresse eines Geraets'),
  ('push_subscription', 'p256dh',   'Schluessel eines Geraets'),
  ('push_subscription', 'auth',     'Geheimnis eines Geraets')
ON CONFLICT DO NOTHING;

CREATE TABLE staff_push (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  user_id       bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind          text   NOT NULL CHECK (kind IN ('plan','room_free','rework')),
  -- Datum bzw. Zimmernummer; nie ein Gastname, nie ein freier Text.
  params        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  -- Dieselbe Nachricht steht nur einmal aus: wer den Plan dreimal speichert,
  -- schickt eine Meldung, nicht drei.
  dedupe_key    text   NOT NULL,
  status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  next_at       timestamptz NOT NULL DEFAULT now(),
  last_error    text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE UNIQUE INDEX staff_push_offen ON staff_push (user_id, kind, dedupe_key)
  WHERE status = 'pending';
CREATE INDEX staff_push_faellig ON staff_push (property_id, next_at) WHERE status = 'pending';

ALTER TABLE staff_push ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_push FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON staff_push USING (property_id = ANY (app_property_ids()));

/*
 * Zimmer frei nach Abreise. Ein Trigger und nicht die Route, weil ein Gast
 * auf vielen Wegen abreist -- an der Rezeption, ueber die Schnittstelle des
 * Adminpanels, beim Abgleich mit dem Channel Manager --, und die Kraft soll
 * es auf jedem erfahren. Auf Anweisungsebene, weil Abreisen im Stapel
 * vorkommen (Migration 0013).
 *
 * Frei ist ein Zimmer, wenn kein abreisender Gast mehr da ist -- dieselbe
 * Regel wie `free` in `routes/myRooms.ts`. Gemeldet wird nur ein Zimmer,
 * das heute einer Kraft als Abreise zugeteilt und noch nicht erledigt ist.
 */
CREATE OR REPLACE FUNCTION reservation_push_zimmer_frei() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO staff_push (property_id, user_id, kind, params, dedupe_key)
  SELECT DISTINCT t.property_id, t.assigned_to, 'room_free',
         jsonb_build_object('room', r.code), t.id::text
    FROM neu n
    JOIN alt o ON o.id = n.id
    JOIN housekeeping_task t ON t.resource_id = n.resource_id
                            AND t.business_date = n.departure
                            AND t.kind = 'departure'
    JOIN resource r ON r.id = t.resource_id
   WHERE o.status IN ('Confirmed','InHouse')
     AND n.status NOT IN ('Confirmed','InHouse')
     AND t.assigned_to IS NOT NULL
     AND t.outcome IS NULL
     AND NOT EXISTS (SELECT 1 FROM reservation a
                      WHERE a.resource_id = t.resource_id AND a.departure = t.business_date
                        AND a.status IN ('Confirmed','InHouse'))
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_reservation_push_zimmer_frei
  AFTER UPDATE ON reservation
  REFERENCING OLD TABLE AS alt NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION reservation_push_zimmer_frei();
