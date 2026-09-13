-- Gaeste und Firmen. Profil je Account, nicht je Property (Entscheidung 13):
-- die Modellgrenze faellt damit mit der Datenschutzgrenze zusammen.

CREATE TABLE guest (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        bigint NOT NULL REFERENCES account(id),
  public_ref        text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  last_name         text NOT NULL,
  first_name        text,
  email             text,
  phone             text,
  birth_date        date,
  nationality       char(2),
  language          char(2) NOT NULL DEFAULT 'de',
  address_line1     text,
  postal_code       text,
  city              text,
  country           char(2),
  id_document_type  text CHECK (id_document_type IN ('passport','id_card','other')),
  -- § 30 BMG erlaubt die Nummer, verbietet die Kopie. Verschluesselt, mit
  -- Schluesselversion fuer Rotation (C4, Dokument 13). Es gibt bewusst kein
  -- Feld fuer einen Datei-Upload.
  id_document_number_enc bytea,
  id_document_key_version smallint,
  preferences       jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','anonymized','blocked')),
  anonymized_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Trigramm-Indizes: die Rezeption sucht nach Namensteilen (D2, Dokument 13).
CREATE INDEX guest_last_name_trgm ON guest USING gin (last_name gin_trgm_ops);
CREATE INDEX guest_email_trgm     ON guest USING gin (email gin_trgm_ops);
CREATE INDEX guest_account        ON guest (account_id, last_name);

-- Was ein einzelnes Haus ueber den Gast notiert, bleibt bei diesem Haus.
CREATE TABLE guest_property_note (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES property(id),
  guest_id    bigint NOT NULL REFERENCES guest(id),
  note        text NOT NULL,
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_note_guest ON guest_property_note (guest_id);

CREATE TABLE company (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES account(id),
  public_ref    text NOT NULL UNIQUE DEFAULT generate_public_ref(),
  name          text NOT NULL,
  vat_id        text,
  address_line1 text,
  postal_code   text,
  city          text,
  country       char(2) NOT NULL DEFAULT 'DE',
  payment_terms_days integer NOT NULL DEFAULT 14,
  invoice_email text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_name_trgm ON company USING gin (name gin_trgm_ops);

ALTER TABLE guest ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON guest USING (account_id = ANY (app_account_ids()));

ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON company USING (account_id = ANY (app_account_ids()));

ALTER TABLE guest_property_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_property_note FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant ON guest_property_note USING (property_id = ANY (app_property_ids()));

SELECT attach_audit('guest');
SELECT attach_audit('company');
SELECT attach_audit('guest_property_note');
