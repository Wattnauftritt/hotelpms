-- Buchungen und Reservierungen.

CREATE TYPE reservation_status AS ENUM
  ('Inquired','Optional','Confirmed','InHouse','CheckedOut','Canceled','NoShow');

CREATE TABLE booking (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        bigint NOT NULL REFERENCES property(id),
  public_ref         text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  booker_guest_id    bigint REFERENCES guest(id),
  booker_company_id  bigint REFERENCES company(id),
  source             text NOT NULL DEFAULT 'direct'
                     CHECK (source IN ('direct','booking_engine','channel','api','walk_in','import')),
  channel_code       text,
  external_reference text,
  market_segment     text,
  -- Provision je Kanal fuer die Kanalrechnung (E10, Dokument 13).
  commission_bp      integer,
  created_by         bigint REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_external ON booking (property_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE reservation (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id       bigint NOT NULL REFERENCES property(id),
  booking_id        bigint NOT NULL REFERENCES booking(id),
  public_ref        text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  category_id       bigint NOT NULL REFERENCES resource_category(id),
  resource_id       bigint REFERENCES resource(id),
  arrival           date NOT NULL,
  departure         date NOT NULL,
  status            reservation_status NOT NULL DEFAULT 'Confirmed',
  rate_plan_id      bigint REFERENCES rate_plan(id),
  primary_guest_id  bigint REFERENCES guest(id),
  option_expires_at timestamptz,
  guaranteed        boolean NOT NULL DEFAULT true,
  notes             text,
  checked_in_at     timestamptz,
  checked_out_at    timestamptz,
  canceled_at       timestamptz,
  cancellation_fee_cent bigint,
  created_by        bigint REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Faellt spaeter fuer Tagesnutzung (B9, Dokument 13).
  CONSTRAINT stay_valid CHECK (departure > arrival),
  CONSTRAINT option_needs_expiry CHECK (status <> 'Optional' OR option_expires_at IS NOT NULL),
  CONSTRAINT inhouse_needs_resource CHECK (status <> 'InHouse' OR resource_id IS NOT NULL)
);
-- Nur aktive Reservierungen im Index: stornierte und abgereiste machen nach
-- Jahren den Grossteil der Tabelle aus.
CREATE INDEX reservation_active_range ON reservation (property_id, departure, arrival)
  WHERE status IN ('Optional','Confirmed','InHouse');
CREATE INDEX reservation_arrival ON reservation (property_id, arrival)
  WHERE status IN ('Optional','Confirmed');
CREATE INDEX reservation_resource ON reservation (property_id, resource_id, arrival)
  WHERE status IN ('Confirmed','InHouse');
CREATE INDEX reservation_booking ON reservation (booking_id);
CREATE INDEX reservation_guest ON reservation (primary_guest_id);

-- Personen statt Zaehler: noetig fuer Kurtaxe-Staffeln, Kinderpreise und den
-- Meldeschein (B7, Dokument 13).
CREATE TABLE reservation_occupant (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  guest_id       bigint REFERENCES guest(id),
  age_at_arrival smallint CHECK (age_at_arrival IS NULL OR age_at_arrival BETWEEN 0 AND 130),
  is_primary     boolean NOT NULL DEFAULT false
);
CREATE INDEX occupant_reservation ON reservation_occupant (reservation_id);

-- Preis je Nacht wird bei Buchung eingefroren.
CREATE TABLE reservation_night (
  reservation_id bigint NOT NULL REFERENCES reservation(id) ON DELETE CASCADE,
  property_id    bigint NOT NULL REFERENCES property(id),
  date           date NOT NULL,
  rate_plan_id   bigint REFERENCES rate_plan(id),
  price_cent     bigint NOT NULL,
  posted         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (reservation_id, date)
);
CREATE INDEX reservation_night_property ON reservation_night (property_id, date);

CREATE TABLE availability_block (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  name         text NOT NULL,
  category_id  bigint NOT NULL REFERENCES resource_category(id),
  company_id   bigint REFERENCES company(id),
  rate_plan_id bigint REFERENCES rate_plan(id),
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  quantity     integer NOT NULL CHECK (quantity > 0),
  picked_up    integer NOT NULL DEFAULT 0 CHECK (picked_up >= 0),
  release_date date,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT block_range CHECK (to_date > from_date)
);

-- Meldeschein nach § 30 Abs. 2 BMG. Aufbewahrung ein Jahr.
CREATE TABLE registration (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     bigint NOT NULL REFERENCES property(id),
  reservation_id  bigint NOT NULL REFERENCES reservation(id),
  guest_id        bigint NOT NULL REFERENCES guest(id),
  arrival         date NOT NULL,
  planned_departure date NOT NULL,
  occupant_count  smallint NOT NULL DEFAULT 1,
  is_foreign      boolean NOT NULL,
  -- Unterschrift seit 1.1.2025 nur noch fuer auslaendische Gaeste Pflicht.
  signature_svg   text,
  signed_at       timestamptz,
  -- Sammelmeldeschein fuer Reisegruppen (E6, Dokument 13).
  group_registration_id bigint REFERENCES registration(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  destroy_after   date NOT NULL,
  CONSTRAINT foreign_needs_signature
    CHECK (NOT is_foreign OR signed_at IS NOT NULL OR signature_svg IS NULL)
);
CREATE INDEX registration_destroy ON registration (destroy_after);
CREATE INDEX registration_reservation ON registration (reservation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['booking','reservation','reservation_occupant',
                           'reservation_night','availability_block','registration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('booking');
SELECT attach_audit('reservation');
SELECT attach_audit('reservation_occupant');
SELECT attach_audit('availability_block');
SELECT attach_audit('registration');
