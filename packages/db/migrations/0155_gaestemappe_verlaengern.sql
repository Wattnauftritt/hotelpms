-- ---------------------------------------------------------------------------
-- 0155 Digitale Gaestemappe: noch eine Nacht bleiben
--
-- Plan gaestemappe/plan.md, Abschnitt 9.1 Punkt 1: "Noch eine Nacht
-- bleiben?" ab dem zweiten Tag, nur wenn das Zimmer die naechste Nacht
-- frei ist. Die Rezeption bestaetigt; erst dann verlaengert StayGrid die
-- Reservierung (es wird nie automatisch umgebucht, Abschnitt 9.5).
--
-- **Eine Anfrage, keine Buchung.** Der Wunsch traegt die Nacht
-- (`wanted_for`, die bisherige Abreise) und den Preis, den der Gast
-- gesehen hat. Annehmen verlegt die Abreise ueber dieselbe Rechnung wie
-- `change-stay`; ist die Abreise inzwischen eine andere, wird nichts
-- verlaengert. Eine Buchung aufs Folio entsteht dabei nicht: die Nacht
-- bucht der Nachtlauf wie jede andere.
--
-- **Aus als Vorgabe**, wie die Nachricht (0153): ein Haus, das kurzfristig
-- keine Nacht verkaufen will (Reinigung, Saisonende), soll das nicht erst
-- an einer Anfrage merken.
-- ---------------------------------------------------------------------------

ALTER TABLE guest_folder_setting
  ADD COLUMN extend_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE guest_request
  ADD COLUMN is_extension boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT guest_request_eintrag_oder_nachricht,
  -- Ein Eintrag aus dem Katalog, eine Nachricht oder eine Verlaengerung.
  -- Der Text einer Nachricht darf fehlen: nach der Loeschung steht sie
  -- ohne ihn da.
  ADD CONSTRAINT guest_request_art CHECK (
    (is_message AND NOT is_extension AND item_id IS NULL AND qty = 1
      AND unit_price_cent IS NULL)
    OR (is_extension AND NOT is_message AND item_id IS NULL AND message IS NULL
      AND qty = 1 AND unit_price_cent IS NOT NULL AND wanted_for IS NOT NULL)
    OR (NOT is_message AND NOT is_extension AND item_id IS NOT NULL AND message IS NULL));

-- Hoechstens eine offene Verlaengerung je Aufenthalt: zwei waeren dieselbe
-- Nacht, und die Rezeption nimmt sonst beide an.
CREATE UNIQUE INDEX guest_request_eine_verlaengerung ON guest_request (reservation_id)
  WHERE is_extension AND status = 'open';
