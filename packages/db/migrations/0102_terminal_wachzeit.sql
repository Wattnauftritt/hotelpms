-- ---------------------------------------------------------------------------
-- 0102 -- Gaesteterminal: Wachzeit je Geraet.
--
-- Anforderung: Sven, 07.10.2026. Das Terminal soll von morgens bis abends
-- den Bildschirm wach halten und ihn danach loslassen, damit Windows ihn
-- schaltet, wie es eingestellt ist. Die Seite am Touchscreen haelt dafuer in
-- der Wachzeit eine Bildschirmsperre (Screen Wake Lock) und gibt sie
-- ausserhalb frei.
--
-- Je Geraet, nicht je Haus: ein Terminal an der Rezeption und eines im
-- Fruehstuecksraum haben verschiedene Zeiten. Ohne Zeiten bleibt alles wie
-- bisher. `awake_from` groesser als `awake_until` heisst ueber Mitternacht;
-- gleich waere "nie" oder "immer" und ist deshalb ausgeschlossen. Gerechnet
-- wird in der Zeitzone des Hauses, nicht in der des Geraets: die Uhr eines
-- Kioskrechners stimmt nicht immer, und die Zeit steht im Haus.
--
-- Kein Eintrag in audit_redaction: eine Uhrzeit bezeichnet keinen Menschen.
-- ---------------------------------------------------------------------------

ALTER TABLE terminal_device
  ADD COLUMN awake_from  time,
  ADD COLUMN awake_until time,
  ADD CONSTRAINT terminal_device_wachzeit CHECK (
    (awake_from IS NULL) = (awake_until IS NULL)
    AND (awake_from IS NULL OR awake_from <> awake_until));
