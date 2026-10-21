-- ---------------------------------------------------------------------------
-- 0193 Push an das Personal auch in der eigenen App (Plan app/plan.md §5)
--
-- Sven, 20.10.2026: native Benachrichtigungen nur fuer die Personal-App. In
-- der App gibt es kein Web-Push: die WebView hat keinen Service Worker und
-- keinen PushManager. Das Telefon meldet sich dort mit einer Kennung von
-- Firebase Cloud Messaging an, und der Worker schickt ueber FCM statt an
-- die Adresse eines Browserherstellers.
--
-- **Dieselbe Tabelle, nicht eine zweite.** Ein Abo gehoert weiter zu einer
-- Sitzung (0113): abmelden, ablaufen, loeschen nehmen es mit, gleich auf
-- welchem Weg es zugestellt wird. Eine zweite Tabelle haette jede dieser
-- Stellen ein zweites Mal gebraucht -- genau die Verdopplung, an der hier
-- schon einmal eine Loeschung vorbeiging.
--
-- Ein Abo ist entweder Web-Push (Adresse und zwei Schluessel) oder FCM
-- (Kennung), nie beides und nie halb.
-- ---------------------------------------------------------------------------

ALTER TABLE push_subscription
  ALTER COLUMN endpoint DROP NOT NULL,
  ALTER COLUMN p256dh DROP NOT NULL,
  ALTER COLUMN auth DROP NOT NULL,
  ADD COLUMN fcm_token text UNIQUE CHECK (length(fcm_token) <= 1000),
  ADD CONSTRAINT push_subscription_art CHECK (
    (fcm_token IS NULL AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL)
    OR (fcm_token IS NOT NULL AND endpoint IS NULL AND p256dh IS NULL AND auth IS NULL));

-- Wer die Kennung hat und das Dienstkonto, kann dem Geraet schreiben.
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('push_subscription', 'fcm_token', 'Zustellkennung eines Geraets')
ON CONFLICT DO NOTHING;
