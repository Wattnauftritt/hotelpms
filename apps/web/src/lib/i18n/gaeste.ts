import type { LocalizedText } from '@hotelpms/contracts'

/** Gästesuche, -profil und Firmen (A6, A10). */
export const gaeste = {
  'guests.title': {
    de: 'Gäste',
    en: 'Guests' },
  'guests.searchPlaceholder': {
    de: 'Nachname, E-Mail oder Telefon',
    en: 'Last name, email or phone' },
  'guests.searchHint': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters' },
  'guests.noResults': {
    de: 'Keine Treffer',
    en: 'No matches' },
  'guests.new': {
    de: 'Neuer Gast',
    en: 'New guest' },
  'guests.profile': {
    de: 'Profil',
    en: 'Profile' },
  'guests.lastName': {
    de: 'Nachname',
    en: 'Last name' },
  'guests.firstName': {
    de: 'Vorname',
    en: 'First name' },
  'guests.email': {
    de: 'E-Mail',
    en: 'Email' },
  'guests.phone': {
    de: 'Telefon',
    en: 'Phone' },
  'guests.birthDate': {
    de: 'Geburtsdatum',
    en: 'Date of birth' },
  'guests.nationality': {
    de: 'Nationalität',
    en: 'Nationality' },
  'guests.language': {
    de: 'Sprache der Gastpost',
    en: 'Language for guest mail' },
  'guests.language.de': {
    de: 'Deutsch',
    en: 'German' },
  'guests.language.en': {
    de: 'Englisch',
    en: 'English' },
  'guests.language.nl': {
    de: 'Niederländisch',
    en: 'Dutch' },
  'guests.language.pl': {
    de: 'Polnisch',
    en: 'Polish' },
  'guests.languageHint': {
    de: 'In dieser Sprache gehen Bestätigung und Rechnung '
      + 'hinaus. Angeboten wird nur, worin wir auch schreiben.',
    en: 'Confirmation and invoice go out in this language. '
      + 'Only languages we actually write in are offered.' },
  'guests.address': {
    de: 'Anschrift',
    en: 'Address' },
  'guests.postalCode': {
    de: 'PLZ',
    en: 'Postal code' },
  'guests.city': {
    de: 'Ort',
    en: 'City' },
  'guests.country': {
    de: 'Land',
    en: 'Country' },
  'guests.idDocument': {
    de: 'Ausweisnummer',
    en: 'ID document number' },
  'guests.idDocumentNone': {
    de: 'Keine hinterlegt',
    en: 'None on file' },
  'guests.idDocumentReveal': {
    de: 'Im Klartext zeigen',
    en: 'Show in full' },
  'guests.idDocumentHint': {
    de: 'Nach § 30 BMG erlaubt, aber niemals eine Kopie. '
      + 'Jeder Abruf wird protokolliert.',
    en: 'Permitted under § 30 BMG, but never a copy. '
      + 'Every access is logged.' },
  'guests.anonymized': {
    de: 'Anonymisiert (Art. 17 DSGVO)',
    en: 'Anonymised (Art. 17 GDPR)' },
  'guests.save': {
    de: 'Speichern',
    en: 'Save' },
  'guests.saved': {
    de: 'Gespeichert',
    en: 'Saved' },
  'guests.duplicateWarning': {
    de: 'Mögliche Dublette',
    en: 'Possible duplicate' },

  'companies.title': {
    de: 'Firmen',
    en: 'Companies' },
  'companies.searchPlaceholder': {
    de: 'Name',
    en: 'Name' },
  'companies.new': {
    de: 'Neue Firma',
    en: 'New company' },
  'companies.name': {
    de: 'Name',
    en: 'Name' },
  'companies.vatId': {
    de: 'USt-IdNr.',
    en: 'VAT ID' },
  'companies.address': {
    de: 'Anschrift',
    en: 'Address' },
  'companies.postalCode': {
    de: 'PLZ',
    en: 'Postal code' },
  'companies.city': {
    de: 'Ort',
    en: 'City' },
  'companies.country': {
    de: 'Land',
    en: 'Country' },
  'companies.paymentTerms': {
    de: 'Zahlungsziel in Tagen',
    en: 'Payment terms in days' },
  'companies.invoiceEmail': {
    de: 'Rechnungsadresse (E-Mail)',
    en: 'Invoice address (email)' },
  'companies.active': {
    de: 'Aktiv',
    en: 'Active' },
  'companies.inactive': {
    de: 'Stillgelegt',
    en: 'Deactivated' },
  'companies.save': {
    de: 'Speichern',
    en: 'Save' },
  'companies.saved': {
    de: 'Gespeichert',
    en: 'Saved' },
  'dsgvo.title': {
    de: 'Betroffenenrechte',
    en: 'Data subject rights' },
  'dsgvo.export': {
    de: 'Auskunft erstellen (Art. 15)',
    en: 'Create access report (Art. 15)' },
  'dsgvo.exportHint': {
    de: 'Trägt alles zusammen, was über diesen Gast gespeichert '
      + 'ist. Die Frist beträgt einen Monat.',
    en: 'Collects everything stored about this guest. '
      + 'The deadline is one month.' },
  'dsgvo.stays': {
    de: 'Aufenthalte',
    en: 'Stays' },
  'dsgvo.invoices': {
    de: 'Rechnungen',
    en: 'Invoices' },
  'dsgvo.notes': {
    de: 'Hausnotizen',
    en: 'Property notes' },
  'dsgvo.registrations': {
    de: 'Meldescheine',
    en: 'Registration forms' },
  'dsgvo.createdAt': {
    de: 'Profil angelegt',
    en: 'Profile created' },
  'dsgvo.print': {
    de: 'Drucken',
    en: 'Print' },
  'dsgvo.anonymize': {
    de: 'Löschen (Art. 17)',
    en: 'Erase (Art. 17)' },
  // Der Satz muss die Erwartung geraderücken, bevor geklickt wird: wer
  // „gelöscht" hört und die Rechnung später wiederfindet, hält das für
  // einen Fehler.
  'dsgvo.anonymizeHint': {
    de: 'Löschen heißt anonymisieren: das Profil wird '
      + 'entpersonalisiert, Hausnotizen und Meldescheine werden '
      + 'vernichtet. Rechnungen bleiben unverändert — sie '
      + 'unterliegen der achtjährigen Aufbewahrungsfrist.',
    en: 'Erasure means anonymisation: the profile is '
      + 'depersonalised, property notes and registration forms '
      + 'are destroyed. Invoices remain unchanged — they are '
      + 'subject to the eight-year retention period.' },
  'dsgvo.anonymizeConfirm': {
    de: 'Diesen Gast unwiderruflich anonymisieren?',
    en: 'Anonymise this guest irreversibly?' },
  'dsgvo.anonymized': {
    de: 'Anonymisiert. Das Profil lässt sich nicht wiederherstellen.',
    en: 'Anonymised. The profile cannot be restored.' },
  'dsgvo.alreadyDone': {
    de: 'Dieses Profil war bereits anonymisiert.',
    en: 'This profile was already anonymised.' },
} as const satisfies Record<string, LocalizedText>
