-- Payment-Adapter (Aufgabe 6, Dokument 02 Abschnitt 6.x). Pay-by-Link ist der
-- einzige vorgesehene Weg, eine Buchung zu garantieren, ohne Kartendaten
-- anzufassen. Stripe zuerst; Adyen und Mollie folgen als weitere Werte in den
-- beiden CHECK-Constraints unten, additiv, ohne diese Migration zu aendern.
--
-- Zwei Tabellen, beide bewusst ohne Zeilenrichtlinie:
--
-- payment_intent haelt die Zuordnung einer Zahlungsanfrage zu Property und
-- Folio. Die Benachrichtigung des Anbieters (Webhook) kommt ohne Sitzung und
-- ohne Mandantenkontext herein; sie kennt nur die Anbieter-Referenz. Damit
-- sie ueberhaupt nachschlagen kann, zu welcher Property die Zahlung gehoert,
-- muss diese Tabelle vor Herstellung des Mandantenkontexts lesbar sein -
-- genau das Muster, das user_session und idempotency_key fuer die Anmeldung
-- schon nutzen (0002_tenancy.sql), keine neue Ausnahme.
--
-- payment_event haelt fest, welche Zustellung eines Anbieters bereits einmal
-- ankam. Anbieter wie Stripe senden dieselbe Benachrichtigung wiederholt zu,
-- bis sie quittiert ist; ohne diese Tabelle waere das im Protokoll unsichtbar.
-- Die eigentliche Sperre gegen einen doppelten Zahlungsvermerk ist aber nicht
-- diese Tabelle, sondern der Statusuebergang von payment_intent selbst
-- (pending -> succeeded, einmalig): zwei verschiedene Ereignisse desselben
-- Anbieters fuer dieselbe Zahlung haben unterschiedliche Ereignis-IDs und
-- kaemen an dieser Tabelle vorbei, nicht aber am Statusuebergang.

CREATE TABLE payment_intent (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),
  provider           text   NOT NULL CHECK (provider IN ('stripe')),
  provider_reference text   NOT NULL,
  amount_cent        bigint NOT NULL CHECK (amount_cent > 0),
  status             text   NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','succeeded','failed')),
  settlement_id      bigint REFERENCES settlement(id),
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  UNIQUE (provider, provider_reference)
);
CREATE INDEX payment_intent_folio ON payment_intent (folio_id);

CREATE TABLE payment_event (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('stripe')),
  provider_event_id text NOT NULL,
  payment_intent_id bigint REFERENCES payment_intent(id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

SELECT attach_audit('payment_intent');
