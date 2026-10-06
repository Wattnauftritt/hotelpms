-- ---------------------------------------------------------------------------
-- 0094 -- Ein versehentlicher Check-out laesst sich zuruecknehmen.
--
-- Anforderung: Sven, 06.10.2026: "ich habe einen gast eingecheckt und dann
-- gemerkt das ich ihn in ein anderes zimmer verschieben wollte. [...] also
-- habe ich den gast wieder ausgecheckt. nun ist er auf eine nacht verkuerzt,
-- ausgecheckt und ich kann ihn weder verschieben noch bearbeiten"
--
-- Der Check-out kuerzt den Aufenthalt auf den Geschaeftstag und loescht die
-- ungebuchten Naechte danach. Ein abgereister Aufenthalt bindet keinen
-- Bestand mehr und laesst sich nicht aendern -- ein Fehlgriff war damit
-- endgueltig, und die Abreise, die vorher galt, stand nirgends mehr ausser
-- im Protokoll.
--
-- `checkout_undo` haelt deshalb fest, was der Check-out weggenommen hat:
-- den Geschaeftstag, die Abreise davor und die geloeschten Naechte mit
-- ihrem Preis. Das Zuruecknehmen stellt genau das wieder her, statt die
-- Naechte neu zu rechnen -- ein vereinbarter Preis je Nacht ginge sonst
-- im Durchschnitt unter. Der Wert gilt nur bis zum naechsten Zustand und
-- wird beim Zuruecknehmen geleert. Er traegt Daten und Betraege, keinen
-- Menschen; in `audit_redaction` gehoert er nicht.
-- ---------------------------------------------------------------------------

ALTER TABLE reservation ADD COLUMN checkout_undo jsonb;

COMMENT ON COLUMN reservation.checkout_undo IS
  'Was der letzte Check-out geaendert hat: {businessDate, departure, nights[]}. '
  'Grundlage fuer das Zuruecknehmen am selben Geschaeftstag (0094).';
