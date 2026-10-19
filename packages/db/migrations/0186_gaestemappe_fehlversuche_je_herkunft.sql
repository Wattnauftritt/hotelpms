-- ---------------------------------------------------------------------------
-- Gaestemappe: Fehlversuche der Freischaltung auch je Herkunft
-- (Audit 19.10.2026, N2).
--
-- Bis hierher zaehlte nur das Zimmer (0147). Wer die Karte kennt -- der
-- Vorgaenger im Zimmer, ein Besucher, ein Foto --, konnte mit zehn falschen
-- Werten je Viertelstunde das Zimmer dauerhaft sperren; dann bekam auch der
-- echte Gast mit der richtigen PLZ 429.
--
-- Jetzt zaehlt zuerst die Herkunft je Zimmer, mit derselben Grenze wie
-- bisher das Zimmer. Ein Dritter sperrt damit sich selbst, nicht den Gast.
-- Das Zimmer zaehlt weiter, mit einer hoeheren Grenze, damit wechselnde
-- Adressen das Durchprobieren nicht beliebig vervielfachen. Ganz verhindern
-- laesst sich das Aussperren durch jemanden mit vielen Adressen nicht, ohne
-- die Grenze aufzugeben; es kostet jetzt aber mehr als ein Telefon.
--
-- Die Bedenken aus 0147 (im Hotel-WLAN teilen sich alle Gaeste eine
-- Adresse, im Mobilnetz wechselt sie) treffen eine Grenze **nur** je
-- Herkunft; deshalb bleibt die des Zimmers daneben stehen.
--
-- **Gespeichert wird der SHA-256 der Adresse, nicht die Adresse.** Die
-- Tabelle braucht nur Gleichheit. Pseudonym ist das trotzdem, nicht anonym:
-- der Raum der IPv4-Adressen ist klein genug, um ihn durchzurechnen. Der
-- Worker loescht eine Zeile einen Tag nach dem letzten Fehlversuch, wie die
-- des Zimmers. Kein Audit-Trigger aus demselben Grund wie bei 0147: der
-- Zaehler aendert sich mit jedem Tippfehler und sagt nichts, was jemand
-- spaeter wissen muesste; damit auch kein Eintrag in `audit_redaction`.
-- ---------------------------------------------------------------------------

CREATE TABLE guest_folder_unlock_failure_origin (
  resource_id     bigint NOT NULL REFERENCES resource(id),
  origin_hash     text NOT NULL,
  property_id     bigint NOT NULL REFERENCES property(id),
  failures        integer NOT NULL DEFAULT 0,
  window_start    timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, origin_hash)
);

ALTER TABLE guest_folder_unlock_failure_origin ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_folder_unlock_failure_origin FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON guest_folder_unlock_failure_origin
  USING (property_id = ANY (app_property_ids()));
