-- ---------------------------------------------------------------------------
-- 0125 Push an die Kraft, wenn der Gast nachtraeglich auf die Reinigung
-- verzichtet (Aufgabe 18, Baustein 10, Nachtrag)
--
-- Sven, 11.10.2026: Gaeste, die ueber den Schluesselsafe anreisen, melden
-- sich oft erst am naechsten Morgen an und waehlen die Reinigung dann ab,
-- wenn das Zimmer schon einer Kraft zugeteilt ist. Gesperrt ist es dann in
-- der App ohnehin (0115); die Meldung `waived` sagt es der Kraft sofort,
-- bevor sie mit dem Wagen vor der Tuer steht. Parameter wie bei den anderen
-- Arten nur die Zimmernummer, nie ein Gastname.
-- ---------------------------------------------------------------------------

ALTER TABLE staff_push DROP CONSTRAINT staff_push_kind_check;
ALTER TABLE staff_push ADD CONSTRAINT staff_push_kind_check
  CHECK (kind IN ('plan','room_free','rework','waived'));
