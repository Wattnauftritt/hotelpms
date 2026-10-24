-- ---------------------------------------------------------------------------
-- 0213 -- Koeder: ein erfundener Gast je Haus und ein Maschinenzugang, den
-- niemand benutzt.
--
-- Bedrohungsanalyse 23.10.2026, E5
-- (/mnt/project-files/security/bedrohungsanalyse-2026-10-23.md). Wer die
-- Gaestedatei mit gueltigem Zugang abzieht, faellt in StayGrid kaum auf --
-- er faellt auf, wenn er sie benutzt. Die Phishing-Welle nach den Abfluessen
-- bei HotelNetSolutions und anderen begann Wochen vor der ersten
-- Gastbeschwerde, und jede dieser Mails ging an jede abgezogene Adresse.
--
-- **Der Koedergast** hat eine Adresse auf einer Catch-all-Domain, die nur
-- bei uns ankommt, und eine stornierte Buchung in der Zukunft: storniert,
-- damit sie keine Kapazitaet bindet, in keine Belegung und keine Kurtaxe
-- eingeht und nichts bucht, und in der Zukunft, damit der Abruf des
-- Adminpanels sie mitnimmt wie jede andere. Ein echter Mensch schreibt
-- dieser Adresse nie. Kommt dort Post an, ist ein Datenbestand draussen.
--
-- **Welcher Weg**, sagt die Adresse selbst: gespeichert steht `<tag>@`
-- (etwa `jonas.kerber47@`), und die Schnittstelle gibt jedem Aufrufer eine
-- eigene Fassung (`<tag>-<aufrufer>@`, platform/koeder.ts). Kommt Post an die gespeicherte
-- Fassung, ist es die Datenbank oder eine Sicherung; kommt sie an
-- `<tag>-c<ref>@`, war es dieser Maschinenzugang.
--
-- **Der Koederzugang** ist ein Maschinenzugang ohne Umsystem. Sein
-- Geheimnis legt der Betrieb dorthin, wo ein Angreifer suchen wuerde (eine
-- alte .env, die Sicherung), und jeder Versuch damit ist ein Alarm.
-- ---------------------------------------------------------------------------

ALTER TABLE oauth_client ADD COLUMN is_decoy boolean NOT NULL DEFAULT false;

CREATE TABLE decoy (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES account(id),
  property_id    bigint NOT NULL REFERENCES property(id),
  guest_id       bigint NOT NULL REFERENCES guest(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  -- Der Anfang der Adresse, etwa "jonas.kerber47": er soll aussehen wie
  -- jede andere. Eine Folge zufaelliger Zeichen sortiert ein Angreifer
  -- als Falle aus, bevor er schreibt.
  tag            text NOT NULL UNIQUE CHECK (tag ~ '^[a-z][a-z0-9.]{4,38}[0-9]$'),
  domain         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id)
);

-- Kein Zugriff fuer die Anwendung. Ein Mandant soll seinen Koeder nicht
-- finden koennen -- wer ihn kennt, laesst ihn beim Abziehen aus. Gelesen
-- wird ueber decoy_tags() fuer die Kennzeichnung der Ausgaben und ueber die
-- Plattform.
REVOKE ALL ON decoy FROM hotelpms_app, hotelpms_readonly;

-- Die Kennungen aller Koeder, fuer den Zwischenspeicher der API. Nur der
-- Anfang der Adresse und die Domain, kein Gast.
CREATE OR REPLACE FUNCTION decoy_tags() RETURNS TABLE (tag text, domain text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.tag, d.domain FROM decoy d
$$;
REVOKE ALL ON FUNCTION decoy_tags() FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION decoy_tags() TO hotelpms_app;

/*
 * Einen Koeder im Haus anlegen. Ein zweiter ersetzt den ersten nicht: wer
 * neu anlegen will, entfernt den alten mit decoy_remove().
 */
CREATE OR REPLACE FUNCTION decoy_plant(
  p_property bigint, p_domain text, p_tag text, p_first text, p_last text, p_city text
) RETURNS TABLE (tag text, address text, guest_ref text, reservation_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_account  bigint;
  v_category bigint;
  v_tag      text := p_tag;
  v_guest    bigint;
  v_booking  bigint;
  v_res      bigint;
  v_arrival  date := current_date + 150 + (get_byte(gen_random_bytes(1), 0) % 60);
BEGIN
  SELECT p.account_id INTO v_account FROM property p WHERE p.id = p_property;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown property %', p_property; END IF;
  IF EXISTS (SELECT 1 FROM decoy d WHERE d.property_id = p_property) THEN
    RAISE EXCEPTION 'decoy exists' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT c.id INTO v_category FROM resource_category c
   WHERE c.property_id = p_property ORDER BY c.id LIMIT 1;
  -- Eigener Fehlercode: die Route liest resource_category nicht selbst,
  -- weil ihr als Plattform der Mandantenkontext fehlt und die
  -- Zeilenrichtlinie dann still nichts liefert.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'property % has no category', p_property USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO guest (account_id, last_name, first_name, email, city, country)
  VALUES (v_account, p_last, p_first, v_tag || '@' || p_domain, p_city, 'DE')
  RETURNING id INTO v_guest;
  INSERT INTO booking (property_id, source) VALUES (p_property, 'direct')
  RETURNING id INTO v_booking;
  INSERT INTO reservation (property_id, booking_id, category_id, arrival, departure,
                           status, canceled_at, primary_guest_id)
  VALUES (p_property, v_booking, v_category, v_arrival, v_arrival + 3,
          'Canceled', now(), v_guest)
  RETURNING id INTO v_res;

  INSERT INTO decoy (account_id, property_id, guest_id, reservation_id, tag, domain)
  VALUES (v_account, p_property, v_guest, v_res, v_tag, p_domain);

  RETURN QUERY
  SELECT v_tag, v_tag || '@' || p_domain,
         (SELECT g.public_ref FROM guest g WHERE g.id = v_guest),
         (SELECT r.public_ref FROM reservation r WHERE r.id = v_res);
END $$;
REVOKE ALL ON FUNCTION decoy_plant(bigint, text, text, text, text, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION decoy_plant(bigint, text, text, text, text, text) TO hotelpms_app;

/*
 * Den Koeder eines Hauses entfernen. Der Gast geht ueber guest_erase_one(),
 * den einen Weg, auf dem Gastdaten geloescht werden (CLAUDE.md); die
 * stornierte Buchung bleibt anonym stehen wie jede andere.
 */
CREATE OR REPLACE FUNCTION decoy_remove(p_property bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_guest   bigint;
  v_account bigint;
  v_vorher  text := current_setting('app.account_ids', true);
BEGIN
  DELETE FROM decoy d WHERE d.property_id = p_property
  RETURNING d.guest_id, d.account_id INTO v_guest, v_account;
  IF v_guest IS NULL THEN RETURN false; END IF;
  -- guest_erase_one() handelt nur im Kontext des Kunden, und den hat die
  -- Plattform nicht. Nur fuer diesen einen Aufruf, danach wie vorher:
  -- der Rest der Transaktion soll nicht ploetzlich Daten des Kunden sehen.
  PERFORM set_config('app.account_ids', v_account::text, true);
  PERFORM guest_erase_one(v_guest);
  PERFORM set_config('app.account_ids', coalesce(v_vorher, ''), true);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION decoy_remove(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION decoy_remove(bigint) TO hotelpms_app;

/*
 * Die Koeder eines Kunden fuer die Sicht der Plattform. Ohne
 * Mandantenkontext; die Route prueft das Plattformrecht, die Funktion
 * liefert nur, was ein Koeder ist.
 */
CREATE OR REPLACE FUNCTION platform_decoys(p_account bigint) RETURNS TABLE (
  property_id bigint, address text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.property_id, d.tag || '@' || d.domain, d.created_at
    FROM decoy d WHERE d.account_id = p_account ORDER BY d.property_id
$$;
REVOKE ALL ON FUNCTION platform_decoys(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION platform_decoys(bigint) TO hotelpms_app;

-- ---------------------------------------------------------------------------
-- Der Koederzugang. Angelegt von der Plattform, ohne Mandantenkontext, und
-- in der Liste des Kunden unsichtbar: wer ihn dort saehe, raeumte ihn auf.
-- Ein Recht bekommt er, weil ein Zugang ohne Recht verdaechtig aussaehe;
-- tragen wird er nie, die Tokenausgabe weist ihn immer ab.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decoy_client_create(p_account bigint, p_name text, p_secret_hash text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO oauth_client (account_id, name, secret_hash, scopes, is_decoy)
  VALUES (p_account, p_name, p_secret_hash, ARRAY['guest:read'], true)
  RETURNING public_ref
$$;
REVOKE ALL ON FUNCTION decoy_client_create(bigint, text, text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION decoy_client_create(bigint, text, text) TO hotelpms_app;

/* Der Betrieb eines Koederzugangs, sonst nichts. */
CREATE OR REPLACE FUNCTION decoy_client_account(p_public_ref text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.account_id FROM oauth_client c WHERE c.public_ref = p_public_ref AND c.is_decoy
$$;
REVOKE ALL ON FUNCTION decoy_client_account(text) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION decoy_client_account(text) TO hotelpms_app;

CREATE OR REPLACE FUNCTION platform_decoy_clients(p_account bigint) RETURNS TABLE (
  client_id text, name text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.public_ref, c.name, c.created_at FROM oauth_client c
   WHERE c.account_id = p_account AND c.is_decoy AND c.status = 'active'
   ORDER BY c.id
$$;
REVOKE ALL ON FUNCTION platform_decoy_clients(bigint) FROM PUBLIC, hotelpms_readonly;
GRANT EXECUTE ON FUNCTION platform_decoy_clients(bigint) TO hotelpms_app;
