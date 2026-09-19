-- Mandantenbezug fuer rate_plan_product.
--
-- Befund H2 (Dokument 25): die Verknuepfungstabelle traegt nur
-- `rate_plan_id` und `product_id`, keine `property_id`, und keine
-- Zeilenrichtlinie -- waehrend beide Seiten, `rate_plan` und `product`, eine
-- haben (0007). Die Anwendungsrolle darf schreiben.
--
-- Heute nicht ausnutzbar, weil die Tabelle nur gelesen wird und der Verbund
-- `p.property_id = $2` mitfuehrt (`routes/billing.ts`): eine
-- mandantenuebergreifende Zeile fiele dort heraus. Ein kuenftiger Schreibweg
-- haette diese Sicherung nicht -- und er kommt, sobald Ratenplaene in der
-- Oberflaeche gepflegt werden.
--
-- Hier nicht nur die Zeilenrichtlinie, sondern die **zusammengesetzten
-- Fremdschluessel**. Der Unterschied ist der zwischen "wird nicht gelesen"
-- und "kann nicht entstehen": mit `(rate_plan_id, property_id)` gegen
-- `rate_plan (id, property_id)` weist die Datenbank eine Zeile ab, die einen
-- Ratenplan aus Haus A mit einer Leistung aus Haus B verbindet. Eine
-- Zeilenrichtlinie allein verbirgt so eine Zeile nur; entstehen koennte sie
-- weiter, und das Haus, dem der Ratenplan gehoert, sieht sie dann sogar.

ALTER TABLE rate_plan_product ADD COLUMN property_id bigint;

UPDATE rate_plan_product rpp
   SET property_id = rp.property_id
  FROM rate_plan rp
 WHERE rp.id = rpp.rate_plan_id;

ALTER TABLE rate_plan_product ALTER COLUMN property_id SET NOT NULL;

-- Bezugsziel der zusammengesetzten Fremdschluessel. Fachlich sagt es nichts
-- Neues -- `id` ist schon Primaerschluessel --, technisch braucht ein
-- Fremdschluessel auf ein Spaltenpaar genau diese Zusage.
ALTER TABLE rate_plan ADD CONSTRAINT rate_plan_id_property_uq UNIQUE (id, property_id);
ALTER TABLE product   ADD CONSTRAINT product_id_property_uq   UNIQUE (id, property_id);

ALTER TABLE rate_plan_product
  DROP CONSTRAINT rate_plan_product_rate_plan_id_fkey,
  DROP CONSTRAINT rate_plan_product_product_id_fkey,
  ADD CONSTRAINT rate_plan_product_rate_plan_fkey
    FOREIGN KEY (rate_plan_id, property_id)
    REFERENCES rate_plan (id, property_id) ON DELETE CASCADE,
  ADD CONSTRAINT rate_plan_product_product_fkey
    FOREIGN KEY (product_id, property_id)
    REFERENCES product (id, property_id);

ALTER TABLE rate_plan_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plan_product FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON rate_plan_product
  USING (property_id = ANY (app_property_ids()));
