-- ---------------------------------------------------------------------------
-- 0218 -- Preiskalender senden: vorher gegen den Channel Manager pruefen.
--
-- Anforderung: Sven, 27.10.2026 (Thread "Preisabruf vom Channelmanager
-- beschleunigen"): "wenn ich bestimmte Tage lokal aendere und pushen will
-- muesste Staygrid vor dem Push alle geaenderten Tage einzeln nochmal vom
-- Channelmanager abrufen und mit dem Stand vor der lokalen Aenderung
-- gegenpruefen ... Sonst aendern wir veraltete Preise."
--
-- Der Stand vor der lokalen Aenderung ist `rate_calendar_sent` (0180): was
-- zuletzt beim Channel Manager stand, aus dem letzten Senden oder Abruf.
-- Das Umsystem holt zu den abgeholten Tagen den Stand drueben und meldet,
-- wo er davon abweicht (`status: checked` mit `conflicts`). Verglichen wird
-- dort und nicht hier, weil nur das Umsystem weiss, wie ein Preis je
-- Belegung drueben aussieht: RoomCloud kennt einen Preis je Zimmer, StayGrid
-- einen je Belegung.
--
-- Weicht etwas ab, wird nicht gesendet. Der Auftrag steht auf `conflict`
-- mit den Tagen und je Tag drei Staenden (zuletzt abgeglichen, hier, drueben),
-- bis ein Mensch je Tag entscheidet (`resolved_at`). Danach geht ein neuer
-- Auftrag hinaus, auf Knopfdruck wie jeder.
--
-- Kein Audit-Trigger (0179), nichts Personenbezogenes, kein Eintrag in
-- `audit_redaction`.
-- ---------------------------------------------------------------------------

ALTER TABLE rate_calendar_push DROP CONSTRAINT rate_calendar_push_status_check;
ALTER TABLE rate_calendar_push ADD CONSTRAINT rate_calendar_push_status_check
  CHECK (status IN ('requested','done','failed','superseded','conflict'));

ALTER TABLE rate_calendar_push
  ADD COLUMN checked_at  timestamptz,
  ADD COLUMN conflicts   jsonb,
  ADD COLUMN resolved_at timestamptz;
