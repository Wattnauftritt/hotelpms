-- ---------------------------------------------------------------------------
-- 0121 -- Eine gepushte Buchung, deren Zimmer belegt ist, liegt in der Ablage.
--
-- Anforderung: Sven, 10.10.2026. Im Gaestehaus meldete die Maske fuer den
-- 12.10. sechs Belegungen auf fuenf Zimmer, der Plan zeigte vier Buchungen.
-- "Buchungen die ueberbelegt sind muessen im Band ueber dem Kalender
-- landen."
--
-- Ursache: Der Push des Umsystems (0092) weist nie ab. Wollte er eine
-- Buchung in ein Zimmer legen, in dem schon jemand lag, legte er sie
-- trotzdem hinein und vermerkte `channel_conflict = 'room'`. Im Plan lag
-- ihr Balken dann genau unter dem anderen -- unsichtbar, aber gezaehlt.
--
-- Jetzt kommt sie in die Ablage, und das Zimmer, das die Quelle wollte,
-- steht in `channel_wanted_resource_id`. Wird es frei, legt der naechste
-- Push des Hauses sie dorthin.
--
-- Fuer den Bestand: jede Ueberschneidung zweier bindender Aufenthalte im
-- selben Zimmer loest sich auf, indem einer in die Ablage geht -- der mit
-- dem Konfliktvermerk, sonst der juengere; ein angereister Gast bleibt in
-- seinem Zimmer. Als Push gekennzeichnet, damit der Trigger aus 0092 die
-- Buchung nicht der Rezeption zuschlaegt.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation
  ADD COLUMN channel_wanted_resource_id bigint REFERENCES resource(id);

COMMENT ON COLUMN reservation.channel_wanted_resource_id IS
  'Zimmer, das ein Push wollte, als es belegt war. Die Buchung liegt bis dahin in der Ablage.';

SELECT set_config('app.channel_push', 'migration-0121', true);

WITH paar AS (
  SELECT a.id AS a_id, b.id AS b_id,
         -- Rang: wer eher weichen soll. Konfliktvermerk vor allem, dann
         -- nicht angereist, dann die juengere Reservierung.
         ((a.channel_conflict = 'room')::int * 4 + (a.status <> 'InHouse')::int * 2) AS a_rang,
         ((b.channel_conflict = 'room')::int * 4 + (b.status <> 'InHouse')::int * 2) AS b_rang,
         a.status AS a_status, b.status AS b_status
    FROM reservation a
    JOIN reservation b ON b.resource_id = a.resource_id AND b.id <> a.id
     AND b.status IN ('Confirmed','InHouse') AND b.arrival < a.departure
     AND b.departure > a.arrival
   WHERE a.status IN ('Confirmed','InHouse') AND a.departure > current_date
), weichen AS (
  SELECT DISTINCT CASE WHEN a_rang > b_rang OR (a_rang = b_rang AND a_id > b_id)
                       THEN a_id ELSE b_id END AS id
    FROM paar
)
UPDATE reservation r
   SET channel_wanted_resource_id = r.resource_id, resource_id = NULL,
       channel_conflict = 'room', updated_at = now()
  FROM weichen w
 WHERE r.id = w.id AND r.status = 'Confirmed';
