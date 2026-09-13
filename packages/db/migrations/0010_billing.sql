-- Rechnungswesen. Haertegrad 1 nach Dokument 08.

CREATE TABLE business_day (
  property_id bigint NOT NULL REFERENCES property(id),
  date        date   NOT NULL,
  status      text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  PRIMARY KEY (property_id, date)
);

-- Schrittmarken des Nachtlaufs. Der Tageswechsel ist Schritt 1, jeder Schritt
-- hinterlaesst eine Marke, ein Wiederholungslauf ueberspringt sie (B1, Dok 13).
CREATE TABLE night_audit_step (
  property_id   bigint NOT NULL REFERENCES property(id),
  business_date date   NOT NULL,
  step          text   NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  detail        jsonb,
  PRIMARY KEY (property_id, business_date, step)
);

CREATE TABLE payment_method (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  code         text NOT NULL,
  name         text NOT NULL,
  -- Spaeter additiv fuer ein Kassenbuch: is_cash, affects_cash_balance,
  -- requires_tse. Jetzt bewusst nicht angelegt (Entscheidung 10).
  is_external  boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code)
);

CREATE TABLE folio (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  reservation_id bigint REFERENCES reservation(id),
  guest_id     bigint REFERENCES guest(id),
  company_id   bigint REFERENCES company(id),
  kind         text NOT NULL DEFAULT 'guest'
               CHECK (kind IN ('guest','company','group','house')),
  label        text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folio_reservation ON folio (reservation_id);
CREATE INDEX folio_open ON folio (property_id) WHERE status = 'open';

-- Lueckenlose Rechnungsnummern. Keine Sequenz: die haelt bei jedem Rollback
-- eine Luecke. Gesperrte Zaehlerzeile in derselben Transaktion (Dok 08).
CREATE TABLE invoice_counter (
  property_id bigint  NOT NULL REFERENCES property(id),
  year        integer NOT NULL,
  prefix      text    NOT NULL DEFAULT '',
  next_number bigint  NOT NULL DEFAULT 1,
  PRIMARY KEY (property_id, year)
);

CREATE TABLE invoice (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  folio_id           bigint NOT NULL REFERENCES folio(id),
  public_ref         text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  number             text NOT NULL,
  issued_on          date NOT NULL,
  business_date      date NOT NULL,
  kind               text NOT NULL DEFAULT 'final'
                     CHECK (kind IN ('final','interim','deposit','credit_note')),
  -- Momentaufnahme: zieht das Hotel um, bleiben alte Rechnungen unveraendert
  -- (B6, Dokument 13).
  issuer_snapshot    jsonb NOT NULL,
  recipient_snapshot jsonb NOT NULL,
  -- Steuer je Satzgruppe aus der Nettosumme, nicht je Zeile gerundet
  -- (B5, Dokument 13).
  totals             jsonb NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'EUR',
  reverses_id        bigint REFERENCES invoice(id),
  pdf_path           text,
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, number)
);
CREATE INDEX invoice_folio ON invoice (folio_id);
CREATE INDEX invoice_business_date ON invoice (property_id, business_date);

CREATE TABLE charge (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     bigint NOT NULL REFERENCES property(id),
  folio_id        bigint NOT NULL REFERENCES folio(id),
  business_date   date   NOT NULL,
  description     text   NOT NULL,
  quantity        integer NOT NULL DEFAULT 1,
  net_cent        bigint NOT NULL,
  tax_cent        bigint NOT NULL,
  gross_cent      bigint NOT NULL,
  tax_rate_bp     integer NOT NULL,
  tax_rule_id     bigint REFERENCES tax_rule(id),
  revenue_account text   NOT NULL,
  product_id      bigint REFERENCES product(id),
  reservation_id  bigint REFERENCES reservation(id),
  -- Eine Rechnung umfasst eine Menge von Charges, nicht ein Folio. Einmal
  -- gesetzt, nie geaendert (B3, Dokument 13).
  invoice_id      bigint REFERENCES invoice(id),
  reverses_id     bigint REFERENCES charge(id),
  created_by      bigint REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT charge_sum CHECK (gross_cent = net_cent + tax_cent)
);
CREATE INDEX charge_folio ON charge (folio_id);
CREATE INDEX charge_open ON charge (folio_id) WHERE invoice_id IS NULL;
CREATE INDEX charge_business_date ON charge (property_id, business_date);

CREATE TABLE settlement (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id       bigint NOT NULL REFERENCES property(id),
  folio_id          bigint NOT NULL REFERENCES folio(id),
  business_date     date   NOT NULL,
  amount_cent       bigint NOT NULL,
  payment_method_id bigint NOT NULL REFERENCES payment_method(id),
  -- Macht sichtbar, dass die massgebliche Aufzeichnung woanders liegt
  -- (Entscheidung 9). Kein Kassenbestand, keine Abwicklung, kein Bon.
  external_reference text,
  invoice_id        bigint REFERENCES invoice(id),
  reverses_id       bigint REFERENCES settlement(id),
  created_by        bigint REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settlement_folio ON settlement (folio_id);
CREATE INDEX settlement_business_date ON settlement (property_id, business_date);

CREATE TABLE routing_rule (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  target_folio_id bigint NOT NULL REFERENCES folio(id),
  match_kind     text NOT NULL CHECK (match_kind IN ('all','accommodation','product','account')),
  match_value    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Vergibt die naechste lueckenlose Nummer. Serialisiert je Property; die
-- Transaktion muss daher kurz bleiben, insbesondere ohne PDF-Erzeugung.
CREATE OR REPLACE FUNCTION next_invoice_number(p_property bigint, p_year integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint; pfx text;
BEGIN
  PERFORM assert_property_in_context(p_property);
  INSERT INTO invoice_counter (property_id, year) VALUES (p_property, p_year)
  ON CONFLICT DO NOTHING;
  UPDATE invoice_counter SET next_number = next_number + 1
   WHERE property_id = p_property AND year = p_year
  RETURNING next_number - 1, prefix INTO n, pfx;
  RETURN pfx || p_year || '-' || lpad(n::text, 5, '0');
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_day','night_audit_step','payment_method','folio',
                           'invoice','charge','settlement','routing_rule',
                           'invoice_counter'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

-- Haertegrad 1: unveraenderlich. Korrektur nur als Gegenbuchung.
SELECT make_append_only('charge');
SELECT make_append_only('settlement');
SELECT make_append_only('invoice');

SELECT attach_audit('folio');
SELECT attach_audit('payment_method');
SELECT attach_audit('routing_rule');
SELECT attach_audit('business_day');
