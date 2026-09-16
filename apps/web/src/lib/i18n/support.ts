import type { LocalizedText } from '@hotelpms/contracts'

/** Support-Sitzungen: Anfrage, Freigabe, Widerruf. */
export const support = {
  'deploy.rollback': {
    de: 'Zurück auf',
    en: 'Roll back to' },
  'deploy.rollbackHint': {
    de: 'Schaltet auf einen früheren Stand zurück — ohne Bau, '
      + 'in Sekunden. Das Datenbankschema bleibt dabei auf dem '
      + 'neueren Stand.',
    en: 'Switches back to an earlier release — no build, done '
      + 'in seconds. The database schema stays at the newer '
      + 'state.' },
  'deploy.rollbackNone': {
    de: 'Kein früherer Stand verfügbar.',
    en: 'No earlier release available.' },
  'deploy.kind.rollback': {
    de: 'zurückgerollt',
    en: 'rolled back' },
  'deploy.title': {
    de: 'Ausrollen',
    en: 'Deploy' },
  'deploy.hint': {
    de: 'Ausgerollt wird der Stand, der auf GitHub mit dem Tag '
      + '„produktion“ markiert ist — nie einfach der letzte. Dieser '
      + 'Knopf bestimmt nur den Zeitpunkt.',
    en: 'What gets deployed is the commit tagged “produktion” on '
      + 'GitHub — never simply the latest one. This button only '
      + 'decides when.' },
  'deploy.request': {
    de: 'Jetzt ausrollen',
    en: 'Deploy now' },
  'deploy.requested': {
    de: 'Angefordert. Die Maschine holt sich das binnen einer Minute.',
    en: 'Requested. The machine picks it up within a minute.' },
  'deploy.current': {
    de: 'Läuft gerade',
    en: 'Currently running' },
  'deploy.currentUnknown': {
    de: 'Noch kein Lauf verzeichnet',
    en: 'No run recorded yet' },
  'deploy.byHand': {
    de: 'von Hand auf der Maschine',
    en: 'by hand on the machine' },
  'deploy.state.pending': {
    de: 'Wartet',
    en: 'Waiting' },
  'deploy.state.running': {
    de: 'Läuft',
    en: 'Running' },
  'deploy.state.done': {
    de: 'Durch',
    en: 'Done' },
  'deploy.state.failed': {
    de: 'Gescheitert',
    en: 'Failed' },
  'deploy.showLog': {
    de: 'Ausgabe zeigen',
    en: 'Show output' },
  'support.title': {
    de: 'Support-Zugriff',
    en: 'Support access' },
  'support.hint': {
    de: 'Unser Support sieht Ihre Daten nur, wenn Sie es hier '
      + 'freigeben — befristet, und jede Handlung steht im Protokoll.',
    en: 'Our support team sees your data only if you approve it here '
      + '— for a limited time, and every action is recorded in the log.' },
  'support.none': {
    de: 'Zurzeit bittet niemand um Zugriff.',
    en: 'Nobody is currently asking for access.' },
  'support.reason': {
    de: 'Anlass',
    en: 'Reason' },
  'support.who': {
    de: 'Angefragt von',
    en: 'Requested by' },
  'support.level': {
    de: 'Umfang',
    en: 'Scope' },
  'support.level.read': {
    de: 'Nur lesen',
    en: 'Read only' },
  'support.level.write': {
    de: 'Lesen und ändern',
    en: 'Read and change' },
  'support.until': {
    de: 'Läuft ab',
    en: 'Expires' },
  'support.grant': {
    de: 'Freigeben',
    en: 'Approve' },
  'support.deny': {
    de: 'Ablehnen',
    en: 'Decline' },
  'support.revoke': {
    de: 'Jetzt beenden',
    en: 'End now' },
  'support.grantedBy': {
    de: 'Freigegeben von {name}',
    en: 'Approved by {name}' },
  'support.state.pending': {
    de: 'Wartet auf Ihre Entscheidung',
    en: 'Waiting for your decision' },
  'support.state.active': {
    de: 'Läuft',
    en: 'Running' },
  'support.state.expired': {
    de: 'Abgelaufen',
    en: 'Expired' },
  'support.state.revoked': {
    de: 'Beendet',
    en: 'Ended' },
  'support.showPermissions': {
    de: 'Was wird damit erlaubt?',
    en: 'What does this allow?' },
  // Die Auslassungen sind der Punkt: der Kunde soll sehen, was auch bei
  // Freigabe nicht geht.
  'support.never': {
    de: 'Nie enthalten: Ausweisdaten, DSGVO-Auskunft und Löschung, '
      + 'Rechnungen festschreiben, Exporte nach außen, Benutzer '
      + 'und Schnittstellen verwalten.',
    en: 'Never included: identity documents, GDPR access and erasure, '
      + 'issuing invoices, exports out of the house, managing users '
      + 'and integrations.' },

  'support.console': {
    de: 'Support',
    en: 'Support' },
  'support.console.hint': {
    de: 'Ohne Freigabe des Kunden sehen Sie keine Kundendaten. '
      + 'Fragen Sie mit einem Anlass an; der Kunde entscheidet.',
    en: 'Without the customer’s approval you see no customer '
      + 'data. Ask with a stated reason; the customer decides.' },
  'support.accountId': {
    de: 'Account-Nummer',
    en: 'Account number' },
  'support.hours': {
    de: 'Laufzeit in Stunden',
    en: 'Duration in hours' },
  'support.request': {
    de: 'Zugriff anfragen',
    en: 'Request access' },
  'support.requested': {
    de: 'Angefragt. Der Kunde wurde benachrichtigt.',
    en: 'Requested. The customer has been notified.' },
  'support.mine': {
    de: 'Meine Anfragen',
    en: 'My requests' },
} as const satisfies Record<string, LocalizedText>
