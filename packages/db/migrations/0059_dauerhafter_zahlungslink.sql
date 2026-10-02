-- ---------------------------------------------------------------------------
-- 0059 -- Ein Zahlungslink, der bis zur Frist haelt.
--
-- Anforderung des Nutzers: ein Zahlungslink darf nicht nach 24 Stunden tot
-- sein. Bisher bekam der Gast die Adresse eines Stripe-Checkouts, und ein
-- Checkout gilt beim Anbieter hoechstens 24 Stunden. Fuer eine Anzahlung,
-- die in zwei Wochen faellig ist, war der Link in der Mail damit am
-- zweiten Tag wertlos -- und der Gast merkte es erst beim Bezahlen.
--
-- Jetzt bekommt der Gast einen Link **von uns** (`/v1/pay?t=<token>`). Er
-- gilt bis zur Frist und laesst sich widerrufen. Erst beim Oeffnen entsteht
-- ein Checkout beim Anbieter, ueber den Betrag, der dann noch offen ist.
--
-- **Zur Nummer.** Diese Migration liegt vor 0060 (Anzahlungsanforderung),
-- wurde aber danach geschrieben. Auf einer frischen Datenbank laeuft sie
-- deshalb **vor** 0060, auf einer bestehenden danach. Sie darf von 0060
-- nichts voraussetzen, was beim Anlegen geprueft wird: `deposit_request`
-- gibt es bei einem frischen Aufbau zu diesem Zeitpunkt noch nicht. Der
-- Verweis darauf ist deshalb keine Fremdschluesselbedingung, sondern wird
-- von einem Trigger geprueft, dessen Rumpf erst beim Einfuegen aufgeloest
-- wird (siehe unten). Wer eine spaetere Migration schreibt, kann ihn durch
-- eine echte Bedingung ersetzen.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_link (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),

  /*
   * Nur der Hash, nie das Token. Wer die Datenbank liest -- eine Sicherung,
   * ein Auszug, ein Angreifer mit Leserecht --, kann damit nichts bezahlen
   * lassen und nichts ueber den Gast erfahren. SHA-256 genuegt: 256 Bit
   * Zufall lassen sich nicht durchprobieren (wie auth_token, 0030).
   *
   * NULL nach Widerruf oder Loeschung des Gastes: dann gibt es nichts
   * mehr, das sich einloesen liesse, und auch keinen Hash, der zu einer
   * alten Mail passt.
   */
  token_hash         text UNIQUE,

  /*
   * Worauf gezahlt wird: entweder eine Anzahlungsanforderung -- dann ist
   * der Betrag beim Oeffnen, was von ihr noch offen ist -- oder ein fester
   * Betrag, etwa der offene Saldo vor der Abreise.
   *
   * Ohne Fremdschluessel, siehe Kopf; `payment_link_check_request` prueft.
   */
  deposit_request_id bigint,
  -- Der Betrag beim Anlegen. Bei einer Anforderung nur zur Anzeige: der
  -- Gast zahlt beim Oeffnen den Rest, der dann offen ist.
  amount_cent        bigint NOT NULL CHECK (amount_cent > 0),

  /*
   * Ein Kalendertag, gegen den Geschaeftstag geprueft. Begruendung der
   * Frist in `paymentLinkValidUntil` (packages/domain/src/depositRequest.ts).
   */
  valid_until        date NOT NULL,

  revoked_at         timestamptz,
  revoked_by         bigint REFERENCES app_user(id),
  -- Die Gastpost mit diesem Link, falls er verschickt wurde.
  email_id           bigint REFERENCES outbound_email(id),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Ein widerrufener Link hat keinen Hash mehr; ein gueltiger muss einen
  -- haben, sonst waere er nie einzuloesen.
  CONSTRAINT payment_link_revoked CHECK (revoked_at IS NOT NULL OR token_hash IS NOT NULL)
);
CREATE INDEX payment_link_folio ON payment_link (folio_id);
CREATE INDEX payment_link_request ON payment_link (deposit_request_id)
  WHERE deposit_request_id IS NOT NULL;

ALTER TABLE payment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON payment_link USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('payment_link');

-- Der Hash ist ein Geheimnis: mit ihm laesst sich zwar nicht bezahlen, aber
-- im Audit stuende er ueber jede Loeschung hinaus (CLAUDE.md, 0044).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('payment_link', 'token_hash', 'Hash eines Zahlungslinks, Geheimnis')
ON CONFLICT DO NOTHING;

/*
 * Der Verweis auf die Anforderung, zur Laufzeit geprueft.
 *
 * Der Rumpf einer plpgsql-Funktion wird erst beim Aufruf aufgeloest; dass
 * `deposit_request` beim Anlegen dieser Funktion auf einer frischen
 * Datenbank noch nicht existiert, stoert deshalb nicht. Geprueft wird unter
 * der Zeilenrichtlinie des Aufrufers: eine fremde Anforderung ist damit
 * genauso wenig zu finden wie eine erfundene.
 */
CREATE OR REPLACE FUNCTION payment_link_check_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deposit_request_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM deposit_request d
        WHERE d.id = NEW.deposit_request_id
          AND d.folio_id = NEW.folio_id
          AND d.property_id = NEW.property_id) THEN
    RAISE EXCEPTION 'Anzahlungsanforderung % gehoert nicht zu Folio %',
      NEW.deposit_request_id, NEW.folio_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payment_link_check_request
  BEFORE INSERT OR UPDATE OF deposit_request_id ON payment_link
  FOR EACH ROW EXECUTE FUNCTION payment_link_check_request();

/*
 * Der einzige Weg von einem Token zu seinem Haus.
 *
 * Die Seite, die der Gast oeffnet, kommt ohne Sitzung und ohne
 * Mandantenkontext -- den gibt es erst, wenn bekannt ist, zu welchem Haus
 * der Link gehoert. Das ist dasselbe Henne-Ei-Problem wie in 0018, und es
 * wird genauso geloest: eng, nur fuer **einen** Hash, und nur Kennungen.
 * Aufzaehlen laesst sich damit nichts.
 */
CREATE OR REPLACE FUNCTION payment_link_scope(p_hash text)
RETURNS TABLE (link_id bigint, property_id bigint, account_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.property_id, p.account_id
    FROM payment_link l JOIN property p ON p.id = l.property_id
   WHERE l.token_hash = p_hash;
$$;

COMMENT ON FUNCTION payment_link_scope(text) IS
  'Loest einen Zahlungslink zu Haus und Account auf. SECURITY DEFINER, weil der Gast ohne Kontext kommt. Nur ein Hash, nur Kennungen.';

-- ---------------------------------------------------------------------------
-- Die Checkouts eines Links.
--
-- Je Link hoechstens **ein** offener Checkout beim Anbieter. Das ist die
-- eigentliche Sperre gegen eine Doppelzahlung: zwei offene Checkouts
-- derselben Anforderung koennte der Gast beide bezahlen, und der Webhook
-- darf eine echte Zahlung nicht verwerfen -- das Geld ist dann da. Die
-- Route schliesst einen alten Checkout beim Anbieter, bevor sie einen neuen
-- anlegt; der Index haelt fest, dass das niemand umgeht.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Das Token in der Gastpost.
--
-- Die Mail muss den Link enthalten, und `outbound_email` haelt den
-- gerenderten Rumpf, bis der Worker ihn zustellt (0028). Danach braucht ihn
-- niemand mehr im Klartext: was verschickt wurde, laesst sich auch ohne das
-- Token belegen, und mit ihm koennte jeder mit Leserecht den Link bis zur
-- Frist einloesen. Sobald die Nachricht nicht mehr wartet -- zugestellt,
-- aufgegeben, zurueckgezogen --, wird das Token im Rumpf ersetzt.
--
-- Als Trigger und nicht im Worker: drei Wege setzen den Endzustand (Worker
-- zweimal, die Route zum Zurueckziehen einmal), und ein vergessener Weg
-- liesse das Token stehen, ohne dass es jemand merkt. Die Bedingung `WHEN`
-- haelt die Massenaenderungen beim Abholen heraus, die den Zustand nicht
-- wechseln.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outbound_email_strip_pay_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.body_text := regexp_replace(NEW.body_text, 't=[A-Za-z0-9_-]{43}', 't=[entfernt]', 'g');
  IF NEW.body_html IS NOT NULL THEN
    NEW.body_html := regexp_replace(NEW.body_html, 't=[A-Za-z0-9_-]{43}', 't=[entfernt]', 'g');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_email_strip_pay_token
  BEFORE UPDATE OF status ON outbound_email
  FOR EACH ROW
  WHEN (NEW.kind = 'payment_link' AND NEW.status IN ('sent','failed','canceled'))
  EXECUTE FUNCTION outbound_email_strip_pay_token();

ALTER TABLE payment_intent ADD COLUMN payment_link_id bigint REFERENCES payment_link(id);
CREATE UNIQUE INDEX payment_intent_one_open_per_link
  ON payment_intent (payment_link_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Loeschung des Gastes erfasst seine Zahlungslinks.
--
-- Ein Link nennt den Gast nicht, aber er fuehrt zu seinem Aufenthalt: wer die
-- alte Mail findet, saehe Haus, Zeitraum und Betrag. Nach einer Loeschung
-- soll er ins Leere fuehren. Widerrufen und der Hash entfernt -- in beiden
-- Fassungen der Loeschung, denn auch die aufgeschobene haelt den Link nicht
-- fuer eine Aufbewahrungsfrist vor.
--
-- Beide Funktionen werden vollstaendig neu gefasst (Stand 0046), ergaenzt
-- allein um den Block zu payment_link. Eine Stelle, nicht drei (CLAUDE.md).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payment_link_revoke_for_guest(p_guest bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE payment_link l
     SET token_hash = NULL, revoked_at = COALESCE(l.revoked_at, now())
   WHERE l.token_hash IS NOT NULL
     AND EXISTS (SELECT 1 FROM folio f
                   JOIN reservation r ON r.id = f.reservation_id
                  WHERE f.id = l.folio_id AND r.primary_guest_id = p_guest);
$$;

COMMENT ON FUNCTION payment_link_revoke_for_guest(bigint) IS
  'Teil der Loeschung eines Gastes; nur aus guest_erase_one und guest_erase_partial aufgerufen.';

CREATE OR REPLACE FUNCTION guest_erase_one(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Fremder Account: nichts tun. Kein Fehler, damit ein Stapellauf nicht an
  -- einer Zeile haengenbleibt, die ihn ohnehin nichts angeht.
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  DELETE FROM registration        WHERE guest_id = p_guest;

  -- Die Zeile bleibt: **dass** zugestimmt wurde und wann, ist der Nachweis,
  -- um den es geht. Das Bild der Unterschrift ist es nicht.
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  -- Gastpost, unabhaengig vom Alter. Derselbe Marker wie in
  -- `email_redact_old`, damit beide Wege dasselbe Ergebnis hinterlassen.
  UPDATE outbound_email e
     SET to_email = 'entfernt@invalid', to_name = NULL,
         body_text = '', body_html = NULL, redacted_at = now()
   WHERE e.redacted_at IS NULL
     AND (EXISTS (SELECT 1 FROM reservation r
                   WHERE r.id = e.reservation_id AND r.primary_guest_id = p_guest)
          OR EXISTS (SELECT 1 FROM invoice i
                       JOIN folio f ON f.id = i.folio_id
                       JOIN reservation r2 ON r2.id = f.reservation_id
                      WHERE i.id = e.invoice_id AND r2.primary_guest_id = p_guest));

  -- Zahlungslinks fuehren danach ins Leere (0059).
  PERFORM payment_link_revoke_for_guest(p_guest);

  UPDATE guest
     SET last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
         birth_date = NULL, nationality = NULL, address_line1 = NULL,
         postal_code = NULL, city = NULL, country = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         status = 'anonymized', anonymized_at = now(), updated_at = now()
   WHERE id = p_guest;
END $$;

CREATE OR REPLACE FUNCTION guest_erase_partial(p_guest bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM guest
                  WHERE id = p_guest AND account_id = ANY (app_account_ids())) THEN
    RETURN;
  END IF;

  DELETE FROM guest_property_note WHERE guest_id = p_guest;
  DELETE FROM registration        WHERE guest_id = p_guest;
  UPDATE guest_agreement SET signature_svg = NULL
   WHERE guest_id = p_guest AND signature_svg IS NOT NULL;

  -- Ein Zahlungslink ist kein Nachweis, den eine Frist haelt (0059).
  PERFORM payment_link_revoke_for_guest(p_guest);

  UPDATE guest
     SET email = NULL, phone = NULL, birth_date = NULL, nationality = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         erasure_requested_at = COALESCE(erasure_requested_at, now()),
         updated_at = now()
   WHERE id = p_guest;
END $$;
