-- Wann ein Stand gebaut wurde -- damit man weiss, auf welchen man zurueck
-- will.
--
-- **Der Befund.** Das Panel bot vier Staende zum Zurueckrollen an, jeder
-- ein Hash. Welcher davon der von gestern Mittag war und welcher der von
-- vor zwei Wochen, stand nirgends; wer zurueck wollte, musste raten oder
-- in der Liste der Anforderungen nach dem Hash suchen -- und ein von Hand
-- ausgerollter Stand steht dort gar nicht. Eine Liste ohne Zeit ist zum
-- Zurueckrollen wertlos: der Punkt ist ja gerade, zu dem Stand zu kommen,
-- der *vor* dem Fehler lief.
--
-- **Welche Zeit.** Die Bauzeit auf der Maschine: deploy.sh setzt .fertig,
-- wenn Bau und Kopie durch sind, und der Agent liest die Aenderungszeit
-- dieser Datei mit. seen_at taugt dafuer nicht -- beim ersten Tick nach
-- 0041 bekamen alle drei alten Staende dieselbe Sekunde. Die Commit-Zeit
-- aus git gibt es hier nicht: releases/<sha> ist ein Archiv ohne
-- Geschichte, mit Absicht. NULL bleibt, was der Agent noch nicht gemeldet
-- hat -- das Panel zeigt dann nur den Hash, wie bisher.

ALTER TABLE release ADD COLUMN built_at timestamptz;

COMMENT ON COLUMN release.built_at IS
  'Aenderungszeit von releases/<commit>/.fertig: wann der Bau auf der '
  'Maschine durch war. NULL, solange der Agent sie nicht gemeldet hat.';
