-- charge und settlement sind unveraenderlich. Das Festschreiben muss aber
-- invoice_id setzen duerfen. Statt die Haerte aufzuweichen, wird genau dieser
-- eine Uebergang erlaubt: NULL -> Wert, und sonst darf sich nichts aendern.
CREATE OR REPLACE FUNCTION forbid_mutation_except_invoice_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_j jsonb; new_j jsonb; diff text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tabelle % ist unveraenderlich (GoBD). Korrektur nur als Gegenbuchung.',
      TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Position ist bereits festgeschrieben und kann nicht geaendert werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.invoice_id IS NULL THEN
    RAISE EXCEPTION 'Tabelle % ist unveraenderlich (GoBD). Korrektur nur als Gegenbuchung.',
      TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;

  old_j := to_jsonb(OLD) - 'invoice_id';
  new_j := to_jsonb(NEW) - 'invoice_id';
  SELECT array_agg(key) INTO diff FROM jsonb_each(new_j)
   WHERE new_j -> key IS DISTINCT FROM old_j -> key;
  IF diff IS NOT NULL THEN
    RAISE EXCEPTION
      'Beim Festschreiben darf sich nur invoice_id aendern, nicht %', array_to_string(diff, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER trg_append_only ON charge;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON charge
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_except_invoice_link();
GRANT UPDATE (invoice_id) ON charge TO hotelpms_app;

DROP TRIGGER trg_append_only ON settlement;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON settlement
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_except_invoice_link();
GRANT UPDATE (invoice_id) ON settlement TO hotelpms_app;

-- Audit auch auf den Finanztabellen: das Festschreiben ist protokollpflichtig.
SELECT attach_audit('charge');
SELECT attach_audit('settlement');
SELECT attach_audit('invoice');
