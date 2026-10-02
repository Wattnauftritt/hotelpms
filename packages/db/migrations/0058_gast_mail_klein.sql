-- ---------------------------------------------------------------------------
-- 0058 -- Die Mailsuche wird unter der Zeilenrichtlinie wieder ein Indexscan.
--
-- Befund (Dokument 16, "Suche: die Schwelle hinter der Zeilenrichtlinie",
-- Punkt "Offen"). `guest` steht unter FORCE ROW LEVEL SECURITY. PostgreSQL
-- laesst eine Bedingung des Aufrufers nur dann **vor** der Richtlinie laufen
-- -- und damit als Indexbedingung --, wenn jede Funktion darin, die eine
-- Spalte beruehrt, LEAKPROOF ist; sonst koennte sie ueber eine
-- Fehlermeldung Zeilen fremder Mandanten verraten. `lower()` und `textlike`
-- sind es nicht. Der Index `guest_email_prefix` aus 0015 stand deshalb auf
-- `lower(email)` und wurde von der Anwendungsrolle nie benutzt: die
-- Mailsuche lief als Filter hinter der Richtlinie, und ein Begriff ohne
-- Treffer las jeden Gast des Accounts (`zz@nix.invalid`: 116 ms,
-- `Rows Removed by Filter: 60000` im Saatlauf).
--
-- Abhilfe. Die Kleinschreibung wird beim Schreiben gerechnet, nicht beim
-- Lesen. Auf der gespeicherten Spalte braucht die Suche keine Funktion mehr,
-- nur noch die Musteroperatoren `~>=~` und `~<~`, und die sind LEAKPROOF.
-- Dasselbe gilt fuer `=`: der Reservierungsimport sucht je Zeile den Gast zur
-- Adresse und bekommt den Index mit. Die Dublettenpruefung liest dieselbe
-- Spalte; sie steht dort in einem ODER mit `%` und bleibt ein Filter.
--
-- Warum gespeichert und nicht nur ein anderer Index. Ein Ausdrucksindex
-- verlangt den Ausdruck in der Abfrage, und der Ausdruck ist genau die
-- nicht-LEAKPROOF-Funktion. Ein Ausweg ueber eine eigene, als LEAKPROOF
-- erklaerte Funktion waere der schlechtere: LEAKPROOF ist eine Zusicherung,
-- die nur ein Superuser geben kann und die niemand prueft, und die
-- Migrationen laufen als `hotelpms_owner`, nicht als Superuser.
--
-- Datenschutz. Die Spalte ist dieselbe Adresse in anderer Schreibweise und
-- gehoert deshalb in `audit_redaction` (CLAUDE.md, Migration 0044); sonst
-- schriebe jede Aenderung der Adresse sie doch wieder ins Protokoll. Die
-- Loeschung muss nichts nachziehen: `guest_erase_one()` und
-- `guest_erase_partial()` setzen `email` auf NULL, und die Generierung
-- leert `email_lower` in derselben Anweisung mit. Ein Test haelt beides
-- fest (`packages/db/src/__tests__/dsgvo.test.ts`).
--
-- Kosten. `ADD COLUMN ... STORED` schreibt die Tabelle einmal neu und haelt
-- dabei die exklusive Sperre. Bei einer Gasttabelle in der Groessenordnung
-- eines Hauses sind das Sekunden; im Saatlauf mit 60 000 Gaesten unter
-- einer Sekunde.
-- ---------------------------------------------------------------------------

ALTER TABLE guest
  ADD COLUMN email_lower text GENERATED ALWAYS AS (lower(email)) STORED;

COMMENT ON COLUMN guest.email_lower IS
  'lower(email), gespeichert, damit die Suche unter der Zeilenrichtlinie '
  'ohne Funktion ueber der Spalte auskommt (Migration 0058).';

-- `text_pattern_ops`, weil der Bereich bytweise verglichen werden muss:
-- nur dann ist [p, p mit erhoehtem letzten Zeichen) genau die Menge der
-- Adressen, die mit p beginnen, unabhaengig von der Sortierfolge der
-- Datenbank. Die Klasse kennt auch `=`.
CREATE INDEX guest_email_lower ON guest (email_lower text_pattern_ops)
  WHERE email_lower IS NOT NULL;

/*
 * Die obere Grenze eines Anfangs: p mit um eins erhoehtem letzten Zeichen.
 * Alles, was mit p beginnt, liegt in [p, text_prefix_end(p)), und nichts
 * sonst -- bei bytweisem Vergleich, und UTF-8 sortiert bytweise genau nach
 * Codepunkt.
 *
 * Eine Funktion statt eines Ausdrucks in der Route, wegen der zwei Raender,
 * an denen `chr(n + 1)` einen Fehler wirft statt einer Grenze: hinter
 * U+D7FF beginnen die Ersatzzeichen, die in UTF-8 nicht vorkommen, also
 * weiter bei U+E000; und hinter U+10FFFF kommt nichts mehr. Dort bleibt die
 * Grenze bei p selbst, der Bereich ist leer -- U+10FFFF ist ein Nichtzeichen
 * und steht in keiner Adresse. Ein Fehler 500 fuer eine Eingabe, die man
 * tippen kann, waere der schlechtere Ausgang.
 *
 * Sie beruehrt keine Spalte, nur den Suchbegriff; ob sie LEAKPROOF ist,
 * spielt deshalb keine Rolle.
 */
CREATE OR REPLACE FUNCTION text_prefix_end(p text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT left(p, -1) || chr(CASE ascii(right(p, 1))
                              WHEN 55295   THEN 57344     -- U+D7FF -> U+E000
                              WHEN 1114111 THEN 1114111   -- U+10FFFF bleibt
                              ELSE ascii(right(p, 1)) + 1 END);
$$;

-- Ohne Aufgabe: die Anwendungsrolle konnte ihn nie benutzen (siehe oben).
DROP INDEX IF EXISTS guest_email_prefix;

INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('guest', 'email_lower', 'Kontaktdatum, Kopie von email')
ON CONFLICT DO NOTHING;
