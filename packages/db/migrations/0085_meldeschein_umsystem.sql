-- ---------------------------------------------------------------------------
-- 0085 -- Ein Meldeschein, den ein Umsystem schon verschickt oder erfasst hat.
--
-- Anforderung: Sven, 04.10.2026. Bis zur Umstellung verschickt das
-- Adminpanel die Meldescheine; fuer Gaeste mit Anreise in den naechsten Tagen
-- sind Links hinaus, und manche haben schon ausgefuellt. Schaltet ein Haus
-- den Online-Check-in in StayGrid ein, bekaeme jeder dieser Gaeste ein
-- zweites Formular -- und welches gilt, wuesste niemand.
--
-- Das Umsystem meldet deshalb je Reservierung, dass es eingeladen oder
-- erfasst hat. Solange der Vermerk steht, laedt der Worker nicht ein; ist
-- erfasst, zeigt die Anreiseliste den Meldeschein nicht als fehlend.
--
-- Eine eigene Tabelle statt Spalten an `reservation`: die Reservierung traegt
-- Trigger fuer Aenderungscursor und Webhooks, und ein Vermerk, den das
-- Umsystem alle fuenfzehn Minuten bestaetigt, ist keine Aenderung, die ein
-- Abgleich wiedersehen soll.
--
-- Keine Eintraege in `audit_redaction`: Zeitpunkte und ein Systemname
-- bezeichnen keinen Menschen.
-- ---------------------------------------------------------------------------

CREATE TABLE reservation_external_registration (
  -- Haelt die Ruecknahme einer Uebernahme auf (kwhotelUndo), wie ein
  -- Meldeschein oder ein Check-in-Link: an diesem Gast ist schon gearbeitet.
  reservation_id     bigint PRIMARY KEY REFERENCES reservation(id),
  property_id        bigint NOT NULL REFERENCES property(id),
  system             text NOT NULL,
  invitation_sent_at timestamptz,
  completed_at       timestamptz,
  submitted_via      text CHECK (submitted_via IN ('link','reception')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reservation_external_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_external_registration FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON reservation_external_registration
  USING (property_id = ANY (app_property_ids()));
SELECT attach_audit('reservation_external_registration');
