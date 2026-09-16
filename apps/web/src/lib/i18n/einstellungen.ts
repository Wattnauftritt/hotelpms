import type { LocalizedText } from '@hotelpms/contracts'

/** Haus: Wartung, Gastpost, Zahlungsarten, Stammdatenpflege. */
export const einstellungen = {
  'nav.maintenance': {
    de: 'Wartung',
    en: 'Maintenance' },
  'nav.settings': {
    de: 'Einstellungen',
    en: 'Settings' },

  'maint.title': {
    de: 'Wartungsmeldungen',
    en: 'Maintenance tickets' },
  'maint.new': {
    de: 'Meldung anlegen',
    en: 'New ticket' },
  'maint.subject': {
    de: 'Was ist zu tun',
    en: 'What needs doing' },
  'maint.description': {
    de: 'Beschreibung',
    en: 'Description' },
  'maint.priority': {
    de: 'Dringlichkeit',
    en: 'Priority' },
  'maint.priority.low': {
    de: 'Niedrig',
    en: 'Low' },
  'maint.priority.normal': {
    de: 'Normal',
    en: 'Normal' },
  'maint.priority.high': {
    de: 'Hoch',
    en: 'High' },
  'maint.status.open': {
    de: 'Offen',
    en: 'Open' },
  'maint.status.in_progress': {
    de: 'In Arbeit',
    en: 'In progress' },
  'maint.status.done': {
    de: 'Erledigt',
    en: 'Done' },
  'maint.take': {
    de: 'In Arbeit nehmen',
    en: 'Take on' },
  'maint.done': {
    de: 'Erledigt',
    en: 'Done' },
  'maint.reopen': {
    de: 'Wieder öffnen',
    en: 'Reopen' },
  'maint.showDone': {
    de: 'Erledigte zeigen',
    en: 'Show finished' },
  'maint.room': {
    de: 'Zimmer',
    en: 'Room' },
  'maint.noRoom': {
    de: 'Kein Zimmer',
    en: 'No room' },
  'maint.block': {
    de: 'Zimmer sperren',
    en: 'Block the room' },
  'maint.block.none': {
    de: 'Nicht sperren',
    en: 'Do not block' },
  'maint.block.out_of_order': {
    de: 'Out of Order',
    en: 'Out of order' },
  'maint.block.out_of_service': {
    de: 'Out of Service',
    en: 'Out of service' },
  'maint.blockHint': {
    de: 'Out of Order senkt die Kapazität: das Zimmer ist nicht mehr '
      + 'verkäuflich. Out of Service nicht — es bleibt im Verkauf und '
      + 'ist nur vorgemerkt.',
    en: 'Out of order lowers capacity: the room can no longer be sold. '
      + 'Out of service does not — it stays on sale and is only noted.' },
  'maint.blockStays': {
    de: 'Eine Sperrung bleibt bestehen, wenn die Meldung erledigt wird. '
      + 'Ob das Zimmer wieder verkäuflich ist, entscheidet, wer '
      + 'hineingesehen hat.',
    en: 'A block stays in place when the ticket is finished. Whether '
      + 'the room can be sold again is decided by whoever looked at it.' },
  'maint.noDelete': {
    de: 'Eine Meldung wird erledigt, nicht gelöscht: sonst bliebe offen, '
      + 'ob das Zimmer je in Ordnung gebracht wurde.',
    en: 'A ticket is finished, not deleted: otherwise it would stay open '
      + 'whether the room was ever put right.' },
  'maint.blocked': {
    de: 'gesperrt',
    en: 'blocked' },
  'maint.blockNeedsRoom': {
    de: 'Eine Sperrung braucht ein Zimmer. Ohne Zimmer wäre es '
      + 'eine Sperrung von nichts.',
    en: 'A block needs a room. Without one it would block nothing.' },
  'master.filter': {
    de: 'Suchen',
    en: 'Search' },
  'master.more': {
    de: 'weitere, durch Suchen einzugrenzen',
    en: 'more, narrow down by searching' },

  'mail.title': {
    de: 'Absenderangaben Gastpost',
    en: 'Guest mail sender' },
  'mail.fromName': {
    de: 'Absendername',
    en: 'Sender name' },
  'mail.fromEmail': {
    de: 'Absenderadresse',
    en: 'Sender address' },
  'mail.replyTo': {
    de: 'Antwortadresse',
    en: 'Reply-to address' },
  'mail.bcc': {
    de: 'Blindkopie',
    en: 'Blind copy' },
  'mail.enabled': {
    de: 'Versand eingeschaltet',
    en: 'Sending enabled' },
  'mail.enabledHint': {
    de: 'Ausgeschaltet bleibt die Post in der Warteschlange stehen. '
      + 'Verloren geht nichts.',
    en: 'While it is off, mail stays in the queue. Nothing is lost.' },
  'mail.training': {
    de: 'In einem Übungshaus lässt sich der Versand nicht einschalten. '
      + 'Ein Übungshaus schreibt keinem echten Gast.',
    en: 'Sending cannot be switched on in a training property. A training '
      + 'property writes to no real guest.' },
  'mail.updatedAt': {
    de: 'Zuletzt geändert',
    en: 'Last changed' },
  'mail.never': {
    de: 'Noch nicht eingerichtet',
    en: 'Not set up yet' },

  'pay.title': {
    de: 'Zahlungsarten',
    en: 'Payment methods' },
  'pay.new': {
    de: 'Zahlungsart anlegen',
    en: 'New payment method' },
  'pay.code': {
    de: 'Kürzel',
    en: 'Code' },
  'pay.name': {
    de: 'Bezeichnung',
    en: 'Name' },
  'pay.external': {
    de: 'Abwicklung außer Haus',
    en: 'Settled outside the house' },
  'pay.sortOrder': {
    de: 'Reihenfolge',
    en: 'Order' },
  'pay.active': {
    de: 'Aktiv',
    en: 'Active' },
  'pay.deactivate': {
    de: 'Stilllegen',
    en: 'Deactivate' },
  'pay.activate': {
    de: 'Wieder einschalten',
    en: 'Reactivate' },
  'pay.showInactive': {
    de: 'Stillgelegte zeigen',
    en: 'Show deactivated' },
  'pay.noDelete': {
    de: 'Es gibt kein Löschen: an einer Zahlungsart hängen Verrechnungen, '
      + 'und die sind unveränderlich. Stillgelegt verschwindet sie aus der '
      + 'Auswahl und bleibt in der Geschichte.',
    en: 'There is no delete: settlements hang off a payment method, and '
      + 'those are immutable. Deactivated it disappears from the list of '
      + 'choices and stays in the history.' },

  'master.title': {
    de: 'Stammdaten pflegen',
    en: 'Maintain master data' },
  'master.categories': {
    de: 'Zimmergruppen',
    en: 'Room types' },
  'master.rooms': {
    de: 'Zimmer',
    en: 'Rooms' },
  'master.edit': {
    de: 'Ändern',
    en: 'Edit' },
  'master.close': {
    de: 'Schließen',
    en: 'Close' },
  'master.description': {
    de: 'Beschreibung',
    en: 'Description' },
  'master.descriptionHint': {
    de: 'Geht an Channel Manager und Buchungsstrecke.',
    en: 'Goes to the channel manager and the booking engine.' },
  'master.sortOrder': {
    de: 'Reihenfolge',
    en: 'Order' },
  'master.sortOrderHint': {
    de: 'Reihenfolge im Zimmerplan und in Listen.',
    en: 'Order in the room chart and in lists.' },
  'master.overbooking': {
    de: 'Überbuchung',
    en: 'Overbooking' },
  'master.overbookingHint': {
    de: 'So viele Einheiten über die Kapazität hinaus dürfen '
      + 'verkauft werden.',
    en: 'This many units beyond capacity may be sold.' },
  'master.deactivate': {
    de: 'Stilllegen',
    en: 'Deactivate' },
  'master.activate': {
    de: 'Wieder einschalten',
    en: 'Reactivate' },
  'master.deactivateHint': {
    de: 'Stilllegen zieht Kapazität ab. Liegen künftige '
      + 'Reservierungen darauf, wird es abgewiesen — erst '
      + 'umbuchen, dann stilllegen.',
    en: 'Deactivating removes capacity. If future reservations '
      + 'rest on it, the request is refused — move them first.' },
  'master.occupancyHint': {
    de: 'Die Belegungszahl wirkt auf Preise und Meldeschein, '
      + 'nicht auf die Kapazität.',
    en: 'Occupancy affects prices and the registration form, not '
      + 'capacity.' },
  'master.floor': {
    de: 'Etage',
    en: 'Floor' },
  'master.attributes': {
    de: 'Merkmale',
    en: 'Attributes' },
  'master.attributesHint': {
    de: 'Kommagetrennt, etwa: balkon, barrierefrei, raucher. '
      + 'Daran hängt später die Zimmerzuweisung.',
    en: 'Comma separated, e.g. balcony, accessible, smoking. Room '
      + 'assignment will build on these.' },
  'master.inactive': {
    de: 'Stillgelegt',
    en: 'Deactivated' },
  'master.showInactive': {
    de: 'Stillgelegte zeigen',
    en: 'Show deactivated' },
  'master.timeUnitHint': {
    de: 'Andere Zeiteinheiten als die Nacht sind noch nicht '
      + 'freigeschaltet.',
    en: 'Time units other than the night are not enabled yet.' },
} as const satisfies Record<string, LocalizedText>
