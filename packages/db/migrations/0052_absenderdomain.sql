-- ---------------------------------------------------------------------------
-- 0052 -- Absenderdomain je Haus, mit Freigabe durch die Plattform.
--
-- Anforderung: Gastpost soll vom Hotel kommen, nicht von uns. Ein Gast, der
-- eine Rechnung von "StayGrid" bekommt, weiss nicht, wovon sie handelt, und
-- seine Antwort landet bei uns statt an der Rezeption.
--
-- **Der Einwand, der diesen Entwurf geformt hat**, lautete: das Hotel kann
-- seine Domain nicht in unser Konto beim Anbieter eintragen. Es muss auch
-- nicht, und der Ablauf laeuft andersherum:
--
--   1. Das Haus beantragt eine Domain (status 'requested').
--   2. Wir geben frei oder lehnen ab. Erst die Freigabe meldet die Domain
--      **mit unserem Schluessel** beim Anbieter an; zurueck kommen drei
--      TXT-Eintraege (status 'dns_pending').
--   3. Das Haus traegt diese drei Zeilen bei **seinem eigenen**
--      DNS-Anbieter ein, wo es ohnehin Zugang hat.
--   4. Ein Knopf fragt beim Anbieter nach. Stehen sie, ist die Domain
--      freigeschaltet (status 'active') und erst dann geht Post hinaus.
--
-- Niemand ausserhalb unseres Betriebs sieht je unser Konto oder unseren
-- Schluessel. Was ein Haus beantragt, kostet uns Kontingent beim Anbieter
-- und traegt unseren Ruf als Versender -- deshalb die Freigabe dazwischen
-- und nicht Selbstbedienung.
--
-- **Zwei Wege**, und der zweite ist kein Sonderfall, sondern der Alltag
-- kleiner Haeuser:
--
--   own   -- eigene Domain. Die Post kommt sichtbar vom Hotel, Antworten
--            gehen direkt an die Rezeption. Der Regelfall.
--   relay -- keine eigene Domain, sondern eine Adresse bei GMX, Web.de oder
--            T-Online. Solche Domains lassen sich nicht anmelden, und das
--            ist richtig so: wer es koennte, koennte im Namen jedes
--            GMX-Kunden schreiben. Dann sendet das Haus unter einer
--            Unterdomain von uns, mit seinem Namen davor und seiner echten
--            Adresse als Antwortadresse.
--
-- Eine eigene Domain zur Pflicht zu machen waere die einfachere Tabelle und
-- die falsche Entscheidung: die Haeuser, die keine haben, sind nicht die,
-- die auf Gastpost verzichten koennen.
--
-- Kein Geheimnis in dieser Tabelle: ein DNS-Eintrag ist oeffentlich, sobald
-- er gesetzt ist, und der DKIM-Wert ist der **oeffentliche** Teil des
-- Schluesselpaars -- den privaten haelt der Anbieter. Der Zugang zum
-- Anbieter steht wie bisher in der Umgebung (0028). Deshalb auch kein
-- Eintrag in audit_redaction.
-- ---------------------------------------------------------------------------

CREATE TABLE property_email_domain (
  property_id   bigint PRIMARY KEY REFERENCES property(id),
  mode          text NOT NULL CHECK (mode IN ('own','relay')),
  /*
   * Bei own die Domain des Hauses, bei relay unsere Unterdomain. In beiden
   * Faellen der Teil hinter dem Klammeraffen und nichts sonst.
   */
  domain        text NOT NULL,
  -- Nur bei relay: der Teil davor, also 'wattenblick' in
  -- wattenblick@mail.staygrid.cloud. Bei own steht die ganze Adresse in
  -- property_email_setting.from_email.
  local_part    text,
  /*
   * requested   -- beantragt, wartet auf uns
   * rejected    -- abgelehnt, Grund steht in decision_note
   * dns_pending -- freigegeben und beim Anbieter angemeldet, wartet auf die
   *                DNS-Eintraege des Hauses
   * active      -- vollstaendig, Versand erlaubt
   */
  status        text NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','rejected','dns_pending','active')),
  -- Kennung beim Anbieter. Noetig, um die Domain dort wieder zu entfernen,
  -- wenn ein Haus kuendigt; ohne sie bliebe sie in unserem Konto stehen.
  provider_id   text,
  /*
   * Die Eintraege, wie der Anbieter sie ausgibt: eine Liste aus
   * {host, type, value, ok}. Bewusst als jsonb und nicht in Spalten
   * zerlegt -- welche Eintraege verlangt werden, entscheidet der Anbieter,
   * und heute sind es drei (Anbietercode, DKIM, DMARC). Eine vierte Zeile
   * waere sonst eine Migration statt einer Anzeige.
   */
  dns_records   jsonb NOT NULL DEFAULT '[]'::jsonb,
  /*
   * Zwei getrennte Zustaende, weil der Anbieter sie getrennt fuehrt:
   * verified sagt "die Domain gehoert euch", authenticated sagt "ihr duerft
   * in ihrem Namen signieren". Getrennt angezeigt sieht die Rezeption,
   * welcher der beiden Eintraege noch fehlt -- zusammengefasst zu einem
   * "nicht fertig" muesste sie raten.
   */
  verified      boolean NOT NULL DEFAULT false,
  authenticated boolean NOT NULL DEFAULT false,
  -- Wann zuletzt beim Anbieter nachgefragt wurde. Ohne diese Angabe ist
  -- "noch nicht bestaetigt" nicht von "seit gestern nicht nachgesehen" zu
  -- unterscheiden, und jemand wartet auf eine Pruefung, die nie lief.
  checked_at    timestamptz,

  requested_by  bigint REFERENCES app_user(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  -- Wer freigegeben oder abgelehnt hat. Ein Plattformbenutzer, derselbe
  -- Tabelle wie alle anderen (is_platform_staff).
  decided_by    bigint REFERENCES app_user(id),
  decided_at    timestamptz,
  -- Der Grund einer Ablehnung, und er geht an den Kunden hinaus. Eine
  -- Ablehnung ohne Grund erzeugt eine Rueckfrage, und die kostet mehr Zeit
  -- als der Satz beim Ablehnen.
  decision_note text,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Mindestpruefung an der Quelle. Der Anbieter weist Unsinn ohnehin ab,
  -- aber eine Fehlermeldung aus einem fremden System ist schwerer zu lesen
  -- als eine aus dem eigenen.
  CONSTRAINT property_email_domain_form CHECK (
    domain = lower(domain) AND domain !~ '[@[:space:]]' AND domain ~ '\.'
  ),
  -- relay ohne Namensteil waere eine Adresse, die aus dem Klammeraffen
  -- beginnt; own mit Namensteil waere eine Angabe, die niemand liest.
  CONSTRAINT property_email_domain_teil CHECK (
    (mode = 'relay' AND local_part ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$')
    OR (mode = 'own' AND local_part IS NULL)
  ),
  -- Eine Ablehnung ohne Grund ist keine Antwort.
  CONSTRAINT property_email_domain_grund CHECK (
    status <> 'rejected' OR nullif(btrim(coalesce(decision_note,'')), '') IS NOT NULL
  )
);

COMMENT ON TABLE property_email_domain IS
  'Beim Anbieter angemeldete Absenderdomain des Hauses, nach Freigabe durch '
  'die Plattform. Die DNS-Eintraege setzt das Haus bei seinem eigenen Anbieter.';

COMMENT ON COLUMN property_email_domain.dns_records IS
  'Liste aus {host,type,value,ok}, wie der Anbieter sie ausgibt. Oeffentlich.';

/*
 * Eine eigene Domain gehoert genau einem Haus. Zwei Haeuser mit derselben
 * waeren kein technisches Problem beim Anbieter, aber ein fachliches hier:
 * die Pruefung des einen wuerde den Stand des anderen ueberschreiben.
 *
 * Eine abgelehnte Zeile blockiert nicht mit: sonst koennte ein Haus eine
 * Domain durch einen abgelehnten Antrag fuer immer belegen.
 */
CREATE UNIQUE INDEX property_email_domain_domain
  ON property_email_domain (domain) WHERE mode = 'own' AND status <> 'rejected';

/*
 * Bei relay teilen sich alle Haeuser dieselbe Unterdomain von uns,
 * unterschieden nur durch den Teil vor dem Klammeraffen. Der muss deshalb
 * eindeutig sein -- zwei "rezeption@" waeren zwei Haeuser in einem Postfach.
 */
CREATE UNIQUE INDEX property_email_domain_teil_eindeutig
  ON property_email_domain (domain, local_part)
  WHERE mode = 'relay' AND status <> 'rejected';

-- Der Arbeitsvorrat der Plattform: offene Antraege, aelteste zuerst.
CREATE INDEX property_email_domain_offen
  ON property_email_domain (requested_at) WHERE status = 'requested';

-- ---------------------------------------------------------------------------
-- Zeilenrichtlinie. FORCE, sonst umgeht der Eigentuemer sie (wie 0028).
--
-- Die Plattformseite kommt nicht ueber die Richtlinie an die Zeilen, sondern
-- ueber die Funktionen weiter unten: eine Plattformsitzung hat keinen
-- Mandantenkontext, ein Lesen ohne Kontext liefert hier nichts -- still und
-- ohne Fehlermeldung. Genau der Fehler, der in diesem System schon zweimal
-- passiert ist (Migrationen 0014, 0018).
-- ---------------------------------------------------------------------------

ALTER TABLE property_email_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_email_domain FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON property_email_domain
  USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('property_email_domain');

-- ---------------------------------------------------------------------------
-- Darf dieses Haus von dieser Adresse senden?
--
-- Als Funktion und nicht als Bedingung in der Route, weil die Antwort an
-- zwei Stellen gebraucht wird: beim Einschalten des Versands und beim
-- Einreihen jeder einzelnen Nachricht. Zweimal dieselbe Bedingung von Hand
-- ist die Bauart, bei der eine der beiden Stellen spaeter nachzieht und die
-- andere nicht.
--
-- Leere Adresse ergibt false, nicht null: der Aufrufer soll nicht zwischen
-- "nein" und "keine Angabe" unterscheiden muessen, um zu wissen, dass er
-- nicht senden darf.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION email_sender_allowed(
  p_property_id bigint, p_from_email text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM property_email_domain d
     WHERE d.property_id = p_property_id
       AND d.status = 'active'
       -- Gleichheit auf der Domain, nicht Endung: wer auf `hotel.de` endet,
       -- ist auch `nicht-mein-hotel.de`.
       AND lower(split_part(COALESCE(p_from_email, ''), '@', 2)) = d.domain
       -- Bei relay zaehlt zusaetzlich der Namensteil. Ohne diese Bedingung
       -- koennte jedes Haus unter der Unterdomain als jedes andere senden.
       AND (d.mode = 'own'
            OR lower(split_part(COALESCE(p_from_email, ''), '@', 1)) = d.local_part)
  );
$$;

COMMENT ON FUNCTION email_sender_allowed(bigint, text) IS
  'Ist die Absenderadresse durch eine freigeschaltete Domain des Hauses gedeckt?';

-- ---------------------------------------------------------------------------
-- Einreihen prueft die Absenderdomain mit.
--
-- Neu gegenueber 0028 ist allein der dritte Block. Er steht hier und nicht
-- nur in der Route, weil eine ungedeckte Absenderadresse **still**
-- schiefgeht: der Anbieter nimmt die Nachricht an, signiert sie mit einer
-- fremden Domain, die Pruefung beim Empfaenger schlaegt fehl, die Post
-- landet im Werbeordner -- und der Versand meldet Erfolg. Niemand erfaehrt
-- es, bis ein Gast anruft und sagt, er habe seine Rechnung nie bekommen.
--
-- Genau diese Sorte Fehler gehoert in die Datenbank und nicht in eine
-- Route: sie faellt nirgends von selbst auf.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION email_enqueue(
  p_property_id bigint,
  p_kind        text,
  p_to_email    text,
  p_to_name     text,
  p_subject     text,
  p_body_text   text,
  p_body_html   text,
  p_invoice_id  bigint,
  p_reservation_id bigint,
  p_requested_by bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_ref      text;
  v_training boolean;
  v_enabled  boolean;
  v_from     text;
BEGIN
  SELECT p.is_training INTO v_training FROM property p WHERE p.id = p_property_id;
  IF v_training IS NULL THEN
    RAISE EXCEPTION 'Property % liegt nicht im Kontext', p_property_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_training THEN
    RAISE EXCEPTION 'Ein Uebungshaus verschickt keine E-Mail'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.enabled, s.from_email INTO v_enabled, v_from
    FROM property_email_setting s WHERE s.property_id = p_property_id;
  IF COALESCE(v_enabled, false) = false THEN
    RAISE EXCEPTION 'Der E-Mail-Versand ist fuer dieses Haus nicht eingeschaltet'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT email_sender_allowed(p_property_id, v_from) THEN
    RAISE EXCEPTION 'Die Absenderdomain % ist nicht freigeschaltet',
      split_part(COALESCE(v_from, ''), '@', 2)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO outbound_email (property_id, kind, to_email, to_name, subject,
                              body_text, body_html, invoice_id, reservation_id,
                              requested_by)
  VALUES (p_property_id, p_kind, p_to_email, p_to_name, p_subject,
          p_body_text, p_body_html, p_invoice_id, p_reservation_id, p_requested_by)
  RETURNING public_ref INTO v_ref;

  RETURN v_ref;
END $$;

-- ---------------------------------------------------------------------------
-- Eine neue Art Plattformpost: der Hinweis auf offene Antraege.
--
-- **Nur ein Hinweis, keine Anfrage.** Entschieden wird im Adminpanel, wo
-- die Zeile mit allem steht, was zur Entscheidung gehoert -- welches Haus,
-- welche Domain, wer sie beantragt hat. Die Mail sagt lediglich, dass es
-- etwas zu entscheiden gibt. Eine Freigabe per Antwortmail waere die
-- naheliegende Bequemlichkeit und die schlechtere Bauart: sie hinge an
-- einem Postfach, das niemand absichert, und sie laesst sich faelschen.
--
-- Sie geht an **ein Postfach**, nicht an Personen. Deshalb darf user_id
-- hier fehlen: an info@staygrid.cloud haengt kein Benutzerkonto, und einen
-- anzulegen, nur damit eine Fremdschluesselspalte gefuellt ist, waere ein
-- Konto, das sich anmelden koennte.
-- ---------------------------------------------------------------------------

ALTER TABLE platform_email ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN platform_email.user_id IS
  'Empfaenger, falls es einer ist. Leer bei Post an ein Postfach der '
  'Plattform selbst, etwa dem Hinweis auf offene Freigaben.';

ALTER TABLE platform_email DROP CONSTRAINT platform_email_kind_check;
ALTER TABLE platform_email ADD CONSTRAINT platform_email_kind_check
  CHECK (kind IN ('invite', 'password_reset', 'support_request',
                  'domain_request'));

-- Wer keinen Benutzer hat, ist Post an uns. Wer einen hat, ist Post an ihn.
-- Die Bedingung haelt fest, dass das kein Zufall ist.
ALTER TABLE platform_email ADD CONSTRAINT platform_email_empfaenger_check
  CHECK (user_id IS NOT NULL OR kind = 'domain_request');

-- ---------------------------------------------------------------------------
-- Den Hinweis einreihen, ohne dem Kunden die Plattform zu oeffnen.
--
-- SECURITY DEFINER, weil der Aufrufer eine Kundensitzung ist: sie darf in
-- platform_email schreiben, aber sie soll dabei weder einen Empfaenger
-- bestimmen noch erfahren, wer bei uns arbeitet. Deshalb nimmt die Funktion
-- die Zieladresse entgegen und sonst nichts Personenbezogenes.
--
-- Hoechstens ein offener Hinweis: liegt schon einer in der Warteschlange,
-- entsteht kein zweiter. Zehn Antraege an einem Vormittag sollen zehn
-- Zeilen im Adminpanel ergeben und eine Mail, nicht zehn.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform_notice_enqueue(
  p_to_email text, p_subject text, p_body_text text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_email
              WHERE kind = 'domain_request' AND status = 'pending') THEN
    RETURN false;
  END IF;
  INSERT INTO platform_email (user_id, kind, to_email, to_name, subject, body_text)
  VALUES (NULL, 'domain_request', p_to_email, NULL, p_subject, p_body_text);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION platform_notice_enqueue(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_notice_enqueue(text, text, text) TO hotelpms_app;

COMMENT ON FUNCTION platform_notice_enqueue(text, text, text) IS
  'Reiht einen Hinweis an ein Postfach der Plattform ein. Hoechstens einen '
  'offenen gleichzeitig, damit ein Andrang nicht zu einer Flut wird.';

-- ---------------------------------------------------------------------------
-- Die Plattformseite: Arbeitsvorrat und Entscheidung.
--
-- Als Funktionen und nicht als Abfragen in der Route, aus demselben Grund
-- wie bei den Supportsitzungen (0032): eine Plattformsitzung hat keinen
-- Mandantenkontext. Ein JOIN auf `account` oder `property` liefert dort
-- nichts -- still und ohne Fehlermeldung.
--
-- SECURITY DEFINER mit `SET search_path = public` und einer Pruefung ueber
-- platform_can() **in** der Funktion: das Recht wird nicht als Parameter
-- entgegengenommen, sonst waere es keine Pruefung, sondern eine Angabe.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform_email_domains(p_status text DEFAULT NULL)
RETURNS TABLE (
  property_id bigint, property_name text, account_id bigint, account_name text,
  mode text, domain text, local_part text, status text,
  verified boolean, authenticated boolean, dns_records jsonb,
  requested_by_name text, requested_at timestamptz,
  decided_by_name text, decided_at timestamptz, decision_note text,
  checked_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.property_id, p.name, a.id, a.name,
         d.mode, d.domain, d.local_part, d.status,
         d.verified, d.authenticated, d.dns_records,
         ru.display_name, d.requested_at,
         du.display_name, d.decided_at, d.decision_note,
         d.checked_at
    FROM property_email_domain d
    JOIN property p       ON p.id = d.property_id
    JOIN account  a       ON a.id = p.account_id
    LEFT JOIN app_user ru ON ru.id = d.requested_by
    LEFT JOIN app_user du ON du.id = d.decided_by
   WHERE platform_can('platform:accounts')
     AND (p_status IS NULL OR d.status = p_status)
   -- Offene zuerst, und innerhalb davon die aeltesten: wer am laengsten
   -- wartet, wartet sonst weiter.
   ORDER BY (d.status = 'requested') DESC, d.requested_at;
$$;

REVOKE ALL ON FUNCTION platform_email_domains(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_email_domains(text) TO hotelpms_app;

COMMENT ON FUNCTION platform_email_domains(text) IS
  'Antraege auf eine Absenderdomain, fuer das Adminpanel. Prueft das '
  'Plattformrecht selbst.';

/*
 * Freigeben.
 *
 * Bei own erst nach der Anmeldung beim Anbieter: die Kennung und die
 * DNS-Eintraege kommen von dort und werden hier nur festgehalten. Die
 * Reihenfolge ist wichtig -- eine Freigabe ohne Eintraege waere ein Haus,
 * dem wir sagen "fertig", das aber nichts einzutragen hat.
 *
 * Bei relay gibt es nichts anzumelden: unsere Unterdomain ist beim Anbieter
 * einmal hinterlegt, und das Haus bekommt nur einen Namensteil darunter.
 * Deshalb dort sofort 'active'.
 */
CREATE OR REPLACE FUNCTION platform_email_domain_approve(
  p_property_id bigint, p_provider_id text DEFAULT NULL,
  p_dns_records jsonb DEFAULT '[]'::jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text; v_status text;
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'Kein Plattformrecht platform:accounts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT mode, status INTO v_mode, v_status
    FROM property_email_domain WHERE property_id = p_property_id;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'Kein Antrag fuer Property %', p_property_id
      USING ERRCODE = 'no_data_found';
  END IF;
  -- Nur ein offener Antrag laesst sich freigeben. Eine zweite Freigabe
  -- wuerde eine bereits gesetzte Kennung beim Anbieter ueberschreiben.
  IF v_status <> 'requested' THEN
    RAISE EXCEPTION 'Antrag fuer Property % steht auf %', p_property_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE property_email_domain
     SET status = CASE WHEN v_mode = 'relay' THEN 'active' ELSE 'dns_pending' END,
         provider_id = COALESCE(p_provider_id, provider_id),
         dns_records = p_dns_records,
         -- Bei relay gilt beides als gegeben: bestaetigt und signierfaehig
         -- ist unsere eigene Unterdomain, nicht die des Hauses.
         verified = (v_mode = 'relay'),
         authenticated = (v_mode = 'relay'),
         decided_by = app_user_id(), decided_at = now(), updated_at = now()
   WHERE property_id = p_property_id;

  RETURN CASE WHEN v_mode = 'relay' THEN 'active' ELSE 'dns_pending' END;
END $$;

REVOKE ALL ON FUNCTION platform_email_domain_approve(bigint, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_email_domain_approve(bigint, text, jsonb) TO hotelpms_app;

/*
 * Ablehnen. Der Grund ist Pflicht und geht an den Kunden hinaus -- eine
 * Ablehnung ohne Grund erzeugt eine Rueckfrage, und die kostet mehr Zeit
 * als der Satz beim Ablehnen.
 */
CREATE OR REPLACE FUNCTION platform_email_domain_reject(
  p_property_id bigint, p_note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT platform_can('platform:accounts') THEN
    RAISE EXCEPTION 'Kein Plattformrecht platform:accounts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Eine Ablehnung braucht einen Grund'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE property_email_domain
     SET status = 'rejected', decision_note = btrim(p_note),
         decided_by = app_user_id(), decided_at = now(), updated_at = now()
   WHERE property_id = p_property_id AND status = 'requested';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kein offener Antrag fuer Property %', p_property_id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

REVOKE ALL ON FUNCTION platform_email_domain_reject(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_email_domain_reject(bigint, text) TO hotelpms_app;
