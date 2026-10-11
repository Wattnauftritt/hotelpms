-- ---------------------------------------------------------------------------
-- 0127 -- Ausweisfrist und Abgabenfrist ueber Index statt Tabellenscan.
--
-- Befund 1 aus dem Performance-Audit vom 11.10.2026
-- (performance/audit-2026-10-11.md). guest_document_purge() und
-- guest_levy_retention_until() aus 0037 fanden die Aufenthalte eines Gastes
-- mit
--
--   WHERE r.primary_guest_id = g.id OR EXISTS (occupant ... g.id)
--
-- Das OR verbindet eine Spalte von reservation mit einer Unterabfrage auf
-- eine andere Tabelle; dafuer kann der Planer keinen Index nehmen und liest
-- reservation ganz -- je Gast. Gemessen am Saatlauf (214 000
-- Reservierungen): 93 ms fuer einen Gast. guest_document_purge laeuft im
-- Worker alle fuenf Minuten je Haus und prueft jeden Gast, der noch eine
-- Ausweisnummer traegt; bei tausend solchen Gaesten waren das anderthalb
-- Minuten Datenbankzeit je Aufruf, und die Tabelle waechst jedes Jahr.
--
-- Jetzt dieselbe Menge als Vereinigung zweier Suchen, die je einen Index
-- haben (reservation_primary_guest bzw. der Index auf
-- reservation_occupant.guest_id). Fachlich unveraendert: dieselben
-- Aufenthalte, derselbe Stichtag, dieselbe Frist. Nur die Form der Abfrage
-- aendert sich, nicht ihr Ergebnis; ausweisfrist.test.ts haelt das fest.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_document_purge()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE guest g
     SET id_document_type        = NULL,
         id_document_number_enc  = NULL,
         id_document_key_version = NULL,
         updated_at              = now()
   WHERE g.account_id = ANY (app_account_ids())
     AND g.id_document_number_enc IS NOT NULL
     AND (COALESCE(
            (SELECT max(COALESCE((r.checked_out_at AT TIME ZONE 'UTC')::date,
                                 r.departure))
               FROM reservation r
              WHERE r.id IN (SELECT x.id FROM reservation x
                              WHERE x.primary_guest_id = g.id
                             UNION
                             SELECT o.reservation_id FROM reservation_occupant o
                              WHERE o.guest_id = g.id)),
            g.created_at::date)
          + INTERVAL '1 year')::date < current_date;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION guest_document_purge() IS
  'Ausweisnummern ein Jahr nach Abreise entfernen (§ 30 Abs. 2 und 4 BMG).';

CREATE OR REPLACE FUNCTION guest_levy_retention_until(p_guest bigint)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max((date_trunc('year', r.departure)
              + INTERVAL '1 year'
              + make_interval(years => p.guest_levy_retention_years))::date)
    FROM reservation r
    JOIN property p ON p.id = r.property_id
   WHERE p.account_id = ANY (app_account_ids())
     AND r.id IN (SELECT x.id FROM reservation x
                   WHERE x.primary_guest_id = p_guest
                  UNION
                  SELECT o.reservation_id FROM reservation_occupant o
                   WHERE o.guest_id = p_guest)
     AND p.guest_levy_retention_years > 0
     AND EXISTS (SELECT 1 FROM charge c
                   JOIN tax_rule t ON t.id = c.tax_rule_id
                  WHERE c.reservation_id = r.id
                    AND t.kind IN ('city_tax','bed_tax'))
     AND (date_trunc('year', r.departure)
          + INTERVAL '1 year'
          + make_interval(years => p.guest_levy_retention_years)) > current_date;
$$;

COMMENT ON FUNCTION guest_levy_retention_until(bigint) IS
  'Ende der kommunalen Aufbewahrung des Gaestebeitragsnachweises, NULL wenn keine.';
