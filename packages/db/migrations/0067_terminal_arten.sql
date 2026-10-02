-- ---------------------------------------------------------------------------
-- Das Gaesteterminal als allgemeiner Anzeige-Client (Dokument 31, §11).
--
-- Zu den beiden Arten aus 0063 kommen drei:
--
--   terms_sign  eine Hausbedingung zustimmen oder unterschreiben, ueber
--               denselben Weg wie am Tresen (platform/hausbedingungen.ts)
--   content     eine Seite des Hauses zeigen (0062)
--   url         eine freigegebene externe Seite zeigen (0062)
--
-- und `registration_fill` wird angebunden: das Terminal fuellt den
-- Meldeschein ueber den Online-Check-in aus (0061). Der Link dafuer
-- entsteht beim Oeffnen und geht nur an das Geraet; hier steht lediglich
-- seine Kennung, damit er mit dem Auftrag zurueckgezogen werden kann.
--
-- Jede Art hat ihren Bezug, und die Datenbank verlangt ihn -- ein Auftrag
-- "zeige Inhalt" ohne Inhalt waere einer, den das Terminal nicht oeffnen
-- kann und die Rezeption nicht versteht.
-- ---------------------------------------------------------------------------

ALTER TABLE terminal_job DROP CONSTRAINT terminal_job_kind_check;
ALTER TABLE terminal_job ADD CONSTRAINT terminal_job_kind_check
  CHECK (kind IN ('registration_sign', 'registration_fill', 'terms_sign', 'content', 'url'));

ALTER TABLE terminal_job
  ADD COLUMN terms_id         bigint REFERENCES property_terms(id),
  ADD COLUMN content_id       bigint REFERENCES terminal_content(id),
  ADD COLUMN url_id           bigint REFERENCES terminal_url(id),
  -- Der Link wird nach einem Jahr nicht vernichtet, aber er koennte es
  -- einmal werden; der Auftrag soll das nicht aufhalten.
  ADD COLUMN checkin_token_id bigint REFERENCES checkin_token(id) ON DELETE SET NULL;

ALTER TABLE terminal_job ADD CONSTRAINT terminal_job_bezug CHECK (
  CASE kind
    WHEN 'registration_sign' THEN reservation_id IS NOT NULL
    WHEN 'registration_fill' THEN reservation_id IS NOT NULL
    WHEN 'terms_sign'        THEN reservation_id IS NOT NULL AND terms_id IS NOT NULL
    WHEN 'content'           THEN content_id IS NOT NULL
    WHEN 'url'               THEN url_id IS NOT NULL
  END);
