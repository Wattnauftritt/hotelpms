-- Ablage des erzeugten Rechnungsbelegs: PDF/A-3 mit eingebettetem CII-XML
-- nach EN 16931 (E3, Dokument 13).
--
-- **Warum eine eigene Tabelle und nicht invoice.pdf_path.** Die Spalte gibt
-- es seit 0010, aber sie ist unbenutzbar: invoice ist Haertegrad 1, die
-- Anwendungsrolle hat kein UPDATE darauf. Ein Pfad koennte also nur beim
-- Anlegen der Rechnung gesetzt werden -- in genau dem Moment, in dem das
-- PDF noch nicht existiert, weil es der Worker erst danach erzeugt. Eine
-- Zeile in einer zweiten Tabelle ist der einzige Weg, der die
-- Unveraenderlichkeit der Rechnung nicht antastet.
--
-- **Warum die Bytes in der Datenbank liegen.** Ein Beleg gehoert zur
-- Rechnung, und die Rechnung gehoert einem Mandanten. In der Datenbank
-- erbt er die Zeilenrichtlinie, die Sicherung und die Aufbewahrungsfrist,
-- ohne dass ein zweites System dieselben Regeln noch einmal umsetzen muss.
-- Ein PDF/A-3 dieser Art wiegt einige zehn Kilobyte; bei einem Haus mit
-- 20 000 Rechnungen im Jahr sind das rund zwei Gigabyte, und das ist
-- billiger als ein zweiter Ablageort mit eigener Mandantentrennung.

CREATE TABLE invoice_document (
  invoice_id   bigint PRIMARY KEY REFERENCES invoice(id),
  property_id  bigint NOT NULL REFERENCES property(id),
  pdf          bytea  NOT NULL,
  -- Das eingebettete CII-XML, zusaetzlich im Klartext. Ein Pruefer will es
  -- ohne PDF-Werkzeug lesen koennen, und ein spaeterer Versandweg
  -- (Peppol, E-Mail) braucht es ohne den Umweg ueber das PDF.
  xml          text,
  -- Leer, wenn das XML eingebettet ist. Sonst der Grund, warum nicht:
  -- die Norm kennt keine Kleinbetragsrechnung, und ohne USt-IdNr. des
  -- Hauses gibt es kein gueltiges EN 16931 (BR-CO-26). Das muss sichtbar
  -- sein, sonst sucht die Buchhaltung im Dunkeln.
  xml_findings jsonb  NOT NULL DEFAULT '[]'::jsonb,
  byte_count   integer NOT NULL,
  -- Fingerabdruck des ausgelieferten Belegs. Wer behauptet, eine andere
  -- Fassung bekommen zu haben, laesst sich damit widerlegen.
  sha256       text   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_document_bytes CHECK (byte_count > 0)
);

COMMENT ON TABLE invoice_document IS
  'PDF/A-3 mit eingebettetem CII-XML (ZUGFeRD) zu einer festgeschriebenen Rechnung.';
COMMENT ON COLUMN invoice_document.xml_findings IS
  'Warum kein XML eingebettet ist, als Liste aus key, rule und de.';

ALTER TABLE invoice_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_document FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice_document
  USING (property_id = ANY (app_property_ids()));

-- Haertegrad 1 wie die Rechnung selbst. Eine ausgestellte Rechnung wird
-- nicht neu gerendert: waere der Beleg ersetzbar, koennte eine spaetere
-- Layoutaenderung stillschweigend ein anderes Dokument an die Stelle des
-- versandten setzen. Ein neuer Beleg ist eine neue Rechnung.
SELECT make_append_only('invoice_document');
