-- Zugriffstoken fuer Maschinen (Aufgabe 2, Dokument 16).
--
-- `oauth_client` steht seit 0002, benutzt wurde es nie: es gab keinen Weg,
-- aus Kennung und Geheimnis ein Token zu machen, und keinen, aus einem Token
-- einen Principal. Genau diese beiden Wege fehlten.
--
-- Scopes sind **dieselben** Schluessel wie die Berechtigungen von Menschen
-- (Grundsatz 1, Dokument 14). Es gibt bewusst keinen zweiten Rechteweg, und
-- deshalb auch keine eigene Scope-Tabelle: `oauth_client.scopes` verweist auf
-- `permission.key`.

CREATE TABLE oauth_access_token (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    bigint NOT NULL REFERENCES oauth_client(id) ON DELETE CASCADE,
  account_id   bigint NOT NULL REFERENCES account(id),
  -- Nur der Hash. Ein Token ist ein Kennwort: waere es im Klartext
  -- gespeichert, machte ein gestohlener Datenbankauszug jeden Client
  -- uebernehmbar. SHA-256 genuegt hier, anders als beim Nutzerkennwort:
  -- das Token ist 32 zufaellige Byte, es gibt nichts zu raten.
  token_hash   bytea NOT NULL UNIQUE,
  -- Die tatsaechlich gewaehrten Scopes. Immer eine Teilmenge der Scopes des
  -- Clients: wer weniger anfragt, bekommt weniger, und wer mehr anfragt,
  -- bekommt gar nichts.
  scopes       text[] NOT NULL,
  -- Momentaufnahme der Haeuser bei der Ausgabe. Der Zugriffsbereich eines
  -- laufenden Tokens soll sich nicht aendern, weil jemand nebenbei den
  -- Client umkonfiguriert; das faellt erst beim naechsten Token auf.
  property_ids bigint[] NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Wird hoechstens stuendlich fortgeschrieben, nicht je Anfrage. Ein
  -- Channel Manager stellt Tausende Anfragen am Tag; ein Schreibzugriff je
  -- Anfrage nur fuer einen Zeitstempel waere teurer als die Auskunft wert
  -- ist. Fuer die Frage "wird dieses Token noch benutzt" genuegt die Stunde.
  last_used_at timestamptz
);

CREATE INDEX oauth_access_token_client ON oauth_access_token (client_id, expires_at DESC);
CREATE INDEX oauth_access_token_expiry ON oauth_access_token (expires_at);

-- Keine Zeilenrichtlinie, und das aus demselben Grund wie bei `user_session`:
-- ein Token muss gelesen werden, **bevor** es einen Mandantenkontext gibt
-- (C6, Dokument 13). Der Schutz liegt darin, dass die Tabelle nur Hashes
-- enthaelt und die Suche ueber den Hash geht -- wer ihn kennt, kennt das
-- Token ohnehin.

COMMENT ON TABLE oauth_access_token IS
  'Ausgegebene Maschinentoken. Nur Hash, nie Klartext. Ohne Zeilenrichtlinie, '
  'weil die Aufloesung dem Mandantenkontext vorausgeht.';

-- ---------------------------------------------------------------------------
-- Dasselbe Henne-Ei-Problem wie in 0018, und dieselbe Loesung.
--
-- `oauth_client` traegt eine Zeilenrichtlinie ueber `account_id`. Die
-- Anmeldung einer Maschine muss den Client aber lesen, **bevor** es einen
-- Mandantenkontext gibt -- den Account kennt man ja erst, wenn der Client
-- gefunden ist. Mit leerem Kontext liefert die Abfrage nichts, und zwar
-- still: die Tokenausgabe antwortete auf jedes richtige Geheimnis mit
-- "Kennung oder Geheimnis stimmt nicht".
--
-- Statt der Anwendungsrolle BYPASSRLS zu geben, antworten zwei eng
-- geschnittene SECURITY-DEFINER-Funktionen: je genau ein Schluessel hinein,
-- nur das fuer die Anmeldung Noetige heraus.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION oauth_client_for_auth(p_public_ref text)
RETURNS TABLE (id bigint, account_id bigint, secret_hash text,
               scopes text[], property_ids bigint[], status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.account_id, c.secret_hash, c.scopes, c.property_ids, c.status
    FROM oauth_client c
   WHERE c.public_ref = p_public_ref;
$$;

/*
 * Aufloesung eines Tokens. Schreibt den Benutzungszeitpunkt gleich mit fort,
 * hoechstens stuendlich -- ein Schreibzugriff je Anfrage waere teurer als die
 * Auskunft wert ist.
 */
CREATE OR REPLACE FUNCTION oauth_token_principal(p_token_hash bytea)
RETURNS TABLE (account_id bigint, scopes text[], property_ids bigint[],
               public_ref text, client_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH gefunden AS (
    SELECT t.id, t.account_id, t.scopes, t.property_ids,
           c.public_ref, c.status AS client_status
      FROM oauth_access_token t
      JOIN oauth_client c ON c.id = t.client_id
     WHERE t.token_hash = p_token_hash
       AND t.revoked_at IS NULL
       AND t.expires_at > now()
  ), beruehrt AS (
    UPDATE oauth_access_token t SET last_used_at = now()
     WHERE t.id IN (SELECT g.id FROM gefunden g)
       AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 hour')
  )
  SELECT g.account_id, g.scopes, g.property_ids, g.public_ref, g.client_status
    FROM gefunden g;
END $$;

/*
 * Die Haeuser eines Accounts, wenn der Client auf keines eingeschraenkt ist.
 * Auch `property` traegt eine Zeilenrichtlinie, und auch hier steht der
 * Kontext erst danach fest.
 */
CREATE OR REPLACE FUNCTION oauth_account_properties(p_account_id bigint)
RETURNS TABLE (id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id FROM property p
   WHERE p.account_id = p_account_id AND p.status = 'active';
$$;
