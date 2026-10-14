-- ---------------------------------------------------------------------------
-- 0167 -- Jedes Haus verbindet sein eigenes Stripe-Konto (Stripe Connect).
--
-- Anforderung von Sven, 14.10.2026: StayGrid soll als SaaS an andere Hotels
-- gehen, und die Plattform will deren Zahlungen nicht verwalten. Bisher lief
-- jeder Checkout ueber das eine Stripe-Konto der Plattform (0021, 0068) --
-- das Geld jedes Hotels waere auf unserem Konto eingegangen, mit Haftung fuer
-- Rueckbuchungen, Pruefpflichten und Auszahlung an die Haeuser.
--
-- Jetzt: Standard-Konten mit Direct Charges. Das Hotel ist selbst
-- Vertragspartner von Stripe, die Zahlung geht direkt auf sein Konto, die
-- Plattform legt nur den Checkout in seinem Namen an (Kopfzeile
-- Stripe-Account). Ohne verbundenes Konto gibt es keinen Zahlungslink.
--
-- property_payment_account: das verbundene Konto je Haus. Bewusst ohne
-- Zeilenrichtlinie, aus demselben Grund wie payment_intent (0021): die
-- Meldungen des Anbieters ueber ein Konto (freigeschaltet, getrennt) kommen
-- ohne Sitzung und kennen nur die Konto-ID. Jede Route filtert property_id
-- selbst. Die Konto-ID ist weder personenbezogen noch geheim; sie steht in
-- jeder Zahlungsbestaetigung von Stripe.
--
-- payment_intent.provider_account: auf welchem Konto der Checkout liegt.
-- Abfragen und Beenden muessen an dasselbe Konto gehen, auch wenn das Haus
-- inzwischen ein anderes verbunden hat. NULL heisst: angelegt vor dieser
-- Migration, auf dem Konto der Plattform.
-- ---------------------------------------------------------------------------

CREATE TABLE property_payment_account (
  property_id      bigint PRIMARY KEY REFERENCES property(id),
  provider         text   NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_account text   NOT NULL,
  -- Darf das Konto Zahlungen annehmen? Stripe schaltet ein neues Konto erst
  -- nach der Pruefung frei; bis dahin endete jeder Checkout mit einem Fehler.
  charges_enabled  boolean NOT NULL DEFAULT false,
  connected_by     bigint REFERENCES app_user(id),
  connected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Kein UNIQUE auf das Konto: zwei Haeuser einer Firma duerfen ein Konto
-- teilen (Hotel und Gaestehaus, ein Rechtstraeger). Zugeordnet wird eine
-- Zahlung ueber ihren Checkout, nicht ueber das Konto.
CREATE INDEX property_payment_account_konto
  ON property_payment_account (provider, provider_account);

SELECT attach_audit('property_payment_account');

ALTER TABLE payment_intent ADD COLUMN provider_account text;
