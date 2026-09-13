-- Inventar: Kategorien, Zimmer, Sperrungen.

CREATE TABLE resource_category (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  code         text NOT NULL,
  name         text NOT NULL,
  description  text,
  max_occupancy smallint NOT NULL DEFAULT 2 CHECK (max_occupancy > 0),
  -- Zeiteinheit als Feld von Anfang an, im MVP nur 'night' (Entscheidung 8).
  time_unit    text NOT NULL DEFAULT 'night' CHECK (time_unit IN ('night','hour','day','month')),
  sort_order   integer NOT NULL DEFAULT 0,
  overbooking_limit integer NOT NULL DEFAULT 0 CHECK (overbooking_limit >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

CREATE TABLE resource (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  category_id bigint NOT NULL REFERENCES resource_category(id),
  code        text NOT NULL,                -- Zimmernummer
  floor       text,
  attributes  text[] NOT NULL DEFAULT '{}', -- balkon, barrierefrei, raucher
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);
CREATE INDEX resource_category_idx ON resource (property_id, category_id) WHERE active;

CREATE TABLE maintenance_block (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  resource_id bigint NOT NULL REFERENCES resource(id),
  from_date   date NOT NULL,
  to_date     date NOT NULL,               -- exklusiv
  -- out_of_order zaehlt nicht zur Kapazitaet, out_of_service schon
  kind        text NOT NULL CHECK (kind IN ('out_of_order','out_of_service')),
  reason      text NOT NULL,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_range CHECK (to_date > from_date)
);
CREATE INDEX maintenance_range_idx ON maintenance_block (property_id, resource_id, from_date, to_date);

ALTER TABLE resource_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_category FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON resource_category USING (property_id = ANY (app_property_ids()));

ALTER TABLE resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON resource USING (property_id = ANY (app_property_ids()));

ALTER TABLE maintenance_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_block FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON maintenance_block USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('resource_category');
SELECT attach_audit('resource');
SELECT attach_audit('maintenance_block');
