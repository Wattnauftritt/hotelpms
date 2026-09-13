-- Housekeeping und Wartung.

CREATE TABLE housekeeping_status (
  property_id  bigint NOT NULL REFERENCES property(id),
  resource_id  bigint NOT NULL REFERENCES resource(id),
  status       text   NOT NULL DEFAULT 'clean'
               CHECK (status IN ('dirty','clean','inspected','occupied')),
  assigned_to  bigint REFERENCES app_user(id),
  updated_by   bigint REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id)
);

CREATE TABLE housekeeping_task (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  resource_id  bigint NOT NULL REFERENCES resource(id),
  business_date date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('departure','stayover','deep_clean','inspection')),
  assigned_to  bigint REFERENCES app_user(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped')),
  done_at      timestamptz,
  UNIQUE (resource_id, business_date, kind)
);
CREATE INDEX hk_task_day ON housekeeping_task (property_id, business_date, status);

CREATE TABLE maintenance_ticket (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  resource_id  bigint REFERENCES resource(id),
  title        text NOT NULL,
  description  text,
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  created_by   bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['housekeeping_status','housekeeping_task','maintenance_ticket'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('housekeeping_status');
SELECT attach_audit('maintenance_ticket');

-- Zimmerstatus beim Check-out automatisch auf schmutzig.
CREATE OR REPLACE FUNCTION reservation_checkout_housekeeping() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'CheckedOut' AND OLD.status IS DISTINCT FROM 'CheckedOut'
     AND NEW.resource_id IS NOT NULL THEN
    INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
    VALUES (NEW.property_id, NEW.resource_id, 'dirty', app_user_id())
    ON CONFLICT (resource_id) DO UPDATE
      SET status = 'dirty', updated_by = app_user_id(), updated_at = now();
  ELSIF NEW.status = 'InHouse' AND OLD.status IS DISTINCT FROM 'InHouse'
     AND NEW.resource_id IS NOT NULL THEN
    INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
    VALUES (NEW.property_id, NEW.resource_id, 'occupied', app_user_id())
    ON CONFLICT (resource_id) DO UPDATE
      SET status = 'occupied', updated_by = app_user_id(), updated_at = now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_checkout_housekeeping AFTER UPDATE ON reservation
  FOR EACH ROW EXECUTE FUNCTION reservation_checkout_housekeeping();
