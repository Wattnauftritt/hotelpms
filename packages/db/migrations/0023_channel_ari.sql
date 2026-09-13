-- ARI-Schnittstelle fuer Channel Manager (Aufgabe 5, Dokument 02 Abschnitt 6,
-- Entscheidung 5: eine Standardschnittstelle statt eines Adapters je Anbieter).
--
-- channel_connection haelt das Geheimnis, mit dem ein Channel Manager sich
-- ausweist. Bewusst ohne Zeilenrichtlinie: ein eingehender Aufruf traegt noch
-- keine Sitzung und keinen Mandantenkontext, nur den Token selbst - die
-- Verbindung muss nachschlagbar sein, um daraus die Property zu gewinnen, aus
-- der der Kontext dann gesetzt wird. Dasselbe Muster wie user_session und
-- idempotency_key (0002_tenancy.sql), keine neue Ausnahme.
--
-- Aufgabe 2 (OAuth-Autorisierungsserver) ist noch nicht gebaut; diese Tabelle
-- haengt nicht davon ab, damit die Anbindung nicht auf sie warten muss.
-- account_id liegt zusaetzlich zu property_id hier, obwohl er sich daraus
-- ergibt: die Anmeldung eines Channel Managers laeuft vor jedem
-- Mandantenkontext und darf deshalb nicht auf property joinen, denn property
-- hat eine Zeilenrichtlinie. Ohne Kontext gelesen, filterte sie ihn auf
-- nichts (CLAUDE.md, "Nie ohne Kontext aus einer Tabelle mit
-- Zeilenrichtlinie lesen"). Eine Kopie bei der Anlage, wo der Kontext schon
-- besteht, vermeidet den Join zur Laufzeit ganz.
CREATE TABLE channel_connection (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  account_id   bigint NOT NULL REFERENCES account(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  provider     text NOT NULL CHECK (provider IN ('roomcloud')),
  name         text NOT NULL,
  token_hash   text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by   bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
SELECT attach_audit('channel_connection');

-- Grundlage der Aenderungsmeldung (Delta) neben dem Vollabgleich: ohne einen
-- Zeitstempel je Zeile kann ein Channel Manager nur alles neu holen, nie nur
-- das Geaenderte. Trigger auf Zeilenebene braeuchte es dafuer nicht - alle
-- drei Spalten werden von genau den Anweisungen gesetzt, die die Zeile ohnehin
-- gerade schreiben (siehe die CREATE OR REPLACE unten und die Massen-Schreiber
-- in rates.ts), nie in einer Schleife ueber viele Zeilen einzeln.
ALTER TABLE inventory_day    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE rate_day         ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE restriction_day  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX inventory_day_updated   ON inventory_day   (property_id, updated_at);
CREATE INDEX rate_day_updated        ON rate_day        (property_id, updated_at);
CREATE INDEX restriction_day_updated ON restriction_day (property_id, updated_at);

-- Die vier Inventarfunktionen aus 0006_provisioning.sql, unveraendert bis auf
-- den Zeitstempel in jeder SET-Klausel.
CREATE OR REPLACE FUNCTION inventory_reserve(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  nights integer := (p_to - p_from);
  present integer;
  affected integer;
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF nights <= 0 OR p_count <= 0 THEN RETURN 'sold_out'; END IF;

  SELECT count(*) INTO present FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
  IF present <> nights * 2 THEN RETURN 'not_materialized'; END IF;

  UPDATE inventory_day SET sold = sold + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id = 0
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  UPDATE inventory_day SET sold = sold + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id = p_category
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inventory_release(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET sold = greatest(sold - p_count, 0), updated_at = now()
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

CREATE OR REPLACE FUNCTION inventory_block(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE nights integer := (p_to - p_from); affected integer;
BEGIN
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET blocked = blocked + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to
     AND sold + blocked + p_count <= capacity + overbooking;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights * 2 THEN RETURN 'sold_out'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inventory_unblock(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_property_in_context(p_property);
  UPDATE inventory_day SET blocked = greatest(blocked - p_count, 0), updated_at = now()
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
END $$;

-- Schutz gegen Doppelanlage bei wiederholter Zustellung derselben externen
-- Nummer (Aufgabe 5, Abnahme). Die bisherige Version dieses Index (0009) war
-- nicht eindeutig - ein zweiter, gleichzeitiger Eingang haette race-frei
-- keine Sperre gehabt, nur die Anwendung haette per SELECT vorher nachgesehen,
-- und zwei parallele Anfragen haetten dieselbe leere Antwort gesehen und
-- beide eingefuegt. Der eindeutige Index macht den zweiten Eingang zu einem
-- erkennbaren Konflikt statt zu einer stillen Dublette.
DROP INDEX booking_external;
CREATE UNIQUE INDEX booking_external ON booking (property_id, external_reference)
  WHERE external_reference IS NOT NULL;
