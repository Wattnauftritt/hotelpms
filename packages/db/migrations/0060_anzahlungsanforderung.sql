-- ---------------------------------------------------------------------------
-- 0060 -- Anzahlung anfordern, Zahlungslink zuordnen, Link per Gastpost.
--
-- Anforderung: Dokument 16, AP 12 "Offen: Anzahlung, Pay-by-Link". Die
-- Schnittstelle konnte einen Zahlungslink erzeugen (0021) und aus einem
-- Zahlungseingang eine Anzahlungsrechnung machen (0027, 0029). Was fehlte,
-- ist der Vorgang davor: dass ein Haus von einem Gast **bis zu einem Tag**
-- einen **Betrag** verlangt. Ohne diesen Datensatz gibt es kein
-- "ueberfaellig" -- ein Link weiss nicht, wann er haette bezahlt sein
-- muessen, und ein Zahlungseingang weiss nicht, wofuer er kam.
--
-- Bewusst **keine** dritte Buchungsart neben charge und settlement. Eine
-- Anforderung ist eine Forderung, keine Tatsache: sie bewegt kein Geld und
-- schuldet keine Steuer. Die Steuer entsteht mit dem Zufluss (Paragraph 13
-- Abs. 1 Nr. 1a UStG), und der steht weiterhin als settlement und, sobald
-- die Anzahlungsrechnung ausgestellt ist, im Anzahlungsjournal. Daran baut
-- diese Migration nichts vorbei.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Die Anforderung.
-- ---------------------------------------------------------------------------

CREATE TABLE deposit_request (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_ref     text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  property_id    bigint NOT NULL REFERENCES property(id),
  folio_id       bigint NOT NULL REFERENCES folio(id),
  -- Die Reservierung ist Pflicht: eine Anzahlung ist eine Anzahlung **auf**
  -- einen Aufenthalt, und ohne ihn fehlt der Leistungszeitraum, den die
  -- Anzahlungsrechnung spaeter braucht (Paragraph 14 Abs. 4 Nr. 6 UStG).
  reservation_id bigint NOT NULL REFERENCES reservation(id),

  -- Der geforderte Betrag, fest ab der Anlage. Auch bei einer Anforderung
  -- in Prozent: aendert sich danach der Aufenthalt, aendert sich nicht still
  -- die Forderung, die der Gast schon in der Hand hat.
  amount_cent    bigint NOT NULL CHECK (amount_cent > 0),
  -- Nur bei einer Anforderung in Prozent: der Satz und der Aufenthaltspreis,
  -- aus dem gerechnet wurde. Beides zusammen oder keines -- ein Satz ohne
  -- Grundlage laesst sich nicht nachrechnen.
  percent_bp     integer CHECK (percent_bp IS NULL OR (percent_bp > 0 AND percent_bp <= 10000)),
  basis_cent     bigint  CHECK (basis_cent IS NULL OR basis_cent > 0),
  CONSTRAINT deposit_request_percent CHECK ((percent_bp IS NULL) = (basis_cent IS NULL)),

  -- Ein Kalendertag, kein Zeitpunkt. Ueberfaellig ist, was am Geschaeftstag
  -- danach noch offen ist -- nicht um Mitternacht einer Zeitzone.
  due_date       date NOT NULL,

  created_by     bigint REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Zurueckgezogen statt geloescht: wer fragt, warum ein Gast nicht
  -- gemahnt wurde, soll die Anforderung noch finden.
  canceled_at    timestamptz,
  canceled_by    bigint REFERENCES app_user(id),
  CONSTRAINT deposit_request_cancel CHECK ((canceled_at IS NULL) = (canceled_by IS NULL))
);
CREATE INDEX deposit_request_folio ON deposit_request (folio_id);
-- Fuer die Frage "was ist heute ueberfaellig" je Haus, wie sie eine
-- Tagesliste stellen wird.
CREATE INDEX deposit_request_due ON deposit_request (property_id, due_date)
  WHERE canceled_at IS NULL;

ALTER TABLE deposit_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON deposit_request USING (property_id = ANY (app_property_ids()));

-- Keine Spalte bezeichnet einen Menschen ausser ueber Verweise; nichts
-- davon gehoert auf die Redaktionsliste (CLAUDE.md, 0044).
SELECT attach_audit('deposit_request');

-- ---------------------------------------------------------------------------
-- 2. Welcher Zahlungseingang zu welcher Anforderung gehoert.
-- ---------------------------------------------------------------------------
--
-- Eine eigene Tabelle und keine Spalte an settlement: settlement ist
-- Haertegrad 1, und der einzige erlaubte Uebergang dort ist invoice_id von
-- NULL auf einen Wert (0012). Eine Ueberweisung kommt aber an, **bevor**
-- jemand sie zuordnet -- die Zuordnung ist ein spaeterer, eigener Vorgang.
--
-- Bewusst ausdruecklich und nicht erschlossen: alle Eingaenge eines Folios
-- der Reihe nach auf die Anforderungen zu verteilen, saehe bequem aus und
-- rechnete nach der Anreise jedes bezahlte Minibar-Wasser als Anzahlung.
-- Das ergaebe keine Fehlermeldung, sondern eine plausibel aussehende
-- falsche Zahl.

CREATE TABLE deposit_request_settlement (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),
  deposit_request_id bigint NOT NULL REFERENCES deposit_request(id),
  settlement_id      bigint NOT NULL REFERENCES settlement(id),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Ein Eingang zaehlt fuer hoechstens eine Anforderung. Der Index ist der
  -- eigentliche Schutz gegen doppelte Zuordnung unter Nebenlaeufigkeit --
  -- Webhook und Rezeption koennen gleichzeitig zugreifen.
  CONSTRAINT deposit_request_settlement_once UNIQUE (settlement_id)
);
CREATE INDEX deposit_request_settlement_request
  ON deposit_request_settlement (deposit_request_id);
CREATE INDEX deposit_request_settlement_folio ON deposit_request_settlement (folio_id);

ALTER TABLE deposit_request_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_request_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON deposit_request_settlement
  USING (property_id = ANY (app_property_ids()));

-- Eine Zuordnung ist festgehalten, nicht verhandelbar: wer sie
-- zurueckdrehen koennte, koennte eine Anforderung nachtraeglich offen
-- erscheinen lassen, die laengst bezahlt ist.
SELECT make_append_only('deposit_request_settlement');
SELECT attach_audit('deposit_request_settlement');

-- ---------------------------------------------------------------------------
-- 3. Der Zahlungslink kennt seine Anforderung, seine Frist und seine Mail.
-- ---------------------------------------------------------------------------
--
-- Die Adresse des Links wird weiterhin **nicht** gespeichert (Begruendung
-- am Vertrag `PaymentLink`): ein gespeicherter Link ist ein Link, den jeder
-- mit Lesezugriff einloesen kann. Deshalb geht ein Link nur **beim
-- Erzeugen** per Gastpost hinaus, nie nachtraeglich.
--
-- expires_at kommt vom Anbieter. Ein Stripe-Checkout gilt hoechstens 24
-- Stunden; ohne die Angabe stuende ein laengst toter Link als "offen" da,
-- solange die Ablaufmeldung des Anbieters ausbleibt.
--
-- 'canceled' ist neu: ein Link, den das Haus beim Anbieter ungueltig
-- gemacht hat. Getrennt von 'failed', weil das eine eine Entscheidung des
-- Hauses ist und das andere ein Ereignis beim Gast.

ALTER TABLE payment_intent
  ADD COLUMN deposit_request_id bigint REFERENCES deposit_request(id),
  ADD COLUMN expires_at         timestamptz,
  ADD COLUMN canceled_at        timestamptz,
  ADD COLUMN canceled_by        bigint REFERENCES app_user(id),
  ADD COLUMN email_id           bigint REFERENCES outbound_email(id);
CREATE INDEX payment_intent_deposit_request ON payment_intent (deposit_request_id)
  WHERE deposit_request_id IS NOT NULL;

ALTER TABLE payment_intent DROP CONSTRAINT payment_intent_status_check;
ALTER TABLE payment_intent ADD CONSTRAINT payment_intent_status_check
  CHECK (status IN ('pending','succeeded','failed','canceled'));

-- ---------------------------------------------------------------------------
-- 4. Eine neue Art Gastpost: der Zahlungslink.
-- ---------------------------------------------------------------------------
--
-- Mit Reservierungsbezug, wie die Buchungsbestaetigung. Das ist nicht nur
-- Ordnung: `guest_erase_one()` (0046) findet Gastpost ueber die
-- Reservierung oder die Rechnung. Eine Zahlungsmail ohne Bezug ueberlebte
-- die Loeschung des Gastes mit Name und Adresse.

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_kind_check;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_kind_check
  CHECK (kind IN ('invoice','reservation_confirmation','payment_link'));

ALTER TABLE outbound_email DROP CONSTRAINT outbound_email_bezug;
ALTER TABLE outbound_email ADD CONSTRAINT outbound_email_bezug CHECK (
  (kind = 'invoice' AND invoice_id IS NOT NULL) OR
  (kind IN ('reservation_confirmation','payment_link') AND reservation_id IS NOT NULL));
