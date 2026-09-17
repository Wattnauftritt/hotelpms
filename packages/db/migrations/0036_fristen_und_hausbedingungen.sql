-- Fristen richtig rechnen, und hausindividuelle Bedingungen zum Unterschreiben.
--
-- Drei Befunde aus einer Pruefung gegen den Wortlaut der Gesetze und gegen
-- eine echte kommunale Satzung (Cuxhaven), ausgeloest von der Frage, ob
-- Laender und Gemeinden laengere Fristen vorschreiben.
--
-- **1. Die Meldescheinfrist lief ab dem falschen Tag.** § 30 Abs. 4 BMG sagt
-- "vom Tag der Abreise der beherbergten Person an ein Jahr". Gerechnet wurde
-- ab **Anreise**. Bei einem Aufenthalt von drei Naechten wurde der Schein
-- drei Tage zu frueh vernichtet; bei einem Langzeitgast Wochen. Zu frueh
-- vernichtet heisst: die Meldebehoerde verlangt Einsicht und bekommt sie
-- nicht, obwohl die Frist noch laeuft.
--
-- Die Abreise steht ausserdem bei der Erfassung noch nicht fest. Ein Gast
-- verlaengert oder reist frueher ab, und `destroy_after` bliebe auf dem
-- Wert vom Anreisetag stehen. Deshalb ein Trigger auf Anweisungsebene, der
-- die Frist nachzieht, wenn sich der Aufenthalt aendert -- und nicht ein
-- Aufruf in jeder Route, die an `departure` ruehrt: davon gibt es mehrere,
-- und die naechste wuerde ihn vergessen.
--
-- **2. Der Gaestebeitragsnachweis ist etwas anderes als der Meldeschein --
-- und wird laenger aufbewahrt.** Die Gaestebeitragssatzung der Stadt
-- Cuxhaven verlangt in § 9 Abs. 5 das Gaesteverzeichnis "sechs Jahre ab
-- Beginn des auf die Eintragung folgenden Kalenderjahres"; ein Verstoss ist
-- eine Ordnungswidrigkeit mit Geldbusse bis 10 000 Euro. Andere Gemeinden
-- schreiben andere Fristen vor -- die Ermaechtigung steht in den
-- Kommunalabgabengesetzen der Laender, nicht im Bundesrecht, und damit ist
-- die Frist je Haus verschieden.
--
-- Das ist **kein** Grund, den Meldeschein laenger zu halten: den verlangt
-- § 30 Abs. 4 BMG nach einem Jahr zu vernichten, und das ist eine Pflicht,
-- kein Ermessen. Was sechs Jahre bleibt, sind Name, Anschrift, Zeitraum,
-- Naechte, Satz und Betrag -- also das, was ohnehin in Beleg und Rechnung
-- steht. Die Frist gehoert deshalb ans Haus und bremst die Anonymisierung,
-- nicht den Meldeschein.
--
-- **3. Unterschrieben wird in der Praxis mehr als der Meldeschein.** Viele
-- Haeuser lassen den Gast zugleich eine Hausbedingung unterschreiben, etwa
-- eine Pauschale bei Verlust der Zimmerkarte. Das ist zulaessig, aber es ist
-- **nicht** der Meldeschein: der ist oeffentlich-rechtlich, zweckgebunden
-- (Art. 5 Abs. 1 lit. b DSGVO) und wird nach einem Jahr vernichtet; eine
-- Vereinbarung ueber 50 Euro ist privatrechtlich und muss ueber die
-- Verjaehrung hinaus nachweisbar bleiben. Beides in ein Feld zu schreiben
-- hiesse, entweder den Meldeschein zu lange zu halten oder den Nachweis der
-- Vereinbarung mit ihm zu vernichten.
--
-- Deshalb zwei Tabellen: der Text am Haus, versioniert, und die Zustimmung
-- am Aufenthalt. Und deshalb bleibt es dabei, dass eine Unterschrift **auf
-- dem Meldeschein** nur vom auslaendischen Gast gespeichert wird.

-- ---------------------------------------------------------------- 1. Frist

ALTER TABLE property
  -- Aufbewahrung des Gaestebeitragsnachweises in Jahren, ab Beginn des auf
  -- den Aufenthalt folgenden Kalenderjahres. Sechs als Standard, weil das
  -- die in den geprueften Satzungen haeufigste Frist ist; wer eine andere
  -- Satzung hat, traegt sie ein. Null heisst: keine Abgabe erhoben.
  ADD COLUMN guest_levy_retention_years smallint NOT NULL DEFAULT 6
    CHECK (guest_levy_retention_years BETWEEN 0 AND 30);

COMMENT ON COLUMN property.guest_levy_retention_years IS
  'Gaestebeitragsnachweis, Jahre ab Beginn des Folgejahres. Kommunal geregelt.';

/**
 * Die Meldescheinfrist an den tatsaechlichen Aufenthalt binden.
 *
 * Auf Anweisungsebene, weil der Nachtlauf Abreisen im Stapel setzt: ein
 * Trigger je Zeile liefe dort einmal je Gast.
 *
 * Massgeblich ist der tatsaechliche Abreisetag, wenn es ihn gibt
 * (`checked_out_at`), sonst der geplante. Ein Gast, der frueher geht,
 * verkuerzt damit die Frist; einer, der verlaengert, schiebt sie.
 */
CREATE OR REPLACE FUNCTION registration_refresh_destroy_after()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE registration reg
     SET destroy_after = (COALESCE((n.checked_out_at AT TIME ZONE 'UTC')::date,
                                   n.departure) + INTERVAL '1 year')::date
    FROM neu n
   WHERE reg.reservation_id = n.id
     AND reg.destroy_after IS DISTINCT FROM
         (COALESCE((n.checked_out_at AT TIME ZONE 'UTC')::date,
                   n.departure) + INTERVAL '1 year')::date;
  RETURN NULL;
END $$;

CREATE TRIGGER reservation_registration_frist
  AFTER UPDATE ON reservation
  REFERENCING NEW TABLE AS neu
  FOR EACH STATEMENT EXECUTE FUNCTION registration_refresh_destroy_after();

-- Die bestehenden Scheine tragen eine Frist ab Anreise. Nachziehen, damit
-- der Bestand nicht zwei Rechenarten nebeneinander fuehrt.
UPDATE registration reg
   SET destroy_after = (COALESCE((r.checked_out_at AT TIME ZONE 'UTC')::date,
                                 r.departure) + INTERVAL '1 year')::date
  FROM reservation r
 WHERE r.id = reg.reservation_id;

-- --------------------------------------------------------- 2. Hausbedingung

/**
 * Der Text, den ein Haus unterschreiben laesst.
 *
 * **Versioniert, nicht geaendert.** Wer die Pauschale von 50 auf 60 Euro
 * setzt, legt eine neue Fassung an. Sonst stuende an einer zwei Jahre alten
 * Unterschrift der heutige Text, und der Nachweis waere wertlos -- genau die
 * Falle, die `invoice.issuer_snapshot` an anderer Stelle schon vermeidet.
 */
CREATE TABLE property_terms (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES property(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  code          text NOT NULL,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title         text NOT NULL,
  body          text NOT NULL,
  -- Ob der Gast unterschreiben soll oder ob Ankreuzen genuegt. Eine
  -- Zahlungspflicht will unterschrieben sein, eine Hausordnung nicht
  -- unbedingt.
  requires_signature boolean NOT NULL DEFAULT true,
  active_from   date NOT NULL DEFAULT current_date,
  active_to     date,
  created_by    bigint REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Gleich, nicht nur groesser: wer am selben Tag einen Tippfehler
  -- nachbessert, erzeugt eine Fassung, die nie gegolten hat. Die zu
  -- verbieten hiesse, den Tippfehler stehen lassen zu muessen -- und eine
  -- Fassung der Laenge null wird von der Abfrage ohnehin nicht gefunden,
  -- weil sie `active_from <= Tag < active_to` verlangt.
  CONSTRAINT terms_validity CHECK (active_to IS NULL OR active_to >= active_from),
  UNIQUE (property_id, code, version)
);
CREATE INDEX property_terms_aktiv ON property_terms (property_id, code, active_from);

/**
 * Was dieser Gast unterschrieben hat.
 *
 * Am Aufenthalt, nicht am Meldeschein: der Meldeschein wird nach einem Jahr
 * vernichtet, die Vereinbarung muss laenger nachweisbar bleiben. Sie haengt
 * deshalb auch nicht an `registration` und geht mit dessen Vernichtung nicht
 * mit.
 *
 * `terms_id` zeigt auf die **Fassung**, nicht auf das Haus: was
 * unterschrieben wurde, steht damit fest, auch wenn der Text spaeter
 * geaendert wird.
 */
CREATE TABLE guest_agreement (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  terms_id       bigint NOT NULL REFERENCES property_terms(id),
  guest_id       bigint REFERENCES guest(id),
  -- Nur, wenn die Fassung sie verlangt. Sonst genuegt der Zeitpunkt der
  -- Zustimmung, und eine Unterschrift ohne Anlass waere eine Erhebung ohne
  -- Rechtsgrund.
  signature_svg  text,
  agreed_at      timestamptz NOT NULL DEFAULT now(),
  created_by     bigint REFERENCES app_user(id),
  UNIQUE (reservation_id, terms_id)
);
CREATE INDEX guest_agreement_reservation ON guest_agreement (reservation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property_terms','guest_agreement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('property_terms');
SELECT attach_audit('guest_agreement');

-- Eine unterschriebene Vereinbarung ist ein Nachweis. Sie zu aendern hiesse,
-- den Nachweis zu aendern; eine falsche Zustimmung wird geloescht und neu
-- erfasst, solange der Aufenthalt laeuft.
REVOKE UPDATE ON guest_agreement FROM hotelpms_app;
