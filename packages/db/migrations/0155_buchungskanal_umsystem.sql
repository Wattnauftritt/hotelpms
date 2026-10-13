-- ---------------------------------------------------------------------------
-- 0155 Buchungskanal aus einem Umsystem
--
-- Sven, 13.10.2026: die Rezeption soll sehen, ueber welchen Kanal eine
-- Buchung kam (Booking.com, Expedia, direkt), und zwar in jedem Haus, nicht
-- nur in seinem. `booking.channel_code` gibt es seit 0009; gefuellt wird es
-- vom Kanal selbst (0023, 0092) und vom CSV-Import. Die Buchungen aus dem
-- KWHotel-Import tragen keinen, weil KWHotel den Kanal nur als Freitext
-- kennt. Das Umsystem, das Buchungen ohnehin mit seinen Quellen abgleicht
-- (Gastkontakt, 0083), kennt ihn und soll ihn nachtragen.
--
-- **Wer gewinnt.** Wie beim Gastkontakt: ein Abgleich irrt. Das Umsystem
-- fuellt Leeres und ersetzt nur, was es selbst gesetzt hat; `null` zieht
-- seinen Wert zurueck. Ob der Wert von ihm stammt, sagt diese Spalte. Eine
-- Buchung aus einem Channel-Zugang (`channel_connection_id`) fasst es nie
-- an: dort hat der Kanal selbst gesagt, wer er ist.
--
-- Kein Eintrag in `audit_redaction`: ein Kanalname bezeichnet keinen
-- Menschen.
-- ---------------------------------------------------------------------------

ALTER TABLE booking
  ADD COLUMN channel_code_external boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN booking.channel_code_external IS
  'channel_code stammt aus dem Abgleich eines Umsystems (PUT .../guest-contact) '
  'und darf von ihm ersetzt oder zurueckgezogen werden.';
