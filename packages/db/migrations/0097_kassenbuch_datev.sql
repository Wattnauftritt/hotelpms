-- ---------------------------------------------------------------------------
-- 0097 -- Kassenbuch: Stichtag fuer den DATEV-Export.
--
-- Anforderung: Teil 3 des Kassenbuchs (Dokument 09, vierte Fassung). Bis zur
-- Umstellung exportiert das Adminpanel an DATEV, danach StayGrid. Exportieren
-- beide, steht jede Zeile zweimal in der Buchhaltung -- und das faellt dort
-- erst beim Abschluss auf. Die Absprache "nur ein System" haelt deshalb nicht
-- ein Hinweis, sondern dieser Stichtag: ohne ihn, oder vor ihm, weist StayGrid
-- den Export ab.
--
-- Ein Tag und kein Schalter, weil er zugleich festhaelt, ab wann StayGrid
-- verantwortlich war; die Frage stellt der Steuerberater beim ersten Abschluss.
-- ---------------------------------------------------------------------------

ALTER TABLE cashbook_setting ADD COLUMN datev_from date;

-- ---------------------------------------------------------------------------
-- Reservierungsbezug uebernommener Gastbuchungen.
--
-- Das Adminpanel liefert zu einer Gastbuchung aus dem Buchungs-Report die
-- Reservierungsreferenz mit, solange die Report-Zeile dort existiert; die
-- Report-ID selbst ist instabil (ein Neuaufbau vergibt neue). Ohne die
-- Referenz liesse sich eine uebernommene Gastbuchung spaeter keiner
-- Reservierung mehr zuordnen -- sie kommt nur beim ersten Uebernehmen,
-- denn die Zeile ist danach unveraenderlich.
-- ---------------------------------------------------------------------------

ALTER TABLE cashbook_entry ADD COLUMN origin_reservation_ref text
  CHECK (origin_reservation_ref IS NULL OR length(origin_reservation_ref) <= 100);

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('cashbook_entry', 'origin_reservation_ref', 'Verweis auf eine Reservierung im Umsystem')
ON CONFLICT DO NOTHING;
