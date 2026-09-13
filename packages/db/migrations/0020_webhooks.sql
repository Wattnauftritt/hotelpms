-- Ausgehende Ereignisse (Aufgabe 4, Dokument 16).
--
-- Ohne Webhooks muss jedes Fremdsystem fragen statt zu erfahren. Der Kern
-- dieser Migration ist deshalb nicht die Zustellung, sondern das Einreihen:
-- webhook_enqueue() laeuft in derselben Transaktion wie die Fachbuchung.
-- Entweder beides oder nichts. Damit gibt es den klassischen Fehler nicht,
-- dass eine Reservierung gespeichert, das Ereignis aber nie zugestellt wird
-- -- und ebenso wenig den umgekehrten, dass ein Empfaenger von einer
-- Reservierung erfaehrt, die es nach dem Rollback nie gab.

-- ---------------------------------------------------------------------------
-- Abonnement. Je Account, nicht je Property: ein Fremdsystem bindet sich an
-- den Mandanten, nicht an ein einzelnes Haus. property_ids schraenkt bei
-- Bedarf ein, leer bedeutet alle Haeuser des Accounts.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_subscription (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES account(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  -- https wird beim Anlegen in der Route erzwungen, nicht hier. Als
  -- Pruefbedingung waere es eine Produktentscheidung, die sich nur noch mit
  -- einer Migration aendern liesse, und sie machte jeden Empfaenger im
  -- eigenen Netz unerreichbar.
  url          text NOT NULL,
  -- Der gemeinsame Schluessel muss zum Signieren im Klartext lesbar sein;
  -- er ist kein Zugang zu diesem System, sondern eine Abmachung mit dem
  -- Empfaenger. Geschuetzt ist er durch die Zeilenrichtlinie und dadurch,
  -- dass ihn nur die Anlage-Antwort einmal herausgibt.
  signing_secret text NOT NULL,
  -- Leer bedeutet alle Ereignisarten. Ein Abonnement, das sich auf nichts
  -- bezieht, waere ein stiller Fehler; eines auf alles ist eine Aussage.
  event_types  text[] NOT NULL DEFAULT '{}',
  property_ids bigint[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  disabled_at  timestamptz,
  disabled_reason text,
  created_by   bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_subscription_account ON webhook_subscription (account_id, status);

-- ---------------------------------------------------------------------------
-- Zustellung. Eine Zeile je Abonnement und Ereignis, angelegt in der
-- Transaktion der Fachbuchung und spaeter vom Worker abgearbeitet.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_delivery (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES webhook_subscription(id) ON DELETE CASCADE,
  account_id      bigint NOT NULL REFERENCES account(id),
  property_id     bigint NOT NULL REFERENCES property(id),
  event_type      text NOT NULL,
  -- Dasselbe Ereignis an mehrere Abonnements traegt dieselbe Kennung, und
  -- eine Wiederholung behaelt sie. Der Empfaenger kann damit doppelte
  -- Zustellung erkennen; die Zustellung ist mindestens einmal, nicht genau
  -- einmal, denn ein Worker kann zwischen Absenden und Vermerken sterben.
  event_ref       text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

-- Der Abholpfad des Workers: nur offene, faellige Zustellungen einer
-- Property. Partiell, weil zugestellte Zeilen die Mehrheit werden und in
-- diesem Index nichts zu suchen haben.
CREATE INDEX webhook_delivery_due ON webhook_delivery (property_id, next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX webhook_delivery_subscription ON webhook_delivery (subscription_id, id DESC);

-- ---------------------------------------------------------------------------
-- Versuchsprotokoll. Ohne es steht in der Zustellung nur der letzte Stand,
-- und die Frage "mit welchem Abstand wurde wiederholt, und was kam zurueck"
-- laesst sich nicht mehr beantworten -- also genau die Frage, die man bei
-- einem stillgelegten Abonnement stellt.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_delivery_attempt (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id  bigint NOT NULL REFERENCES webhook_delivery(id) ON DELETE CASCADE,
  property_id  bigint NOT NULL REFERENCES property(id),
  attempt      integer NOT NULL,
  status_code  integer,
  error        text,
  duration_ms  integer,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt)
);

-- ---------------------------------------------------------------------------
-- Zeilenrichtlinien. FORCE, sonst umgeht der Eigentuemer sie.
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscription FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON webhook_subscription
  USING (account_id = ANY (app_account_ids()));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_delivery','webhook_delivery_attempt'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('webhook_subscription');

-- ---------------------------------------------------------------------------
-- Einreihen. Wird aus der Fachroute mit deren Client aufgerufen und laeuft
-- damit in deren Transaktion.
--
-- Bewusst SECURITY INVOKER: die Zeilenrichtlinie soll auch hier greifen. Ein
-- Aufrufer ohne Kontext auf die Property sieht keine Abonnements und reiht
-- nichts ein, statt im falschen Mandanten zu landen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION webhook_enqueue(
  p_property_id bigint, p_event_type text, p_data jsonb
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_event_ref text := generate_public_ref(16);
  v_envelope  jsonb;
  v_count     integer;
BEGIN
  -- Der Umschlag entsteht an einer Stelle, damit jede Ereignisart gleich
  -- aussieht. Nach aussen geht die oeffentliche Referenz, nie die laufende
  -- id (C1, Dokument 13).
  SELECT jsonb_build_object(
           'id',          v_event_ref,
           'type',        p_event_type,
           'occurredAt',  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'propertyRef', p.public_ref,
           'data',        p_data)
    INTO v_envelope
    FROM property p
   WHERE p.id = p_property_id;

  IF v_envelope IS NULL THEN
    RAISE EXCEPTION 'Property % liegt nicht im Kontext', p_property_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO webhook_delivery (subscription_id, account_id, property_id,
                                event_type, event_ref, payload)
  SELECT s.id, s.account_id, p_property_id, p_event_type, v_event_ref, v_envelope
    FROM webhook_subscription s
    JOIN property p ON p.id = p_property_id AND p.account_id = s.account_id
   WHERE s.status = 'active'
     AND (cardinality(s.event_types)  = 0 OR p_event_type  = ANY (s.event_types))
     AND (cardinality(s.property_ids) = 0 OR p_property_id = ANY (s.property_ids));

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
