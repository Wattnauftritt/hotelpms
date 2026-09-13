-- Raten, Restriktionen, Steuern.

CREATE TABLE tax_rule (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('vat','city_tax','bed_tax')),
  -- Basispunkte: 700 = 7 %. Kein Fliesskomma bei Geld und Steuern.
  rate_bp     integer,
  amount_cent bigint,
  basis       text NOT NULL CHECK (basis IN ('percent','per_person_night','per_night')),
  exempt_below_age smallint,
  exempt_business  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code),
  CONSTRAINT tax_value CHECK (
    (basis = 'percent' AND rate_bp IS NOT NULL) OR
    (basis <> 'percent' AND amount_cent IS NOT NULL))
);

CREATE TABLE cancellation_policy (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id       bigint NOT NULL REFERENCES property(id),
  code              text NOT NULL,
  name              text NOT NULL,
  free_until_hours  integer NOT NULL DEFAULT 24,
  fee_kind          text NOT NULL DEFAULT 'first_night'
                    CHECK (fee_kind IN ('none','first_night','percent','amount')),
  fee_value         integer NOT NULL DEFAULT 0,
  -- B10, Dokument 13: nicht garantierte Reservierungen verfallen abends.
  guaranteed        boolean NOT NULL DEFAULT true,
  no_show_cutoff    time,
  UNIQUE (property_id, code)
);

CREATE TABLE rate_plan (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  category_id   bigint NOT NULL REFERENCES resource_category(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  code          text NOT NULL,
  name          text NOT NULL,
  cancellation_policy_id bigint REFERENCES cancellation_policy(id),
  -- Abgeleitete Raten: Basisrate plus Betrag oder Prozent.
  base_rate_plan_id bigint REFERENCES rate_plan(id),
  derive_kind   text CHECK (derive_kind IN ('amount','percent')),
  derive_value  integer,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code),
  CONSTRAINT derive_complete CHECK (
    (base_rate_plan_id IS NULL AND derive_kind IS NULL) OR
    (base_rate_plan_id IS NOT NULL AND derive_kind IS NOT NULL AND derive_value IS NOT NULL)),
  CONSTRAINT no_self_derive CHECK (base_rate_plan_id IS DISTINCT FROM id)
);

CREATE TABLE rate_day (
  property_id  bigint NOT NULL REFERENCES property(id),
  rate_plan_id bigint NOT NULL REFERENCES rate_plan(id),
  date         date   NOT NULL,
  -- Preis je Belegung: Index 1 = eine Person, 2 = zwei Personen usw.
  price_cent   bigint[] NOT NULL,
  PRIMARY KEY (rate_plan_id, date)
);
CREATE INDEX rate_day_property ON rate_day (property_id, date);

CREATE TABLE restriction_day (
  property_id  bigint NOT NULL REFERENCES property(id),
  rate_plan_id bigint NOT NULL REFERENCES rate_plan(id),
  date         date   NOT NULL,
  min_los      smallint,
  max_los      smallint,
  closed       boolean NOT NULL DEFAULT false,
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rate_plan_id, date)
);
CREATE INDEX restriction_day_property ON restriction_day (property_id, date);

CREATE TABLE product (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  code        text NOT NULL,
  name        text NOT NULL,
  price_cent  bigint NOT NULL,
  tax_rule_id bigint REFERENCES tax_rule(id),
  charge_mode text NOT NULL DEFAULT 'per_night'
              CHECK (charge_mode IN ('once','per_night','per_person_night')),
  revenue_account text NOT NULL DEFAULT '8300',
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, code)
);

CREATE TABLE rate_plan_product (
  rate_plan_id bigint NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
  product_id   bigint NOT NULL REFERENCES product(id),
  PRIMARY KEY (rate_plan_id, product_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_rule','cancellation_policy','rate_plan','rate_day',
                           'restriction_day','product'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('tax_rule');
SELECT attach_audit('cancellation_policy');
SELECT attach_audit('rate_plan');
SELECT attach_audit('product');
