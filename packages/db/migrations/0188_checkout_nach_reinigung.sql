-- ---------------------------------------------------------------------------
-- Check-out nach der Reinigung laesst das Zimmer sauber.
--
-- Sven, 19.10.2026: "zimmer 14 und 25 waren gestern zur reinigung geplant,
-- wurden auch vom personal als gereinigt markiert und waren nicht belegt.
-- heute wird es vom system trotzdem zur reinigung eingereiht."
--
-- Seit eine Buchung ohne Check-in als angereist gilt (Grundregel vom
-- 05.10.2026), checkt die Rezeption oft erst aus, wenn sie das Folio
-- abschliesst -- und das kann nach der Reinigung sein. Der Trigger aus 0011
-- setzte beim Check-out ohne Ansehen auf schmutzig und machte die erledigte
-- Reinigung damit zunichte. Am Folgetag stand das Zimmer als liegen
-- gebliebene Abreise wieder im Plan (cleaningPlan.ts, `liegen`), obwohl
-- niemand darin geschlafen hatte. Zimmer, die vor der Reinigung ausgecheckt
-- wurden, traf es nicht; genau das unterschied 14 und 25 von 13, 21 und 30.
--
-- Jetzt bleibt ein sauberes oder abgenommenes Zimmer so, wenn fuer den
-- Abreisetag dieser Reservierung eine Abreisereinigung als gereinigt oder
-- "war sauber" gemeldet ist. Eine Abreisereinigung am Abreisetag kann nur
-- nach dem Gast stattgefunden haben; ein spaet erfasster Check-out (am Tag
-- danach) traegt denselben Abreisetag und wird ebenso erkannt. Ein
-- vorzeitiger Check-out kuerzt die Abreise vorher auf den Geschaeftstag
-- (reservations.ts), trifft also die Aufgabe dieses Tages.
--
-- Ohne erledigte Abreisereinigung bleibt alles wie bisher: schmutzig.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_checkout_housekeeping() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'CheckedOut' AND OLD.status IS DISTINCT FROM 'CheckedOut'
     AND NEW.resource_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM housekeeping_status h
                WHERE h.resource_id = NEW.resource_id
                  AND h.status IN ('clean','inspected'))
       AND EXISTS (SELECT 1 FROM housekeeping_task t
                    WHERE t.resource_id = NEW.resource_id
                      AND t.business_date = NEW.departure
                      AND t.kind = 'departure'
                      AND t.outcome IN ('cleaned','was_clean')) THEN
      RETURN NEW;
    END IF;
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
