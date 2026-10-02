-- ---------------------------------------------------------------------------
-- Das Pruefprotokoll erkennt ein Geraet als Handelnden (Dokument 31).
--
-- Anforderung. Am Gaesteterminal unterschreibt ein Gast den Meldeschein.
-- Die Aenderung an `registration` steht im Protokoll -- bisher aber mit
-- leerem `user_id` und sonst nichts, genau wie die Handlung eines
-- Maschinenzugangs. Ein leerer Handelnder an einer Unterschrift ist im
-- Streitfall die schlechteste aller Antworten: man kann nicht sagen, ob
-- sie am Tresen, am Terminal oder ueber die Schnittstelle kam.
--
-- Deshalb eine eigene Spalte und keine Verwendung von `user_id`: ein Geraet
-- ist kein Benutzer, und eine Kennung aus einer anderen Tabelle in derselben
-- Spalte liesse jede Auswertung "wer hat was getan" still falsche Namen
-- zuordnen. Gesetzt wird sie wie der Benutzer, transaktionslokal aus dem
-- Kontext (`app.terminal_device_id`, packages/db/src/context.ts).
--
-- ADD COLUMN ohne Vorgabewert ist an einer partitionierten Tabelle eine
-- reine Katalogaenderung: keine Partition wird umgeschrieben, und
-- `trg_append_only` feuert nicht, weil keine Zeile beruehrt wird.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ADD COLUMN terminal_device_id bigint;

CREATE OR REPLACE FUNCTION app_terminal_device_id() RETURNS bigint
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.terminal_device_id', true), '')::bigint;
$$;

-- Der Trigger selbst. Gegenueber Migration 0044 aendern sich nur Spalten-
-- und Werteliste des INSERT; alles andere steht hier nur, weil PostgreSQL
-- eine Funktion nicht teilweise ersetzen kann.
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

  -- Befund 1 (0044): der Wert eines redigierten Feldes geht nicht ins Protokoll.
  changed_fields := audit_redact(changed_fields, audit_redacted_columns(TG_TABLE_NAME));

  row_j := to_jsonb(coalesce(NEW, OLD));
  pid := CASE WHEN row_j ? 'property_id' THEN (row_j ->> 'property_id')::bigint END;
  aid := CASE WHEN row_j ? 'account_id'  THEN (row_j ->> 'account_id')::bigint  END;

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
                         action, changed, user_id, support_session_id,
                         terminal_device_id)
  VALUES (pid, aid, TG_TABLE_NAME, (row_j ->> 'id')::bigint, pk_value, TG_OP,
          changed_fields, app_user_id(),
          nullif(current_setting('app.support_session_id', true), '')::bigint,
          app_terminal_device_id());

  RETURN coalesce(NEW, OLD);
END $$;
