-- Arbeitsplatz-PIN: eigene Sperre, und ein Weg, ihn ueberhaupt zu setzen.
--
-- **Der Befund.** `app_user.workstation_pin_hash` steht seit Migration 0002,
-- und `POST /v1/auth/workstation-switch` prueft ihn. Nur gesetzt hat ihn nie
-- jemand: es gibt keine Route dafuer, und ausser zwei Tests, die die Spalte
-- direkt beschreiben, ist das Feld in der ganzen Anwendung leer. Der
-- Personenwechsel am geteilten Rezeptionsrechner war damit gebaut, aber
-- unbenutzbar.
--
-- **Warum ein eigener Fehlversuchszaehler und nicht der der Anmeldung.**
-- Ein PIN ist kurz -- vier Ziffern sind zehntausend Moeglichkeiten -- und
-- haelt deshalb nur, weil er sich sperren laesst. Naheliegend waere,
-- `failed_login_count` mitzubenutzen: dasselbe Konto, dieselbe Gefahr.
--
-- Der Unterschied liegt im Schaden, den ein Angreifer damit anrichten kann.
-- Wer den PIN eines Kollegen falsch raet, sperrt bei einem gemeinsamen
-- Zaehler dessen **Anmeldung**. Ein Mitarbeiter mit irgendeiner Sitzung
-- koennte die Hausleitung aus dem System aussperren, waehrend Gaeste am
-- Tresen stehen -- ohne ein Kennwort zu kennen, nur durch Tippen. Getrennt
-- gezaehlt sperrt derselbe Angriff nur den Personenwechsel; der Weg ueber
-- die normale Anmeldung bleibt offen. Die Bequemlichkeit zu verlieren ist
-- hinnehmbar, den einzigen Zugang zu verlieren nicht.

ALTER TABLE app_user
  ADD COLUMN workstation_pin_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN workstation_pin_locked_until timestamptz,
  -- Wann der PIN zuletzt gesetzt wurde. Nicht fuer eine Ablauffrist --
  -- erzwungener Wechsel macht aus guten Geheimnissen schlechte --, sondern
  -- damit die Oberflaeche sagen kann, ob ueberhaupt einer hinterlegt ist,
  -- ohne den Hash anzufassen.
  ADD COLUMN workstation_pin_set_at timestamptz;

COMMENT ON COLUMN app_user.workstation_pin_hash IS
  'Argon2id wie beim Kennwort. Der PIN selbst wird nirgends gespeichert.';
