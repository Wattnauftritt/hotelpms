-- Querschnitt: Erweiterungen, Mandantenkontext, Audit-Log, Hilfsfunktionen.
-- Laeuft unter hotelpms_owner. Die Anwendungsrolle besitzt nichts.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Mandantenkontext. Wird je Transaktion gesetzt, nie je Sitzung, damit
-- PgBouncer im Transaction Mode die Verbindung nicht verschmutzt (S1, Dok 12).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_property_ids() RETURNS bigint[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    string_to_array(nullif(current_setting('app.property_ids', true), ''), ',')::bigint[],
    ARRAY[]::bigint[]
  );
$$;

CREATE OR REPLACE FUNCTION app_account_ids() RETURNS bigint[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    string_to_array(nullif(current_setting('app.account_ids', true), ''), ',')::bigint[],
    ARRAY[]::bigint[]
  );
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Oeffentliche Referenz. Nie die laufende id nach aussen geben (C1, Dok 13).
-- Alphabet ohne verwechselbare Zeichen: kein I, L, O, U, 0, 1.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_public_ref(len integer DEFAULT 12) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..len LOOP
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- Audit-Log. Partitioniert nach Monat, weil es die groesste Tabelle wird.
-- Primaerschluessel muss den Partitionsschluessel enthalten.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  property_id bigint,
  account_id  bigint,
  table_name  text        NOT NULL,
  row_id      bigint,                    -- NULL bei zusammengesetztem Schluessel
  row_key     jsonb       NOT NULL,      -- Primaerschluessel als Objekt
  action      text        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  changed     jsonb,
  user_id     bigint,
  support_session_id bigint,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Auffangnetz. Darf nie Zeilen enthalten; wird ueberwacht (P2, Dok 12).
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

CREATE INDEX audit_log_lookup ON audit_log (table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log_user   ON audit_log (user_id, occurred_at DESC);

-- Legt fehlende Monatspartitionen an. Laeuft taeglich als Job, zwoelf Monate
-- Vorlauf. Fehlt die Partition, schlaegt jeder Schreibzugriff fehl.
CREATE OR REPLACE FUNCTION audit_log_ensure_partitions(months_ahead integer DEFAULT 12)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  m integer;
  start_date date;
  end_date date;
  part_name text;
  created integer := 0;
BEGIN
  FOR m IN -1..months_ahead LOOP
    start_date := date_trunc('month', current_date + (m || ' months')::interval)::date;
    end_date   := (start_date + interval '1 month')::date;
    part_name  := 'audit_log_' || to_char(start_date, 'YYYY_MM');
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- ---------------------------------------------------------------------------
-- Generischer Audit-Trigger. Gehoert in die Datenbank, nicht in die Anwendung:
-- was in der Anwendung liegt, wird irgendwann an einer Stelle vergessen.
-- Protokolliert nur tatsaechlich geaenderte Felder (P7, Dok 12).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  changed_fields jsonb;
  old_j jsonb;
  new_j jsonb;
  row_j jsonb;
  pk_cols text[];
  pk_value jsonb;
  pid bigint;
  aid bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);
    SELECT jsonb_object_agg(key, jsonb_build_object('von', old_j -> key, 'nach', new_j -> key))
      INTO changed_fields
      FROM jsonb_each(new_j)
     WHERE new_j -> key IS DISTINCT FROM old_j -> key;
    IF changed_fields IS NULL THEN
      RETURN NEW;   -- nichts geaendert, kein Eintrag
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    changed_fields := to_jsonb(NEW);
  ELSE
    changed_fields := to_jsonb(OLD);
  END IF;

  row_j := to_jsonb(coalesce(NEW, OLD));
  pid := CASE WHEN row_j ? 'property_id' THEN (row_j ->> 'property_id')::bigint END;
  aid := CASE WHEN row_j ? 'account_id'  THEN (row_j ->> 'account_id')::bigint  END;

  -- Nicht jede Tabelle hat eine einzelne id: Verknuepfungstabellen haben
  -- zusammengesetzte Schluessel. Dann bleibt row_id leer und row_key traegt
  -- den vollstaendigen Schluessel.
  IF row_j ? 'id' THEN
    pk_value := jsonb_build_object('id', row_j -> 'id');
  ELSE
    SELECT array_agg(a.attname ORDER BY k.ord) INTO pk_cols
      FROM pg_index i
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = TG_RELID AND i.indisprimary;
    SELECT coalesce(jsonb_object_agg(c, row_j -> c), '{}'::jsonb)
      INTO pk_value FROM unnest(coalesce(pk_cols, ARRAY[]::text[])) AS c;
  END IF;

  INSERT INTO audit_log (property_id, account_id, table_name, row_id, row_key,
                         action, changed, user_id, support_session_id)
  VALUES (pid, aid, TG_TABLE_NAME, (row_j ->> 'id')::bigint, pk_value, TG_OP,
          changed_fields, app_user_id(),
          nullif(current_setting('app.support_session_id', true), '')::bigint);

  RETURN coalesce(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION attach_audit(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %s', target);
  EXECUTE format(
    'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION audit_trigger()', target);
END $$;

-- ---------------------------------------------------------------------------
-- Haertegrad 1: kein UPDATE, kein DELETE. Korrektur nur als Gegenbuchung.
-- Wirkt nur, weil hotelpms_app nicht Eigentuemerin ist (W2, Dok 12).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Tabelle % ist unveraenderlich (GoBD). Korrektur nur als Gegenbuchung.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE OR REPLACE FUNCTION make_append_only(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_append_only ON %s', target);
  EXECUTE format(
    'CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', target);
  EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM hotelpms_app', target);
END $$;

-- ---------------------------------------------------------------------------
-- Rechte. Die Anwendungsrolle bekommt nur, was sie braucht.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO hotelpms_app, hotelpms_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelpms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelpms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hotelpms_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO hotelpms_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE hotelpms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hotelpms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hotelpms_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO hotelpms_app, hotelpms_readonly;

GRANT SELECT, INSERT ON audit_log TO hotelpms_app;
SELECT make_append_only('audit_log');
SELECT audit_log_ensure_partitions(12);
