-- Berechtigungskatalog und Systemrollen nach Dokument 14.
-- Fester Katalog im Code, nicht vom Kunden aenderbar.

INSERT INTO permission (key, grp, description) VALUES
  ('reservation:read',                 'Reservierung', 'Zimmerplan, Listen, Details'),
  ('reservation:write',                'Reservierung', 'Anlegen, aendern, stornieren vor Anreise'),
  ('reservation:checkin',              'Reservierung', 'Check-in und Check-out ausfuehren'),
  ('reservation:override_restriction', 'Reservierung', 'Restriktionen und Ausbuchung uebergehen'),
  ('guest:read',                       'Gaeste',       'Name, Kontakt, Historie'),
  ('guest:write',                      'Gaeste',       'Anlegen, aendern, zusammenfuehren'),
  ('guest:read_identity',              'Gaeste',       'Ausweisdaten, Geburtsdatum, Staatsangehoerigkeit'),
  ('guest:export',                     'Gaeste',       'DSGVO-Auskunft und Loeschung anstossen'),
  ('folio:read',                       'Folio',        'Konten und Positionen sehen'),
  ('folio:post',                       'Folio',        'Leistungen buchen, Zahlungsvermerke erfassen'),
  ('folio:void_own',                   'Folio',        'Eigene Buchungen innerhalb der Frist stornieren'),
  ('folio:void_any',                   'Folio',        'Beliebige Buchungen stornieren'),
  ('folio:discount',                   'Folio',        'Rabatt bis zur konfigurierten Grenze'),
  ('folio:discount_unlimited',         'Folio',        'Rabatt ohne Grenze'),
  ('folio:route',                      'Folio',        'Umleitungen und Split Billing'),
  ('invoice:issue',                    'Rechnung',     'Rechnung festschreiben'),
  ('invoice:credit',                   'Rechnung',     'Gutschrift, Storno einer Rechnung'),
  ('rate:read',                        'Raten',        'Preise und Restriktionen sehen'),
  ('rate:write',                       'Raten',        'Preise, Restriktionen, Ratenplaene pflegen'),
  ('inventory:read',                   'Inventar',     'Kategorien und Zimmer sehen'),
  ('inventory:write',                  'Inventar',     'Kategorien, Zimmer, Sperrungen'),
  ('housekeeping:read',                'Housekeeping', 'Zimmerstatus und Aufgaben'),
  ('housekeeping:write',               'Housekeeping', 'Status setzen, Aufgaben erledigen'),
  ('maintenance:write',                'Housekeeping', 'Wartungstickets, Out of Order'),
  ('report:operational',               'Berichte',     'Anreise, Abreise, Hausliste, Offene Posten'),
  ('report:revenue',                   'Berichte',     'Umsatz, ADR, RevPAR, Pickup'),
  ('report:export',                    'Berichte',     'DATEV, GoBD, Statistik'),
  ('nightaudit:run',                   'Nachtlauf',    'Manuell ausloesen, Pruefliste bearbeiten'),
  ('settings:property',                'Einstellungen','Steuern, Zeiten, Vorlagen, Zahlarten'),
  ('settings:account',                 'Einstellungen','Accountweite Einstellungen, Properties anlegen'),
  ('user:manage',                      'Einstellungen','Nutzer einladen, Rollen zuweisen'),
  ('integration:manage',               'Einstellungen','API-Clients, Webhooks, Channel Manager'),
  ('account:contract',                 'Einstellungen','Vertrag, Abonnement, Account loeschen'),
  ('platform:accounts',                'Plattform',    'Accounts anlegen, sperren'),
  ('platform:support_session',         'Plattform',    'Support-Sitzung anfragen'),
  ('platform:billing',                 'Plattform',    'Abonnements und unsere Rechnungen an Kunden'),
  ('platform:operations',              'Plattform',    'Monitoring, Metriken, Alarme');

-- Systemrollen -------------------------------------------------------------

INSERT INTO role (account_id, level, key, name, is_system) VALUES
  (NULL, 'account',  'owner',            'Inhaber',          true),
  (NULL, 'account',  'account_admin',    'Account-Admin',    true),
  (NULL, 'property', 'hotel_director',   'Hoteldirektion',   true),
  (NULL, 'property', 'front_office_mgr', 'Empfangsleitung',  true),
  (NULL, 'property', 'reception',        'Rezeption',        true),
  (NULL, 'property', 'reservations',     'Reservierung',     true),
  (NULL, 'property', 'night_audit',      'Nachtdienst',      true),
  (NULL, 'account',  'accounting',       'Buchhaltung',      true),
  (NULL, 'account',  'tax_advisor',      'Steuerberatung',   true),
  (NULL, 'account',  'revenue',          'Revenue',          true),
  (NULL, 'property', 'housekeeping',     'Housekeeping',     true),
  (NULL, 'property', 'maintenance',      'Haustechnik',      true),
  (NULL, 'account',  'read_only',        'Nur lesen',        true),
  (NULL, 'platform', 'platform_admin',   'Plattform-Admin',  true),
  (NULL, 'platform', 'platform_support', 'Support',          true),
  (NULL, 'platform', 'platform_billing', 'Abrechnung',       true),
  (NULL, 'platform', 'platform_ops',     'Betrieb',          true);

CREATE OR REPLACE FUNCTION grant_perms(role_key text, VARIADIC keys text[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO role_permission (role_id, permission_key)
  SELECT r.id, k FROM role r, unnest(keys) AS k
   WHERE r.key = role_key AND r.account_id IS NULL
  ON CONFLICT DO NOTHING;
$$;

-- Inhaber: alles ausser Plattformrechten.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, p.key FROM role r, permission p
 WHERE r.key = 'owner' AND r.account_id IS NULL AND p.grp <> 'Plattform';

-- Account-Admin: wie Inhaber, aber kein Vertrag.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, p.key FROM role r, permission p
 WHERE r.key = 'account_admin' AND r.account_id IS NULL
   AND p.grp <> 'Plattform' AND p.key <> 'account:contract';

-- Hoteldirektion: alles in der Property, keine accountweiten Einstellungen.
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, p.key FROM role r, permission p
 WHERE r.key = 'hotel_director' AND r.account_id IS NULL
   AND p.grp <> 'Plattform'
   AND p.key NOT IN ('account:contract','settings:account');

SELECT grant_perms('front_office_mgr',
  'reservation:read','reservation:write','reservation:checkin','reservation:override_restriction',
  'guest:read','guest:write','guest:read_identity',
  'folio:read','folio:post','folio:void_own','folio:void_any',
  'folio:discount','folio:discount_unlimited','folio:route',
  'invoice:issue','invoice:credit',
  'rate:read','inventory:read',
  'housekeeping:read','housekeeping:write','maintenance:write',
  'report:operational','report:revenue','nightaudit:run');

-- Rezeption: buchen ja, fremde Stornos nein. Trennung gegen den klassischen
-- Betrugsweg buchen, kassieren, stornieren (Dok 14, Grundsatz 5).
SELECT grant_perms('reception',
  'reservation:read','reservation:write','reservation:checkin',
  'guest:read','guest:write','guest:read_identity',
  'folio:read','folio:post','folio:void_own','folio:discount','folio:route',
  'invoice:issue',
  'rate:read','inventory:read',
  'housekeeping:read','housekeeping:write',
  'report:operational');

SELECT grant_perms('reservations',
  'reservation:read','reservation:write',
  'guest:read','guest:write',
  'rate:read','inventory:read','report:operational');

SELECT grant_perms('night_audit',
  'reservation:read','reservation:write','reservation:checkin',
  'guest:read','guest:write','guest:read_identity',
  'folio:read','folio:post','folio:void_own','folio:discount','folio:route',
  'invoice:issue','rate:read','inventory:read',
  'housekeeping:read','housekeeping:write',
  'report:operational','nightaudit:run');

SELECT grant_perms('accounting',
  'folio:read','invoice:credit','report:operational','report:revenue','report:export','guest:read');

-- Bewusst eng: ein Kanzleimitarbeiter mit schwachem Passwort darf kein
-- Einfallstor fuer Gaestedaten sein.
SELECT grant_perms('tax_advisor', 'folio:read','report:export');

SELECT grant_perms('revenue',
  'rate:read','rate:write','inventory:read','report:revenue','reservation:read');

-- Housekeeping sieht Belegung und Personenzahl, aber keine Gastdaten.
SELECT grant_perms('housekeeping',
  'housekeeping:read','housekeeping:write','maintenance:write','inventory:read');

SELECT grant_perms('maintenance', 'maintenance:write','housekeeping:read','inventory:read');

SELECT grant_perms('read_only', 'report:operational','report:revenue');

SELECT grant_perms('platform_admin',
  'platform:accounts','platform:support_session','platform:billing','platform:operations');
SELECT grant_perms('platform_support', 'platform:support_session','platform:operations');
SELECT grant_perms('platform_billing', 'platform:billing');
SELECT grant_perms('platform_ops', 'platform:operations');

DROP FUNCTION grant_perms(text, text[]);
