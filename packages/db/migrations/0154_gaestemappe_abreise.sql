-- ---------------------------------------------------------------------------
-- 0154 Digitale Gaestemappe: spaete Abreise, Abreiseseite, Bewertungslink
--
-- Plan gaestemappe/plan.md, Abschnitt 3 Punkte 7 und 9 und Abschnitt 11
-- Punkt 2 (Sven, 11.10.2026): spaete Abreise gegen Gebuehr, als Anfrage,
-- die Preise legt das Haus fest; am Abreisetag der Bewertungslink.
--
-- **Wann ein Eintrag angeboten wird** (`offer`). Bisher den ganzen
-- Aufenthalt. Neu:
--   - `departure`: am Abend vor der Abreise und am Abreisetag, gewuenscht
--     fuer den Abreisetag -- das Lunchpaket fuer die Heimfahrt.
--   - `late_checkout`: ebenso, aber nur, wenn am Abreisetag niemand in
--     dieses Zimmer anreist. Sonst bietet die Mappe etwas an, das die
--     Rezeption danach ablehnen muss, und der Gast hat sich umsonst gefreut.
--     Kommt die Anreise erst nach dem Wunsch, entscheidet die Rezeption.
-- Eine eigene Art statt eines eigenen Moduls: Preis, Annehmen und Buchen
-- aufs Folio sind dieselben wie bei jedem Extra (0149), und der Bericht
-- zaehlt sie spaeter mit.
--
-- **Abreiseseite und Bewertungslink** kommen aus dem, was das Haus fuer
-- das Gaesteterminal schon pflegt: eine Seite (`terminal_content`) und
-- eine freigegebene Adresse (`terminal_url`, nur https, 0070). Keine
-- zweite Pflegestelle und keine Adresse, die nur hier jemand eintippt.
-- ---------------------------------------------------------------------------

ALTER TABLE guest_request_item
  ADD COLUMN offer text NOT NULL DEFAULT 'stay'
    CHECK (offer IN ('stay','departure','late_checkout'));

ALTER TABLE guest_folder_setting
  -- Eine Seite der Mappe, auf die der Aufenthalt ab dem Abend vor der
  -- Abreise verweist: wohin mit dem Schluessel, wie man bezahlt.
  ADD COLUMN departure_content_id bigint REFERENCES terminal_content(id),
  -- Am Abreisetag als Knopf: wer gerade abreist, erinnert sich noch.
  ADD COLUMN review_url_id bigint REFERENCES terminal_url(id);
