-- Abruf aus einem Kontingent (Aufgabe 10, Dokument 16).
--
-- `availability_block` gibt es seit 0009, und der Nachtlauf gibt bei Ablauf
-- den nicht abgerufenen Rest frei: `quantity - picked_up`. Nur gab es bisher
-- keinen Weg, `picked_up` zu erhoehen -- die Zeile wurde nie beschrieben.
-- Ein Kontingent konnte also angelegt und freigegeben, aber nie benutzt
-- werden.
--
-- Was fehlte, ist der Verweis von der Reservierung auf das Kontingent. Ohne
-- ihn laesst sich weder sagen, welche Reservierungen zu einer Gruppe
-- gehoeren, noch beim Storno erkennen, dass ein Platz an das Kontingent
-- zurueckfaellt und nicht an den freien Verkauf.

ALTER TABLE reservation
  ADD COLUMN block_id bigint REFERENCES availability_block(id);

-- Die Abrufliste einer Gruppe ist die haeufigste Abfrage darauf, und sie
-- fragt immer nach einem Kontingent. Partiell, weil die grosse Mehrheit der
-- Reservierungen zu keinem gehoert.
CREATE INDEX reservation_block ON reservation (block_id)
  WHERE block_id IS NOT NULL;

-- Der Abrufzaehler darf nie ueber die Kontingentgroesse steigen. Das ist die
-- Bedingung, auf die sich der Nachtlauf beim Freigeben verlaesst: waere
-- picked_up groesser als quantity, gaebe er eine negative Menge frei.
ALTER TABLE availability_block
  ADD CONSTRAINT block_pickup_within_quantity CHECK (picked_up <= quantity);
