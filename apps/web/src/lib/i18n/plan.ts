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
  /*
   * Die Ueberschriften der Abschnitte. Sie tragen die breite Maske: zwei
   * Spalten ohne Ueberschrift sind zwei Reihen Felder, die zufaellig
   * nebeneinander liegen.
   */
  'booking.sectionStay': {
    de: 'Aufenthalt',
    en: 'Stay',
    tr: 'Konaklama' },
  'booking.sectionGuest': {
    de: 'Gast und Notizen',
    en: 'Guest and notes',
    tr: 'Misafir ve notlar' },
  'booking.sectionPrice': {
    de: 'Preis und Belegung',
    en: 'Price and occupancy',
    tr: 'Fiyat ve doluluk' },
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
  'booking.pricePerNight': {
    de: 'Preis je Nacht',
    en: 'Price per night',
    tr: 'Gecelik fiyat' },
  'booking.priceTotal': {
    de: 'Gesamtpreis',
    en: 'Total price',
    tr: 'Toplam fiyat' },
  'booking.remainder': {
    de: '+{n} ct auf der 1. Nacht',
    en: '+{n} ct on the 1st night',
    tr: '1. geceye +{n} kuruş' },
  'booking.remainderHint': {
    de: 'Der Gesamtpreis geht nicht glatt durch die Nächte. Der Rest liegt '
      + 'auf der ersten Nacht, damit die Summe genau stimmt.',
    en: 'The total does not divide evenly across the nights. The remainder '
      + 'sits on the first night so the sum matches exactly.',
    tr: 'Toplam fiyat gecelere tam bölünmüyor. Kalan, toplam tam tutsun diye '
      + 'ilk geceye yazılır.' },
  /*
   * Warum ein Knopf gesperrt ist.
   *
   * Ein gesperrter Knopf ohne Grund ist ein Knopf, der nicht funktioniert:
   * geklickt, nichts passiert, und nichts auf dem Bildschirm sagt, was
   * fehlt. Die Saetze sind deshalb keine Vorwuerfe, sondern Wegweiser --
   * sie nennen das Feld, nicht den Fehler.
   */
  'booking.needNights': {
    de: 'Die Abreise muss nach der Anreise liegen',
    en: 'The departure has to be after the arrival',
    tr: 'Çıkış tarihi giriş tarihinden sonra olmalı' },
  'booking.needGuest': {
    de: 'Es fehlt noch der Gast',
    en: 'The guest is still missing',
    tr: 'Misafir hâlâ eksik' },
  'booking.needOptionUntil': {
    de: 'Eine Option braucht eine Frist',
    en: 'An option needs an expiry',
    tr: 'Opsiyon için bir son tarih gerekli' },
  'group.needRooms': {
    de: 'Es ist kein Zimmer mehr in der Gruppe',
    en: 'No room is left in the group',
    tr: 'Grupta hiç oda kalmadı' },
  'group.needRoomNights': {
    de: 'Ein Zimmer hat keine Nacht: Abreise nach Anreise',
    en: 'One room has no night: departure must follow arrival',
    tr: 'Bir odanın gecesi yok: çıkış girişten sonra olmalı' },
  'sperre.needReason': {
    de: 'Es fehlt noch der Grund',
    en: 'The reason is still missing',
    tr: 'Sebep hâlâ eksik' },
  'booking.priceHint': {
    de: 'Leer lassen heißt: der Preis aus dem Ratenplan gilt.',
    en: 'Leave empty to use the price from the rate plan.',
    tr: 'Boş bırakırsanız fiyat planındaki fiyat geçerli olur.' },
  'booking.adults': {
    de: 'Erwachsene',
    en: 'Adults',
    tr: 'Yetişkin' },
  'booking.children': {
    de: 'Kinder',
    en: 'Children',
    tr: 'Çocuk' },
  'booking.guestsHint': {
    de: 'Erwachsene leer lassen heißt: so viele, wie die Zimmergruppe hergibt.',
    en: 'Leave adults empty for as many as the room category allows.',
    tr: 'Yetişkin alanını boş bırakırsanız oda tipinin izin verdiği kadar olur.' },
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
  'plan.dayBack': {
    de: 'Einen Tag zurück',
    en: 'One day back',
    tr: 'Bir gün geri' },
  'plan.dayForward': {
    de: 'Einen Tag vor',
    en: 'One day forward',
    tr: 'Bir gün ileri' },
  'plan.weekBack': {
    de: 'Eine Woche zurück',
    en: 'One week back',
    tr: 'Bir hafta geri' },
  'plan.weekForward': {
    de: 'Eine Woche vor',
    en: 'One week forward',
    tr: 'Bir hafta ileri' },
  'plan.scrollTime': {
    de: 'Durch die Zeit scrollen',
    en: 'Scroll through time',
    tr: 'Zaman içinde kaydır' },
  'plan.yearBack': {
    de: 'Ein Jahr zurück',
    en: 'One year back',
    tr: 'Bir yıl geri' },
  'plan.yearForward': {
    de: 'Ein Jahr vor',
    en: 'One year forward',
    tr: 'Bir yıl ileri' },
  'plan.legend': {
    de: 'Legende',
    en: 'Legend',
    tr: 'Açıklama' },
  'plan.rowHeight': {
    de: 'Zeilenhöhe',
    en: 'Row height',
    tr: 'Satır yüksekliği' },
  'plan.rowHeightHint': {
    de: 'Kleiner stellen, damit alle Zimmer auf den Bildschirm passen. Doppelklick: Standard.',
    en: 'Make smaller to fit all rooms on screen. Double-click: default.',
    tr: 'Tüm odaların ekrana sığması için küçültün. Çift tıklama: varsayılan.' },
  'plan.groupByCategory': {
    de: 'nach Zimmergruppe',
    en: 'by room category',
    tr: 'oda tipine göre' },

  'plan.selectedRooms': {
    de: '{n} Zimmer ausgewählt',
    en: '{n} rooms selected',
    tr: '{n} oda seçildi' },
  /* Eigener Schluessel statt "{n}" mit einer 1 darin: "1 rooms selected"
     steht sonst in der Leiste, sobald jemand ein einzelnes Zimmer
     markiert -- und das ist jetzt der haeufigste Fall. */
  'plan.selectedRoom': {
    de: 'Ein Zimmer ausgewählt',
    en: 'One room selected',
    tr: 'Bir oda seçildi' },
  'plan.mixedDates': {
    de: 'verschiedene Tage',
    en: 'dates differ',
    tr: 'tarihler farklı' },
  'plan.bookSelection': {
    de: 'Als Gruppe buchen',
    en: 'Book as a group',
    tr: 'Grup olarak rezerve et' },
  'plan.clearSelection': {
    de: 'Auswahl aufheben (Esc)',
    en: 'Clear selection (Esc)',
    tr: 'Seçimi temizle (Esc)' },

  'plan.bandHidden': {
    de: '{n} weitere verdeckt · nächste Anreise {datum}',
    en: '{n} more hidden · next arrival {datum}',
    tr: '{n} tanesi daha gizli · sonraki giriş {datum}' },
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
  /*
   * Das Verlegen (A3/A4) bekommt eigene Schluessel und nicht `plan.move*`:
   * dort steht die Warnung vor der Zimmergruppe, hier die Maske drumherum.
   * Ein Vorsatz fuer beides liesse beim naechsten Schluessel niemanden
   * mehr erkennen, wohin er gehoert.
   */
  'verlegen.title': {
    de: 'Buchung bearbeiten',
    en: 'Edit the booking',
    tr: 'Rezervasyonu düzenle' },
  'verlegen.before': {
    de: 'Bisher: {raum}, {von} bis {bis}',
    en: 'Currently: {raum}, {von} to {bis}',
    tr: 'Şu an: {raum}, {von} – {bis}' },
  'verlegen.state': {
    de: '{raum}, {von} bis {bis}',
    en: '{raum}, {von} to {bis}',
    tr: '{raum}, {von} – {bis}' },
  'verlegen.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'verlegen.noRoom': {
    de: 'ohne Zimmer',
    en: 'no room',
    tr: 'odasız' },
  'verlegen.unassignHint': {
    de: 'Das Zimmer wird abgenommen. Die Buchung steht danach im Band über dem '
      + 'Plan und behält ihre Tage.',
    en: 'The room is taken away. The booking then sits in the band above the '
      + 'plan and keeps its dates.',
    tr: 'Oda geri alınır. Rezervasyon planın üstündeki şeritte kalır ve '
      + 'tarihlerini korur.' },
  'verlegen.nothingChanged': {
    de: 'Nichts geändert',
    en: 'Nothing changed',
    tr: 'Değişiklik yok' },
  'verlegen.inHouseKeepsRoom': {
    de: 'Ein angereister Gast behält sein Zimmer',
    en: 'A guest who has checked in keeps their room',
    tr: 'Giriş yapmış misafir odasını korur' },
  'verlegen.groupShift': {
    de: 'Die ganze Buchung {ref} wandert um {tage} Tage — alle {n} Zimmer.',
    en: 'The whole booking {ref} moves by {tage} days — all {n} rooms.',
    tr: '{ref} rezervasyonunun tamamı {tage} gün kayar — {n} odanın hepsi.' },
  'verlegen.planningMode': {
    de: 'Planungsmodus',
    en: 'Planning mode',
    tr: 'Planlama modu' },
  'verlegen.planningModeHint': {
    de: 'Verschiebungen werden sofort gespeichert, ohne Nachfrage. Strg+Z nimmt '
      + 'die letzte zurück.',
    en: 'Moves are saved immediately, without asking. Ctrl+Z takes the last one '
      + 'back.',
    tr: 'Taşımalar sorulmadan hemen kaydedilir. Son işlemi Ctrl+Z geri alır.' },
  'verlegen.planningModeOn': {
    de: 'Planungsmodus: Verschiebungen werden sofort gespeichert',
    en: 'Planning mode: moves are saved immediately',
    tr: 'Planlama modu: taşımalar hemen kaydedilir' },
  'verlegen.undoTitle': {
    de: 'Änderung zurücknehmen',
    en: 'Take the change back',
    tr: 'Değişikliği geri al' },
  'verlegen.undoQuestion': {
    de: 'Buchung {gast} zurücksetzen von {von} zu {zu}?',
    en: 'Reset booking {gast} from {von} to {zu}?',
    tr: '{gast} rezervasyonu {von} durumundan {zu} durumuna alınsın mı?' },
  'verlegen.undoGroup': {
    de: 'Buchung {ref} wieder um {tage} Tage zurückschieben — alle {n} Zimmer?',
    en: 'Move booking {ref} back by {tage} days — all {n} rooms?',
    tr: '{ref} rezervasyonu {tage} gün geri alınsın mı — {n} odanın hepsi?' },
  'verlegen.undoConfirm': {
    de: 'Zurücksetzen',
    en: 'Reset',
    tr: 'Geri al' },
  'verlegen.undoHint': {
    de: 'Zurückgenommen wird nur diese eine Änderung. Ist das Zimmer inzwischen '
      + 'belegt, schlägt sie fehl und bleibt, wie sie ist.',
    en: 'Only this one change is taken back. If the room is occupied by now, it '
      + 'fails and stays as it is.',
    tr: 'Yalnızca bu değişiklik geri alınır. Oda bu arada doluysa işlem başarısız '
      + 'olur ve her şey olduğu gibi kalır.' },
  'verlegen.nothingToUndo': {
    de: 'Nichts zurückzunehmen',
    en: 'Nothing to take back',
    tr: 'Geri alınacak bir şey yok' },

  'plan.dragHint': {
    de: 'Balken ziehen verschiebt die Reservierung, die Ränder verlängern sie. Auf '
      + 'freier Fläche aufziehen legt eine Buchung an — mit gedrückter Strg-, ⌘- '
      + 'oder Umschalttaste über mehrere Zimmer hinweg eine Gruppenbuchung.',
    en: 'Drag a bar to move the reservation, drag its edges to extend it. Drag '
      + 'across free space to create a booking — hold Ctrl, ⌘ or Shift and drag '
      + 'across several rooms for a group booking.',
    tr: 'Çubuğu sürüklemek rezervasyonu taşır, kenarları uzatır. Boş alanda sürükleyerek açmak yeni bir rezervasyon oluşturur — Strg, ⌘ veya Shift tuşu basılıyken birden çok oda üzerinde grup rezervasyonu.' },
  'plan.dropToUnassign': {
    de: 'Hier ablegen nimmt das Zimmer ab',
    en: 'Drop here to take the room away',
    tr: 'Buraya bırakmak odayı geri alır' },
  'plan.dragHintGroup': {
    de: 'Einen Balken festzuhalten hebt alle Zimmer derselben Buchung hervor. Mit '
      + 'gedrückter Alt-Taste wandert beim seitlichen Ziehen die ganze Gruppe statt '
      + 'nur dieses Zimmers. Ins gelbe Band gezogen nimmt das Zimmer wieder ab — der '
      + 'Zwischenablageplatz zum Umsortieren.',
    en: 'Holding a bar highlights every room of the same booking. Hold Alt while '
      + 'dragging sideways to move the whole group instead of just this room. Drag '
      + 'into the amber band to take the room away — the place to park a booking '
      + 'while rearranging.',
    tr: 'Bir çubuğu basılı tutmak aynı rezervasyonun tüm odalarını vurgular. Yana '
      + 'sürüklerken Alt tuşunu basılı tutmak yalnızca bu odayı değil tüm grubu taşır. '
      + 'Sarı şeride sürüklemek odayı geri alır — yeniden düzenlerken ara park yeri.' },

  'group.title': {
    de: 'Gruppenbuchung',
    en: 'Group booking',
    tr: 'Grup rezervasyonu' },
  'tape.nightsShort': {
    de: '{n} N.',
    en: '{n} n.',
    tr: '{n} g.' },
  'group.rooms': {
    de: 'Zimmer',
    en: 'rooms',
    tr: 'Oda' },
  'group.selection': {
    de: 'Ausgewählte Zimmer',
    en: 'Selected rooms',
    tr: 'Seçilen odalar' },
  'group.sectionPeriod': {
    de: 'Zeitraum der Gruppe',
    en: 'Dates for the group',
    tr: 'Grubun tarihleri' },
  'group.sectionPrice': {
    de: 'Preis',
    en: 'Price',
    tr: 'Fiyat' },
  'group.sectionGuest': {
    de: 'Besteller und Notiz',
    en: 'Booker and note',
    tr: 'Sipariş veren ve not' },
  'group.nightsHead': {
    de: 'Nächte',
    en: 'Nights',
    tr: 'Gece' },
  'group.periodHint': {
    de: 'Gilt für jedes Zimmer, das in der Tabelle nichts Eigenes stehen hat.',
    en: 'Applies to every room that has no dates of its own in the table.',
    tr: 'Tabloda kendi tarihi olmayan her oda için geçerlidir.' },
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
  /*
   * Zimmersperre. Der Vorsatz heisst `sperre.` und nicht `block.`, weil
   * `block.` schon den Kontingenten gehoert (`i18n/gruppen.ts`) -- und das
   * ist etwas voellig anderes: ein Kontingent haelt Zimmer fuer eine
   * Gruppe frei, eine Sperre nimmt eines aus dem Verkauf. Zwei Begriffe
   * unter einem Vorsatz laufen beim naechsten Schluessel ineinander.
   */
  'kontext.open': {
    de: 'Reservierung öffnen',
    en: 'Open the reservation',
    tr: 'Rezervasyonu aç' },
  'kontext.checkIn': {
    de: 'Check-in …',
    en: 'Check in …',
    tr: 'Giriş yap …' },
  'kontext.checkOut': {
    de: 'Check-out',
    en: 'Check out',
    tr: 'Çıkış yap' },
  'kontext.checkOutConfirm': {
    de: 'Gast jetzt auschecken? Reist er vor dem gebuchten Tag ab, endet der Aufenthalt heute.',
    en: 'Check the guest out now? If they leave before the booked day, the stay ends today.',
    tr: 'Misafir şimdi çıkış yapsın mı? Rezerve edilen günden önce ayrılırsa konaklama bugün sona erer.' },
  'kontext.group': {
    de: 'Gruppe öffnen ({n} Zimmer)',
    en: 'Open the group ({n} rooms)',
    tr: 'Grubu aç ({n} oda)' },
  'kontext.unassign': {
    de: 'Zimmer abnehmen',
    en: 'Take the room away',
    tr: 'Odayı geri al' },
  'kontext.cancel': {
    de: 'Stornieren',
    en: 'Cancel',
    tr: 'İptal et' },
  'kontext.cancelConfirm': {
    de: 'Diese Reservierung stornieren?',
    en: 'Cancel this reservation?',
    tr: 'Bu rezervasyon iptal edilsin mi?' },
  'kontext.newReservation': {
    de: 'Reservierung hier anlegen',
    en: 'Create a reservation here',
    tr: 'Burada rezervasyon oluştur' },
  'kontext.blockRoom': {
    de: 'Zimmer sperren …',
    en: 'Block the room …',
    tr: 'Odayı kapat …' },
  /*
   * Zwei eigene Schluessel statt eines mit Zahl: "Reservierung hier
   * anlegen" ist der haeufige Fall und soll nicht fuer immer ein "(1
   * Zimmer)" hinter sich herziehen. Die Zahl steht nur da, wo sie eine
   * Frage beantwortet -- naemlich welche Zimmer gemeint sind, wenn mehrere
   * markiert sind.
   */
  'kontext.newReservationN': {
    de: 'Reservierung für {n} Zimmer anlegen',
    en: 'Create a reservation for {n} rooms',
    tr: '{n} oda için rezervasyon oluştur' },
  'kontext.blockRoomN': {
    de: '{n} Zimmer sperren …',
    en: 'Block {n} rooms …',
    tr: '{n} odayı kapat …' },

  'sperre.title': {
    de: 'Zimmer sperren',
    en: 'Block a room',
    tr: 'Odayı kapat' },
  /* Im Deutschen dasselbe Wort, im Englischen nicht: "Block a room" ueber
     einer Liste von drei Zimmern liest sich wie ein Fehler. */
  'sperre.titleMany': {
    de: 'Zimmer sperren',
    en: 'Block rooms',
    tr: 'Odaları kapat' },
  'sperre.kind': {
    de: 'Art der Sperrung',
    en: 'Kind of block',
    tr: 'Kapatma türü' },
  'sperre.outOfOrder': {
    de: 'Out of Order — nicht verkäuflich',
    en: 'Out of order — not sellable',
    tr: 'Out of Order — satılamaz' },
  'sperre.outOfOrderHint': {
    de: 'Das Zimmer fällt aus der Kapazität. Für Schäden, die eine Übernachtung '
      + 'unmöglich machen.',
    en: 'The room leaves the capacity. For damage that makes a stay impossible.',
    tr: 'Oda kapasiteden düşer. Konaklamayı imkânsız kılan hasarlar için.' },
  'sperre.outOfService': {
    de: 'Out of Service — verkäuflich',
    en: 'Out of service — still sellable',
    tr: 'Out of Service — satılabilir' },
  'sperre.outOfServiceHint': {
    de: 'Das Zimmer bleibt in der Kapazität und ist im Plan als eingeschränkt '
      + 'markiert. Für alles, womit ein Gast übernachten kann.',
    en: 'The room stays in the capacity and is marked as restricted in the plan. '
      + 'For anything a guest can still sleep with.',
    tr: 'Oda kapasitede kalır ve planda kısıtlı olarak işaretlenir. Misafirin yine '
      + 'de kalabileceği her şey için.' },
  'sperre.reason': {
    de: 'Grund',
    en: 'Reason',
    tr: 'Sebep' },
  'sperre.reasonPlaceholder': {
    de: 'z. B. Dusche undicht',
    en: 'e.g. shower leaking',
    tr: 'ör. duş sızdırıyor' },
  'sperre.reasonHint': {
    de: 'Steht am Riegel im Plan und ist der Titel der Wartungsmeldung, die dabei '
      + 'entsteht.',
    en: 'Shown on the bar in the plan, and the title of the maintenance ticket '
      + 'this creates.',
    tr: 'Planda çubukta görünür ve oluşan bakım kaydının başlığıdır.' },
  'sperre.submit': {
    de: 'Sperren',
    en: 'Block',
    tr: 'Kapat' },
  'sperre.created': {
    de: 'Zimmer gesperrt, Wartungsmeldung angelegt.',
    en: 'Room blocked, maintenance ticket created.',
    tr: 'Oda kapatıldı, bakım kaydı oluşturuldu.' },
  'sperre.createdMany': {
    de: '{n} Zimmer gesperrt, je eine Wartungsmeldung angelegt.',
    en: '{n} rooms blocked, one maintenance ticket each.',
    tr: '{n} oda kapatıldı, her biri için bir bakım kaydı oluşturuldu.' },
  'sperre.roomCount': {
    de: '{n} Zimmer',
    en: '{n} rooms',
    tr: '{n} oda' },
  /* Warum je Zimmer eine Meldung: sie wird einzeln erledigt. "Dusche in 204
     repariert" schliesst 205 nicht mit. */
  'sperre.manyHint': {
    de: 'Zeitraum, Art und Grund gelten für alle {n} Zimmer. Jedes bekommt eine '
      + 'eigene Wartungsmeldung, weil jede einzeln erledigt wird.',
    en: 'Period, kind and reason apply to all {n} rooms. Each one gets its own '
      + 'maintenance ticket, because each is closed on its own.',
    tr: 'Tarih aralığı, tür ve sebep {n} odanın tümü için geçerlidir. Her biri ayrı '
      + 'kapatıldığı için kendi bakım kaydını alır.' },

  'group.panelTitle': {
    de: 'Gruppenbuchung',
    en: 'Group booking',
    tr: 'Grup rezervasyonu' },
  'group.total': {
    de: 'Gesamt',
    en: 'Total',
    tr: 'Toplam' },
  'group.unassigned': {
    de: 'ohne Zimmer',
    en: 'no room',
    tr: 'odasız' },
  'group.shift': {
    de: 'Ganze Gruppe verschieben:',
    en: 'Move the whole group:',
    tr: 'Tüm grubu taşı:' },
  'group.shiftHint': {
    de: 'Tage. Abweichende Aufenthalte bleiben abweichend.',
    en: 'days. Stays that differ stay different.',
    tr: 'gün. Farklı olan konaklamalar farklı kalır.' },
  'group.changeDates': {
    de: 'Tage ändern',
    en: 'Change dates',
    tr: 'Tarihleri değiştir' },
  'group.removeConfirm': {
    de: 'Dieses Zimmer aus der Gruppe nehmen? Die Reservierung wird storniert.',
    en: 'Remove this room from the group? The reservation will be canceled.',
    tr: 'Bu oda gruptan çıkarılsın mı? Rezervasyon iptal edilir.' },
  'group.addRoom': {
    de: 'Zimmer hinzufügen',
    en: 'Add a room',
    tr: 'Oda ekle' },
  'group.pickCategory': {
    de: 'Zimmergruppe wählen',
    en: 'Pick a room category',
    tr: 'Oda tipi seç' },
  'group.add': {
    de: 'Hinzufügen',
    en: 'Add',
    tr: 'Ekle' },
  'group.addHint': {
    de: 'Zeitraum wie die Gruppe. Das Zimmer wird im Plan zugewiesen.',
    en: 'Same dates as the group. Assign the room in the plan.',
    tr: 'Grupla aynı tarihler. Oda plandan atanır.' },
  'group.ownDates': {
    de: 'eigene Tage',
    en: 'own dates',
    tr: 'kendi tarihleri' },
  'group.sameDates': {
    de: 'Tage der Gruppe',
    en: "the group's dates",
    tr: 'grubun tarihleri' },
  'group.nights': {
    de: '{n} Nächte',
    en: '{n} nights',
    tr: '{n} gece' },
  'group.priceSplitHint': {
    de: 'Wird nach Personenzahl je Zimmergruppe auf die Zimmer aufgeteilt. '
      + 'Der Rest-Cent liegt auf dem ersten Zimmer, damit die Summe genau '
      + 'dem eingegebenen Betrag entspricht.',
    en: 'Split across the rooms by the occupancy of each room category. The '
      + 'remaining cent goes to the first room so the sum matches the amount '
      + 'entered exactly.',
    tr: 'Oda tipinin kişi sayısına göre odalara bölünür. Toplam girilen tutara '
      + 'tam eşit olsun diye kalan kuruş ilk odaya yazılır.' },
  'group.pricePerRoomHint': {
    de: 'Leer lassen heißt: der Preis aus dem Ratenplan gilt.',
    en: 'Leave empty to use the price from the rate plan.',
    tr: 'Boş bırakırsanız fiyat planındaki fiyat geçerli olur.' },
  'group.priceFromRooms': {
    de: 'Summe der Zimmerpreise. Wird hier ein Betrag eingetragen, gilt wieder '
      + 'er und wird neu aufgeteilt.',
    en: 'The sum of the room prices. Enter an amount here and that amount '
      + 'applies again and is split anew.',
    tr: 'Oda fiyatlarının toplamı. Buraya bir tutar girilirse yine o geçerli olur '
      + 've yeniden bölünür.' },
  'group.needAllRoomPrices': {
    de: 'Es fehlen Zimmerpreise. Entweder alle Zimmer oder keines.',
    en: 'Room prices are missing. Either every room or none.',
    tr: 'Oda fiyatları eksik. Ya tüm odalar ya da hiçbiri.' },
  /*
   * Die Preisspalten der Tabelle. Sie stehen immer da -- auch wenn der
   * Preis fuer die ganze Gruppe gilt; dann zeigen sie die Aufteilung.
   */
  'group.priceNight': {
    de: 'Preis/Nacht',
    en: 'Price/night',
    tr: 'Fiyat/gece' },
  'group.priceRoomNightHint': {
    de: '„Preis je Nacht" gilt je Zimmer und Nacht. {n} Zimmernächte ergeben '
      + 'den Gesamtpreis.',
    en: '"Price per night" applies per room and night. {n} room nights make up '
      + 'the total.',
    tr: '„Gecelik fiyat" oda ve gece başınadır. {n} oda gecesi toplamı verir.' },
  'group.priceSum': {
    de: 'Summe',
    en: 'Sum',
    tr: 'Toplam' },
  'group.pricePreviewHint': {
    de: 'Die Aufteilung ist eine Vorschau — nach Plätzen der Zimmergruppe, der '
      + 'Rest-Cent auf dem ersten Zimmer. Gebucht wird der Gruppenpreis; geteilt '
      + 'wird beim Anlegen.',
    en: 'The split is a preview — by the occupancy of each room category, the '
      + 'remaining cent on the first room. What is booked is the group price; it '
      + 'is split when the booking is created.',
    tr: 'Dağılım bir önizlemedir — oda tipinin kişi sayısına göre, kalan kuruş ilk '
      + 'odaya. Rezerve edilen grup fiyatıdır; bölme kayıt sırasında yapılır.' },
  /*
   * Die Zahl steht **hinter** dem Wort, nicht davor: "{n} Zimmer" wird im
   * Englischen bei eins zu "1 rooms", und eine Mehrzahlbehandlung gibt es
   * im Katalog nicht. Ein Satz, der fuer jede Zahl stimmt, ist billiger
   * als die Maschinerie dafuer.
   */
  'group.priceFromRatePlan': {
    de: 'Zimmer ohne Preis: {n}. Entweder alle oder keines — sonst gilt für '
      + 'diese still der Ratenplan.',
    en: 'Rooms without a price: {n}. Either all of them or none — otherwise '
      + 'the rate plan quietly applies to those.',
    tr: 'Fiyatsız oda: {n}. Ya hepsi ya hiçbiri — yoksa bunlara sessizce fiyat '
      + 'planı uygulanır.' },
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
  'warnings.nextArrival': {
    de: 'nächste Anreise',
    en: 'next arrival',
    tr: 'sonraki giriş' },
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

  /*
   * Der Aenderungsverlauf.
   *
   * Die Feldnamen sind die Spalten der Datenbank, und sie heissen hier, wie
   * sie auf dem Bildschirm heissen -- nicht wie in der Tabelle. "Zimmer" und
   * nicht "resource_id": wer den Verlauf liest, sucht die Buchung, nicht das
   * Schema.
   */
  'verlauf.title': {
    de: 'Verlauf',
    en: 'History',
    tr: 'Geçmiş' },
  'verlauf.hausTitle': {
    de: 'Zuletzt geändert',
    en: 'Changed recently',
    tr: 'Son değişiklikler' },
  'verlauf.leer': {
    de: 'Noch keine Änderungen aufgezeichnet.',
    en: 'No changes recorded yet.',
    tr: 'Henüz kayıtlı değişiklik yok.' },
  'verlauf.system': {
    de: 'System',
    en: 'System',
    tr: 'Sistem' },
  'verlauf.redigiert': {
    de: 'geändert',
    en: 'changed',
    tr: 'değişti' },
  'verlauf.ja': {
    de: 'ja',
    en: 'yes',
    tr: 'evet' },
  'verlauf.nein': {
    de: 'nein',
    en: 'no',
    tr: 'hayır' },
  'verlauf.angelegt': {
    de: '{was} angelegt',
    en: '{was} created',
    tr: '{was} oluşturuldu' },
  'verlauf.geaendert': {
    de: '{was} geändert',
    en: '{was} changed',
    tr: '{was} değişti' },
  'verlauf.entfernt': {
    de: '{was} entfernt',
    en: '{was} removed',
    tr: '{was} kaldırıldı' },

  'verlauf.tabelle.reservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'verlauf.tabelle.booking': {
    de: 'Buchung',
    en: 'Booking',
    tr: 'Rezervasyon kaydı' },
  'verlauf.tabelle.night': {
    de: 'Nacht',
    en: 'Night',
    tr: 'Gece' },
  'verlauf.tabelle.charge': {
    de: 'Position',
    en: 'Charge',
    tr: 'Kalem' },
  'verlauf.tabelle.block': {
    de: 'Sperrung',
    en: 'Block',
    tr: 'Kapatma' },

  'verlauf.feld.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'verlauf.feld.category': {
    de: 'Zimmergruppe',
    en: 'Room type',
    tr: 'Oda tipi' },
  'verlauf.feld.status': {
    de: 'Zustand',
    en: 'Status',
    tr: 'Durum' },
  'verlauf.feld.ratePlan': {
    de: 'Ratenplan',
    en: 'Rate plan',
    tr: 'Fiyat planı' },
  'verlauf.feld.guest': {
    de: 'Hauptgast',
    en: 'Main guest',
    tr: 'Ana misafir' },
  'verlauf.feld.guaranteed': {
    de: 'Garantiert',
    en: 'Guaranteed',
    tr: 'Garantili' },
  'verlauf.feld.optionExpires': {
    de: 'Option bis',
    en: 'Option until',
    tr: 'Opsiyon bitişi' },
  'verlauf.feld.cancellationFee': {
    de: 'Stornogebühr',
    en: 'Cancellation fee',
    tr: 'İptal ücreti' },
  'verlauf.feld.notes': {
    de: 'Notiz',
    en: 'Note',
    tr: 'Not' },
  'verlauf.feld.shortNote': {
    de: 'Kurznotiz',
    en: 'Short note',
    tr: 'Kısa not' },
  'verlauf.feld.price': {
    de: 'Preis',
    en: 'Price',
    tr: 'Fiyat' },
  'verlauf.feld.description': {
    de: 'Bezeichnung',
    en: 'Description',
    tr: 'Açıklama' },
  'verlauf.feld.quantity': {
    de: 'Menge',
    en: 'Quantity',
    tr: 'Miktar' },
  'verlauf.feld.net': {
    de: 'Netto',
    en: 'Net',
    tr: 'Net' },
  'verlauf.feld.tax': {
    de: 'Steuer',
    en: 'Tax',
    tr: 'Vergi' },
  'verlauf.feld.gross': {
    de: 'Brutto',
    en: 'Gross',
    tr: 'Brüt' },
  'verlauf.feld.businessDate': {
    de: 'Geschäftstag',
    en: 'Business day',
    tr: 'İş günü' },
  'verlauf.feld.invoice': {
    de: 'Rechnung',
    en: 'Invoice',
    tr: 'Fatura' },
  'verlauf.feld.reverses': {
    de: 'Gegenbuchung zu',
    en: 'Reverses',
    tr: 'Ters kayıt' },
  'verlauf.feld.kind': {
    de: 'Art',
    en: 'Kind',
    tr: 'Tür' },
  'verlauf.feld.reason': {
    de: 'Grund',
    en: 'Reason',
    tr: 'Sebep' },
  'verlauf.feld.source': {
    de: 'Herkunft',
    en: 'Source',
    tr: 'Kaynak' },
  'verlauf.feld.channel': {
    de: 'Kanal',
    en: 'Channel',
    tr: 'Kanal' },
  'verlauf.feld.externalRef': {
    de: 'Fremdnummer',
    en: 'External reference',
    tr: 'Harici referans' },
  'verlauf.feld.segment': {
    de: 'Marktsegment',
    en: 'Market segment',
    tr: 'Pazar segmenti' },
  'verlauf.feld.commission': {
    de: 'Provision',
    en: 'Commission',
    tr: 'Komisyon' },
  'verlauf.feld.booker': {
    de: 'Besteller',
    en: 'Booker',
    tr: 'Rezervasyonu yapan' },
  'verlauf.feld.bookerCompany': {
    de: 'Firma des Bestellers',
    en: "Booker's company",
    tr: 'Rezervasyonu yapan firma' },
} as const satisfies Record<string, LocalizedText>
