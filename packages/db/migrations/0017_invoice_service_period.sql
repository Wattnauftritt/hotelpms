-- Leistungszeitraum an der Rechnung.
--
-- § 14 Abs. 4 Nr. 6 UStG verlangt den Zeitpunkt der Leistung. Bei
-- Beherbergung ist das der **Aufenthalt**, nicht das Rechnungsdatum. Die
-- Verwechslung der beiden ist der häufigste Mangel an Hotelrechnungen, und
-- sie kostet dem Firmenkunden den Vorsteuerabzug.
--
-- Der Zeitraum wird aus den Geschäftsdaten der abgerechneten Positionen
-- abgeleitet und mitgeschrieben, nicht bei Bedarf nachgerechnet: eine
-- festgeschriebene Rechnung darf sich nicht ändern, auch nicht, wenn später
-- Positionen zu demselben Folio hinzukommen.

ALTER TABLE invoice
  ADD COLUMN service_from date,
  ADD COLUMN service_to   date,
  ADD CONSTRAINT invoice_service_period
    CHECK (service_to IS NULL OR service_from IS NULL OR service_to >= service_from);

COMMENT ON COLUMN invoice.service_from IS
  'Beginn des Leistungszeitraums nach § 14 Abs. 4 Nr. 6 UStG. Bei Beherbergung die erste abgerechnete Nacht.';
COMMENT ON COLUMN invoice.service_to IS
  'Ende des Leistungszeitraums. Bei Beherbergung die letzte abgerechnete Nacht.';
