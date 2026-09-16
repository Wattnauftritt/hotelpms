import type { LocalizedText } from '@hotelpms/contracts'

/** Rechnungsliste, Beleg, Versand (Spur B). */
export const rechnung = {
  'nav.invoices': {
    de: 'Rechnungen',
    en: 'Invoices',
    tr: 'Faturalar' },
  'inv.title': {
    de: 'Rechnungen',
    en: 'Invoices',
    tr: 'Faturalar' },
  'inv.kind': {
    de: 'Art',
    en: 'Type',
    tr: 'Tür' },
  'inv.kind.all': {
    de: 'alle',
    en: 'all',
    tr: 'hepsi' },
  'inv.kind.final': {
    de: 'Schlussrechnung',
    en: 'Final invoice',
    tr: 'Nihai fatura' },
  'inv.kind.interim': {
    de: 'Zwischenrechnung',
    en: 'Interim invoice',
    tr: 'Ara fatura' },
  'inv.kind.deposit': {
    de: 'Anzahlung',
    en: 'Deposit',
    tr: 'Ön ödeme' },
  'inv.kind.credit_note': {
    de: 'Gutschrift',
    en: 'Credit note',
    tr: 'İade faturası' },
  'inv.number': {
    de: 'Nummer',
    en: 'Number',
    tr: 'Numara' },
  'inv.issuedOn': {
    de: 'Ausgestellt',
    en: 'Issued',
    tr: 'Düzenlendi' },
  'inv.recipient': {
    de: 'Empfänger',
    en: 'Recipient',
    tr: 'Alıcı' },
  'inv.amount': {
    de: 'Betrag',
    en: 'Amount',
    tr: 'Tutar' },
  'inv.document': {
    de: 'Beleg',
    en: 'Document',
    tr: 'Belge' },
  'inv.document.ready': {
    de: 'fertig',
    en: 'ready',
    tr: 'hazır' },
  'inv.document.pending': {
    de: 'wird erzeugt',
    en: 'being created',
    tr: 'oluşturuluyor' },
  'inv.document.noXml': {
    de: 'ohne XML',
    en: 'without XML',
    tr: 'XML yok' },
  'inv.document.noXmlHint': {
    de: 'Kleinbetragsrechnungen und Rechnungen ohne USt-IdNr. '
      + 'des Hauses tragen kein EN-16931-XML. Der Beleg ist gültig.',
    en: 'Small-amount invoices and invoices without the '
      + 'property VAT ID carry no EN 16931 XML. The document is valid.',
    tr: 'Küçük tutarlı faturalar ve tesisin USt-IdNr. bilgisi olmayan faturalar EN-16931 XML taşımaz. Belge geçerlidir.' },
  'inv.show': {
    de: 'Ansehen',
    en: 'View',
    tr: 'Görüntüle' },
  'inv.hide': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'inv.download': {
    de: 'Herunterladen',
    en: 'Download',
    tr: 'İndir' },
  'inv.folio': {
    de: 'Gastkonto',
    en: 'Guest account',
    tr: 'Misafir hesabı' },
  'inv.send': {
    de: 'Verschicken',
    en: 'Send',
    tr: 'Gönder' },
  'inv.send.to': {
    de: 'Abweichende Adresse',
    en: 'Different address',
    tr: 'Farklı adres' },
  'inv.send.toHint': {
    de: 'Leer lassen, dann geht sie an die Adresse am Gast- oder '
      + 'Firmenprofil.',
    en: 'Leave empty to use the address on the guest or company profile.',
    tr: 'Boş bırakırsanız misafir veya firma profilindeki adrese gider.' },
  'inv.send.again': {
    de: 'Noch einmal verschicken',
    en: 'Send again',
    tr: 'Yeniden gönder' },
  'inv.send.queued': {
    de: 'Eingereiht',
    en: 'Queued',
    tr: 'Kuyruğa alındı' },
  'inv.send.alreadyHint': {
    de: 'Diese Rechnung ist bereits verschickt oder eingereiht. '
      + 'Ein zweiter Versand muss ausdrücklich gewollt sein.',
    en: 'This invoice has already been sent or queued. '
      + 'Sending it again has to be deliberate.',
    tr: 'Bu fatura zaten gönderilmiş veya kuyruğa alınmış. İkinci bir gönderim açıkça istenmiş olmalıdır.' },
  'inv.mail.pending': {
    de: 'eingereiht',
    en: 'queued',
    tr: 'kuyrukta' },
  'inv.mail.sent': {
    de: 'verschickt',
    en: 'sent',
    tr: 'gönderildi' },
  'inv.mail.failed': {
    de: 'fehlgeschlagen',
    en: 'failed',
    tr: 'başarısız' },
  'inv.mail.canceled': {
    de: 'zurückgezogen',
    en: 'withdrawn',
    tr: 'geri çekildi' },
  'inv.outbox': {
    de: 'Postausgang',
    en: 'Outbox',
    tr: 'Giden kutusu' },
  'inv.outbox.empty': {
    de: 'Nichts im Postausgang.',
    en: 'Nothing in the outbox.',
    tr: 'Giden kutusunda bir şey yok.' },
  'inv.outbox.cancel': {
    de: 'Zurückziehen',
    en: 'Withdraw',
    tr: 'Geri çek' },
  'inv.outbox.attempts': {
    de: 'Versuche',
    en: 'attempts',
    tr: 'Deneme' },
  'inv.none': {
    de: 'Keine Rechnung in diesem Zeitraum.',
    en: 'No invoice in this period.',
    tr: 'Bu dönemde fatura yok.' },
  'inv.paid': {
    de: 'bezahlt',
    en: 'paid',
    tr: 'ödendi' },
  'inv.open': {
    de: 'offen',
    en: 'open',
    tr: 'açık' },
  'inv.settled': {
    de: 'davon vermerkt',
    en: 'of which recorded',
    tr: 'bunun kaydedilen kısmı' },
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
      + 'the guest account balance is the truth.',
    tr: 'Bir ödeme, fatura kesinleştirilirken ve ödeme kaydedilirken eşleştirilir. Bu eşleştirmeden önceki ödemeler fatura numarası taşımaz ve sonradan eklenemez — böyle faturalar ödenmiş olsalar bile burada açık görünür. Şüphe hâlinde misafir hesabındaki bakiye geçerlidir.' },

  // Vorauszahlung: Anzahlungsrechnung und Zahlungslink (B8, B9)
  'vz.title': {
    de: 'Vorauszahlung',
    en: 'Prepayment',
    tr: 'Ön ödeme' },
  'vz.open': {
    de: 'Anzahlung und Zahlungslink',
    en: 'Deposit and payment link',
    tr: 'Ön ödeme ve ödeme bağlantısı' },
  'vz.close': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'vz.dep.title': {
    de: 'Anzahlungsrechnungen',
    en: 'Deposit invoices',
    tr: 'Ön ödeme faturaları' },
  'vz.dep.none': {
    de: 'Noch keine Anzahlungsrechnung.',
    en: 'No deposit invoice yet.',
    tr: 'Henüz ön ödeme faturası yok.' },
  'vz.dep.new': {
    de: 'Anzahlungsrechnung erstellen',
    en: 'Issue deposit invoice',
    tr: 'Ön ödeme faturası oluştur' },
  'vz.dep.settlement': {
    de: 'Zahlungseingang',
    en: 'Payment received',
    tr: 'Tahsilat' },
  'vz.dep.noneOpen': {
    de: 'Zu jedem Zahlungseingang gibt es schon eine Anzahlungsrechnung. '
      + 'Eine Anzahlung wird erst vermerkt und dann fakturiert.',
    en: 'Every payment already has a deposit invoice. A deposit is '
      + 'recorded first and invoiced afterwards.',
    tr: 'Her tahsilat için zaten bir ön ödeme faturası var. Ön ödeme önce kaydedilir, sonra faturalanır.' },
  'vz.dep.blocked': {
    de: 'Eine Anzahlungsrechnung braucht die Reservierung des Folios: '
      + 'ohne sie fehlt der Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG). '
      + 'Ein geschlossenes Folio nimmt keine mehr an.',
    en: 'A deposit invoice needs the reservation behind the folio: without '
      + 'it there is no service period (§ 14 (4) no. 6 UStG). A closed '
      + 'folio accepts none.',
    tr: 'Ön ödeme faturası, folionun rezervasyonunu gerektirir: o olmadan hizmet dönemi eksik kalır (§ 14 Abs. 4 Nr. 6 UStG). Kapalı bir folio artık kabul etmez.' },
  'vz.dep.tax': {
    de: 'Steuer',
    en: 'Tax',
    tr: 'Vergi' },
  'vz.dep.tax.derive': {
    de: 'aus dem Aufenthalt ableiten',
    en: 'derive from the stay',
    tr: 'konaklamadan türet' },
  'vz.dep.tax.single': {
    de: 'ein Satz für alles',
    en: 'one rate for everything',
    tr: 'her şey için tek oran' },
  'vz.dep.tax.split': {
    de: 'aufteilen',
    en: 'split',
    tr: 'böl' },
  'vz.dep.tax.deriveHint': {
    de: 'Abgeleitet aus dem erwarteten Aufenthalt: die Übernachtung '
      + 'trägt 7 %, Frühstück und Extras ihren eigenen Satz. Eine '
      + 'Anzahlung ist ein pauschaler Betrag, die Leistung dahinter '
      + 'ist es nicht — ausgewiesen werden muss sie trotzdem schon '
      + 'jetzt (§ 14 Abs. 5 UStG).',
    en: 'Derived from the expected stay: accommodation carries 7 %, '
      + 'breakfast and extras carry their own. A deposit is a lump '
      + 'sum, the service behind it is not — and it has to be shown '
      + 'already (§ 14 (5) UStG).',
    tr: 'Beklenen konaklamadan türetilir: geceleme %7 taşır, kahvaltı ve ekstralar kendi oranını. Ön ödeme götürü bir tutardır, arkasındaki hizmet ise değildir — yine de daha şimdiden gösterilmesi gerekir (§ 14 Abs. 5 UStG).' },
  'vz.dep.tax.splitHint': {
    de: 'Die Teile müssen den vereinnahmten Betrag auf den Cent ergeben.',
    en: 'The parts have to add up to the amount received, to the cent.',
    tr: 'Parçalar, tahsil edilen tutarı kuruşu kuruşuna vermelidir.' },
  'vz.dep.tax.sum': {
    de: 'Summe der Teile',
    en: 'Sum of the parts',
    tr: 'Parçaların toplamı' },
  'vz.dep.tax.add': {
    de: 'Teil hinzufügen',
    en: 'Add part',
    tr: 'Parça ekle' },
  'vz.dep.tax.remove': {
    de: 'Entfernen',
    en: 'Remove',
    tr: 'Kaldır' },
  'vz.dep.issue': {
    de: 'Erstellen',
    en: 'Issue',
    tr: 'Oluştur' },
  'vz.dep.issued': {
    de: 'Anzahlungsrechnung erstellt',
    en: 'Deposit invoice issued',
    tr: 'Ön ödeme faturası oluşturuldu' },
  'vz.dep.appliedTo': {
    de: 'verrechnet auf',
    en: 'applied to',
    tr: 'şuna mahsup edildi:' },
  'vz.dep.notApplied': {
    de: 'noch nicht verrechnet',
    en: 'not applied yet',
    tr: 'henüz mahsup edilmedi' },
  'vz.dep.applyHint': {
    de: 'Verrechnet wird auf der Schlussrechnung, und zwar als Position: '
      + 'sie mindert die zu zahlende Summe, nicht den Steuerausweis.',
    en: 'It is applied on the final invoice, and as a line item: it '
      + 'reduces the amount payable, not the tax shown.',
    tr: 'Mahsup, nihai faturada ve bir kalem olarak yapılır: ödenecek toplamı azaltır, vergi gösterimini değil.' },
  'vz.dep.hasInvoice': {
    de: 'Anzahlungsrechnung',
    en: 'Deposit invoice',
    tr: 'Ön ödeme faturası' },
  'vz.link.title': {
    de: 'Zahlungslink',
    en: 'Payment link',
    tr: 'Ödeme bağlantısı' },
  'vz.link.amount': {
    de: 'Betrag',
    en: 'Amount',
    tr: 'Tutar' },
  'vz.link.create': {
    de: 'Link erzeugen',
    en: 'Create link',
    tr: 'Bağlantı oluştur' },
  'vz.link.hint': {
    de: 'Ein Link ist keine Zahlung. Der Zahlungsvermerk entsteht erst, wenn '
      + 'der Zahlungsdienstleister den Eingang meldet — bis dahin steht der '
      + 'Link auf „offen“, auch wenn der Gast ihn schon geöffnet hat.',
    en: 'A link is not a payment. The payment is recorded only once the '
      + 'provider reports it — until then the link stays “open”, even if the '
      + 'guest has already opened it.',
    tr: 'Bağlantı ödeme demek değildir. Ödeme kaydı ancak ödeme sağlayıcısı tahsilatı bildirdiğinde oluşur — o ana kadar bağlantı „açık“ durur, misafir onu açmış olsa bile.' },
  'vz.link.address': {
    de: 'Adresse',
    en: 'Address',
    tr: 'Adres' },
  'vz.link.copy': {
    de: 'Kopieren',
    en: 'Copy',
    tr: 'Kopyala' },
  'vz.link.copied': {
    de: 'Kopiert',
    en: 'Copied',
    tr: 'Kopyalandı' },
  'vz.link.once': {
    de: 'Diese Adresse wird nur jetzt gezeigt. Sie wird nicht gespeichert — '
      + 'ein gespeicherter Link ist ein Link, den jeder mit Lesezugriff '
      + 'einlösen kann. Wer ihn noch einmal braucht, erzeugt einen neuen.',
    en: 'This address is shown now and never again. It is not stored — a '
      + 'stored link is a link anyone with read access can redeem. Create a '
      + 'new one if you need it again.',
    tr: 'Bu adres yalnızca şimdi gösterilir. Saklanmaz — saklanan bir bağlantı, okuma yetkisi olan herkesin kullanabileceği bir bağlantıdır. Yeniden ihtiyaç duyan yenisini oluşturur.' },
  'vz.link.none': {
    de: 'Kein Zahlungslink.',
    en: 'No payment link.',
    tr: 'Ödeme bağlantısı yok.' },
  'vz.link.status.pending': {
    de: 'offen',
    en: 'open',
    tr: 'açık' },
  'vz.link.status.succeeded': {
    de: 'bezahlt',
    en: 'paid',
    tr: 'ödendi' },
  'vz.link.status.failed': {
    de: 'fehlgeschlagen',
    en: 'failed',
    tr: 'başarısız' },
  'vz.link.notConfigured': {
    de: 'Es ist kein Zahlungsdienstleister eingerichtet. '
      + 'Ohne ihn gibt es keinen Zahlungslink; eine Garantie läuft '
      + 'dann über das virtuelle Terminal des Anbieters.',
    en: 'No payment provider is configured. Without one there is no '
      + 'payment link; a guarantee then runs through the provider’s '
      + 'virtual terminal.',
    tr: 'Kurulu bir ödeme sağlayıcısı yok. O olmadan ödeme bağlantısı da olmaz; teminat o durumda sağlayıcının sanal terminali üzerinden alınır.' },
  'vz.link.noCard': {
    de: 'Kartendaten werden hier nie erfasst und nie gespeichert. '
      + 'Der Gast gibt sie beim Zahlungsdienstleister ein.',
    en: 'Card data is never captured and never stored here. The guest '
      + 'enters it at the payment provider.',
    tr: 'Kart bilgileri burada asla alınmaz ve asla saklanmaz. Misafir onları ödeme sağlayıcısında girer.' },

  // Rechnungsempfänger (S6)
  'emp.title': {
    de: 'Rechnungsempfänger',
    en: 'Invoice recipient',
    tr: 'Fatura alıcısı' },
  'emp.none': {
    de: 'niemand hinterlegt',
    en: 'nobody set',
    tr: 'kayıtlı kimse yok' },
  'emp.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'emp.company': {
    de: 'Firma',
    en: 'Company',
    tr: 'Firma' },
  'emp.change': {
    de: 'Ändern',
    en: 'Change',
    tr: 'Değiştir' },
  'emp.close': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'emp.noAddress': {
    de: 'ohne Anschrift — so lässt sich keine Rechnung schreiben',
    en: 'no address — no invoice can be issued like this',
    tr: 'adressiz — böyle fatura yazılamaz' },
  'emp.guestPick': {
    de: 'An diesen Gast',
    en: 'To this guest',
    tr: 'Bu misafire' },
  'emp.guestHint': {
    de: 'Das ist nicht zwingend der Gast des Aufenthalts: der steht an der '
      + 'Reservierung. Hier steht, an wen abgerechnet wird — der Ehepartner '
      + 'zahlt, der Gast reist.',
    en: 'Not necessarily the guest of the stay — that one is on the '
      + 'reservation. This is who gets billed: the spouse pays, the guest '
      + 'travels.',
    tr: 'Bu, zorunlu olarak konaklayan misafir değildir: o rezervasyonda durur. Burada kime fatura kesileceği yazar — eş öder, misafir konaklar.' },
  'emp.companyPick': {
    de: 'An diese Firma',
    en: 'To this company',
    tr: 'Bu firmaya' },
  'emp.companySearch': {
    de: 'Name der Firma, ab zwei Zeichen',
    en: 'Company name, from two characters',
    tr: 'Firma adı, iki karakterden itibaren' },
  'emp.companyNone': {
    de: 'Keine Firma gefunden.',
    en: 'No company found.',
    tr: 'Firma bulunamadı.' },
  'emp.companyClear': {
    de: 'Firma entfernen',
    en: 'Remove company',
    tr: 'Firmayı kaldır' },
  'emp.snapshotHint': {
    de: 'Wirkt auf die nächste Rechnung. Eine festgeschriebene trägt '
      + 'ihren Empfänger als Momentaufnahme und ändert sich nie wieder; '
      + 'dort hilft nur eine Stornorechnung.',
    en: 'Applies to the next invoice. An issued one carries its '
      + 'recipient as a snapshot and never changes; there only a credit '
      + 'note helps.',
    tr: 'Bir sonraki faturayı etkiler. Kesinleşmiş bir fatura alıcısını anlık görüntü olarak taşır ve bir daha değişmez; orada yalnızca iptal faturası çare olur.' },
} as const satisfies Record<string, LocalizedText>
