-- ---------------------------------------------------------------------------
-- 0151 Gaestewuensche in der Personal-App (Dokument 35, Abschnitt 8)
--
-- Ein kostenloser Wunsch, um den sich Housekeeping kuemmert -- ein Kissen,
-- eine Decke --, geht an die Kraft, der das Zimmer heute zugeteilt ist:
-- sie sieht ihn an der Kachel und bekommt eine Push-Meldung. Parameter wie
-- bei den anderen Arten nur die Zimmernummer, nie ein Gastname und nie der
-- Wunsch selbst; den liest sie in der App in ihrer Sprache.
-- ---------------------------------------------------------------------------

ALTER TABLE staff_push DROP CONSTRAINT staff_push_kind_check;
ALTER TABLE staff_push ADD CONSTRAINT staff_push_kind_check
  CHECK (kind IN ('plan','room_free','rework','waived','request'));
