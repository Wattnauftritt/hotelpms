-- ---------------------------------------------------------------------------
-- 0124 -- Zimmer sortieren: Anreisen von heute sortiert der Sortierer mit.
--
-- Anforderung: Sven, 11.10.2026: "das scheint die heutigen buchungen zu
-- meiden obwohl diese ja noch nicht angereist sind. aber die muessen ja auch
-- sortiert werden". Die Vorgabe aus 0104 hielt jede heutige Anreise mit
-- Zimmer fest. Ein Gast, der noch nicht eingecheckt ist, hat sein Zimmer
-- aber noch nicht -- und gerade der heutige Tag ist der, an dem eine Luecke
-- am meisten kostet.
--
-- Nur die Vorgabe. Ein Haus, das die Einstellung gespeichert hat, behaelt
-- seinen Wert: der kann bewusst gesetzt sein, etwa weil die Reinigung die
-- Zimmer fuer heute schon vorbereitet hat. Eingecheckte Gaeste bleiben ohnehin
-- liegen (Status, nicht diese Einstellung).
-- ---------------------------------------------------------------------------

ALTER TABLE room_sort_setting ALTER COLUMN keep_today SET DEFAULT false;
