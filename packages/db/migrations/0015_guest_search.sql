-- Namenssuche der Rezeption.
--
-- Befund aus dem Saatlauf mit 60 000 Gaesten: die Suche nach einem Namensteil
-- brauchte 147 Millisekunden, und zwar als **Seq Scan** ueber die ganze
-- Tabelle. Der GIN-Trigramm-Index wurde nicht benutzt: PostgreSQL schaetzt
-- die Trefferzahl des Operators `%` schlecht ein und haelt das Lesen der
-- Tabelle fuer billiger. Erzwungen lief derselbe Plan in 25 ms.
--
-- Der eigentliche Fehler steckt aber nicht in der Schaetzung, sondern in der
-- Form der Abfrage. `ORDER BY similarity(...) DESC LIMIT 20` muss **alle**
-- Treffer holen und dann sortieren; bei einem haeufigen Namen sind das
-- Tausende Zeilen fuer zwanzig Ausgaben. Die Kosten wachsen mit der
-- Haeufigkeit des Namens, und ausgerechnet bei "Mueller" wird es am
-- langsamsten.
--
-- Ein GiST-Trigramm-Index kann den Abstandsoperator `<->` **zur Sortierung**
-- benutzen. Der Index liefert die naechsten Nachbarn der Reihe nach, der
-- Scan hoert nach zwanzig Zeilen auf, und es gibt keinen Sortierschritt.
-- Gemessen: 14 ms statt 147 ms, und die Zeit haengt nicht mehr davon ab, wie
-- verbreitet der Name ist.
--
-- Der Preis ist ein groesserer und schreiblangsamerer Index. Fuer eine
-- Gasttabelle, in der die Rezeption den ganzen Tag tippt und selten
-- schreibt, ist das der richtige Tausch.

CREATE INDEX guest_last_name_gist ON guest USING gist (last_name gist_trgm_ops);
CREATE INDEX company_name_gist    ON company USING gist (name gist_trgm_ops);

-- E-Mail wird nicht unscharf gesucht, sondern von vorn getippt. Dafuer ist
-- ein Btree mit Musteroperatorklasse der passende Index und nicht Trigramm.
CREATE INDEX guest_email_prefix ON guest (lower(email) text_pattern_ops)
  WHERE email IS NOT NULL;

-- Die GIN-Indizes sind damit ohne Aufgabe. Sie stehen zu lassen kostet
-- Schreibzeit und Platz fuer nichts.
DROP INDEX IF EXISTS guest_last_name_trgm;
DROP INDEX IF EXISTS guest_email_trgm;
DROP INDEX IF EXISTS company_name_trgm;
