/** Support-Sitzungen: Anfrage, Freigabe, Widerruf. */
export const support = {
  de: {
    'support.title': 'Support-Zugriff',
    'support.hint': 'Unser Support sieht Ihre Daten nur, wenn Sie es hier '
                  + 'freigeben — befristet, und jede Handlung steht im Protokoll.',
    'support.none': 'Zurzeit bittet niemand um Zugriff.',
    'support.reason': 'Anlass',
    'support.who': 'Angefragt von',
    'support.level': 'Umfang',
    'support.level.read': 'Nur lesen',
    'support.level.write': 'Lesen und ändern',
    'support.until': 'Läuft ab',
    'support.grant': 'Freigeben',
    'support.deny': 'Ablehnen',
    'support.revoke': 'Jetzt beenden',
    'support.grantedBy': 'Freigegeben von {name}',
    'support.state.pending': 'Wartet auf Ihre Entscheidung',
    'support.state.active': 'Läuft',
    'support.state.expired': 'Abgelaufen',
    'support.state.revoked': 'Beendet',
    'support.showPermissions': 'Was wird damit erlaubt?',
    // Die Auslassungen sind der Punkt: der Kunde soll sehen, was auch bei
    // Freigabe nicht geht.
    'support.never': 'Nie enthalten: Ausweisdaten, DSGVO-Auskunft und Löschung, '
                   + 'Rechnungen festschreiben, Exporte nach außen, Benutzer '
                   + 'und Schnittstellen verwalten.',

    'support.console': 'Support',
    'support.console.hint': 'Ohne Freigabe des Kunden sehen Sie keine Kundendaten. '
                          + 'Fragen Sie mit einem Anlass an; der Kunde entscheidet.',
    'support.accountId': 'Account-Nummer',
    'support.hours': 'Laufzeit in Stunden',
    'support.request': 'Zugriff anfragen',
    'support.requested': 'Angefragt. Der Kunde wurde benachrichtigt.',
    'support.mine': 'Meine Anfragen'
  },
  en: {
    'support.title': 'Support access',
    'support.hint': 'Our support team sees your data only if you approve it here '
                  + '— for a limited time, and every action is recorded in the log.',
    'support.none': 'Nobody is currently asking for access.',
    'support.reason': 'Reason',
    'support.who': 'Requested by',
    'support.level': 'Scope',
    'support.level.read': 'Read only',
    'support.level.write': 'Read and change',
    'support.until': 'Expires',
    'support.grant': 'Approve',
    'support.deny': 'Decline',
    'support.revoke': 'End now',
    'support.grantedBy': 'Approved by {name}',
    'support.state.pending': 'Waiting for your decision',
    'support.state.active': 'Running',
    'support.state.expired': 'Expired',
    'support.state.revoked': 'Ended',
    'support.showPermissions': 'What does this allow?',
    'support.never': 'Never included: identity documents, GDPR access and erasure, '
                   + 'issuing invoices, exports out of the house, managing users '
                   + 'and integrations.',

    'support.console': 'Support',
    'support.console.hint': 'Without the customer’s approval you see no customer '
                          + 'data. Ask with a stated reason; the customer decides.',
    'support.accountId': 'Account number',
    'support.hours': 'Duration in hours',
    'support.request': 'Request access',
    'support.requested': 'Requested. The customer has been notified.',
    'support.mine': 'My requests'
  }
} as const
