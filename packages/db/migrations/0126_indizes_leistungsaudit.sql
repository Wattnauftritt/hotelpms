-- ---------------------------------------------------------------------------
-- 0126 -- Fehlende Indizes aus dem Performance-Audit vom 11.10.2026.
--
-- Anforderung: Sven, 11.10.2026 ("Mach einen Performanceaudit des gesamten
-- projektes"), Bericht unter performance/audit-2026-10-11.md. Gemessen
-- gegen den Saatlauf (214 000 Reservierungen, 230 000 Buchungszeilen).
--
-- Nur Indizes, keine Aenderung an Daten oder Rechten. Haertegrad 1 bleibt
-- unberuehrt: ein Index ist kein UPDATE.
--
-- 1. Zimmerplan. Er zeigt Abgereiste mit (`CheckedOut`), jeder bisherige
--    Index auf reservation(property_id, ...) ist aber partiell ohne
--    `CheckedOut`. Der Planer konnte keinen davon nehmen und las bei jedem
--    Aufruf die ganze Tabelle, zweimal (Reservierungen und Naechte).
--    Dasselbe Muster haben Zimmer sortieren und die Abreiseliste.
--
-- 2. Housekeeping, Reinigungsplan und "Meine Zimmer" suchen Reservierungen
--    je Zimmer (resource_id) ohne property_id; der vorhandene Index beginnt
--    mit property_id und greift nicht. Je Zimmer und Aufruf ein Scan.
--    Zugleich der Fremdschluessel, den das Loeschen eines Zimmers prueft.
--
-- 3. charge.reservation_id und charge.invoice_id. Storno und No-Show
--    suchen die zu stornierenden Naechte ueber reservation_id, der Verlauf
--    und der Export ueber invoice_id. Beides las bisher die ganze Tabelle,
--    und das Rueckgaengig der KWHotel-Uebernahme pruefte den Fremdschluessel
--    je geloeschter Reservierung mit einem Scan.
--
-- 4. Fremdschluessel auf guest. Die Loeschung eines Gastes
--    (guest_erase_one), die Auskunft nach Art. 15 und das Rueckgaengig der
--    Uebernahme suchen ueber diese Spalten.
--
-- 5. maintenance_ticket hatte nur den Primaerschluessel. Housekeeping und
--    die Personal-App zaehlen offene Tickets je Zimmer, und geschlossene
--    Tickets werden nie geloescht -- der Scan waechst mit den Jahren.
--
-- 6. Kleinere Fremdschluessel, die die Nachtbuchung (routing_rule je
--    gebuchter Nacht) oder das Rueckgaengig der Uebernahme je Zeile prueft.
-- ---------------------------------------------------------------------------

-- 1. Zimmerplan, Zimmer sortieren, Abreisen
CREATE INDEX reservation_property_stay ON reservation (property_id, departure, arrival)
  WHERE status IN ('Optional','Confirmed','InHouse','CheckedOut');

-- 2. Reservierungen je Zimmer
CREATE INDEX reservation_resource_departure ON reservation (resource_id, departure)
  WHERE resource_id IS NOT NULL;
CREATE INDEX reservation_resource_arrival ON reservation (resource_id, arrival)
  WHERE resource_id IS NOT NULL;

-- 3. Buchungszeilen und Zahlungen
CREATE INDEX charge_reservation ON charge (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX charge_invoice ON charge (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX settlement_invoice ON settlement (invoice_id) WHERE invoice_id IS NOT NULL;

-- 4. Fremdschluessel auf guest
CREATE INDEX folio_guest ON folio (guest_id) WHERE guest_id IS NOT NULL;
CREATE INDEX booking_booker_guest ON booking (booker_guest_id) WHERE booker_guest_id IS NOT NULL;
CREATE INDEX registration_guest ON registration (guest_id);
CREATE INDEX guest_agreement_guest ON guest_agreement (guest_id);

-- 5. Offene Tickets je Zimmer
CREATE INDEX maintenance_ticket_resource_open ON maintenance_ticket (resource_id)
  WHERE status <> 'done';
CREATE INDEX maintenance_ticket_property ON maintenance_ticket (property_id, status);

-- 6. Kleinere Fremdschluessel
CREATE INDEX routing_rule_reservation ON routing_rule (reservation_id);
CREATE INDEX routing_rule_target_folio ON routing_rule (target_folio_id)
  WHERE target_folio_id IS NOT NULL;
CREATE INDEX deposit_request_reservation ON deposit_request (reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX avs_export_reservation ON avs_export (reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX reservation_channel_wanted ON reservation (channel_wanted_resource_id)
  WHERE channel_wanted_resource_id IS NOT NULL;

-- Statistik sofort, damit der Planer die neuen Indizes beim ersten Aufruf
-- nach dem Einspielen kennt und nicht erst nach dem naechsten Autovacuum.
ANALYZE reservation;
ANALYZE charge;
