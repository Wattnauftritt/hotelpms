import type { LocalizedText } from '@hotelpms/contracts'

/** Belegungsplan und das Seitenfenster einer Reservierung (Spur A). */
export const plan = {
  'nav.availability': {
    de: 'Verfügbarkeit',
    en: 'Availability' },
  'plan.reservation': {
    de: 'Reservierung',
    en: 'Reservation' },
  'plan.guest': {
    de: 'Gast',
    en: 'Guest' },
  'plan.noGuest': {
    de: 'Kein Gast hinterlegt',
    en: 'No guest on file' },
  'plan.company': {
    de: 'Firma',
    en: 'Company' },
  'plan.room': {
    de: 'Zimmer',
    en: 'Room' },
  'plan.noRoom': {
    de: 'Kein Zimmer zugewiesen',
    en: 'No room assigned' },
  'plan.category': {
    de: 'Zimmergruppe',
    en: 'Room category' },
  'plan.ratePlan': {
    de: 'Ratenplan',
    en: 'Rate plan' },
  'plan.stay': {
    de: 'Aufenthalt',
    en: 'Stay' },
  'plan.nights': {
    de: 'Nächte',
    en: 'Nights' },
  'plan.occupants': {
    de: 'Mitreisende',
    en: 'Occupants' },
  'plan.noOccupants': {
    de: 'Keine weiteren Mitreisende',
    en: 'No further occupants' },
  'plan.primary': {
    de: 'Hauptgast',
    en: 'Primary guest' },
  'plan.total': {
    de: 'Gesamtpreis',
    en: 'Total price' },
  'plan.block': {
    de: 'Aus Kontingent',
    en: 'From block' },
  'plan.source': {
    de: 'Quelle',
    en: 'Source' },
  'plan.checkedInAt': {
    de: 'Angereist am',
    en: 'Checked in at' },
  'plan.checkedOutAt': {
    de: 'Abgereist am',
    en: 'Checked out at' },
  'plan.canceledAt': {
    de: 'Storniert am',
    en: 'Cancelled at' },
  'plan.folio': {
    de: 'Gastkonto',
    en: 'Folio' },
  'plan.openFolio': {
    de: 'Folio öffnen',
    en: 'Open folio' },
  'plan.noFolio': {
    de: 'Noch kein Gastkonto',
    en: 'No folio yet' },
  'plan.notes': {
    de: 'Notiz',
    en: 'Note' },
  'plan.notesHint': {
    de: 'Freitext für die Rezeption. Hier gehören keine '
      + 'Gesundheitsdaten hin: das Feld wird weder durchsucht noch anonymisiert.',
    en: 'Free text for the front desk. No health data belongs '
      + 'here: the field is neither searched nor anonymised.' },
  'plan.notesSave': {
    de: 'Speichern',
    en: 'Save' },
  'plan.notesSaved': {
    de: 'Gespeichert',
    en: 'Saved' },
  'plan.cancel': {
    de: 'Stornieren',
    en: 'Cancel booking' },
  'plan.cancelConfirm': {
    de: 'Diese Reservierung wirklich stornieren?',
    en: 'Cancel this reservation?' },
  'plan.reinstate': {
    de: 'Storno zurücknehmen',
    en: 'Undo cancellation' },
  'plan.sendConfirmation': {
    de: 'Bestätigung schicken',
    en: 'Send confirmation' },
  'plan.confirmationSent': {
    de: 'Bestätigung eingereiht',
    en: 'Confirmation queued' },

  'booking.title': {
    de: 'Buchen',
    en: 'Book' },
  'booking.room': {
    de: 'Zimmer',
    en: 'Room' },
  'booking.category': {
    de: 'Zimmergruppe',
    en: 'Room category' },
  'booking.arrival': {
    de: 'Anreise',
    en: 'Arrival' },
  'booking.departure': {
    de: 'Abreise',
    en: 'Departure' },
  'booking.guest': {
    de: 'Gast',
    en: 'Guest' },
  'booking.notes': {
    de: 'Notiz',
    en: 'Note' },
  'booking.submit': {
    de: 'Buchen',
    en: 'Book' },
  'booking.close': {
    de: 'Abbrechen',
    en: 'Cancel' },
  'booking.created': {
    de: 'Gebucht',
    en: 'Booked' },
  'booking.needsGuest': {
    de: 'Ohne Gast lässt sich nicht buchen. Suchen oder neu anlegen.',
    en: 'Booking needs a guest. Search or create one.' },

  'plan.dragHint': {
    de: 'Balken ziehen verschiebt die Reservierung, die Ränder verlängern sie. Auf '
      + 'freier Fläche aufziehen legt eine Buchung an — mit gedrückter Strg-, ⌘- '
      + 'oder Umschalttaste über mehrere Zimmer hinweg eine Gruppenbuchung.',
    en: 'Drag a bar to move the reservation, drag its edges to extend it. Drag '
      + 'across free space to create a booking — hold Ctrl, ⌘ or Shift and drag '
      + 'across several rooms for a group booking.' },

  'group.title': {
    de: 'Gruppenbuchung',
    en: 'Group booking' },
  'group.rooms': {
    de: 'Zimmer',
    en: 'rooms' },
  'group.selection': {
    de: 'Ausgewählte Zimmer',
    en: 'Selected rooms' },
  'group.remove': {
    de: 'Entfernen',
    en: 'Remove' },
  'group.submit': {
    de: 'Gruppe buchen',
    en: 'Book the group' },
  'group.created': {
    de: 'Gruppe gebucht',
    en: 'Group booked' },
  'group.createdDetail': {
    de: '{n} Zimmer unter einer Buchung',
    en: '{n} rooms under one booking' },
  'group.guestHint': {
    de: 'Der Gast ist der Besteller der Gruppe, nicht der Bewohner jedes Zimmers. '
      + 'Er wird nur im ersten Zimmer als Mitreisender geführt — sonst zählte die '
      + 'Kurtaxe ihn mehrfach. Die Namen der übrigen Zimmer kommen mit der '
      + 'Namensliste.',
    en: 'The guest is the person who booked the group, not the occupant of every '
      + 'room. They are recorded as an occupant of the first room only — otherwise '
      + 'city tax would count them several times. The other names arrive with the '
      + 'rooming list.' },
  'group.empty': {
    de: 'Kein Zimmer mehr ausgewählt.',
    en: 'No room selected any more.' },

  'guestPicker.placeholder': {
    de: 'Nachname, E-Mail oder Telefon',
    en: 'Last name, email or phone' },
  'guestPicker.hint': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters' },
  'guestPicker.noResults': {
    de: 'Keine Treffer',
    en: 'No matches' },
  'guestPicker.createNew': {
    de: 'Neuen Gast anlegen',
    en: 'Create new guest' },
  'guestPicker.change': {
    de: 'Ändern',
    en: 'Change' },
  'guestPicker.anonymized': {
    de: 'Anonymisiert',
    en: 'Anonymised' },

  'warnings.title': {
    de: 'Warnungen',
    en: 'Warnings' },
  'warnings.none': {
    de: 'Keine Warnungen im sichtbaren Zeitraum',
    en: 'No warnings in the visible range' },
  'warnings.unassigned': {
    de: 'ohne Zimmer',
    en: 'without a room' },
  'warnings.overbooked': {
    de: 'Überbuchung',
    en: 'Overbooking' },
  'warnings.overbookedOn': {
    de: 'am',
    en: 'on' },

  'availability.title': {
    de: 'Verfügbarkeit',
    en: 'Availability' },
  'availability.category': {
    de: 'Zimmergruppe',
    en: 'Room category' },
  'availability.free': {
    de: 'frei',
    en: 'free' },

  'checkin.title': {
    de: 'Check-in',
    en: 'Check-in' },
  'checkin.needsRoom': {
    de: 'Ohne zugewiesenes Zimmer ist kein Check-in möglich. '
      + 'Zuerst ein Zimmer zuweisen.',
    en: 'Check-in needs an assigned room. Assign one first.' },
  'checkin.alreadyRegistered': {
    de: 'Für diese Reservierung liegt bereits ein Meldeschein vor.',
    en: 'This reservation already has a registration form.' },
  'checkin.signatureRequired': {
    de: 'Ausländischer Gast: Unterschrift erforderlich.',
    en: 'Foreign guest: signature required.' },
  'checkin.noSignatureNeeded': {
    de: 'Inländischer Gast: seit dem 1.1.2025 keine Unterschrift nötig.',
    en: 'Domestic guest: no signature needed since 1 Jan 2025.' },
  'checkin.clear': {
    de: 'Löschen',
    en: 'Clear' },
  'checkin.register': {
    de: 'Meldeschein speichern',
    en: 'Save registration form' },
  'checkin.submit': {
    de: 'Meldeschein erfassen und einchecken',
    en: 'Register and check in' },
} as const satisfies Record<string, LocalizedText>
