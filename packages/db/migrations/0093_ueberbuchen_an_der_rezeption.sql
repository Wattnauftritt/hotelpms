-- ---------------------------------------------------------------------------
-- 0093 -- Die Rezeption darf eine Zimmergruppe bewusst ueberbuchen, und eine
-- geaenderte Personenzahl macht eine gepushte Buchung zur lokalen.
--
-- Anforderung: Sven, 06.10.2026: "zimmergruppen muessen ueberbuchbar sein.
-- wenn ich ein zimmer aus der kategorie FZ wo es nur eines gibt in die
-- ablage schiebe und ein neues in die luecke eintragen will sagt das system
-- keine verfuegbarkeit obwohl das zimmer zu der zeit gerade leer ist.
-- vielleicht eine warnung anzeigen aber nicht generell verbieten."
--
-- 1. Ueberbuchen auf ausdrueckliche Bestaetigung.
--
--    Der Zaehler hat recht: die Buchung in der Ablage bindet ihre Gruppe
--    weiter, sie hat nur kein Zimmer. Die Rezeption weiss aber etwas, das
--    der Zaehler nicht weiss -- dass sie die abgelegte Buchung gleich
--    woandershin legt. Umsortieren im vollen Haus geht nur ueber diesen
--    Zwischenschritt, und eine Absage an genau dieser Stelle macht ihn
--    unmoeglich.
--
--    `inventory_reserve` bindet deshalb ohne Obergrenze, wenn der Aufrufer
--    das transaktionslokal verlangt (`app.allow_overbooking`). Gesetzt wird
--    das nur von den Routen der Rezeption und nur, nachdem jemand die
--    Warnung bestaetigt hat; ein Kanal, ein Import und das Kontingent
--    (`inventory_block`) bleiben bei der harten Grenze. Ueber eine
--    Einstellung und nicht ueber einen zweiten Parameter, weil
--    `inventory_move` diese Funktion selbst aufruft -- und ein Verlaengern
--    oder Verlegen in die volle Gruppe dieselbe Frage ist wie das Anlegen.
--    Dasselbe Muster wie `app.channel_push` (0092).
--
--    Gezaehlt wird trotzdem, damit `sold` stimmt; der Plan zeigt die
--    Ueberbuchung danach als Warnung (A7). Die Haussumme zuerst, wie
--    bisher: feste Sperrreihenfolge gegen Deadlocks.
--
-- 2. Personenzahl im Trigger aus 0092.
--
--    Die Rezeption kann die Personenzahl einer bestehenden Buchung jetzt
--    aendern. Bei einer Buchung aus einem fuehrenden Umsystem ist das eine
--    Aenderung von Hand wie ein anderer Zeitraum (Sven, 05.10.2026): der
--    naechste Push ueberschriebe sie sonst still. Die Pruefsumme der Quelle
--    rechnet die Personen ohnehin mit.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inventory_reserve(
  p_property bigint, p_category bigint, p_from date, p_to date, p_count integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  nights integer := (p_to - p_from);
  present integer;
  affected integer;
  ueberbuchen boolean :=
    coalesce(current_setting('app.allow_overbooking', true), '') = 'on';
BEGIN
  PERFORM assert_property_in_context(p_property);
  IF nights <= 0 OR p_count <= 0 THEN RETURN 'sold_out'; END IF;

  SELECT count(*) INTO present FROM inventory_day
   WHERE property_id = p_property AND category_id IN (0, p_category)
     AND date >= p_from AND date < p_to;
  IF present <> nights * 2 THEN RETURN 'not_materialized'; END IF;

  UPDATE inventory_day SET sold = sold + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id = 0
     AND date >= p_from AND date < p_to
     AND (ueberbuchen OR sold + blocked + p_count <= capacity + overbooking);
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  UPDATE inventory_day SET sold = sold + p_count, updated_at = now()
   WHERE property_id = p_property AND category_id = p_category
     AND date >= p_from AND date < p_to
     AND (ueberbuchen OR sold + blocked + p_count <= capacity + overbooking);
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> nights THEN RETURN 'sold_out'; END IF;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION channel_owner_from_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF nullif(current_setting('app.channel_push', true), '') IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
     WHERE b.channel_owner = 'source'
       AND b.id IN (SELECT booking_id FROM neu);
  ELSE
    UPDATE booking b SET channel_owner = 'local', owned_locally_at = now()
     WHERE b.channel_owner = 'source'
       AND b.id IN (
         SELECT n.booking_id FROM neu n JOIN alt a ON a.id = n.id
          WHERE n.arrival     IS DISTINCT FROM a.arrival
             OR n.departure   IS DISTINCT FROM a.departure
             OR n.resource_id IS DISTINCT FROM a.resource_id
             OR n.category_id IS DISTINCT FROM a.category_id
             OR n.guest_count IS DISTINCT FROM a.guest_count
             OR n.adults      IS DISTINCT FROM a.adults
             OR n.children    IS DISTINCT FROM a.children
             OR ((n.status IN ('Canceled','NoShow')) <> (a.status IN ('Canceled','NoShow'))));
  END IF;
  RETURN NULL;
END $$;
