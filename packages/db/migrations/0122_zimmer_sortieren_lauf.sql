-- ---------------------------------------------------------------------------
-- 0122 -- Zimmer sortieren, Schritt 2: Laeufe und Rueckgaengig.
--
-- Anforderung: Sven, 07.10.2026 und 10.10.2026 ("ich habe im kalender
-- keinen knopf zum zimmer sortieren"), Thread "Zimmer-Sortierung". Der
-- Sortierer schlaegt Zuege vor, die Rezeption uebernimmt sie, und ein Lauf
-- laesst sich zuruecknehmen. Das Adminpanel hatte beides, und Sven wollte
-- die Pruefung vor dem Schreiben ausdruecklich.
--
-- 1. `room_sort_run`: wer wann welchen Zeitraum sortiert hat und welche
--    Reservierung von welchem Zimmer in welches ging. Daraus entsteht das
--    Rueckgaengig, und es zeigt spaeter, warum Frau Meyer nicht mehr in 12
--    liegt. Nur Reservierungs- und Zimmer-IDs, kein Name: kein Eintrag in
--    audit_redaction noetig, und die Loeschung eines Gastes muss hier
--    nichts finden.
--
-- 2. Ein Zug des Sortierers ist keine Aenderung der Rezeption im Sinne von
--    0092. Ohne Ausnahme stuende jede gepushte Gaestehausbuchung nach dem
--    ersten Sortieren auf `local` und naehme keinen Storno aus RoomCloud
--    mehr an -- genau das Gegenteil von Svens Entscheidung, dass StayGrid
--    im Gaestehaus die Zimmer vergibt. Die Route setzt dafuer
--    `app.room_sort` in ihrer Transaktion, wie der Push `app.channel_push`.
-- ---------------------------------------------------------------------------

CREATE TABLE room_sort_run (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  from_date    date NOT NULL,
  to_date      date NOT NULL CHECK (to_date > from_date),
  -- manual: Knopf im Zimmerplan. auto: der Worker (Gaestehaus).
  trigger      text NOT NULL CHECK (trigger IN ('manual', 'auto')),
  -- [{ "reservationId", "fromResourceId", "toResourceId" }]
  moves        jsonb NOT NULL CHECK (jsonb_typeof(moves) = 'array'),
  created_by   bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz,
  undone_by    bigint REFERENCES app_user(id)
);
CREATE INDEX room_sort_run_property ON room_sort_run (property_id, created_at DESC);

ALTER TABLE room_sort_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_sort_run FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON room_sort_run USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('room_sort_run');

CREATE OR REPLACE FUNCTION channel_owner_from_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF nullif(current_setting('app.channel_push', true), '') IS NOT NULL
     OR nullif(current_setting('app.room_sort', true), '') IS NOT NULL THEN
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
