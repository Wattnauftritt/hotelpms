-- ---------------------------------------------------------------------------
-- 0088 -- Eine Anreise ohne Check-in gilt als angereist, nicht als No-Show.
--
-- Anforderung: Sven, 05.10.2026, nach der Fruehstueckszahl (14 statt rund
-- 50): "Alle Buchungen, die wir nicht manuell stornieren oder loeschen,
-- nehmen wir als angereist an, auch wenn nicht manuell eingecheckt. Was im
-- Kalender steht, ist da."
--
-- Der Nachtlauf hat bisher jede bestaetigte Anreise des Tages, die niemand
-- eingecheckt hatte, zum No-Show gemacht und ihr Kontingent freigegeben. In
-- einem Haus, dessen Rezeption nicht jeden Gast eincheckt -- und in einem,
-- das noch in KWHotel eincheckt --, ist das falsch: seit der Uebernahme
-- standen so 31 von 40 Aufenthalten des Tages als storniert in der Liste,
-- und das Adminpanel hat ihre Fruehstuecke nicht gezaehlt.
--
-- Die Regel ist eine Einstellung am Haus, weil der No-Show-Weg samt Gebuehr
-- fuer garantierte Buchungen (B10, Dokument 13) fachlich richtig bleibt, wo
-- eine Rezeption jeden Gast eincheckt. Vorgabe ist Svens Regel.
-- ---------------------------------------------------------------------------

ALTER TABLE property
  -- 'arrived': der Nachtlauf checkt eine nicht eingecheckte Anreise ein.
  -- 'no_show': der Nachtlauf macht sie zum No-Show (bisheriges Verhalten).
  ADD COLUMN unchecked_arrival text NOT NULL DEFAULT 'arrived'
    CHECK (unchecked_arrival IN ('arrived', 'no_show'));

/*
 * Nachtrag: was der Nachtlauf bisher zum No-Show gemacht hat, ist nach der
 * neuen Regel angereist. Einen anderen Weg zum No-Show gibt es nicht -- die
 * Oberflaeche und die Schnittstelle kennen keine No-Show-Handlung --, also
 * stammt jeder No-Show vom Nachtlauf.
 *
 * Ausgenommen ist ein No-Show, dem eine Gebuehr gebucht wurde: die Buchung
 * ist Haertegrad 1 und laesst sich nur gegenbuchen. Das entscheidet ein
 * Mensch, nicht eine Migration.
 *
 * Der Zustand folgt dem Kalender am Geschaeftstag des Hauses: abgereist, wer
 * vor oder an ihm abreist, sonst im Haus -- dieselbe Einteilung wie beim
 * KWHotel-Import. Das Kontingent wird genau um das wieder gebunden, was der
 * Nachtlauf freigegeben hat: der ganze Zeitraum, Kategorie und Haussumme.
 * Ohne Pruefung gegen die Kapazitaet, wie in 0080: der Gast ist da, ob der
 * Zaehler Platz hat oder nicht, und eine Ueberbuchung soll er zeigen.
 */
CREATE TEMP TABLE nachtrag_0088 ON COMMIT DROP AS
SELECT r.id, r.property_id, r.category_id, r.arrival, r.departure, p.timezone,
       COALESCE((SELECT max(b.date) FROM business_day b
                  WHERE b.property_id = r.property_id AND b.status = 'open'),
                (now() AT TIME ZONE p.timezone)::date) AS geschaeftstag
  FROM reservation r
  JOIN property p ON p.id = r.property_id
 WHERE r.status = 'NoShow'
   AND p.unchecked_arrival = 'arrived'
   AND COALESCE(r.cancellation_fee_cent, 0) = 0;

WITH naechte AS (
  SELECT n.property_id, n.category_id, d::date AS date
    FROM nachtrag_0088 n,
         generate_series(n.arrival, n.departure - 1, interval '1 day') AS d
), je_zeile AS (
  SELECT property_id, category_id, date FROM naechte
  UNION ALL
  SELECT property_id, 0, date FROM naechte
), summe AS (
  SELECT property_id, category_id, date, count(*)::integer AS anzahl
    FROM je_zeile GROUP BY 1, 2, 3
)
UPDATE inventory_day inv
   SET sold = inv.sold + s.anzahl, updated_at = now()
  FROM summe s
 WHERE inv.property_id = s.property_id AND inv.category_id = s.category_id
   AND inv.date = s.date;

-- Den Tag kennt der Kalender, die Uhrzeit nicht; wie beim KWHotel-Import.
-- Im Haus ist nur, wer ein Zimmer hat; eine Reservierung ohne Zimmer wird
-- wieder bestaetigt, wie der Nachtlauf sie kuenftig auch stehen laesst.
UPDATE reservation r
   SET status = CASE WHEN n.departure <= n.geschaeftstag THEN 'CheckedOut'
                     WHEN r.resource_id IS NULL THEN 'Confirmed'
                     ELSE 'InHouse' END::reservation_status,
       checked_in_at = CASE WHEN n.departure <= n.geschaeftstag
                              OR r.resource_id IS NOT NULL
                            THEN COALESCE(r.checked_in_at,
                                          n.arrival::timestamp AT TIME ZONE n.timezone)
                       END,
       checked_out_at = CASE WHEN n.departure <= n.geschaeftstag
                             THEN COALESCE(r.checked_out_at,
                                           n.departure::timestamp AT TIME ZONE n.timezone)
                        END,
       updated_at = now()
  FROM nachtrag_0088 n
 WHERE r.id = n.id;
