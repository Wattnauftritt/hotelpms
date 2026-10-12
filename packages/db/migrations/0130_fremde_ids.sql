-- ---------------------------------------------------------------------------
-- 0130 -- Ausweisfrist nur aus Aufenthalten im eigenen Betrieb.
--
-- Befund M4 aus dem Sicherheitsaudit vom 11.10.2026
-- (security/audit-2026-10-11.md): Fremde IDs aus dem Rumpf wurden ungeprueft
-- geschrieben, auch ueber Betriebe hinweg. Eine Fremdschluesselpruefung liest
-- an der Zeilenrichtlinie vorbei; ein Kunde konnte so den Gast eines anderen
-- Kunden als Hauptgast oder Mitreisenden an eine eigene Reservierung haengen.
--
-- Die Routen pruefen das jetzt selbst (apps/api/src/platform/fremdeIds.ts).
-- Diese Migration schliesst die Folge, die der Befund benennt:
-- guest_document_purge() bildete max(departure) ueber **alle** Reservierungen
-- eines Gastes, ohne nach dem Betrieb zu fragen. Eine fremde Reservierung mit
-- spaeter Abreise schob damit die Loeschung der Ausweisnummer nach § 30 BMG
-- bei einem Gast eines anderen Kunden beliebig hinaus -- und eine Zeile, die
-- schon vor der Pruefung in den Routen entstanden ist, taete das weiter.
--
-- Jetzt zaehlen nur Aufenthalte in Haeusern des Betriebs, dem der Gast
-- gehoert. Das ist auch fachlich die richtige Frage: die Frist laeuft fuer
-- das Haus, das die Nummer erhoben hat, und das ist eines dieses Betriebs.
-- Sonst unveraendert gegenueber 0127: dieselbe Vereinigung zweier
-- Indexsuchen, derselbe Stichtag, dieselbe Frist.
--
-- search_path mit pg_temp am Ende: eine SECURITY-DEFINER-Funktion, die
-- pg_temp implizit zuerst durchsucht, laesst sich von jedem, der temporaere
-- Tabellen anlegen darf, ein gleichnamiges Objekt unterschieben (M11).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guest_document_purge()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
               JOIN property p ON p.id = r.property_id
              WHERE p.account_id = g.account_id
                AND r.id IN (SELECT x.id FROM reservation x
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
  'Ausweisnummern ein Jahr nach Abreise entfernen (§ 30 Abs. 2 und 4 BMG); '
  'nur Aufenthalte im Betrieb des Gastes zaehlen (0130).';
