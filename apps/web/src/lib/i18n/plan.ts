import type { LocalizedText } from '@hotelpms/contracts'

/** Belegungsplan und das Seitenfenster einer Reservierung (Spur A). */
export const plan = {
  'nav.availability': {
    de: 'Verfügbarkeit',
    en: 'Availability',
    tr: 'Müsaitlik' },
  'plan.reservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'plan.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'plan.noGuest': {
    de: 'Kein Gast hinterlegt',
    en: 'No guest on file',
    tr: 'Kayıtlı misafir yok' },
  'plan.company': {
    de: 'Firma',
    en: 'Company',
    tr: 'Firma' },
  'plan.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'plan.noRoom': {
    de: 'Kein Zimmer zugewiesen',
    en: 'No room assigned',
    tr: 'Oda atanmamış' },
  'plan.category': {
    de: 'Zimmergruppe',
    en: 'Room category',
    tr: 'Oda tipi' },
  'plan.ratePlan': {
    de: 'Ratenplan',
    en: 'Rate plan',
    tr: 'Fiyat planı' },
  'plan.stay': {
    de: 'Aufenthalt',
    en: 'Stay',
    tr: 'Konaklama' },
  'plan.nights': {
    de: 'Nächte',
    en: 'Nights',
    tr: 'Gece' },
  'plan.occupants': {
    de: 'Mitreisende',
    en: 'Occupants',
    tr: 'Birlikte kalanlar' },
  'plan.noOccupants': {
    de: 'Keine weiteren Mitreisende',
    en: 'No further occupants',
    tr: 'Başka kimse yok' },
  'plan.primary': {
    de: 'Hauptgast',
    en: 'Primary guest',
    tr: 'Ana misafir' },
  'plan.total': {
    de: 'Gesamtpreis',
    en: 'Total price',
    tr: 'Toplam fiyat' },
  'plan.block': {
    de: 'Aus Kontingent',
    en: 'From block',
    tr: 'Kontenjandan' },
  'plan.source': {
    de: 'Quelle',
    en: 'Source',
    tr: 'Kaynak' },
  'plan.checkedInAt': {
    de: 'Angereist am',
    en: 'Checked in at',
    tr: 'Giriş tarihi' },
  'plan.checkedOutAt': {
    de: 'Abgereist am',
    en: 'Checked out at',
    tr: 'Çıkış tarihi' },
  'plan.canceledAt': {
    de: 'Storniert am',
    en: 'Cancelled at',
    tr: 'İptal tarihi' },
  'plan.folio': {
    de: 'Gastkonto',
    en: 'Folio',
    tr: 'Misafir hesabı' },
  'plan.openFolio': {
    de: 'Folio öffnen',
    en: 'Open folio',
    tr: 'Folio aç' },
  'plan.noFolio': {
    de: 'Noch kein Gastkonto',
    en: 'No folio yet',
    tr: 'Henüz misafir hesabı yok' },
  'plan.notes': {
    de: 'Notiz',
    en: 'Note',
    tr: 'Not' },
  'plan.notesHint': {
    de: 'Freitext für die Rezeption. Hier gehören keine '
      + 'Gesundheitsdaten hin: das Feld wird weder durchsucht noch anonymisiert.',
    en: 'Free text for the front desk. No health data belongs '
      + 'here: the field is neither searched nor anonymised.',
    tr: 'Resepsiyon için serbest metin. Buraya sağlık verisi yazılmaz: bu alan ne aranır ne de anonimleştirilir.' },
  'plan.notesSave': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'plan.notesSaved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
  'plan.cancel': {
    de: 'Stornieren',
    en: 'Cancel booking',
    tr: 'İptal et' },
  'plan.cancelConfirm': {
    de: 'Diese Reservierung wirklich stornieren?',
    en: 'Cancel this reservation?',
    tr: 'Bu rezervasyon gerçekten iptal edilsin mi?' },
  'plan.reinstate': {
    de: 'Storno zurücknehmen',
    en: 'Undo cancellation',
    tr: 'İptali geri al' },
  'plan.sendConfirmation': {
    de: 'Bestätigung schicken',
    en: 'Send confirmation',
    tr: 'Onay gönder' },
  'plan.confirmationSent': {
    de: 'Bestätigung eingereiht',
    en: 'Confirmation queued',
    tr: 'Onay kuyruğa alındı' },

  'booking.title': {
    de: 'Buchen',
    en: 'Book',
    tr: 'Rezerve et' },
  'booking.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'booking.category': {
    de: 'Zimmergruppe',
    en: 'Room category',
    tr: 'Oda tipi' },
  'booking.arrival': {
    de: 'Anreise',
    en: 'Arrival',
    tr: 'Giriş' },
  'booking.departure': {
    de: 'Abreise',
    en: 'Departure',
    tr: 'Çıkış' },
  'booking.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'booking.notes': {
    de: 'Notiz',
    en: 'Note',
    tr: 'Not' },
  'booking.submit': {
    de: 'Buchen',
    en: 'Book',
    tr: 'Rezerve et' },
  'booking.close': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'Vazgeç' },
  'booking.created': {
    de: 'Gebucht',
    en: 'Booked',
    tr: 'Rezerve edildi' },
  'booking.needsGuest': {
    de: 'Ohne Gast lässt sich nicht buchen. Suchen oder neu anlegen.',
    en: 'Booking needs a guest. Search or create one.',
    tr: 'Misafir olmadan rezervasyon yapılamaz. Arayın veya yeni kayıt oluşturun.' },

  'plan.dragHint': {
    de: 'Balken ziehen verschiebt die Reservierung, die Ränder verlängern sie. Auf '
      + 'freier Fläche aufziehen legt eine Buchung an — mit gedrückter Strg-, ⌘- '
      + 'oder Umschalttaste über mehrere Zimmer hinweg eine Gruppenbuchung.',
    en: 'Drag a bar to move the reservation, drag its edges to extend it. Drag '
      + 'across free space to create a booking — hold Ctrl, ⌘ or Shift and drag '
      + 'across several rooms for a group booking.',
    tr: 'Çubuğu sürüklemek rezervasyonu taşır, kenarları uzatır. Boş alanda sürükleyerek açmak yeni bir rezervasyon oluşturur — Strg, ⌘ veya Shift tuşu basılıyken birden çok oda üzerinde grup rezervasyonu.' },

  'group.title': {
    de: 'Gruppenbuchung',
    en: 'Group booking',
    tr: 'Grup rezervasyonu' },
  'group.rooms': {
    de: 'Zimmer',
    en: 'rooms',
    tr: 'Oda' },
  'group.selection': {
    de: 'Ausgewählte Zimmer',
    en: 'Selected rooms',
    tr: 'Seçilen odalar' },
  'group.remove': {
    de: 'Entfernen',
    en: 'Remove',
    tr: 'Kaldır' },
  'group.submit': {
    de: 'Gruppe buchen',
    en: 'Book the group',
    tr: 'Grubu rezerve et' },
  'group.created': {
    de: 'Gruppe gebucht',
    en: 'Group booked',
    tr: 'Grup rezerve edildi' },
  'group.createdDetail': {
    de: '{n} Zimmer unter einer Buchung',
    en: '{n} rooms under one booking',
    tr: 'tek rezervasyon altında {n} oda' },
  'group.guestHint': {
    de: 'Der Gast ist der Besteller der Gruppe, nicht der Bewohner jedes Zimmers. '
      + 'Er wird nur im ersten Zimmer als Mitreisender geführt — sonst zählte die '
      + 'Kurtaxe ihn mehrfach. Die Namen der übrigen Zimmer kommen mit der '
      + 'Namensliste.',
    en: 'The guest is the person who booked the group, not the occupant of every '
      + 'room. They are recorded as an occupant of the first room only — otherwise '
      + 'city tax would count them several times. The other names arrive with the '
      + 'rooming list.',
    tr: 'Misafir, grubun siparişini verendir, her odanın sakini değil. Yalnızca ilk odada birlikte kalan olarak gösterilir — yoksa konaklama vergisi onu birden çok kez sayardı. Diğer odaların adları isim listesiyle gelir.' },
  'group.empty': {
    de: 'Kein Zimmer mehr ausgewählt.',
    en: 'No room selected any more.',
    tr: 'Artık seçili oda yok.' },

  'guestPicker.placeholder': {
    de: 'Nachname, E-Mail oder Telefon',
    en: 'Last name, email or phone',
    tr: 'Soyadı, e-posta veya telefon' },
  'guestPicker.hint': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters',
    tr: 'En az iki karakter' },
  'guestPicker.noResults': {
    de: 'Keine Treffer',
    en: 'No matches',
    tr: 'Sonuç yok' },
  'guestPicker.createNew': {
    de: 'Neuen Gast anlegen',
    en: 'Create new guest',
    tr: 'Yeni misafir oluştur' },
  'guestPicker.change': {
    de: 'Ändern',
    en: 'Change',
    tr: 'Değiştir' },
  'guestPicker.anonymized': {
    de: 'Anonymisiert',
    en: 'Anonymised',
    tr: 'Anonimleştirildi' },

  'warnings.title': {
    de: 'Warnungen',
    en: 'Warnings',
    tr: 'Uyarılar' },
  'warnings.none': {
    de: 'Keine Warnungen im sichtbaren Zeitraum',
    en: 'No warnings in the visible range',
    tr: 'Görünen dönemde uyarı yok' },
  'warnings.unassigned': {
    de: 'ohne Zimmer',
    en: 'without a room',
    tr: 'odasız' },
  'warnings.overbooked': {
    de: 'Überbuchung',
    en: 'Overbooking',
    tr: 'Aşırı rezervasyon' },
  'warnings.overbookedOn': {
    de: 'am',
    en: 'on',
    tr: 'tarihinde' },

  'availability.title': {
    de: 'Verfügbarkeit',
    en: 'Availability',
    tr: 'Müsaitlik' },
  'availability.category': {
    de: 'Zimmergruppe',
    en: 'Room category',
    tr: 'Oda tipi' },
  'availability.free': {
    de: 'frei',
    en: 'free',
    tr: 'boş' },

  'checkin.title': {
    de: 'Check-in',
    en: 'Check-in',
    tr: 'Check-in' },
  'checkin.needsRoom': {
    de: 'Ohne zugewiesenes Zimmer ist kein Check-in möglich. '
      + 'Zuerst ein Zimmer zuweisen.',
    en: 'Check-in needs an assigned room. Assign one first.',
    tr: 'Atanmış bir oda olmadan check-in yapılamaz. Önce bir oda atayın.' },
  'checkin.alreadyRegistered': {
    de: 'Für diese Reservierung liegt bereits ein Meldeschein vor.',
    en: 'This reservation already has a registration form.',
    tr: 'Bu rezervasyon için zaten bir Meldeschein var.' },
  'checkin.signatureRequired': {
    de: 'Ausländischer Gast: Unterschrift erforderlich.',
    en: 'Foreign guest: signature required.',
    tr: 'Yabancı misafir: imza zorunlu.' },
  'checkin.noSignatureNeeded': {
    de: 'Inländischer Gast: seit dem 1.1.2025 keine Unterschrift nötig.',
    en: 'Domestic guest: no signature needed since 1 Jan 2025.',
    tr: 'Yurt içinde ikamet eden misafir: 1.1.2025 tarihinden beri imza gerekmiyor.' },
  'checkin.whoStaysHere': {
    de: 'Wer wohnt in diesem Zimmer? Bei einer Gruppe steht hier bis zur Anreise '
      + 'der Name des Buchers; jetzt bekommt das Zimmer seinen eigenen.',
    en: 'Who is staying in this room? For a group the booker\u2019s name stands '
      + 'here until arrival; now the room gets its own.',
    tr: 'Bu odada kim kalıyor? Bir grupta varışa kadar burada rezervasyonu yapanın '
      + 'adı yazar; şimdi oda kendi adını alır.' },
  'checkin.occupants': {
    de: 'Mitreisende',
    en: 'Further occupants',
    tr: 'Birlikte kalanlar' },
  'checkin.occupantsHint': {
    de: 'Die Meldepflicht gilt je Person. Bei einer Reisegruppe entsteht daraus '
      + 'ein Sammelmeldeschein: jeder bekommt einen eigenen Datensatz, '
      + 'unterschrieben wird einmal.',
    en: 'The duty to register applies per person. For a travel group this becomes '
      + 'a collective registration: everyone gets their own record, signed once.',
    tr: 'Bildirim yükümlülüğü kişi başınadır. Bir tur grubunda bundan toplu '
      + 'Meldeschein oluşur: herkesin kendi kaydı olur, bir kez imzalanır.' },
  'checkin.clear': {
    de: 'Löschen',
    en: 'Clear',
    tr: 'Temizle' },
  'checkin.register': {
    de: 'Meldeschein speichern',
    en: 'Save registration form',
    tr: 'Meldeschein kaydet' },
  'checkin.submit': {
    de: 'Meldeschein erfassen und einchecken',
    en: 'Register and check in',
    tr: 'Meldeschein doldur ve check-in yap' },
} as const satisfies Record<string, LocalizedText>
