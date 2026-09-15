-- Einen Kunden anlegen: Account, erstes Haus, erster Benutzer (Aufgabe 13b).
--
-- **Der Befund.** Es gab keinen Weg, einen Account oder ein Haus anzulegen.
-- Keine Route, nirgends. Die Tests und db:testhotel schreiben mit der
-- Eigentuemerrolle direkt in die Tabellen; auf einer Produktivmaschine hiesse
-- das, dass der erste Kunde nur ueber psql hineinkommt.
--
-- **Warum eine Funktion und keine Route mit Eigentuemerverbindung.** Die
-- Zeilenrichtlinie auf account lautet USING (id = ANY (app_account_ids())),
-- und ohne eigenes WITH CHECK gilt sie auch fuer INSERT. Ein neuer Account
-- hat naturgemaess eine id, die in keinem Kontext steht -- die
-- Anwendungsrolle kann ihn deshalb nicht anlegen, und zwar grundsaetzlich
-- nicht. Migration 0006 benennt das schon: die Bereitstellung gehoert der
-- Eigentuemerrolle, "wird nie fuer normale Anfragen benutzt".
--
-- Der naheliegende Weg waere also eine zweite Verbindung in der API, unter
-- hotelpms_owner. Das waere ein stehender BYPASSRLS im Anfrageprozess: wer
-- dort Code ausfuehren kann, liest jeden Mandanten. Diese Funktion ist statt
-- dessen genau ein Loch, und es ist schmal -- wer sie aufruft, kann einen
-- leeren Account anlegen und sonst nichts. Dieselbe Bauart wie bei den
-- Inventarfunktionen (0005, 0006), aus demselben Grund.

CREATE OR REPLACE FUNCTION account_provision(
  p_account_name  text,
  p_code          text,
  p_name          text,
  p_address_line1 text,
  p_postal_code   text,
  p_city          text,
  p_country       text,
  p_tax_number    text,
  p_vat_id        text,
  p_timezone      text,
  p_currency      text,
  p_is_training   boolean,
  -- Der Geschaeftstag kommt fertig herein. Er haengt an Zeitzone und
  -- rollover_time des Hauses, und diese Rechnung steht schon in
  -- businessDateFor(); sie hier in SQL zu wiederholen hiesse, zwei Fassungen
  -- zu pflegen, von denen die zweite irgendwann um einen Tag danebenliegt.
  p_business_date date,
  p_user_email    text,
  p_user_name     text
) RETURNS TABLE (account_id bigint, property_id bigint, user_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account  bigint;
  v_property bigint;
  v_user     bigint;
  v_role     bigint;
BEGIN
  /*
   * Diese Funktion umgeht die Zeilenrichtlinie vollstaendig, also prueft sie
   * selbst -- wie assert_property_in_context bei den Inventarfunktionen.
   *
   * Der Kontext MUSS leer sein. Die eigentliche Tuer ist das Recht
   * platform:accounts an der Route; dies hier ist die zweite. Wer einen
   * Mandantenkontext hat, ist ein Kunde und legt keine Accounts an -- und
   * Plattformpersonal in einer laufenden Supportsitzung traegt den Kontext
   * des betreuten Kunden, arbeitet also gerade in dessen Namen. Auch dann
   * ist das Anlegen eines fremden Accounts nicht das, was gemeint war.
   */
  IF app_account_ids() <> ARRAY[]::bigint[] THEN
    RAISE EXCEPTION 'account_provision laeuft ohne Mandantenkontext'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  /*
   * Anschrift und Steuernummer sind Pflicht, nicht Kuer: ohne sie darf das
   * Haus nach § 14 UStG keine Rechnung ausstellen. Ein Haus ohne sie
   * anzulegen hiesse, die Luecke bis zum ersten Check-out zu verstecken --
   * und dann steht ein Gast an der Rezeption. Die lesbare Meldung dazu kommt
   * aus der Route; dies ist der Riegel dahinter.
   */
  IF coalesce(btrim(p_address_line1), '') = ''
     OR coalesce(btrim(p_postal_code), '') = ''
     OR coalesce(btrim(p_city), '') = ''
     OR coalesce(btrim(p_tax_number), '') = '' THEN
    RAISE EXCEPTION 'Pflichtangaben nach § 14 UStG fehlen'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO account (name) VALUES (p_account_name) RETURNING id INTO v_account;

  INSERT INTO property (account_id, code, name, address_line1, postal_code,
                        city, country, tax_number, vat_id, timezone, currency,
                        is_training)
  VALUES (v_account, p_code, p_name, btrim(p_address_line1), btrim(p_postal_code),
          btrim(p_city), p_country, btrim(p_tax_number), nullif(btrim(p_vat_id), ''),
          p_timezone, p_currency, p_is_training)
  RETURNING id INTO v_property;

  /*
   * Einen offenen Geschaeftstag gleich mit. Ohne ihn meldet der Worker
   * taeglich "ALARM: Property hat keinen offenen Geschaeftstag" -- und er hat
   * recht: ohne offenen Tag laeuft kein Nachtlauf, also wird keine Logis
   * gebucht. Das faellt sonst erst auf, wenn beim Check-out ein zu kleiner
   * Betrag steht, und bemerkt wird es vom Gast.
   *
   * Der Bestand dagegen bleibt hier leer und muss es: inventory_day haengt an
   * Kategorien und Zimmern, und die legt der Kunde selbst an. Der Pflegejob
   * des Workers materialisiert taeglich nach, sobald es welche gibt.
   */
  INSERT INTO business_day (property_id, date) VALUES (v_property, p_business_date);

  /*
   * Der erste Benutzer ist Inhaber, nicht Account-Admin: ihm fehlte sonst
   * account:contract, und damit koennte der Kunde seinen eigenen Vertrag
   * nicht einsehen. Weitere Benutzer legt er danach selbst an.
   *
   * status bleibt auf der Vorgabe 'invited' und das Kennwort leer. Gesetzt
   * wird es ueber den Einladungslink (Migration 0030) -- ein Kennwort, das
   * wir vergeben und per Mail schicken, bliebe im Postfach stehen.
   */
  INSERT INTO app_user (email, display_name)
  VALUES (p_user_email, p_user_name) RETURNING id INTO v_user;

  /*
   * role.account_id ausdruecklich qualifiziert. RETURNS TABLE legt
   * account_id, property_id und user_id als Ausgabeparameter an, und die
   * stehen in jeder Abfrage dieses Rumpfes im selben Namensraum wie die
   * Spalten: unqualifiziert meldet PostgreSQL 42702, "column reference
   * account_id is ambiguous". Wer hier eine Bedingung ergaenzt, qualifiziert
   * sie ebenso.
   */
  SELECT id INTO v_role FROM role
   WHERE role.key = 'owner' AND role.account_id IS NULL;
  INSERT INTO user_account_role (user_id, account_id, role_id)
  VALUES (v_user, v_account, v_role);

  RETURN QUERY SELECT v_account, v_property, v_user;
END $$;

REVOKE ALL ON FUNCTION account_provision(text,text,text,text,text,text,text,text,
  text,text,text,boolean,date,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_provision(text,text,text,text,text,text,text,text,
  text,text,text,boolean,date,text,text) TO hotelpms_app;
