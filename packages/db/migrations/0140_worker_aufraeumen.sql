-- ---------------------------------------------------------------------------
-- 0140 -- Worker: Aufbewahrung, Abgleich ohne Vergangenheit, Belegfehler
-- mit Abstand.
--
-- Performance-Audit 11.10.2026, Befunde 9, 13 und 14
-- (performance/audit-2026-10-11.md). Vier voneinander unabhaengige Teile,
-- alle aus derselben Durchsicht des Workers.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Abgleich der Verkaufszaehler ohne die Vergangenheit (Befund 14).
--
-- inventory_sold_expected(p, p_from) schnitt jeden Aufenthalt vorne auf
-- p_from zu, filterte aber keinen aus: eine Reservierung, die vor drei
-- Jahren abgereist ist, wurde gelesen und ergab eine leere Reihe. Der
-- Abgleich im Worker fragt ab heute; gelesen wurden alle bindenden
-- Reservierungen des Hauses seit Beginn. Mit `departure > p_from` nimmt der
-- Planer reservation_active_range (property_id, departure, arrival) und
-- liest nur, was ab p_from noch eine Nacht hat.
--
-- Fachlich unveraendert: eine Reservierung mit departure <= p_from hatte ab
-- p_from keine Nacht und trug nichts bei. Ohne p_from (Saatlauf, Testhotel)
-- wie bisher alles.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inventory_sold_expected(p_property bigint, p_from date)
RETURNS TABLE (category_id bigint, date date, n integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(s.category_id, r.category_id), d::date, count(*)::integer
    FROM reservation r
    LEFT JOIN resource s ON s.id = r.resource_id
   CROSS JOIN LATERAL generate_series(GREATEST(r.arrival, COALESCE(p_from, r.arrival)),
                                      r.departure - 1, interval '1 day') d
   WHERE r.property_id = p_property
     AND r.status IN ('Optional','Confirmed','InHouse')
     AND (p_from IS NULL OR r.departure > p_from)
   GROUP BY 1, 2
$$;

-- ---------------------------------------------------------------------------
-- 2. Stillgelegtes Abonnement: offene Zustellungen scheitern (Befund 13).
--
-- Bisher blieben sie fuer immer 'pending'. Der Abholpfad las sie bei jedem
-- Tick ueber den Teilindex webhook_delivery_due und verwarf sie erst am
-- Verbund mit dem Abonnement -- eine Menge, die mit jedem Ereignis des
-- Hauses weiter wuchs, solange das Abonnement aus war, denn auch das
-- Aufraeumen (unten) laesst offene Zeilen stehen.
--
-- Als Trigger und nicht im Worker: der Worker arbeitet im Kontext eines
-- Hauses und saehe die Zustellungen der anderen Haeuser desselben
-- Abonnements nicht -- die Zeilenrichtlinie von webhook_delivery gilt je
-- Haus, das Abonnement je Konto. Und ein spaeterer zweiter Weg zum
-- Abschalten (eine Route) bekaeme dasselbe Verhalten, ohne daran denken zu
-- muessen. SECURITY DEFINER, weil die Wirkung genau die Zeilen dieses einen
-- Abonnements trifft, dessen Aenderung der Aufrufer schon durfte.
--
-- Wieder eingeschaltet, bleiben sie gescheitert -- wie die Zustellungen,
-- die zur Stilllegung gefuehrt haben (webhooks.ts, /enable): ein Schwall
-- veralteter Ereignisse hilft dem Empfaenger nicht.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION webhook_subscription_disabled_fail_pending()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE webhook_delivery
     SET status = 'failed', next_attempt_at = now(), last_error = 'subscriptionDisabled'
   WHERE subscription_id = NEW.id AND status = 'pending';
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION webhook_subscription_disabled_fail_pending() FROM PUBLIC;

CREATE TRIGGER trg_webhook_subscription_disabled
  AFTER UPDATE OF status ON webhook_subscription
  FOR EACH ROW
  WHEN (NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled')
  EXECUTE FUNCTION webhook_subscription_disabled_fail_pending();

-- Was bis heute liegen geblieben ist, einmal nachziehen.
UPDATE webhook_delivery d
   SET status = 'failed', next_attempt_at = now(), last_error = 'subscriptionDisabled'
  FROM webhook_subscription s
 WHERE s.id = d.subscription_id AND s.status = 'disabled' AND d.status = 'pending';

-- ---------------------------------------------------------------------------
-- 3. Indizes fuer die Aufbewahrung (Befund 13).
--
-- Der Worker loescht einmal am Tag erledigte Zustellungen nach 30 Tagen und
-- Versuchsprotokolle der Gastpost nach 90 Tagen. Ohne Index waere das je
-- Lauf ein Scan ueber die ganze Tabelle -- und es sind genau die
-- Tabellen, die bisher unbegrenzt wuchsen. Teilindex, weil offene
-- Zustellungen nie geloescht werden und hier nichts zu suchen haben.
-- ---------------------------------------------------------------------------

CREATE INDEX webhook_delivery_erledigt ON webhook_delivery (occurred_at)
  WHERE status <> 'pending';
CREATE INDEX outbound_email_attempt_zeit ON outbound_email_attempt (attempted_at);

-- ---------------------------------------------------------------------------
-- 4. Fehlgeschlagene Rechnungsbelege mit Abstand (Befund 14).
--
-- Die Abholung nahm die 50 aeltesten Rechnungen ohne Beleg. Scheiterten 50
-- davon dauerhaft -- eine Summe, die nicht aufgeht, ein Zeichen, das die
-- Schrift nicht kennt --, kamen alle neueren nie mehr an die Reihe, und mit
-- ihnen die Rechnungsmails, die auf den Anhang warten. Jetzt merkt sich der
-- Worker den Fehlschlag und versucht dieselbe Rechnung erst nach einem
-- wachsenden Abstand wieder; die Zeile verschwindet, sobald der Beleg da
-- ist.
--
-- Eine eigene Tabelle und keine Spalte an invoice: die Rechnung ist
-- Haertegrad 1, und ein Fehlerzaehler ist kein Teil von ihr.
-- ---------------------------------------------------------------------------

CREATE TABLE invoice_document_failure (
  invoice_id      bigint PRIMARY KEY REFERENCES invoice(id),
  property_id     bigint NOT NULL REFERENCES property(id),
  attempts        integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  next_attempt_at timestamptz NOT NULL,
  -- Die Meldung des Erzeugers: Rechnungsnummer und Betraege, kein Gastdatum.
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invoice_document_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_document_failure FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice_document_failure
  USING (property_id = ANY (app_property_ids()));
