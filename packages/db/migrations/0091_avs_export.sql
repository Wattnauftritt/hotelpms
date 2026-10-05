-- ---------------------------------------------------------------------------
-- 0091 -- Meldescheine als Datei fuer AVS (Gaestekarte und Kurbeitrag).
--
-- Anforderung: Sven, 05.10.2026: "dann lass das nach vorgabe von
-- adminpanel und wie wir das geplant haben bauen". Konzept:
-- adminpanel/gastdaten-meldeschein-konzept.md, Abschnitt 2.5. Grundlage ist
-- die AVS-Dokumentation "Meldeschein Importschnittstelle" (Stand 24.05.2022).
--
-- Drei Dinge, die die Schnittstelle vorgibt und die das Schema tragen muss:
--
-- **Eine Datei je Aufenthalt, nicht eine Sammeldatei** (Sven, 05.10.2026):
-- die Rezeption erstellt die Kurkarte in dem Moment, in dem der Gast
-- eincheckt und den Meldeschein ausfuellt. Sie laedt die Datei an der
-- Reservierung herunter und liest sie gleich in AVS ein.
--
-- 1. **Uebertragen ist endgueltig.** AVS hat keine Updateschnittstelle, ein
--    geaenderter Satz darf nicht noch einmal geschickt werden. Jeder Schein
--    merkt sich deshalb, mit welcher Datei er ging, und keine zweite nimmt
--    ihn wieder auf.
-- 2. **Die Kennungen gelten je Gemeinde.** Objektnummer (`hotelid`) und die
--    Kategorien vergibt die Kurverwaltung; deshalb eine Einstellung je Haus.
-- 3. **Die digitale Gaestekarte braucht eine Einwilligung** (doppeltes
--    Opt-in bei AVS). Ohne Haekchen geht keine Mailadresse mit.
-- ---------------------------------------------------------------------------

/**
 * Einstellung je Haus. Ohne sie kein Export: ohne Objektnummer ordnet AVS
 * den Schein keinem Haus zu.
 */
CREATE TABLE avs_setting (
  property_id      bigint PRIMARY KEY REFERENCES property(id),
  hotel_id         text NOT NULL CHECK (hotel_id ~ '^[0-9]{1,10}$'),
  origin           text NOT NULL DEFAULT 'StayGrid'
                   CHECK (length(origin) BETWEEN 1 AND 40),
  -- Bildet auch den Dateinamen; AVS erlaubt zehn Zeichen.
  user_name        text NOT NULL DEFAULT 'StayGrid'
                   CHECK (user_name ~ '^[A-Za-z0-9_-]{1,10}$'),
  -- Juengere werden nicht gemeldet (Cuxhaven: Kategorie 1 "ab vollendetem
  -- 16. Lebensjahr").
  min_age          smallint NOT NULL DEFAULT 16 CHECK (min_age BETWEEN 0 AND 30),
  -- Kategorie ohne Befreiung. Die Befreiung bringt ihre eigene mit (0089).
  default_category smallint NOT NULL DEFAULT 1 CHECK (default_category BETWEEN 1 AND 99),
  -- Fruehstuecksanteil je gemeldeter Person und Nacht in Cent. AVS will das
  -- reine Uebernachtungsentgelt; wo das Fruehstueck im Preis steckt, zieht
  -- die Datei es ab. Das Adminpanel hatte 10 EUR fest im Code -- hier ist es
  -- eine Angabe des Hauses, 0 fuer ein Haus ohne Fruehstueck im Preis.
  breakfast_cent   integer NOT NULL DEFAULT 0 CHECK (breakfast_cent BETWEEN 0 AND 100000),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE avs_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE avs_setting FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON avs_setting USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('avs_setting');

/**
 * Eine erzeugte Datei, je Meldeschein eine. Ihr Inhalt wird **nicht** gespeichert: er ist eine
 * Kopie von Meldescheinen samt Ausweisnummern, die die Loeschung nach einem
 * Jahr kennen muesste. Erneut herunterladen heisst, dieselben Scheine noch
 * einmal zu schreiben -- solange es sie gibt.
 */
CREATE TABLE avs_export (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  file_name     text NOT NULL,
  persons       integer NOT NULL CHECK (persons > 0),
  created_by    bigint REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avs_export_property ON avs_export (property_id, created_at DESC);

ALTER TABLE avs_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE avs_export FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON avs_export USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('avs_export');
-- Eine Datei ist ein Nachweis, was gemeldet wurde.
REVOKE UPDATE, DELETE ON avs_export FROM hotelpms_app;

ALTER TABLE registration
  ADD COLUMN avs_export_id bigint REFERENCES avs_export(id),
  -- Einwilligung in die digitale Gaestekarte per Mail (AVS `digit_gastkart`).
  ADD COLUMN digital_guest_card boolean NOT NULL DEFAULT false;
CREATE INDEX registration_avs_export ON registration (avs_export_id)
  WHERE avs_export_id IS NOT NULL;

/**
 * Einmal gemeldet, bleibt gemeldet. Die Anwendungsrolle darf
 * `avs_reported_at` und `avs_export_id` setzen, aber nie zuruecknehmen oder
 * umschreiben: ein zweiter Export desselben Scheins waere bei AVS ein
 * zweiter Gast.
 */
CREATE OR REPLACE FUNCTION registration_avs_endgueltig()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.avs_reported_at IS NOT NULL
     AND (NEW.avs_reported_at IS DISTINCT FROM OLD.avs_reported_at
          OR NEW.avs_export_id IS DISTINCT FROM OLD.avs_export_id) THEN
    RAISE EXCEPTION 'Meldeschein % ist an AVS gemeldet und bleibt es', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER registration_avs_endgueltig
  BEFORE UPDATE OF avs_reported_at, avs_export_id ON registration
  FOR EACH ROW EXECUTE FUNCTION registration_avs_endgueltig();
