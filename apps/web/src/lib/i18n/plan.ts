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

  /*
   * „Reservierung", nicht „Buchung". Das Datenmodell trennt beides: eine
   * `booking` haelt mehrere `reservation`, und dieser Dialog legt einen
   * Aufenthalt in einem Zimmer an. Die Rezeption traegt eine Buchung ein,
   * sie erstellt keine -- gebucht hat der Gast.
   */
  'booking.title': {
    de: 'Neue Reservierung',
    en: 'New reservation',
    tr: 'Yeni rezervasyon' },
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
  'booking.guestRequired': {
    de: 'Ohne Gast lässt sich die Reservierung nicht anlegen. Ein Nachname '
      + 'genügt.',
    en: 'The reservation cannot be created without a guest. A surname is enough.',
    tr: 'Misafir olmadan rezervasyon oluşturulamaz. Bir soyadı yeterlidir.' },
  'tape.noGuest': {
    de: 'ohne Gast',
    en: 'no guest',
    tr: 'misafir yok' },
  'booking.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'booking.status': {
    de: 'Art',
    en: 'Kind',
    tr: 'Tür' },
  'booking.statusConfirmed': {
    de: 'verbindlich',
    en: 'confirmed',
    tr: 'kesin' },
  'booking.statusOptional': {
    de: 'unverbindlich',
    en: 'provisional',
    tr: 'opsiyonlu' },
  'booking.optionUntil': {
    de: 'Option gilt bis',
    en: 'Option held until',
    tr: 'Opsiyon geçerlilik tarihi' },
  'booking.optionHint': {
    de: 'Danach verfällt sie im Nachtlauf und das Zimmer wird wieder frei. '
      + 'Ohne Frist bliebe es dauerhaft besetzt.',
    en: 'After that it lapses in the night audit and the room becomes free '
      + 'again. Without an expiry it would stay blocked indefinitely.',
    tr: 'Sonrasında gece işleminde düşer ve oda yeniden boşalır. Son tarih '
      + 'olmadan oda süresiz dolu kalır.' },
  'booking.price': {
    de: 'Preis je Nacht',
    en: 'Price per night',
    tr: 'Gecelik fiyat' },
  'booking.priceHint': {
    de: 'Leer lassen heißt: der Preis aus dem Ratenplan gilt.',
    en: 'Leave empty to use the price from the rate plan.',
    tr: 'Boş bırakırsanız fiyat planındaki fiyat geçerli olur.' },
  'booking.guests': {
    de: 'Personen',
    en: 'Guests',
    tr: 'Kişi' },
  'booking.guestsHint': {
    de: 'Leer lassen heißt: so viele, wie die Zimmergruppe hergibt.',
    en: 'Leave empty for as many as the room category allows.',
    tr: 'Boş bırakırsanız oda tipinin izin verdiği kadar olur.' },
  'booking.overCapacity': {
    de: 'Die Zimmergruppe ist für {max} Personen. Sie tragen {n} ein. Sicher?',
    en: 'The room category holds {max} guests. You entered {n}. Are you sure?',
    tr: 'Oda tipi {max} kişiliktir. {n} girdiniz. Emin misiniz?' },
  'booking.shortNote': {
    de: 'Kurznotiz',
    en: 'Short note',
    tr: 'Kısa not' },
  'booking.shortNotePlaceholder': {
    de: 'Balkon, 1. Stock, Spätanreise',
    en: 'Balcony, 1st floor, late arrival',
    tr: 'Balkon, 1. kat, geç giriş' },
  'booking.shortNoteHint': {
    de: 'Steht im Plan auf dem Balken. Für den Vorgang das Feld darunter.',
    en: 'Shown on the bar in the plan. Use the field below for the details.',
    tr: 'Planda çubuğun üzerinde görünür. Ayrıntılar için aşağıdaki alanı kullanın.' },
  'booking.notes': {
    de: 'Notiz',
    en: 'Note',
    tr: 'Not' },
  'booking.submit': {
    de: 'Reservierung anlegen',
    en: 'Create reservation',
    tr: 'Rezervasyon oluştur' },
  'booking.close': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'Vazgeç' },
  'booking.created': {
    de: 'Reservierung angelegt',
    en: 'Reservation created',
    tr: 'Rezervasyon oluşturuldu' },
  'booking.needsGuest': {
    de: 'Ohne Gast lässt sich nicht buchen. Suchen oder neu anlegen.',
    en: 'Booking needs a guest. Search or create one.',
    tr: 'Misafir olmadan rezervasyon yapılamaz. Arayın veya yeni kayıt oluşturun.' },

  'plan.monthBack': {
    de: 'Einen Monat zurück',
    en: 'One month back',
    tr: 'Bir ay geri' },
  'plan.monthForward': {
    de: 'Einen Monat vor',
    en: 'One month forward',
    tr: 'Bir ay ileri' },
  'plan.yearBack': {
    de: 'Ein Jahr zurück',
    en: 'One year back',
    tr: 'Bir yıl geri' },
  'plan.yearForward': {
    de: 'Ein Jahr vor',
    en: 'One year forward',
    tr: 'Bir yıl ileri' },
  'plan.groupByCategory': {
    de: 'nach Zimmergruppe',
    en: 'by room category',
    tr: 'oda tipine göre' },

  'plan.bandScroll': {
    de: 'Liste scrollt',
    en: 'list scrolls',
    tr: 'liste kayar' },
  /*
   * "Bis zu" ist hier keine Unschaerfe, sondern das Genaue: bekannt ist der
   * Bucher, zugesagt sind die Plaetze der gebuchten Zimmergruppe. Eine feste
   * Personenzahl stuende im Band bei jeder Buchung aus dem Channel auf 1.
   */
  'plan.capacityUpTo': {
    de: 'Platz für bis zu {n} Personen',
    en: 'space for up to {n} people',
    tr: 'en fazla {n} kişilik' },
  'plan.tooSmall': {
    de: 'Zu klein für diese Buchung',
    en: 'Too small for this booking',
    tr: 'Bu rezervasyon için çok küçük' },
  'plan.moveOtherCategory': {
    de: 'Andere Zimmergruppe',
    en: 'Different room category',
    tr: 'Farklı oda kategorisi' },
  'plan.moveUpgrade': {
    de: '{ref} ist als {von} gebucht. {raum} gehört zu {nach} — das ist ein '
      + 'Wechsel der Zimmergruppe. Abgerechnet wird weiterhin, was gebucht '
      + 'wurde.',
    en: '{ref} is booked as {von}. Room {raum} belongs to {nach} — that is a '
      + 'change of room category. Billing still follows what was booked.',
    tr: '{ref}, {von} olarak rezerve edildi. {raum} odası {nach} kategorisine '
      + 'ait — bu bir kategori değişikliğidir. Faturalandırma rezerve edilene '
      + 'göre kalır.' },
  'plan.moveTooSmall': {
    de: 'Achtung: {raum} bietet Platz für {platz}, gebucht sind {bedarf} '
      + 'Plätze. Die Buchung passt dort nicht vollständig hinein.',
    en: 'Careful: room {raum} has space for {platz}, but {bedarf} places were '
      + 'booked. The booking does not fit in there completely.',
    tr: 'Dikkat: {raum} odası {platz} kişiliktir, ancak {bedarf} kişilik '
      + 'rezervasyon yapılmıştır. Rezervasyon oraya tam sığmaz.' },
  'plan.moveConfirm': {
    de: 'Trotzdem verschieben',
    en: 'Move anyway',
    tr: 'Yine de taşı' },
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
  'guestPicker.createNamed': {
    de: '„{name}" als neuen Gast anlegen',
    en: 'Create “{name}” as a new guest',
    tr: '„{name}" adını yeni misafir olarak oluştur' },
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
  'terms.title': {
    de: 'Hausbedingungen',
    en: 'House terms',
    tr: 'Konaklama koşulları' },
  'terms.sign': {
    de: 'Unterschreiben',
    en: 'Sign',
    tr: 'İmzala' },
  'terms.accept': {
    de: 'Zur Kenntnis genommen',
    en: 'Acknowledged',
    tr: 'Okudum, kabul ediyorum' },
  'terms.signed': {
    de: 'Unterschrieben',
    en: 'Signed',
    tr: 'İmzalandı' },
  'terms.accepted': {
    de: 'Zugestimmt',
    en: 'Agreed',
    tr: 'Kabul edildi' },
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
