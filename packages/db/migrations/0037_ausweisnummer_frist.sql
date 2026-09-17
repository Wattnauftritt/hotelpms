-- Die Ausweisnummer hatte gar keine Frist.
--
-- **Der Befund.** § 30 Abs. 2 BMG erlaubt, die Nummer des Identitaets-
-- dokuments zu notieren; § 30 Abs. 4 verlangt, den Meldeschein ein Jahr nach
-- Abreise zu vernichten. In diesem System stand die Nummer aber nie auf dem
-- Meldeschein, sondern am Gastprofil (`guest.id_document_number_enc`, seit
-- Migration 0008) -- und `purgeRegistrations` loeschte nur `registration`.
-- Die Nummer blieb damit unbegrenzt liegen. Der einzige Weg, sie
-- loszuwerden, war die Anonymisierung auf Antrag des Gastes.
--
-- **Warum das jetzt auffaellt.** Migration 0036 stellt die Anonymisierung
-- hinter die Aufbewahrungsfrist des Gaestebeitragsnachweises -- in Cuxhaven
-- sechs Jahre ab Beginn des Folgejahres. Damit stand der einzige Loeschweg
-- fuer die Ausweisnummer bis zu sieben Jahre lang zu, und aus einem stillen
-- Versaeumnis wurde ein handfester Widerspruch: eine kommunale Abgabenfrist
-- haette eine bundesrechtliche Vernichtungspflicht ausgehebelt.
--
-- Aufgeloest wird er nicht dadurch, dass man die Abgabenfrist verkuerzt --
-- die steht in der Satzung --, sondern dadurch, dass beide Fristen das tun,
-- wofuer sie da sind: **das Gaesteverzeichnis braucht die Ausweisnummer
-- nicht.** Es fuehrt Name, Anschrift, Zeitraum, Naechte, Satz und Betrag
-- (§ 9 Abs. 5 Gaestebeitragssatzung Cuxhaven). Die Nummer geht deshalb nach
-- der BMG-Jahresfrist, unabhaengig davon, ob je jemand Loeschung beantragt
-- und ob eine Abgabenfrist laeuft.
--
-- **Was bleibt, und warum.** Geburtsdatum und Staatsangehoerigkeit bleiben
-- am Profil. Sie sind zwar auch Angaben des Meldescheins, haben aber
-- eigenstaendige Zwecke: die Staatsangehoerigkeit traegt die
-- Beherbergungsstatistik und entscheidet die Unterschriftspflicht, das
-- Geburtsdatum die Altersfreigrenze der Kurtaxe. Sie mit derselben Frist zu
-- loeschen waere Uebererfuellung mit Folgeschaden.

/**
 * Ausweisnummern nach der Jahresfrist entfernen.
 *
 * **Warum SECURITY DEFINER.** Der Worker laeuft im Kontext **einer**
 * Property; `reservation` traegt eine Zeilenrichtlinie ueber
 * `app_property_ids()`. Ein Gast, der auch im Schwesterhaus desselben
 * Accounts wohnte, haette dort eine spaetere Abreise, die der Worker nicht
 * saehe -- und die Nummer fiele zu frueh. Die Funktion sieht deshalb alle
 * Aufenthalte, aber nur die der Accounts im Kontext.
 *
 * **Ohne Parameter, und das ist die Sicherung.** Sie arbeitet auf
 * `app_account_ids()`, nicht auf einer uebergebenen Kennung: eine
 * DEFINER-Funktion, der man einen fremden Account nennen kann, waere ein
 * Werkzeug, mit dem sich die Daten eines anderen Mandanten zerstoeren
 * lassen. Bei leerem Kontext ist die Liste leer und die Funktion tut
 * nichts.
 *
 * Massgeblich ist der **tatsaechliche** Abreisetag, sonst der geplante --
 * dieselbe Rechnung wie bei `registration.destroy_after`. Ein Gast ohne
 * jeden Aufenthalt faellt auf das Anlagedatum seines Profils zurueck: eine
 * Ausweisnummer ohne Aufenthalt hat ohnehin keinen Zweck.
 */
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
              WHERE r.primary_guest_id = g.id
                 OR EXISTS (SELECT 1 FROM reservation_occupant o
                             WHERE o.reservation_id = r.id AND o.guest_id = g.id)),
            g.created_at::date)
          + INTERVAL '1 year')::date < current_date;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION guest_document_purge() IS
  'Ausweisnummern ein Jahr nach Abreise entfernen (§ 30 Abs. 2 und 4 BMG).';

-- Der Index traegt die Abfrage: die weit ueberwiegende Mehrheit der
-- Gastprofile hat nie eine Nummer getragen, und ohne ihn liefe der
-- Pflegelauf jede Nacht ueber die ganze Tabelle.
CREATE INDEX guest_document_offen ON guest (account_id)
  WHERE id_document_number_enc IS NOT NULL;

-- ------------------------------------------------- Loeschung in zwei Schritten

-- **Der zweite Teil desselben Befundes.** Migration 0036 laesst die
-- Anonymisierung an der Abgabenfrist scheitern -- mit 409 und gar nichts.
-- Das haelt mehr zurueck, als die Satzung verlangt: das Gaesteverzeichnis
-- braucht Name, Anschrift, Zeitraum, Naechte, Satz und Betrag. E-Mail,
-- Telefon, Geburtsdatum, Staatsangehoerigkeit, Vorlieben und Hausnotizen
-- braucht es nicht, und Art. 17 Abs. 3 lit. b DSGVO nimmt von der Loeschung
-- nur aus, was die rechtliche Verpflichtung wirklich fordert.
--
-- Deshalb zwei Schritte: sofort faellt alles, was der Nachweis nicht
-- braucht; der Rest faellt, sobald die Frist abgelaufen ist. Der Wunsch
-- bleibt am Profil vermerkt, damit der zweite Schritt nicht davon abhaengt,
-- dass jemand daran denkt.

ALTER TABLE guest
  ADD COLUMN erasure_requested_at timestamptz;

COMMENT ON COLUMN guest.erasure_requested_at IS
  'Loeschung verlangt (Art. 17 DSGVO), aber durch eine Aufbewahrungsfrist '
  'aufgeschoben. Der Nachtlauf vollendet sie.';

CREATE INDEX guest_erasure_offen ON guest (account_id)
  WHERE erasure_requested_at IS NOT NULL AND status <> 'anonymized';

/**
 * Bis wann laeuft die Aufbewahrung des Gaestebeitragsnachweises fuer diesen
 * Gast? NULL heisst: keine.
 *
 * **An einer Stelle, nicht an zweien.** Dieselbe Frage stellen die Route
 * (darf ich jetzt loeschen?) und der Nachtlauf (darf ich die aufgeschobene
 * Loeschung vollenden?). Zweimal formuliert liefen die beiden Fassungen
 * auseinander, und der Befund waere ein Gast, dessen Loeschung nie
 * vollendet wird -- oder eine, die zu frueh kommt.
 *
 * SECURITY DEFINER aus demselben Grund wie `guest_document_purge`: die Frage
 * laeuft ueber alle Haeuser des Accounts, der Aufrufer sieht aber nur eines.
 * Der Gast selbst bleibt dabei die Grenze -- die Funktion beantwortet nur,
 * was zu ihm gehoert, und eine fremde Kennung liefert NULL, weil dessen
 * Aufenthalte in keinem Account des Kontextes liegen.
 */
CREATE OR REPLACE FUNCTION guest_levy_retention_until(p_guest bigint)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max((date_trunc('year', r.departure)
              + INTERVAL '1 year'
              + make_interval(years => p.guest_levy_retention_years))::date)
    FROM reservation r
    JOIN property p ON p.id = r.property_id
   WHERE p.account_id = ANY (app_account_ids())
     AND (r.primary_guest_id = p_guest
          OR EXISTS (SELECT 1 FROM reservation_occupant o
                      WHERE o.reservation_id = r.id AND o.guest_id = p_guest))
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

/**
 * Aufgeschobene Loeschungen vollenden.
 *
 * Laeuft im Nachtlauf. Was die Route beim Antrag nicht loeschen durfte --
 * Name und Anschrift, die das Gaesteverzeichnis fuehrt --, faellt hier,
 * sobald die Frist abgelaufen ist. Die Frist beantwortet dieselbe Funktion
 * wie in der Route; zwei Formulierungen liefen auseinander, und der Befund
 * waere ein Gast, dessen Loeschung nie vollendet wird.
 */
CREATE OR REPLACE FUNCTION guest_erasure_complete()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH faellig AS (
    SELECT g.id FROM guest g
     WHERE g.account_id = ANY (app_account_ids())
       AND g.erasure_requested_at IS NOT NULL
       AND g.status <> 'anonymized'
       AND guest_levy_retention_until(g.id) IS NULL
  ), geloescht AS (
    DELETE FROM guest_property_note WHERE guest_id IN (SELECT id FROM faellig)
  ), scheine AS (
    DELETE FROM registration WHERE guest_id IN (SELECT id FROM faellig)
  )
  UPDATE guest g
     SET last_name = 'Anonymisiert', first_name = NULL, email = NULL, phone = NULL,
         birth_date = NULL, nationality = NULL, address_line1 = NULL,
         postal_code = NULL, city = NULL, country = NULL,
         id_document_type = NULL, id_document_number_enc = NULL,
         id_document_key_version = NULL, preferences = '{}',
         status = 'anonymized', anonymized_at = now(), updated_at = now()
    FROM faellig f WHERE f.id = g.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION guest_erasure_complete() IS
  'Loeschungen vollenden, die eine Aufbewahrungsfrist aufgeschoben hat.';
