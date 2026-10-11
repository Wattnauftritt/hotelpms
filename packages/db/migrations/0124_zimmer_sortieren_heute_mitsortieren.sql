-- ---------------------------------------------------------------------------
-- 0124 -- Zimmer sortieren: Anreisen von heute werden immer mitsortiert.
--
-- Anforderung: Sven, 11.10.2026: "buchungen von heute sollen sortiert werden
-- solange sie noch nicht eingecheckt ist. das ist der einzige punkt". Die
-- Einstellung aus 0104, heutige Anreisen mit Zimmer festzuhalten, stand
-- vorgegeben an und liess den Sortierer genau die Gaeste meiden, bei denen
-- eine Luecke am meisten kostet. Bis zum Check-in ist das Zimmer nicht
-- seins; danach haelt ihn der Status ohnehin fest.
--
-- Die Spalte geht ganz, nicht nur ihre Vorgabe: ein gespeicherter Haken
-- haette sonst in jedem Haus, das die Einstellung schon einmal gesichert
-- hat, weiter gebremst, und eine zweite Regel neben dem Check-in ist genau
-- das, was Sven nicht will.
-- ---------------------------------------------------------------------------

ALTER TABLE room_sort_setting DROP COLUMN keep_today;
