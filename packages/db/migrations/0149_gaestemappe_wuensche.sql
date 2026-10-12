-- ---------------------------------------------------------------------------
-- 0149 Digitale Gaestemappe, Baustein 6: Wuensche und Extras mit Preis
--
-- Plan gaestemappe/plan.md, Abschnitte 4, 5 und 9 (Sven, 11.10.2026):
-- ein kurzer Katalog, den das Haus pflegt -- Kopfkissen, Decke, Babybett,
-- aber auch Extras mit Preis wie Sekt aufs Zimmer oder ein Lunchpaket.
-- Der Gast waehlt in der freigeschalteten Mappe (0147) Menge und
-- optional einen Tag; die Rezeption nimmt an oder lehnt ab. Ein Extra mit
-- Preis kommt beim Annehmen aufs Folio.
--
--   guest_request_item  der Katalog je Haus
--   guest_request       ein Wunsch eines Aufenthalts
--
-- **Jedes Extra mit Preis ist ein `product`** (0007), mit Steuerregel und
-- Erloeskonto. Damit steht es richtig auf der Rechnung und im
-- DATEV-Export, ohne eigene Buchungslogik. Weil StayGrid noch keine
-- Artikelpflege hat, legt die Pflege des Katalogs den Artikel selbst an
-- (Code `MAPPE-<id>`); wer spaeter eine Artikelpflege baut, findet ihn
-- dort wieder.
--
-- **Der Preis haengt am Wunsch, nicht nur am Artikel.** Der Gast hat beim
-- Bestellen einen Preis gesehen. Aendert das Haus ihn bis zum Annehmen,
-- gilt fuer diesen Wunsch der gesehene.
--
-- **Kein Freitext.** Ein Wunsch ist ein Eintrag aus dem Katalog mit Menge
-- und Tag; die Ablehnung ist ein Grund aus einer festen Liste, damit der
-- Gast eine Antwort in seiner Sprache bekommt. Damit traegt keine Spalte
-- etwas, das einen Menschen bezeichnet, und die Loeschfunktionen des
-- Gastes bleiben unberuehrt: der Wunsch haengt an der Reservierung, deren
-- Gast anonymisiert wird. Die freie Nachricht kommt spaeter und
-- bringt dann ihre eigene Loeschung mit.
-- ---------------------------------------------------------------------------

CREATE TABLE guest_request_item (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES property(id),
  public_ref   text NOT NULL UNIQUE DEFAULT generate_public_ref(12),
  -- Name je Sprache; Deutsch ist Pflicht, eine fehlende Sprache zeigt ihn.
  name         jsonb NOT NULL CHECK (jsonb_typeof(name) = 'object'
                                     AND length(btrim(name ->> 'de')) BETWEEN 1 AND 80),
  -- Wer sich kuemmert. Housekeeping bekommt den Wunsch mit dem naechsten
  -- Baustein in die Personal-App; bis dahin sieht ihn die Rezeption mit diesem Vermerk.
  handler      text NOT NULL DEFAULT 'reception' CHECK (handler IN ('reception','housekeeping')),
  max_qty      smallint NOT NULL DEFAULT 1 CHECK (max_qty BETWEEN 1 AND 20),
  -- Leer: kostenlos. Sonst der Artikel mit Preis, Steuer und Erloeskonto.
  product_id   bigint,
  on_folder    boolean NOT NULL DEFAULT true,
  -- Fuer das Gaesteterminal (Plan terminal-selfservice/plan.md); die
  -- Mappe liest es nicht.
  on_terminal  boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint REFERENCES app_user(id),
  -- Der Artikel gehoert zum Haus des Eintrags (Sicherheitsaudit M4).
  FOREIGN KEY (product_id, property_id) REFERENCES product (id, property_id),
  UNIQUE (id, property_id)
);
CREATE INDEX guest_request_item_property ON guest_request_item (property_id, position, id);

CREATE TABLE guest_request (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    bigint NOT NULL REFERENCES property(id),
  public_ref     text NOT NULL UNIQUE DEFAULT generate_public_ref(12),
  reservation_id bigint NOT NULL REFERENCES reservation(id),
  -- Das Zimmer beim Bestellen; zieht der Gast um, weiss die Kraft trotzdem,
  -- wohin das Kissen sollte.
  resource_id    bigint REFERENCES resource(id),
  item_id        bigint NOT NULL,
  qty            smallint NOT NULL CHECK (qty BETWEEN 1 AND 20),
  -- Brutto je Stueck, wie der Gast ihn gesehen hat; leer bei kostenlos.
  unit_price_cent bigint CHECK (unit_price_cent IS NULL OR unit_price_cent > 0),
  -- Leer: so bald wie moeglich.
  wanted_for     date,
  -- Ueber welche Tuer: die Mappe im Zimmer, der Link aus der Mail, das
  -- Terminal (Plan gaestemappe/plan.md, Abschnitt 10).
  source         text NOT NULL CHECK (source IN ('folder','mail','terminal')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined')),
  decline_reason text CHECK (decline_reason IN ('unavailable','notThatDay','askReception')),
  -- Die Buchung aufs Folio, wenn ein Extra mit Preis angenommen wurde.
  charge_id      bigint REFERENCES charge(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  handled_by     bigint REFERENCES app_user(id),
  handled_at     timestamptz,
  FOREIGN KEY (item_id, property_id) REFERENCES guest_request_item (id, property_id),
  CONSTRAINT guest_request_handled CHECK (
    (status = 'open' AND handled_at IS NULL AND decline_reason IS NULL AND charge_id IS NULL)
    OR (status = 'done' AND handled_at IS NOT NULL AND decline_reason IS NULL)
    OR (status = 'declined' AND handled_at IS NOT NULL AND decline_reason IS NOT NULL
        AND charge_id IS NULL))
);
CREATE INDEX guest_request_reservation ON guest_request (reservation_id, created_at);
-- Der Eingang in "Heute": offene Wuensche eines Hauses.
CREATE INDEX guest_request_offen ON guest_request (property_id, created_at) WHERE status = 'open';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guest_request_item','guest_request'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (property_id = ANY (app_property_ids()))', t);
  END LOOP;
END $$;

SELECT attach_audit('guest_request_item');
SELECT attach_audit('guest_request');

-- Ein Wunsch wird erledigt oder abgelehnt, nie geloescht: an einem
-- angenommenen Extra haengt eine Buchung, und die Hausdame soll sehen,
-- was gewuenscht war. Die Anwendung darf deshalb nur den Stand setzen.
REVOKE UPDATE, DELETE ON guest_request FROM hotelpms_app;
GRANT UPDATE (status, decline_reason, charge_id, handled_by, handled_at)
  ON guest_request TO hotelpms_app;
-- Ein Eintrag wird abgeschaltet, nicht geloescht: Wuensche verweisen auf ihn.
REVOKE DELETE ON guest_request_item FROM hotelpms_app;
