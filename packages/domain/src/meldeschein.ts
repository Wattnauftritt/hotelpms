import { istAuslaendisch } from '@hotelpms/contracts'

/**
 * Braucht der Meldeschein dieser Person eine Unterschrift? (§ 29 Abs. 2 BMG)
 *
 * Seit dem 1.1.2025 unterschreiben nur noch ausländische Personen, also
 * wer nicht Deutscher im Sinne von Art. 116 GG ist. Es entscheidet die
 * **Staatsangehörigkeit**, nicht die Anschrift: eine Türkin mit Wohnsitz
 * in Köln unterschreibt, ein Deutscher mit Wohnsitz in Wien nicht. Bis zum
 * Online-Check-in entschied der Tresen nach `guest.country`.
 *
 * Nur wenn keine Staatsangehörigkeit erfasst ist, gilt ersatzweise das Land
 * der Anschrift: Profile aus der Zeit vor dieser Regel tragen oft nur das
 * eine, und ein Schein ohne jede Entscheidung wäre schlechter als einer mit
 * der bisherigen. Fehlt beides, ist keine Unterschrift verlangt -- eine
 * Unterschrift ohne Rechtsgrund wäre eine Erhebung ohne Rechtsgrund.
 *
 * **Die Regel selbst steht im Vertrag** (`istAuslaendisch` in
 * `@hotelpms/contracts`, Datei `checkin.ts`), weil auch die Oberfläche sie
 * braucht -- die Gastseite und die Check-in-Maske entscheiden damit, ob ein
 * Unterschriftsfeld erscheint -- und das Barrel dieses Pakets `node:crypto`
 * mitbringt, das ein Browser nicht hat. Hier steht derselbe Ausdruck unter
 * dem fachlichen Namen, nicht eine zweite Fassung.
 */
export function requiresRegistrationSignature(p: {
  nationality?: string | null; country?: string | null
}): boolean {
  return istAuslaendisch(p)
}
