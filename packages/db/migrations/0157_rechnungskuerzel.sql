-- Rechnungskuerzel je Haus (Pruefung Rechnungssystem 2026-10-13).
--
-- Befund: der Zaehler laeuft je Property, die Nummer lautet aber nur
-- Jahr und laufende Nummer. Zwei Haeuser im selben Account vergeben damit
-- beide 2026-00001. § 14 Abs. 4 Nr. 4 UStG verlangt eine Nummer, die beim
-- **Unternehmer** einmalig ist, nicht beim Haus -- und die Haeuser eines
-- Accounts gehoeren in der Regel demselben (bei Sven: Hotel und
-- Gaestehaus, ein Rechtstraeger).
--
-- Mehrere Nummernkreise sind erlaubt, solange jede Nummer eindeutig
-- bleibt. Ein Kuerzel je Haus leistet genau das und laesst die
-- bestehende Zaehlung, ihre Sperre und ihre Lueckenlosigkeit unangetastet.
-- Ein gemeinsamer Zaehler fuer den Account haette alle Haeuser an eine
-- Sperrzeile gehaengt: der Check-out im Gaestehaus wartete auf den im
-- Hotel.

ALTER TABLE property ADD COLUMN invoice_prefix text
  CHECK (invoice_prefix ~ '^[A-Z0-9]{1,6}$');

-- Eindeutig im Account. Die Zeilenrichtlinie sieht ein Benutzer mit
-- einem Haus nicht ueber dessen Grenze; ein Index schon.
CREATE UNIQUE INDEX property_invoice_prefix ON property (account_id, invoice_prefix)
  WHERE invoice_prefix IS NOT NULL;

-- Das Uebungskuerzel bleibt am Zaehler (C11, Dokument 13), das Hauskuerzel
-- kommt aus der Property und wirkt ab der naechsten Nummer. Die Zaehlung
-- selbst laeuft weiter: eine Nummer H-2026-00042 nach 2026-00041 ist
-- eindeutig und luecklos nachvollziehbar.
CREATE OR REPLACE FUNCTION next_invoice_number(p_property bigint, p_year integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n bigint; pfx text; haus text;
BEGIN
  PERFORM assert_property_in_context(p_property);
  INSERT INTO invoice_counter (property_id, year) VALUES (p_property, p_year)
  ON CONFLICT DO NOTHING;
  UPDATE invoice_counter SET next_number = next_number + 1
   WHERE property_id = p_property AND year = p_year
  RETURNING next_number - 1, prefix INTO n, pfx;
  SELECT invoice_prefix INTO haus FROM property WHERE id = p_property;
  RETURN pfx || coalesce(haus || '-', '') || p_year || '-' || lpad(n::text, 5, '0');
END $$;

-- Fehlt einem Haus das Kuerzel, obwohl der Account ein zweites echtes Haus
-- fuehrt? SECURITY DEFINER, weil ein Benutzer mit Recht auf ein Haus das
-- andere ueber die Zeilenrichtlinie nicht sieht -- er saehe ein Haus allein
-- und stellte die doppelte Nummer still aus (vgl. 0014, 0018).
-- Uebungshaeuser zaehlen nicht: sie tragen ihr eigenes Kuerzel und
-- exportieren nichts.
CREATE OR REPLACE FUNCTION invoice_prefix_missing(p_property bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p property%ROWTYPE;
BEGIN
  PERFORM assert_property_in_context(p_property);
  SELECT * INTO p FROM property WHERE id = p_property;
  IF p.is_training OR p.invoice_prefix IS NOT NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM property o
                  WHERE o.account_id = p.account_id AND o.id <> p.id
                    AND NOT o.is_training);
END $$;
