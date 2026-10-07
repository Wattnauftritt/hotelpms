/**
 * Berechtigungskatalog nach Dokument 14.
 * Muss mit der Migration 0003 uebereinstimmen; ein Test prueft das.
 */
export const PERMISSIONS = [
  'reservation:read', 'reservation:write', 'reservation:checkin',
  'reservation:override_restriction',
  'guest:read', 'guest:write', 'guest:read_identity', 'guest:export',
  // Kontaktdaten aus einem Umsystem (0083): schmaler als guest:write, weil
  // ein Abgleich irrt und dann nur nachtragen, nie umbenennen soll.
  'guest:contact_write',
  // Fertige Meldescheine aus einem Umsystem (0087): setzt Geburtsdatum und
  // Staatsangehoerigkeit und legt Mitreisende an, also mehr als Kontaktdaten.
  'registration:import',
  'folio:read', 'folio:post', 'folio:void_own', 'folio:void_any',
  'folio:discount', 'folio:discount_unlimited', 'folio:route',
  'invoice:issue', 'invoice:credit',
  'rate:read', 'rate:write',
  // Preissteuerung (0065): Regeln setzen, nach denen sich Preise ohne
  // weiteres Zutun bewegen, und auf automatisch schalten. Eigenes Recht,
  // weil ein Fehler darin ein Jahr lang falsch verkauft.
  'rate:steer',
  'inventory:read', 'inventory:write',
  'housekeeping:read', 'housekeeping:write', 'maintenance:write',
  // Reinigungsplan (0106): Zimmer den Kraeften zuteilen und Sollminuten
  // pflegen. Eigenes Recht, weil an den Minuten die Abrechnung haengt.
  'housekeeping:plan',
  // Kontrolle (0109): gereinigte Zimmer abnehmen oder nacharbeiten lassen.
  // Eigenes Recht, weil "kontrolliert" das Zimmer fuer die Rezeption
  // bezugsfertig macht.
  'housekeeping:inspect',
  'report:operational', 'report:revenue', 'report:export',
  'nightaudit:run',
  // Gastpost (0028): eigenes Recht, weil Hinausschicken etwas anderes ist
  // als Festschreiben -- es verlaesst das Haus und kommt nicht zurueck.
  'email:send',
  // Kassenbuch (0095): Lesen und Buchen getrennt vom Stornieren, der Export
  // getrennt von beidem; die Uebernahme nur fuer Maschinenzugaenge.
  'cashbook:read', 'cashbook:write', 'cashbook:void', 'cashbook:export',
  'cashbook:import',
  'settings:property', 'settings:account', 'user:manage', 'integration:manage',
  'account:contract',
  'platform:accounts', 'platform:support_session', 'platform:billing',
  'platform:operations',
  // Plattformbenutzer anlegen und Rollen vergeben (0038): eigenes Recht,
  // weil das die eine Handlung ist, mit der sich der Kreis der Berechtigten
  // selbst erweitert.
  'platform:staff',
  // Gaesteterminal (0071): keiner Rolle zugeordnet und als Zugriffsbereich
  // eines Maschinenzugangs ausgeschlossen. Die einzige Quelle ist ein
  // gekoppeltes Geraet (`loadPrincipalFromDevice`).
  'terminal:device',
  // Personal-App (0105): die App benutzen. Was darin zu sehen ist, sagt der
  // Plan -- die eigenen Zimmer, nie fremde. Als Zugriffsbereich eines
  // Maschinenzugangs ausgeschlossen, denn eine Maschine hat keine Zimmer.
  'staff:app',
  // Kueche (0110): die Fruehstueckszahl, und nichts sonst. Kueche, Hausdame
  // und Rezeption; report:operational zeigte der Kueche viel zu viel.
  'kitchen:breakfast'
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(v: string): v is Permission {
  return (PERMISSIONS as readonly string[]).includes(v)
}
