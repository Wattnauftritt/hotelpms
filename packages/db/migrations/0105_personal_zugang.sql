-- ---------------------------------------------------------------------------
-- 0105 -- Personal ohne Mailadresse, Sprache je Person, Rollen Reinigung und
-- Kueche.
--
-- Anforderung: Sven, 07.10.2026, Thread "Personalsystem in StayGrid".
-- StayGrid uebernimmt die Personal-App (bisher Repo zurseerobbe): Putzplan,
-- Zimmerstatus, Kontrolle, Kueche, Zusatzarbeiten. Plan in
-- /mnt/project-files/personal-app/plan.md, das hier ist Baustein 1.
--
-- 1. `app_user.email` darf fehlen, dafuer gibt es `username`. Das Personal
--    kommt von einer Zeitarbeitsfirma, viele haben keine Mailadresse, und
--    eine erfundene Adresse waere schlimmer als keine: an sie ginge jede
--    Kennwortruecksetzung, und niemand liest sie. Eine von beiden Angaben
--    muss da sein, sonst kann sich niemand anmelden.
--
--    Der Benutzername ist klein geschrieben und enthaelt kein `@`. Damit ist
--    eine Anmeldung mit "anna.k" nie mit einer Mailadresse zu verwechseln,
--    und dasselbe Feld der Anmeldemaske nimmt beides. Eindeutig ueber alle
--    Kunden, weil die Anmeldung vor jedem Mandanten liegt.
--
-- 2. `app_user.locale`: die Sprache, die die Person selbst gewaehlt hat. Bis
--    jetzt stand sie nur im Browser; eine Nachricht an das Handy einer
--    Reinigungskraft muss sie aber auf dem Server kennen. Fuenf Werte: die
--    drei der Oberflaeche und Russisch und Ukrainisch fuer die Personal-App
--    (die alte App sprach de/en/ru/uk). Welche Sprachen eine Oberflaeche
--    anbietet, entscheidet sie selbst -- hier steht nur, was die Person will.
--
-- 3. Zwei Hausrollen: `housekeeping_staff` (Reinigung) und `kitchen`
--    (Kueche). Die alte App kannte dazu `hausdame`; das ist die bestehende
--    Rolle `housekeeping`. Beide neuen Rollen tragen zunaechst nur
--    `staff:app` -- die Personal-App benutzen. Was sie darin sehen
--    (eigene Zimmer, Fruehstueckszahl), kommt mit den naechsten Bausteinen
--    als eigene, enge Rechte dazu. `housekeeping:read` bekommt die
--    Reinigung bewusst nicht: es zeigt den ganzen Tagesplan mit
--    Reservierungsnummern, und eine Reinigungskraft braucht ihre Zimmer.
-- ---------------------------------------------------------------------------

ALTER TABLE app_user ALTER COLUMN email DROP NOT NULL;
ALTER TABLE app_user ADD COLUMN username text;
ALTER TABLE app_user ADD COLUMN locale text;

ALTER TABLE app_user ADD CONSTRAINT app_user_hat_anmeldung
  CHECK (email IS NOT NULL OR username IS NOT NULL);
ALTER TABLE app_user ADD CONSTRAINT app_user_username_form
  CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,39}$');
ALTER TABLE app_user ADD CONSTRAINT app_user_locale_wert
  CHECK (locale IS NULL OR locale IN ('de','en','tr','ru','uk'));

CREATE UNIQUE INDEX app_user_username ON app_user (username)
  WHERE username IS NOT NULL;

-- Der Benutzername ist meist der Vorname. Er bezeichnet einen Menschen und
-- gehoert damit nicht ins Protokoll, wie Name und Adresse (Migration 0044).
INSERT INTO audit_redaction (table_name, column_name, grund) VALUES
  ('app_user', 'username', 'Name');

-- Rechte und Rollen ----------------------------------------------------------

INSERT INTO permission (key, grp, description) VALUES
  ('staff:app', 'Personal', 'Die Personal-App benutzen')
ON CONFLICT DO NOTHING;

INSERT INTO role (account_id, level, key, name, is_system) VALUES
  (NULL, 'property', 'housekeeping_staff', 'Reinigung', true),
  (NULL, 'property', 'kitchen',            'Küche',     true);

-- Inhaber, Betriebsverwaltung und Direktion bekamen in 0003 jedes Recht,
-- das es damals gab. Neue Rechte erreichen sie nur, wenn man sie nennt.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'staff:app'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner','account_admin','hotel_director',
                 'housekeeping','housekeeping_staff','kitchen')
ON CONFLICT DO NOTHING;
