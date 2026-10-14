-- Zahlungsarten fuer Haeuser, die keine haben (Sven, 14.10.2026: "Warum sind
-- die Zahlungsarten leer?").
--
-- Weder account_provision (0031) noch platform_property_add (0039) legen
-- Zahlungsarten an; nur das Testhotel und die Testfixtures taten es. Ein
-- echtes Haus stand deshalb mit leerer Auswahl unter "Zahlung vermerken" und
-- konnte keine Zahlung vermerken, bis jemand die Arten unter Einstellungen
-- -> Zahlungsarten anlegte -- und dass es dort welche anzulegen gibt, sagte
-- keine Maske.
--
-- Dieselben drei wie im Testhotel. Ein Haus, das schon eigene hat (auch
-- stillgelegte), bleibt unberuehrt; die Zahlungsart STRIPE, die der
-- Zahlungseingang selbst anlegt, zaehlt nicht als eigene.

INSERT INTO payment_method (property_id, code, name, sort_order)
SELECT p.id, v.code, v.name, v.sort_order
  FROM property p
 CROSS JOIN (VALUES ('CASH', 'Barzahlung vor Ort', 1),
                    ('CARD', 'Kartenzahlung vor Ort', 2),
                    ('TRANSFER', 'Überweisung', 3)) v(code, name, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM payment_method m
                    WHERE m.property_id = p.id AND m.code <> 'STRIPE')
ON CONFLICT (property_id, code) DO NOTHING;
