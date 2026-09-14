/** Haus: Wartung, Gastpost, Zahlungsarten, Stammdatenpflege. */
export const einstellungen = {
  de: {
    'nav.maintenance': 'Wartung',
    'nav.settings': 'Einstellungen',

    'maint.title': 'Wartungsmeldungen',
    'maint.new': 'Meldung anlegen',
    'maint.subject': 'Was ist zu tun',
    'maint.description': 'Beschreibung',
    'maint.priority': 'Dringlichkeit',
    'maint.priority.low': 'Niedrig',
    'maint.priority.normal': 'Normal',
    'maint.priority.high': 'Hoch',
    'maint.status.open': 'Offen',
    'maint.status.in_progress': 'In Arbeit',
    'maint.status.done': 'Erledigt',
    'maint.take': 'In Arbeit nehmen',
    'maint.done': 'Erledigt',
    'maint.reopen': 'Wieder öffnen',
    'maint.showDone': 'Erledigte zeigen',
    'maint.room': 'Zimmer',
    'maint.noRoom': 'Kein Zimmer',
    'maint.block': 'Zimmer sperren',
    'maint.block.none': 'Nicht sperren',
    'maint.block.out_of_order': 'Out of Order',
    'maint.block.out_of_service': 'Out of Service',
    'maint.blockHint': 'Out of Order senkt die Kapazität: das Zimmer ist nicht mehr '
                     + 'verkäuflich. Out of Service nicht — es bleibt im Verkauf und '
                     + 'ist nur vorgemerkt.',
    'maint.blockStays': 'Eine Sperrung bleibt bestehen, wenn die Meldung erledigt wird. '
                      + 'Ob das Zimmer wieder verkäuflich ist, entscheidet, wer '
                      + 'hineingesehen hat.',
    'maint.noDelete': 'Eine Meldung wird erledigt, nicht gelöscht: sonst bliebe offen, '
                    + 'ob das Zimmer je in Ordnung gebracht wurde.',
    'maint.blocked': 'gesperrt',
    'maint.blockNeedsRoom': 'Eine Sperrung braucht ein Zimmer. Ohne Zimmer wäre es '
                          + 'eine Sperrung von nichts.',
    'master.filter': 'Suchen',
    'master.more': 'weitere, durch Suchen einzugrenzen',

    'mail.title': 'Absenderangaben Gastpost',
    'mail.fromName': 'Absendername',
    'mail.fromEmail': 'Absenderadresse',
    'mail.replyTo': 'Antwortadresse',
    'mail.bcc': 'Blindkopie',
    'mail.enabled': 'Versand eingeschaltet',
    'mail.enabledHint': 'Ausgeschaltet bleibt die Post in der Warteschlange stehen. '
                      + 'Verloren geht nichts.',
    'mail.training': 'In einem Übungshaus lässt sich der Versand nicht einschalten. '
                   + 'Ein Übungshaus schreibt keinem echten Gast.',
    'mail.updatedAt': 'Zuletzt geändert',
    'mail.never': 'Noch nicht eingerichtet',

    'pay.title': 'Zahlungsarten',
    'pay.new': 'Zahlungsart anlegen',
    'pay.code': 'Kürzel',
    'pay.name': 'Bezeichnung',
    'pay.external': 'Abwicklung außer Haus',
    'pay.sortOrder': 'Reihenfolge',
    'pay.active': 'Aktiv',
    'pay.deactivate': 'Stilllegen',
    'pay.activate': 'Wieder einschalten',
    'pay.showInactive': 'Stillgelegte zeigen',
    'pay.noDelete': 'Es gibt kein Löschen: an einer Zahlungsart hängen Verrechnungen, '
                  + 'und die sind unveränderlich. Stillgelegt verschwindet sie aus der '
                  + 'Auswahl und bleibt in der Geschichte.',

    'master.title': 'Stammdaten pflegen',
    'master.categories': 'Zimmergruppen',
    'master.rooms': 'Zimmer',
    'master.edit': 'Ändern',
    'master.close': 'Schließen',
    'master.description': 'Beschreibung',
    'master.descriptionHint': 'Geht an Channel Manager und Buchungsstrecke.',
    'master.sortOrder': 'Reihenfolge',
    'master.sortOrderHint': 'Reihenfolge im Zimmerplan und in Listen.',
    'master.overbooking': 'Überbuchung',
    'master.overbookingHint': 'So viele Einheiten über die Kapazität hinaus dürfen '
                            + 'verkauft werden.',
    'master.deactivate': 'Stilllegen',
    'master.activate': 'Wieder einschalten',
    'master.deactivateHint': 'Stilllegen zieht Kapazität ab. Liegen künftige '
                           + 'Reservierungen darauf, wird es abgewiesen — erst '
                           + 'umbuchen, dann stilllegen.',
    'master.occupancyHint': 'Die Belegungszahl wirkt auf Preise und Meldeschein, '
                          + 'nicht auf die Kapazität.',
    'master.floor': 'Etage',
    'master.attributes': 'Merkmale',
    'master.attributesHint': 'Kommagetrennt, etwa: balkon, barrierefrei, raucher. '
                           + 'Daran hängt später die Zimmerzuweisung.',
    'master.inactive': 'Stillgelegt',
    'master.showInactive': 'Stillgelegte zeigen',
    'master.timeUnitHint': 'Andere Zeiteinheiten als die Nacht sind noch nicht '
                         + 'freigeschaltet.'
  },
  en: {
    'nav.maintenance': 'Maintenance',
    'nav.settings': 'Settings',

    'maint.title': 'Maintenance tickets',
    'maint.new': 'New ticket',
    'maint.subject': 'What needs doing',
    'maint.description': 'Description',
    'maint.priority': 'Priority',
    'maint.priority.low': 'Low',
    'maint.priority.normal': 'Normal',
    'maint.priority.high': 'High',
    'maint.status.open': 'Open',
    'maint.status.in_progress': 'In progress',
    'maint.status.done': 'Done',
    'maint.take': 'Take on',
    'maint.done': 'Done',
    'maint.reopen': 'Reopen',
    'maint.showDone': 'Show finished',
    'maint.room': 'Room',
    'maint.noRoom': 'No room',
    'maint.block': 'Block the room',
    'maint.block.none': 'Do not block',
    'maint.block.out_of_order': 'Out of order',
    'maint.block.out_of_service': 'Out of service',
    'maint.blockHint': 'Out of order lowers capacity: the room can no longer be sold. '
                     + 'Out of service does not — it stays on sale and is only noted.',
    'maint.blockStays': 'A block stays in place when the ticket is finished. Whether '
                      + 'the room can be sold again is decided by whoever looked at it.',
    'maint.noDelete': 'A ticket is finished, not deleted: otherwise it would stay open '
                    + 'whether the room was ever put right.',
    'maint.blocked': 'blocked',
    'maint.blockNeedsRoom': 'A block needs a room. Without one it would block nothing.',
    'master.filter': 'Search',
    'master.more': 'more, narrow down by searching',

    'mail.title': 'Guest mail sender',
    'mail.fromName': 'Sender name',
    'mail.fromEmail': 'Sender address',
    'mail.replyTo': 'Reply-to address',
    'mail.bcc': 'Blind copy',
    'mail.enabled': 'Sending enabled',
    'mail.enabledHint': 'While it is off, mail stays in the queue. Nothing is lost.',
    'mail.training': 'Sending cannot be switched on in a training property. A training '
                   + 'property writes to no real guest.',
    'mail.updatedAt': 'Last changed',
    'mail.never': 'Not set up yet',

    'pay.title': 'Payment methods',
    'pay.new': 'New payment method',
    'pay.code': 'Code',
    'pay.name': 'Name',
    'pay.external': 'Settled outside the house',
    'pay.sortOrder': 'Order',
    'pay.active': 'Active',
    'pay.deactivate': 'Deactivate',
    'pay.activate': 'Reactivate',
    'pay.showInactive': 'Show deactivated',
    'pay.noDelete': 'There is no delete: settlements hang off a payment method, and '
                  + 'those are immutable. Deactivated it disappears from the list of '
                  + 'choices and stays in the history.',

    'master.title': 'Maintain master data',
    'master.categories': 'Room types',
    'master.rooms': 'Rooms',
    'master.edit': 'Edit',
    'master.close': 'Close',
    'master.description': 'Description',
    'master.descriptionHint': 'Goes to the channel manager and the booking engine.',
    'master.sortOrder': 'Order',
    'master.sortOrderHint': 'Order in the room chart and in lists.',
    'master.overbooking': 'Overbooking',
    'master.overbookingHint': 'This many units beyond capacity may be sold.',
    'master.deactivate': 'Deactivate',
    'master.activate': 'Reactivate',
    'master.deactivateHint': 'Deactivating removes capacity. If future reservations '
                           + 'rest on it, the request is refused — move them first.',
    'master.occupancyHint': 'Occupancy affects prices and the registration form, not '
                          + 'capacity.',
    'master.floor': 'Floor',
    'master.attributes': 'Attributes',
    'master.attributesHint': 'Comma separated, e.g. balcony, accessible, smoking. Room '
                           + 'assignment will build on these.',
    'master.inactive': 'Deactivated',
    'master.showInactive': 'Show deactivated',
    'master.timeUnitHint': 'Time units other than the night are not enabled yet.'
  }
} as const
