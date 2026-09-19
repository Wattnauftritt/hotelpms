import type { LocalizedText } from '@hotelpms/contracts'

/** Gästesuche, -profil und Firmen (A6, A10). */
export const gaeste = {
  'guests.title': {
    de: 'Gäste',
    en: 'Guests',
    tr: 'Misafirler' },
  'guests.searchPlaceholder': {
    de: 'Nachname, E-Mail oder Telefon',
    en: 'Last name, email or phone',
    tr: 'Soyadı, e-posta veya telefon' },
  'guests.searchHint': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters',
    tr: 'En az iki karakter' },
  'guests.noResults': {
    de: 'Keine Treffer',
    en: 'No matches',
    tr: 'Sonuç yok' },
  'guests.new': {
    de: 'Neuer Gast',
    en: 'New guest',
    tr: 'Yeni misafir' },
  'guests.profile': {
    de: 'Profil',
    en: 'Profile',
    tr: 'Profil' },
  'guests.lastName': {
    de: 'Nachname',
    en: 'Last name',
    tr: 'Soyadı' },
  'guests.firstName': {
    de: 'Vorname',
    en: 'First name',
    tr: 'Adı' },
  'guests.email': {
    de: 'E-Mail',
    en: 'Email',
    tr: 'E-posta' },
  'guests.phone': {
    de: 'Telefon',
    en: 'Phone',
    tr: 'Telefon' },
  'guests.birthDate': {
    de: 'Geburtsdatum',
    en: 'Date of birth',
    tr: 'Doğum tarihi' },
  'guests.nationality': {
    de: 'Nationalität',
    en: 'Nationality',
    tr: 'Uyruk' },
  'guests.language': {
    de: 'Sprache der Gastpost',
    en: 'Language for guest mail',
    tr: 'Misafir yazışma dili' },
  'guests.language.de': {
    de: 'Deutsch',
    en: 'German',
    tr: 'Almanca' },
  'guests.language.en': {
    de: 'Englisch',
    en: 'English',
    tr: 'İngilizce' },
  'guests.language.nl': {
    de: 'Niederländisch',
    en: 'Dutch',
    tr: 'Felemenkçe' },
  'guests.language.pl': {
    de: 'Polnisch',
    en: 'Polish',
    tr: 'Lehçe' },
  'guests.languageHint': {
    de: 'In dieser Sprache gehen Bestätigung und Rechnung '
      + 'hinaus. Angeboten wird nur, worin wir auch schreiben.',
    en: 'Confirmation and invoice go out in this language. '
      + 'Only languages we actually write in are offered.',
    tr: 'Onay ve fatura bu dilde gönderilir. Yalnızca gerçekten yazdığımız diller sunulur.' },
  'guests.address': {
    de: 'Anschrift',
    en: 'Address',
    tr: 'Adres' },
  'guests.postalCode': {
    de: 'PLZ',
    en: 'Postal code',
    tr: 'Posta kodu' },
  'guests.city': {
    de: 'Ort',
    en: 'City',
    tr: 'Şehir' },
  'guests.country': {
    de: 'Land',
    en: 'Country',
    tr: 'Ülke' },
  'guests.idDocument': {
    de: 'Ausweisnummer',
    en: 'ID document number',
    tr: 'Kimlik numarası' },
  'guests.idDocumentNone': {
    de: 'Keine hinterlegt',
    en: 'None on file',
    tr: 'Kayıtlı değil' },
  'guests.idDocumentReveal': {
    de: 'Im Klartext zeigen',
    en: 'Show in full',
    tr: 'Açık olarak göster' },
  'guests.idDocumentHint': {
    de: 'Nach § 30 BMG erlaubt, aber niemals eine Kopie. '
      + 'Jeder Abruf wird protokolliert.',
    en: 'Permitted under § 30 BMG, but never a copy. '
      + 'Every access is logged.',
    tr: '§ 30 BMG uyarınca izinlidir, ancak kopyası asla alınmaz. Her görüntüleme kayda geçer.' },
  'guests.anonymized': {
    de: 'Anonymisiert (Art. 17 DSGVO)',
    en: 'Anonymised (Art. 17 GDPR)',
    tr: 'Anonimleştirildi (DSGVO Madde 17)' },
  'guests.save': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'guests.saved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
  'guests.duplicateWarning': {
    de: 'Mögliche Dublette',
    en: 'Possible duplicate',
    tr: 'Olası mükerrer kayıt' },

  'companies.title': {
    de: 'Firmen',
    en: 'Companies',
    tr: 'Firmalar' },
  'companies.searchPlaceholder': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'companies.new': {
    de: 'Neue Firma',
    en: 'New company',
    tr: 'Yeni firma' },
  'companies.name': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'companies.vatId': {
    de: 'USt-IdNr.',
    en: 'VAT ID',
    tr: 'USt-IdNr. (vergi kimlik no)' },
  'companies.address': {
    de: 'Anschrift',
    en: 'Address',
    tr: 'Adres' },
  'companies.postalCode': {
    de: 'PLZ',
    en: 'Postal code',
    tr: 'Posta kodu' },
  'companies.city': {
    de: 'Ort',
    en: 'City',
    tr: 'Şehir' },
  'companies.country': {
    de: 'Land',
    en: 'Country',
    tr: 'Ülke' },
  'companies.paymentTerms': {
    de: 'Zahlungsziel in Tagen',
    en: 'Payment terms in days',
    tr: 'Gün cinsinden ödeme vadesi' },
  'companies.invoiceEmail': {
    de: 'Rechnungsadresse (E-Mail)',
    en: 'Invoice address (email)',
    tr: 'Fatura adresi (e-posta)' },
  'companies.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'companies.inactive': {
    de: 'Stillgelegt',
    en: 'Deactivated',
    tr: 'Devre dışı' },
  'companies.save': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'companies.saved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
  'dsgvo.title': {
    de: 'Betroffenenrechte',
    en: 'Data subject rights',
    tr: 'İlgili kişi hakları' },
  'dsgvo.export': {
    de: 'Auskunft erstellen (Art. 15)',
    en: 'Create access report (Art. 15)',
    tr: 'Bilgi dökümü oluştur (Madde 15)' },
  'dsgvo.exportHint': {
    de: 'Trägt alles zusammen, was über diesen Gast gespeichert '
      + 'ist. Die Frist beträgt einen Monat.',
    en: 'Collects everything stored about this guest. '
      + 'The deadline is one month.',
    tr: 'Bu misafir hakkında saklanan her şeyi bir araya getirir. Süre bir aydır.' },
  'dsgvo.stays': {
    de: 'Aufenthalte',
    en: 'Stays',
    tr: 'Konaklamalar' },
  'dsgvo.invoices': {
    de: 'Rechnungen',
    en: 'Invoices',
    tr: 'Faturalar' },
  'dsgvo.notes': {
    de: 'Hausnotizen',
    en: 'Property notes',
    tr: 'Tesis notları' },
  'dsgvo.notesHint': {
    de: 'Eine Hausnotiz haelt eine Anforderung fest, nicht ihren Grund — '
      + '„barrierefreies Zimmer" gehört hierher, die Diagnose dahinter nicht.',
    en: 'A property note records a requirement, not its reason — "step-free room" '
      + 'belongs here, the diagnosis behind it does not.',
    tr: 'Tesis notu bir gereksinimi kaydeder, nedenini değil — „engelsiz oda" '
      + 'buraya aittir, arkasındaki teşhis ait değildir.' },
  'dsgvo.registrations': {
    de: 'Meldescheine',
    en: 'Registration forms',
    tr: 'Meldeschein kayıtları' },
  'dsgvo.createdAt': {
    de: 'Profil angelegt',
    en: 'Profile created',
    tr: 'Profil oluşturuldu' },
  'dsgvo.print': {
    de: 'Drucken',
    en: 'Print',
    tr: 'Yazdır' },
  'dsgvo.anonymize': {
    de: 'Löschen (Art. 17)',
    en: 'Erase (Art. 17)',
    tr: 'Sil (Madde 17)' },
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
      + 'subject to the eight-year retention period.',
    tr: 'Silmek anonimleştirmek demektir: profil kişisellikten arındırılır, tesis notları ve Meldeschein kayıtları imha edilir. Faturalar değişmeden kalır — sekiz yıllık saklama süresine tabidirler.' },
  'dsgvo.anonymizeConfirm': {
    de: 'Diesen Gast unwiderruflich anonymisieren?',
    en: 'Anonymise this guest irreversibly?',
    tr: 'Bu misafir geri dönülmez biçimde anonimleştirilsin mi?' },
  'dsgvo.anonymized': {
    de: 'Anonymisiert. Das Profil lässt sich nicht wiederherstellen.',
    en: 'Anonymised. The profile cannot be restored.',
    tr: 'Anonimleştirildi. Profil geri getirilemez.' },
  'dsgvo.alreadyDone': {
    de: 'Dieses Profil war bereits anonymisiert.',
    en: 'This profile was already anonymised.',
    tr: 'Bu profil zaten anonimleştirilmişti.' },
} as const satisfies Record<string, LocalizedText>
