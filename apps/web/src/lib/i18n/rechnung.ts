/** Rechnungsliste, Beleg, Versand (Spur B). */
export const rechnung = {
  de: {
    'nav.invoices': 'Rechnungen',
    'inv.title': 'Rechnungen',
    'inv.kind': 'Art',
    'inv.kind.all': 'alle',
    'inv.kind.final': 'Schlussrechnung',
    'inv.kind.interim': 'Zwischenrechnung',
    'inv.kind.deposit': 'Anzahlung',
    'inv.kind.credit_note': 'Gutschrift',
    'inv.number': 'Nummer',
    'inv.issuedOn': 'Ausgestellt',
    'inv.recipient': 'Empfänger',
    'inv.amount': 'Betrag',
    'inv.document': 'Beleg',
    'inv.document.ready': 'fertig',
    'inv.document.pending': 'wird erzeugt',
    'inv.document.noXml': 'ohne XML',
    'inv.document.noXmlHint': 'Kleinbetragsrechnungen und Rechnungen ohne USt-IdNr. '
                            + 'des Hauses tragen kein EN-16931-XML. Der Beleg ist gültig.',
    'inv.show': 'Ansehen',
    'inv.hide': 'Schließen',
    'inv.download': 'Herunterladen',
    'inv.folio': 'Gastkonto',
    'inv.send': 'Verschicken',
    'inv.send.to': 'Abweichende Adresse',
    'inv.send.toHint': 'Leer lassen, dann geht sie an die Adresse am Gast- oder '
                     + 'Firmenprofil.',
    'inv.send.again': 'Noch einmal verschicken',
    'inv.send.queued': 'Eingereiht',
    'inv.send.alreadyHint': 'Diese Rechnung ist bereits verschickt oder eingereiht. '
                          + 'Ein zweiter Versand muss ausdrücklich gewollt sein.',
    'inv.mail.pending': 'eingereiht',
    'inv.mail.sent': 'verschickt',
    'inv.mail.failed': 'fehlgeschlagen',
    'inv.mail.canceled': 'zurückgezogen',
    'inv.outbox': 'Postausgang',
    'inv.outbox.empty': 'Nichts im Postausgang.',
    'inv.outbox.cancel': 'Zurückziehen',
    'inv.outbox.attempts': 'Versuche',
    'inv.none': 'Keine Rechnung in diesem Zeitraum.',
    'inv.paymentHint': 'Ob eine Rechnung bezahlt ist, steht am Gastkonto: eine Zahlung '
                     + 'wird dort vermerkt, nicht an der Rechnung.',

    // Vorauszahlung: Anzahlungsrechnung und Zahlungslink (B8, B9)
    'vz.title': 'Vorauszahlung',
    'vz.open': 'Anzahlung und Zahlungslink',
    'vz.close': 'Schließen',
    'vz.dep.title': 'Anzahlungsrechnungen',
    'vz.dep.none': 'Noch keine Anzahlungsrechnung.',
    'vz.dep.new': 'Anzahlungsrechnung erstellen',
    'vz.dep.settlement': 'Zahlungseingang',
    'vz.dep.noneOpen': 'Zu jedem Zahlungseingang gibt es schon eine Anzahlungsrechnung. '
                     + 'Eine Anzahlung wird erst vermerkt und dann fakturiert.',
    'vz.dep.blocked': 'Eine Anzahlungsrechnung braucht die Reservierung des Folios: '
                    + 'ohne sie fehlt der Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG). '
                    + 'Ein geschlossenes Folio nimmt keine mehr an.',
    'vz.dep.tax': 'Steuer',
    'vz.dep.tax.derive': 'aus dem Aufenthalt ableiten',
    'vz.dep.tax.single': 'ein Satz für alles',
    'vz.dep.tax.split': 'aufteilen',
    'vz.dep.tax.deriveHint': 'Abgeleitet aus dem erwarteten Aufenthalt: die Übernachtung '
                           + 'trägt 7 %, Frühstück und Extras ihren eigenen Satz. Eine '
                           + 'Anzahlung ist ein pauschaler Betrag, die Leistung dahinter '
                           + 'ist es nicht — ausgewiesen werden muss sie trotzdem schon '
                           + 'jetzt (§ 14 Abs. 5 UStG).',
    'vz.dep.tax.splitHint': 'Die Teile müssen den vereinnahmten Betrag auf den Cent ergeben.',
    'vz.dep.tax.sum': 'Summe der Teile',
    'vz.dep.tax.add': 'Teil hinzufügen',
    'vz.dep.tax.remove': 'Entfernen',
    'vz.dep.issue': 'Erstellen',
    'vz.dep.issued': 'Anzahlungsrechnung erstellt',
    'vz.dep.appliedTo': 'verrechnet auf',
    'vz.dep.notApplied': 'noch nicht verrechnet',
    'vz.dep.applyHint': 'Verrechnet wird auf der Schlussrechnung, und zwar als Position: '
                      + 'sie mindert die zu zahlende Summe, nicht den Steuerausweis.',
    'vz.dep.hasInvoice': 'Anzahlungsrechnung',
    'vz.link.title': 'Zahlungslink',
    'vz.link.amount': 'Betrag',
    'vz.link.create': 'Link erzeugen',
    'vz.link.hint': 'Ein Link ist keine Zahlung. Der Zahlungsvermerk entsteht erst, wenn '
                  + 'der Zahlungsdienstleister den Eingang meldet — bis dahin steht der '
                  + 'Link auf „offen“, auch wenn der Gast ihn schon geöffnet hat.',
    'vz.link.address': 'Adresse',
    'vz.link.copy': 'Kopieren',
    'vz.link.copied': 'Kopiert',
    'vz.link.once': 'Diese Adresse wird nur jetzt gezeigt. Sie wird nicht gespeichert — '
                  + 'ein gespeicherter Link ist ein Link, den jeder mit Lesezugriff '
                  + 'einlösen kann. Wer ihn noch einmal braucht, erzeugt einen neuen.',
    'vz.link.none': 'Kein Zahlungslink.',
    'vz.link.status.pending': 'offen',
    'vz.link.status.succeeded': 'bezahlt',
    'vz.link.status.failed': 'fehlgeschlagen',
    'vz.link.notConfigured': 'Es ist kein Zahlungsdienstleister eingerichtet. '
                           + 'Ohne ihn gibt es keinen Zahlungslink; eine Garantie läuft '
                           + 'dann über das virtuelle Terminal des Anbieters.',
    'vz.link.noCard': 'Kartendaten werden hier nie erfasst und nie gespeichert. '
                    + 'Der Gast gibt sie beim Zahlungsdienstleister ein.'
  },
  en: {
    'nav.invoices': 'Invoices',
    'inv.title': 'Invoices',
    'inv.kind': 'Type',
    'inv.kind.all': 'all',
    'inv.kind.final': 'Final invoice',
    'inv.kind.interim': 'Interim invoice',
    'inv.kind.deposit': 'Deposit',
    'inv.kind.credit_note': 'Credit note',
    'inv.number': 'Number',
    'inv.issuedOn': 'Issued',
    'inv.recipient': 'Recipient',
    'inv.amount': 'Amount',
    'inv.document': 'Document',
    'inv.document.ready': 'ready',
    'inv.document.pending': 'being created',
    'inv.document.noXml': 'without XML',
    'inv.document.noXmlHint': 'Small-amount invoices and invoices without the '
                            + 'property VAT ID carry no EN 16931 XML. The document is valid.',
    'inv.show': 'View',
    'inv.hide': 'Close',
    'inv.download': 'Download',
    'inv.folio': 'Guest account',
    'inv.send': 'Send',
    'inv.send.to': 'Different address',
    'inv.send.toHint': 'Leave empty to use the address on the guest or company profile.',
    'inv.send.again': 'Send again',
    'inv.send.queued': 'Queued',
    'inv.send.alreadyHint': 'This invoice has already been sent or queued. '
                          + 'Sending it again has to be deliberate.',
    'inv.mail.pending': 'queued',
    'inv.mail.sent': 'sent',
    'inv.mail.failed': 'failed',
    'inv.mail.canceled': 'withdrawn',
    'inv.outbox': 'Outbox',
    'inv.outbox.empty': 'Nothing in the outbox.',
    'inv.outbox.cancel': 'Withdraw',
    'inv.outbox.attempts': 'attempts',
    'inv.none': 'No invoice in this period.',
    'inv.paymentHint': 'Whether an invoice is paid is shown on the guest account: '
                     + 'a payment is recorded there, not on the invoice.',

    'vz.title': 'Prepayment',
    'vz.open': 'Deposit and payment link',
    'vz.close': 'Close',
    'vz.dep.title': 'Deposit invoices',
    'vz.dep.none': 'No deposit invoice yet.',
    'vz.dep.new': 'Issue deposit invoice',
    'vz.dep.settlement': 'Payment received',
    'vz.dep.noneOpen': 'Every payment already has a deposit invoice. A deposit is '
                     + 'recorded first and invoiced afterwards.',
    'vz.dep.blocked': 'A deposit invoice needs the reservation behind the folio: without '
                    + 'it there is no service period (§ 14 (4) no. 6 UStG). A closed '
                    + 'folio accepts none.',
    'vz.dep.tax': 'Tax',
    'vz.dep.tax.derive': 'derive from the stay',
    'vz.dep.tax.single': 'one rate for everything',
    'vz.dep.tax.split': 'split',
    'vz.dep.tax.deriveHint': 'Derived from the expected stay: accommodation carries 7 %, '
                           + 'breakfast and extras carry their own. A deposit is a lump '
                           + 'sum, the service behind it is not — and it has to be shown '
                           + 'already (§ 14 (5) UStG).',
    'vz.dep.tax.splitHint': 'The parts have to add up to the amount received, to the cent.',
    'vz.dep.tax.sum': 'Sum of the parts',
    'vz.dep.tax.add': 'Add part',
    'vz.dep.tax.remove': 'Remove',
    'vz.dep.issue': 'Issue',
    'vz.dep.issued': 'Deposit invoice issued',
    'vz.dep.appliedTo': 'applied to',
    'vz.dep.notApplied': 'not applied yet',
    'vz.dep.applyHint': 'It is applied on the final invoice, and as a line item: it '
                      + 'reduces the amount payable, not the tax shown.',
    'vz.dep.hasInvoice': 'Deposit invoice',
    'vz.link.title': 'Payment link',
    'vz.link.amount': 'Amount',
    'vz.link.create': 'Create link',
    'vz.link.hint': 'A link is not a payment. The payment is recorded only once the '
                  + 'provider reports it — until then the link stays “open”, even if the '
                  + 'guest has already opened it.',
    'vz.link.address': 'Address',
    'vz.link.copy': 'Copy',
    'vz.link.copied': 'Copied',
    'vz.link.once': 'This address is shown now and never again. It is not stored — a '
                  + 'stored link is a link anyone with read access can redeem. Create a '
                  + 'new one if you need it again.',
    'vz.link.none': 'No payment link.',
    'vz.link.status.pending': 'open',
    'vz.link.status.succeeded': 'paid',
    'vz.link.status.failed': 'failed',
    'vz.link.notConfigured': 'No payment provider is configured. Without one there is no '
                           + 'payment link; a guarantee then runs through the provider’s '
                           + 'virtual terminal.',
    'vz.link.noCard': 'Card data is never captured and never stored here. The guest '
                    + 'enters it at the payment provider.'
  }
} as const
