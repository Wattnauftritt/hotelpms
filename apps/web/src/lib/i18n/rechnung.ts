import type { LocalizedText } from '@hotelpms/contracts'

/** Rechnungsliste, Beleg, Versand (Spur B). */
export const rechnung = {
  'nav.invoices': {
    de: 'Rechnungen',
    en: 'Invoices' },
  'inv.title': {
    de: 'Rechnungen',
    en: 'Invoices' },
  'inv.kind': {
    de: 'Art',
    en: 'Type' },
  'inv.kind.all': {
    de: 'alle',
    en: 'all' },
  'inv.kind.final': {
    de: 'Schlussrechnung',
    en: 'Final invoice' },
  'inv.kind.interim': {
    de: 'Zwischenrechnung',
    en: 'Interim invoice' },
  'inv.kind.deposit': {
    de: 'Anzahlung',
    en: 'Deposit' },
  'inv.kind.credit_note': {
    de: 'Gutschrift',
    en: 'Credit note' },
  'inv.number': {
    de: 'Nummer',
    en: 'Number' },
  'inv.issuedOn': {
    de: 'Ausgestellt',
    en: 'Issued' },
  'inv.recipient': {
    de: 'Empfänger',
    en: 'Recipient' },
  'inv.amount': {
    de: 'Betrag',
    en: 'Amount' },
  'inv.document': {
    de: 'Beleg',
    en: 'Document' },
  'inv.document.ready': {
    de: 'fertig',
    en: 'ready' },
  'inv.document.pending': {
    de: 'wird erzeugt',
    en: 'being created' },
  'inv.document.noXml': {
    de: 'ohne XML',
    en: 'without XML' },
  'inv.document.noXmlHint': {
    de: 'Kleinbetragsrechnungen und Rechnungen ohne USt-IdNr. '
      + 'des Hauses tragen kein EN-16931-XML. Der Beleg ist gültig.',
    en: 'Small-amount invoices and invoices without the '
      + 'property VAT ID carry no EN 16931 XML. The document is valid.' },
  'inv.show': {
    de: 'Ansehen',
    en: 'View' },
  'inv.hide': {
    de: 'Schließen',
    en: 'Close' },
  'inv.download': {
    de: 'Herunterladen',
    en: 'Download' },
  'inv.folio': {
    de: 'Gastkonto',
    en: 'Guest account' },
  'inv.send': {
    de: 'Verschicken',
    en: 'Send' },
  'inv.send.to': {
    de: 'Abweichende Adresse',
    en: 'Different address' },
  'inv.send.toHint': {
    de: 'Leer lassen, dann geht sie an die Adresse am Gast- oder '
      + 'Firmenprofil.',
    en: 'Leave empty to use the address on the guest or company profile.' },
  'inv.send.again': {
    de: 'Noch einmal verschicken',
    en: 'Send again' },
  'inv.send.queued': {
    de: 'Eingereiht',
    en: 'Queued' },
  'inv.send.alreadyHint': {
    de: 'Diese Rechnung ist bereits verschickt oder eingereiht. '
      + 'Ein zweiter Versand muss ausdrücklich gewollt sein.',
    en: 'This invoice has already been sent or queued. '
      + 'Sending it again has to be deliberate.' },
  'inv.mail.pending': {
    de: 'eingereiht',
    en: 'queued' },
  'inv.mail.sent': {
    de: 'verschickt',
    en: 'sent' },
  'inv.mail.failed': {
    de: 'fehlgeschlagen',
    en: 'failed' },
  'inv.mail.canceled': {
    de: 'zurückgezogen',
    en: 'withdrawn' },
  'inv.outbox': {
    de: 'Postausgang',
    en: 'Outbox' },
  'inv.outbox.empty': {
    de: 'Nichts im Postausgang.',
    en: 'Nothing in the outbox.' },
  'inv.outbox.cancel': {
    de: 'Zurückziehen',
    en: 'Withdraw' },
  'inv.outbox.attempts': {
    de: 'Versuche',
    en: 'attempts' },
  'inv.none': {
    de: 'Keine Rechnung in diesem Zeitraum.',
    en: 'No invoice in this period.' },
  'inv.paid': {
    de: 'bezahlt',
    en: 'paid' },
  'inv.open': {
    de: 'offen',
    en: 'open' },
  'inv.settled': {
    de: 'davon vermerkt',
    en: 'of which recorded' },
  'inv.paymentHint': {
    de: 'Zugeordnet wird eine Zahlung beim Festschreiben und beim '
      + 'Vermerken. Zahlungen von vor dieser Zuordnung tragen keine '
      + 'Rechnungsnummer und lassen sich nicht nachtragen — solche '
      + 'Rechnungen stehen hier als offen, auch wenn sie bezahlt sind. '
      + 'Im Zweifel gilt der Saldo am Gastkonto.',
    en: 'A payment is assigned when the invoice is issued and when the '
      + 'payment is recorded. Payments made before this assignment '
      + 'existed carry no invoice number and cannot be added later — '
      + 'such invoices show as open even though they are paid. In doubt '
      + 'the guest account balance is the truth.' },

  // Vorauszahlung: Anzahlungsrechnung und Zahlungslink (B8, B9)
  'vz.title': {
    de: 'Vorauszahlung',
    en: 'Prepayment' },
  'vz.open': {
    de: 'Anzahlung und Zahlungslink',
    en: 'Deposit and payment link' },
  'vz.close': {
    de: 'Schließen',
    en: 'Close' },
  'vz.dep.title': {
    de: 'Anzahlungsrechnungen',
    en: 'Deposit invoices' },
  'vz.dep.none': {
    de: 'Noch keine Anzahlungsrechnung.',
    en: 'No deposit invoice yet.' },
  'vz.dep.new': {
    de: 'Anzahlungsrechnung erstellen',
    en: 'Issue deposit invoice' },
  'vz.dep.settlement': {
    de: 'Zahlungseingang',
    en: 'Payment received' },
  'vz.dep.noneOpen': {
    de: 'Zu jedem Zahlungseingang gibt es schon eine Anzahlungsrechnung. '
      + 'Eine Anzahlung wird erst vermerkt und dann fakturiert.',
    en: 'Every payment already has a deposit invoice. A deposit is '
      + 'recorded first and invoiced afterwards.' },
  'vz.dep.blocked': {
    de: 'Eine Anzahlungsrechnung braucht die Reservierung des Folios: '
      + 'ohne sie fehlt der Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG). '
      + 'Ein geschlossenes Folio nimmt keine mehr an.',
    en: 'A deposit invoice needs the reservation behind the folio: without '
      + 'it there is no service period (§ 14 (4) no. 6 UStG). A closed '
      + 'folio accepts none.' },
  'vz.dep.tax': {
    de: 'Steuer',
    en: 'Tax' },
  'vz.dep.tax.derive': {
    de: 'aus dem Aufenthalt ableiten',
    en: 'derive from the stay' },
  'vz.dep.tax.single': {
    de: 'ein Satz für alles',
    en: 'one rate for everything' },
  'vz.dep.tax.split': {
    de: 'aufteilen',
    en: 'split' },
  'vz.dep.tax.deriveHint': {
    de: 'Abgeleitet aus dem erwarteten Aufenthalt: die Übernachtung '
      + 'trägt 7 %, Frühstück und Extras ihren eigenen Satz. Eine '
      + 'Anzahlung ist ein pauschaler Betrag, die Leistung dahinter '
      + 'ist es nicht — ausgewiesen werden muss sie trotzdem schon '
      + 'jetzt (§ 14 Abs. 5 UStG).',
    en: 'Derived from the expected stay: accommodation carries 7 %, '
      + 'breakfast and extras carry their own. A deposit is a lump '
      + 'sum, the service behind it is not — and it has to be shown '
      + 'already (§ 14 (5) UStG).' },
  'vz.dep.tax.splitHint': {
    de: 'Die Teile müssen den vereinnahmten Betrag auf den Cent ergeben.',
    en: 'The parts have to add up to the amount received, to the cent.' },
  'vz.dep.tax.sum': {
    de: 'Summe der Teile',
    en: 'Sum of the parts' },
  'vz.dep.tax.add': {
    de: 'Teil hinzufügen',
    en: 'Add part' },
  'vz.dep.tax.remove': {
    de: 'Entfernen',
    en: 'Remove' },
  'vz.dep.issue': {
    de: 'Erstellen',
    en: 'Issue' },
  'vz.dep.issued': {
    de: 'Anzahlungsrechnung erstellt',
    en: 'Deposit invoice issued' },
  'vz.dep.appliedTo': {
    de: 'verrechnet auf',
    en: 'applied to' },
  'vz.dep.notApplied': {
    de: 'noch nicht verrechnet',
    en: 'not applied yet' },
  'vz.dep.applyHint': {
    de: 'Verrechnet wird auf der Schlussrechnung, und zwar als Position: '
      + 'sie mindert die zu zahlende Summe, nicht den Steuerausweis.',
    en: 'It is applied on the final invoice, and as a line item: it '
      + 'reduces the amount payable, not the tax shown.' },
  'vz.dep.hasInvoice': {
    de: 'Anzahlungsrechnung',
    en: 'Deposit invoice' },
  'vz.link.title': {
    de: 'Zahlungslink',
    en: 'Payment link' },
  'vz.link.amount': {
    de: 'Betrag',
    en: 'Amount' },
  'vz.link.create': {
    de: 'Link erzeugen',
    en: 'Create link' },
  'vz.link.hint': {
    de: 'Ein Link ist keine Zahlung. Der Zahlungsvermerk entsteht erst, wenn '
      + 'der Zahlungsdienstleister den Eingang meldet — bis dahin steht der '
      + 'Link auf „offen“, auch wenn der Gast ihn schon geöffnet hat.',
    en: 'A link is not a payment. The payment is recorded only once the '
      + 'provider reports it — until then the link stays “open”, even if the '
      + 'guest has already opened it.' },
  'vz.link.address': {
    de: 'Adresse',
    en: 'Address' },
  'vz.link.copy': {
    de: 'Kopieren',
    en: 'Copy' },
  'vz.link.copied': {
    de: 'Kopiert',
    en: 'Copied' },
  'vz.link.once': {
    de: 'Diese Adresse wird nur jetzt gezeigt. Sie wird nicht gespeichert — '
      + 'ein gespeicherter Link ist ein Link, den jeder mit Lesezugriff '
      + 'einlösen kann. Wer ihn noch einmal braucht, erzeugt einen neuen.',
    en: 'This address is shown now and never again. It is not stored — a '
      + 'stored link is a link anyone with read access can redeem. Create a '
      + 'new one if you need it again.' },
  'vz.link.none': {
    de: 'Kein Zahlungslink.',
    en: 'No payment link.' },
  'vz.link.status.pending': {
    de: 'offen',
    en: 'open' },
  'vz.link.status.succeeded': {
    de: 'bezahlt',
    en: 'paid' },
  'vz.link.status.failed': {
    de: 'fehlgeschlagen',
    en: 'failed' },
  'vz.link.notConfigured': {
    de: 'Es ist kein Zahlungsdienstleister eingerichtet. '
      + 'Ohne ihn gibt es keinen Zahlungslink; eine Garantie läuft '
      + 'dann über das virtuelle Terminal des Anbieters.',
    en: 'No payment provider is configured. Without one there is no '
      + 'payment link; a guarantee then runs through the provider’s '
      + 'virtual terminal.' },
  'vz.link.noCard': {
    de: 'Kartendaten werden hier nie erfasst und nie gespeichert. '
      + 'Der Gast gibt sie beim Zahlungsdienstleister ein.',
    en: 'Card data is never captured and never stored here. The guest '
      + 'enters it at the payment provider.' },

  // Rechnungsempfänger (S6)
  'emp.title': {
    de: 'Rechnungsempfänger',
    en: 'Invoice recipient' },
  'emp.none': {
    de: 'niemand hinterlegt',
    en: 'nobody set' },
  'emp.guest': {
    de: 'Gast',
    en: 'Guest' },
  'emp.company': {
    de: 'Firma',
    en: 'Company' },
  'emp.change': {
    de: 'Ändern',
    en: 'Change' },
  'emp.close': {
    de: 'Schließen',
    en: 'Close' },
  'emp.noAddress': {
    de: 'ohne Anschrift — so lässt sich keine Rechnung schreiben',
    en: 'no address — no invoice can be issued like this' },
  'emp.guestPick': {
    de: 'An diesen Gast',
    en: 'To this guest' },
  'emp.guestHint': {
    de: 'Das ist nicht zwingend der Gast des Aufenthalts: der steht an der '
      + 'Reservierung. Hier steht, an wen abgerechnet wird — der Ehepartner '
      + 'zahlt, der Gast reist.',
    en: 'Not necessarily the guest of the stay — that one is on the '
      + 'reservation. This is who gets billed: the spouse pays, the guest '
      + 'travels.' },
  'emp.companyPick': {
    de: 'An diese Firma',
    en: 'To this company' },
  'emp.companySearch': {
    de: 'Name der Firma, ab zwei Zeichen',
    en: 'Company name, from two characters' },
  'emp.companyNone': {
    de: 'Keine Firma gefunden.',
    en: 'No company found.' },
  'emp.companyClear': {
    de: 'Firma entfernen',
    en: 'Remove company' },
  'emp.snapshotHint': {
    de: 'Wirkt auf die nächste Rechnung. Eine festgeschriebene trägt '
      + 'ihren Empfänger als Momentaufnahme und ändert sich nie wieder; '
      + 'dort hilft nur eine Stornorechnung.',
    en: 'Applies to the next invoice. An issued one carries its '
      + 'recipient as a snapshot and never changes; there only a credit '
      + 'note helps.' },
} as const satisfies Record<string, LocalizedText>
