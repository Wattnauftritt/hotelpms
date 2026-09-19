-- ---------------------------------------------------------------------------
-- Der Audit-Trigger redigiert, statt abzuschreiben (Befund 1, Dokument 24).
--
-- Befund. Der Trigger aus Migration 0001 schreibt bei UPDATE beide Werte und
-- bei DELETE die ganze Zeile. Die Loeschung nach Art. 17 DSGVO ist eine
-- Aenderung -- sie erzeugte damit im selben Moment eine vollstaendige,
-- dauerhafte und fuer die Anwendung unerreichbare Kopie genau der Daten, die
-- sie entfernt. Nachgestellt an einer laufenden Datenbank: nach der Loeschung
-- stand das Profil auf "Anonymisiert", und im Protokoll standen Name,
-- Geburtsdatum, Anschrift, die geloeschte Hausnotiz und der vernichtete
-- Meldeschein samt Unterschrift.
--
-- Dasselbe traf die Vernichtungsfrist nach § 30 Abs. 4 BMG: das Loeschen des
-- Meldescheins legte ihn unbefristet ins Protokoll. Die Frist wurde nicht
-- eingehalten, sondern in eine andere Tabelle verschoben.
--
-- Mitgefunden: auch `password_hash`, `totp_secret_enc` und
-- `workstation_pin_hash` standen dort. Jede Kennwortaenderung archivierte den
-- alten und den neuen Hash, unbefristet, in einer Tabelle ohne
-- Zeilenrichtlinie. Das ist kein Datenschutz-, sondern ein Sicherheitsbefund.
--
-- Was bleibt. Der Schluessel des Feldes bleibt stehen, nur sein Wert faellt.
-- Das Protokoll beantwortet damit weiter, **wer wann welches Feld** geaendert
-- hat -- das ist sein Zweck. Den Wert selbst hat es nie gebraucht.
--
-- Warum eine Tabelle und keine Liste im Code. Dieselbe Begruendung wie bei
-- der Redaktionsliste von `pino`: wer eine Spalte hinzufuegt, soll die Regel
-- an einer Stelle finden und nicht in einer Funktion suchen muessen. Und eine
-- Tabelle laesst sich pruefen -- der Test unten tut das.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_redaction (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  grund       text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);

COMMENT ON TABLE audit_redaction IS
  'Felder, deren Wert nicht ins Protokoll gehoert. Der Schluessel bleibt.';

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  -- Gastprofil: unmittelbare Kennzeichen einer natuerlichen Person.
  ('guest', 'last_name',        'Name'),
  ('guest', 'first_name',       'Name'),
  ('guest', 'email',            'Kontaktdatum'),
  ('guest', 'phone',            'Kontaktdatum'),
  ('guest', 'birth_date',       'Geburtsdatum'),
  ('guest', 'address_line1',    'Anschrift'),
  ('guest', 'postal_code',      'Anschrift'),
  ('guest', 'city',             'Anschrift'),
  ('guest', 'country',          'Anschrift'),
  ('guest', 'nationality',      'Staatsangehoerigkeit'),
  ('guest', 'preferences',      'Freitext, kann alles enthalten'),
  -- Geheimtext, aber auf die Liste: sich darauf zu verlassen, dass der
  -- Schluessel rotiert wurde, ist keine Massnahme.
  ('guest', 'id_document_number_enc', 'Ausweismerkmal nach § 30 BMG'),

  -- Freitext. Nach Befund 4 landet hier faktisch auch Gesundheitliches --
  -- die Kategorie mit der strengsten Loeschpflicht gehoert nicht in die
  -- Tabelle, die nicht geloescht werden kann.
  ('guest_property_note', 'note',  'Freitext, faktisch auch Art.-9-Daten'),
  ('reservation',         'notes', 'Freitext, faktisch auch Art.-9-Daten'),

  -- Unterschriften. Ein Bild der eigenen Hand ist ein Kennzeichen.
  ('registration',    'signature_svg', 'Unterschrift'),
  ('guest_agreement', 'signature_svg', 'Unterschrift'),

  -- Geheimnisse. Ein Protokoll ohne Zeilenrichtlinie und ohne Frist ist der
  -- letzte Ort, an dem ein Kennworthash stehen sollte.
  ('app_user', 'password_hash',        'Geheimnis'),
  ('app_user', 'totp_secret_enc',      'Geheimnis'),
  ('app_user', 'workstation_pin_hash', 'Geheimnis'),
  ('app_user', 'email',                'Kontaktdatum'),
  ('app_user', 'display_name',         'Name');

-- Bewusst **nicht** auf der Liste: `company`. Deren Felder bezeichnen eine
-- juristische Person; der Einzelunternehmer ist der Grenzfall. Sie zu
-- redigieren naehme dem Protokoll den Nutzen fuer Rechnungsvorgaenge, ohne
-- dass ein Gast davon etwas haette. Eine bewusste Entscheidung, keine Luecke.

/**
 * Die redigierten Spalten einer Tabelle.
 *
 * STABLE, damit der Planer den Aufruf innerhalb einer Anweisung nicht je
 * Zeile neu bewerten muss. Die Tabelle ist klein genug, dass sie ohnehin im
 * Puffer steht.
 */
CREATE OR REPLACE FUNCTION audit_redacted_columns(p_table text)
RETURNS text[] LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(array_agg(column_name), ARRAY[]::text[])
    FROM audit_redaction WHERE table_name = p_table;
$$;

/**
 * Werte der genannten Spalten durch einen Marker ersetzen.
 *
 * Wirkt auf beide Formen, die der Trigger erzeugt: das flache Objekt aus
 * INSERT und DELETE und das Paar {von, nach} aus UPDATE. Der Marker ist
 * sichtbar und nicht NULL -- ein Protokoll, in dem ein redigiertes Feld wie
 * ein geleertes aussaehe, waere schlechter als keines.
 */
CREATE OR REPLACE FUNCTION audit_redact(p_changed jsonb, p_cols text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_changed IS NULL OR array_length(p_cols, 1) IS NULL THEN p_changed
    ELSE coalesce((
      SELECT jsonb_object_agg(e.key,
               CASE WHEN e.key = ANY (p_cols)
                    THEN CASE WHEN jsonb_typeof(e.value) = 'object'
                                   AND e.value ? 'von' AND e.value ? 'nach'
                              THEN jsonb_build_object('von', '"[redigiert]"'::jsonb,
                                                      'nach', '"[redigiert]"'::jsonb)
                              ELSE '"[redigiert]"'::jsonb END
                    ELSE e.value END)
        FROM jsonb_each(p_changed) e), '{}'::jsonb)
  END;
$$;

-- Der Trigger selbst. Gegenueber Migration 0001 aendert sich **eine** Zeile
-- vor dem INSERT; alles andere steht hier nur, weil PostgreSQL eine Funktion
-- nicht teilweise ersetzen kann.
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

  -- Befund 1: der Wert eines redigierten Feldes geht nicht ins Protokoll.
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
                         action, changed, user_id, support_session_id)
  VALUES (pid, aid, TG_TABLE_NAME, (row_j ->> 'id')::bigint, pk_value, TG_OP,
          changed_fields, app_user_id(),
          nullif(current_setting('app.support_session_id', true), '')::bigint);

  RETURN coalesce(NEW, OLD);
END $$;

-- ---------------------------------------------------------------------------
-- Die bereits geschriebenen Kopien.
--
-- Ab hier redigiert der Trigger. Was vor dieser Migration ins Protokoll lief,
-- steht aber noch darin -- und das ist der eigentliche Bestand, um den es
-- geht. Die Anwendungsrolle kann ihn nicht anfassen (Haertegrad 1); diese
-- Migration laeuft als Eigentuemerin und kann es.
--
-- Bewusst ein UPDATE und kein DELETE: die Zeile bleibt, ihr Wert faellt. Wer
-- wann welches Feld geaendert hat, bleibt damit nachweisbar. Die
-- Unveraenderlichkeit gegenueber der Anwendung ist davon unberuehrt.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  betroffen bigint := 0;
  n bigint;
BEGIN
  FOR r IN SELECT DISTINCT table_name FROM audit_redaction LOOP
    EXECUTE format(
      'UPDATE audit_log SET changed = audit_redact(changed, %L::text[])
        WHERE table_name = %L
          AND changed IS NOT NULL
          AND changed ?| %L::text[]',
      (SELECT array_agg(column_name) FROM audit_redaction WHERE table_name = r.table_name),
      r.table_name,
      (SELECT array_agg(column_name) FROM audit_redaction WHERE table_name = r.table_name));
    GET DIAGNOSTICS n = ROW_COUNT;
    betroffen := betroffen + n;
  END LOOP;
  RAISE NOTICE 'Altbestand redigiert: % Protokollzeilen', betroffen;
END $$;

GRANT SELECT ON audit_redaction TO hotelpms_app;
