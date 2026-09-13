-- Atomarer Pfad für Aufenthaltsänderungen (E11, Dokument 13).
--
-- Der Fall: der Gast bleibt länger, seine Kategorie ist aber ausgebucht, eine
-- andere frei. Das ist eine Verlängerung **plus** einen Umzug, und beides
-- muss zusammen gelingen oder zusammen scheitern.
--
-- Ohne diese Funktion müsste die Anwendung erst freigeben und dann neu
-- belegen. Zwischen beiden Schritten ist das Kontingent frei, und genau dann
-- kauft es jemand anders — auf dem Portal, in derselben Sekunde. Der Gast
-- verliert sein Zimmer, obwohl er es schon hatte.
--
-- Die Reihenfolge ist deshalb **erst binden, dann freigeben**. Schlägt das
-- Binden fehl, ist nichts passiert und der alte Zustand gilt weiter.

CREATE OR REPLACE FUNCTION inventory_move(
  p_property bigint,
  p_from_category bigint, p_from_arrival date, p_from_departure date,
  p_to_category   bigint, p_to_arrival   date, p_to_departure   date
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE fehler text;
BEGIN
  PERFORM assert_property_in_context(p_property);

  -- Nichts zu tun: derselbe Zeitraum in derselben Kategorie.
  IF p_from_category = p_to_category
     AND p_from_arrival = p_to_arrival
     AND p_from_departure = p_to_departure THEN
    RETURN NULL;
  END IF;

  /*
   * Nur die Nächte binden, die neu hinzukommen. Wer bei einer Verlängerung
   * um eine Nacht den ganzen Aufenthalt erst freigibt und neu bindet, kann
   * an der Kapazitätsprüfung scheitern, obwohl die Nächte ihm bereits
   * gehören: er konkurriert mit sich selbst.
   *
   * Bei gleicher Kategorie überlappt das Alte mit dem Neuen, also wird nur
   * die Differenz gebunden. Bei einem Kategoriewechsel überlappt nichts,
   * also der ganze neue Zeitraum.
   */
  IF p_from_category = p_to_category THEN
    -- Nächte vor dem bisherigen Beginn.
    IF p_to_arrival < p_from_arrival THEN
      fehler := inventory_reserve(p_property, p_to_category,
                                  p_to_arrival, least(p_from_arrival, p_to_departure), 1);
      IF fehler IS NOT NULL THEN RETURN fehler; END IF;
    END IF;
    -- Nächte nach dem bisherigen Ende.
    IF p_to_departure > p_from_departure THEN
      fehler := inventory_reserve(p_property, p_to_category,
                                  greatest(p_from_departure, p_to_arrival), p_to_departure, 1);
      IF fehler IS NOT NULL THEN
        -- Was eben gebunden wurde, wieder lösen. Sonst bliebe ein Rest
        -- belegt, den keine Reservierung erklärt.
        IF p_to_arrival < p_from_arrival THEN
          PERFORM inventory_release(p_property, p_to_category,
                                    p_to_arrival, least(p_from_arrival, p_to_departure), 1);
        END IF;
        RETURN fehler;
      END IF;
    END IF;
    -- Nächte, die wegfallen.
    IF p_to_arrival > p_from_arrival THEN
      PERFORM inventory_release(p_property, p_from_category,
                               p_from_arrival, least(p_to_arrival, p_from_departure), 1);
    END IF;
    IF p_to_departure < p_from_departure THEN
      PERFORM inventory_release(p_property, p_from_category,
                               greatest(p_to_departure, p_from_arrival), p_from_departure, 1);
    END IF;
    RETURN NULL;
  END IF;

  -- Kategoriewechsel: erst binden, dann freigeben.
  fehler := inventory_reserve(p_property, p_to_category, p_to_arrival, p_to_departure, 1);
  IF fehler IS NOT NULL THEN RETURN fehler; END IF;
  PERFORM inventory_release(p_property, p_from_category, p_from_arrival, p_from_departure, 1);
  RETURN NULL;
END $$;

COMMENT ON FUNCTION inventory_move(bigint,bigint,date,date,bigint,date,date) IS
  'Verlegt eine Belegung atomar. Bindet zuerst und gibt erst danach frei, damit zwischen beiden Schritten niemand das Kontingent wegkauft.';
