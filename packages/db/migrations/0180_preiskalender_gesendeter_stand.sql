-- ---------------------------------------------------------------------------
-- Preiskalender: der zuletzt gesendete Stand je Plan und Tag.
--
-- Sven, 18.10.2026: "geaenderte Tage werden bis zum Senden farblich markiert
-- ... Wenn man Aenderungen der Preise vor dem Senden rueckgaengig macht oder
-- zurueck aendert, bleibt das Senden der Aenderungen grau. Es gibt dann ja
-- nichts zu aendern."
--
-- Bis 0179 hiess "Aenderung": seit dem letzten Senden geschrieben
-- (`updated_at`). Ein Preis, der von 89 auf 95 und zurueck auf 89 ging, war
-- danach eine Aenderung, obwohl beim Channel Manager genau 89 steht. Jetzt
-- ist eine Aenderung, was vom gesendeten Stand **abweicht**: dieser Stand
-- steht hier, je Plan und Tag mit denselben Werten, die das Umsystem
-- abgeholt hat.
--
-- Geschrieben wird er erst mit der Rueckmeldung "gesendet", aus den Werten,
-- die beim Abholen hinausgingen (`rate_calendar_push.served`), nicht aus den
-- Werten, die beim Rueckmelden gerade stehen -- was dazwischen getippt
-- wurde, ist nicht gesendet. Ein gescheitertes Senden aendert ihn nicht.
-- Eine uebernommene Lieferung aus dem Channel Manager schreibt ihn auch: was
-- gerade von dort kam, steht dort.
--
-- Ein Tag ohne Zeile ist nie gesendet worden und gilt als Aenderung, sobald
-- es ueberhaupt einen gesendeten Stand gibt (am Ende des Jahres rueckt jeden
-- Tag einer nach). Ohne ein erfolgreiches Senden bleibt "nur Aenderungen"
-- abgewiesen wie bisher.
--
-- Kein Audit-Trigger, aus demselben Grund wie bei `rate_day` (0179):
-- ein Jahr Preise je Senden waere eine Kopie im Protokoll. Personenbezogen
-- ist nichts; kein Eintrag in `audit_redaction`.
-- ---------------------------------------------------------------------------

CREATE TABLE rate_calendar_sent (
  property_id         bigint NOT NULL REFERENCES property(id),
  rate_plan_id        bigint NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
  date                date   NOT NULL,
  price_cent          bigint[],
  min_los             smallint,
  max_los             smallint,
  closed              boolean NOT NULL,
  closed_to_arrival   boolean NOT NULL,
  closed_to_departure boolean NOT NULL,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_plan_id, date)
);
CREATE INDEX rate_calendar_sent_property ON rate_calendar_sent (property_id, date);

ALTER TABLE rate_calendar_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_calendar_sent FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON rate_calendar_sent
  USING (property_id = ANY (app_property_ids()));

-- Die abgeholten Werte bis zur Rueckmeldung; danach geleert.
ALTER TABLE rate_calendar_push ADD COLUMN served jsonb;

-- Bestand: wer schon gesendet hat, soll danach nicht das ganze Jahr als
-- geaendert sehen. Als gesendet gilt, was in einem erfolgreich gesendeten
-- Zeitraum liegt und seit dessen Abholen nicht geschrieben wurde -- genau
-- das stand dort beim Abholen.
INSERT INTO rate_calendar_sent (property_id, rate_plan_id, date, price_cent, min_los, max_los,
                                closed, closed_to_arrival, closed_to_departure, sent_at)
SELECT DISTINCT ON (rp.id, d.day)
       rp.property_id, rp.id, d.day::date, rd.price_cent, rs.min_los, rs.max_los,
       COALESCE(rs.closed, false), COALESCE(rs.closed_to_arrival, false),
       COALESCE(rs.closed_to_departure, false), p.served_at
  FROM rate_calendar_push p
  JOIN rate_plan rp ON rp.property_id = p.property_id AND rp.active
 CROSS JOIN generate_series(p.date_from, p.date_to, interval '1 day') AS d(day)
  LEFT JOIN rate_day rd ON rd.rate_plan_id = rp.id AND rd.date = d.day::date
  LEFT JOIN restriction_day rs ON rs.rate_plan_id = rp.id AND rs.date = d.day::date
 WHERE p.status = 'done' AND p.served_at IS NOT NULL
   AND d.day >= current_date - 1
   AND COALESCE(rd.updated_at, '-infinity') <= p.served_at
   AND COALESCE(rs.updated_at, '-infinity') <= p.served_at
 ORDER BY rp.id, d.day, p.served_at DESC;
