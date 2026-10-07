-- ---------------------------------------------------------------------------
-- 0110 Fruehstueckszahl fuer Kueche und Hausdame (Aufgabe 18, Baustein 5)
--
-- Die alte App spiegelte die Zahl stuendlich aus dem Adminpanel und hatte
-- ein festes Enddatum (01.11.2026). Hier kommt sie direkt aus der Belegung,
-- mit derselben Regel wie `GET /breakfast` (Personen der Vornacht).
--
-- Eigenes, enges Recht `kitchen:breakfast`: die Kueche braucht die Zahl
-- und nichts sonst. `report:operational` zeigte ihr Statistik und
-- Reservierungslisten. Die Hausdame bekommt es auch -- sie kontrolliert die
-- Zahl (Sven, 07.10.2026) --, und die Rezeption, die morgens gefragt wird.
-- ---------------------------------------------------------------------------

INSERT INTO permission (key, grp, description) VALUES
  ('kitchen:breakfast', 'Personal', 'Fruehstueckszahl heute und in den naechsten Tagen')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'kitchen:breakfast'
  FROM role r
 WHERE r.account_id IS NULL
   AND r.key IN ('owner','account_admin','hotel_director','housekeeping','kitchen',
                 'reception')
ON CONFLICT DO NOTHING;
