import type { LocalizedText } from '@hotelpms/contracts'

/** Berichte: Kennzahlen, Nachtlauf, Statistik, Ausgaben. */
export const berichte = {
  'nav.reports': {
    de: 'Berichte',
    en: 'Reports',
    tr: 'Raporlar' },
  'report.title': {
    de: 'Berichte',
    en: 'Reports',
    tr: 'Raporlar' },
  'report.tab.kpi': {
    de: 'Kennzahlen',
    en: 'Key figures',
    tr: 'Göstergeler' },
  'report.tab.audit': {
    de: 'Nachtlauf',
    en: 'Night audit',
    tr: 'Gece işlemi' },
  'report.tab.statistics': {
    de: 'Beherbergung',
    en: 'Accommodation',
    tr: 'Konaklama' },
  'report.tab.exports': {
    de: 'Ausgaben',
    en: 'Exports',
    tr: 'Aktarımlar' },
  'report.nothingAllowed': {
    de: 'Dieses Konto hat in diesem Haus kein Recht auf Berichte.',
    en: 'This account has no reporting rights in this property.',
    tr: 'Bu hesabın bu tesiste rapor görme yetkisi yok.' },

  'kpi.occupancy': {
    de: 'Belegung',
    en: 'Occupancy',
    tr: 'Doluluk' },
  'kpi.adr': {
    de: 'ADR',
    en: 'ADR',
    tr: 'ADR' },
  'kpi.revpar': {
    de: 'RevPAR',
    en: 'RevPAR',
    tr: 'RevPAR' },
  'kpi.sold': {
    de: 'Verkauft',
    en: 'Sold',
    tr: 'Satılan' },
  'kpi.available': {
    de: 'Verfügbar',
    en: 'Available',
    tr: 'Müsait' },
  'kpi.revenue': {
    de: 'Logiserlös',
    en: 'Room revenue',
    tr: 'Konaklama geliri' },
  'kpi.adrHint': {
    de: 'Logiserlös je verkaufter Einheit.',
    en: 'Room revenue per unit sold.',
    tr: 'Satılan birim başına konaklama geliri.' },
  'kpi.revparHint': {
    de: 'Logiserlös je verfügbarer Einheit. Der Unterschied zum ADR '
      + 'ist der Punkt: ein hoher ADR bei leeren Zimmern verdient nichts.',
    en: 'Room revenue per unit available. The difference to ADR is the '
      + 'whole point: a high ADR with empty rooms earns nothing.',
    tr: 'Müsait birim başına konaklama geliri. ADR ile farkı asıl noktadır: odalar boşken yüksek bir ADR hiçbir şey kazandırmaz.' },
  'kpi.compare': {
    de: 'Vorjahr vergleichen',
    en: 'Compare previous year',
    tr: 'Geçen yılla karşılaştır' },
  'kpi.previousYear': {
    de: 'Vorjahr',
    en: 'Previous year',
    tr: 'Geçen yıl' },
  'kpi.change': {
    de: 'Veränderung',
    en: 'Change',
    tr: 'Değişim' },
  'kpi.period': {
    de: 'Zeitraum',
    en: 'Period',
    tr: 'Dönem' },
  'kpi.source': {
    de: 'Quelle',
    en: 'Source',
    tr: 'Kaynak' },
  'kpi.source.recorded': {
    de: 'aufgezeichnet',
    en: 'recorded',
    tr: 'kayda geçmiş' },
  'kpi.source.books': {
    de: 'auf den Büchern',
    en: 'on the books',
    tr: 'defterlerdeki hâliyle' },
  'kpi.sourceHint': {
    de: 'Vergangene Tage stehen fest; ab dem offenen Geschäftstag ist '
      + 'es der Stand der Bücher und ändert sich noch.',
    en: 'Past days are settled; from the open business day onwards it '
      + 'is the state of the books and still changes.',
    tr: 'Geçmiş günler kesindir; açık işletme gününden itibaren defterlerin o anki durumudur ve daha değişir.' },

  'audit.businessDate': {
    de: 'Geschäftsdatum',
    en: 'Business date',
    tr: 'İşletme tarihi' },
  'audit.openDay': {
    de: 'Offener Tag',
    en: 'Open day',
    tr: 'Açık gün' },
  'audit.daysBehind': {
    de: 'Rückstand',
    en: 'Behind by',
    tr: 'Gecikme' },
  'audit.days': {
    de: 'Tage',
    en: 'days',
    tr: 'gün' },
  'audit.ok': {
    de: 'Der Nachtlauf ist aktuell.',
    en: 'The night audit is up to date.',
    tr: 'Gece işlemi güncel.' },
  'audit.overdue': {
    de: 'Der Nachtlauf ist im Rückstand. Ohne ihn fehlt die Logis auf '
      + 'den Folios, und es fällt erst dem Gast beim Check-out auf.',
    en: 'The night audit is behind. Without it accommodation is missing '
      + 'from the folios, and the guest notices at check-out.',
    tr: 'Gece işlemi geride kaldı. O çalışmadan foliolarda konaklama bedeli eksik kalır ve bu ancak misafirin çıkışında fark edilir.' },
  'audit.noOpenDay': {
    de: 'Für dieses Haus ist kein Geschäftstag geöffnet. Bis das '
      + 'behoben ist, läuft nichts, was ein Geschäftsdatum braucht.',
    en: 'No business day is open for this property. Until that is '
      + 'fixed nothing that needs a business date will run.',
    tr: 'Bu tesis için açık bir işletme günü yok. Bu giderilene kadar işletme tarihine ihtiyaç duyan hiçbir şey çalışmaz.' },
  'audit.steps': {
    de: 'Schritte',
    en: 'Steps',
    tr: 'Adımlar' },
  'audit.complete': {
    de: 'vollständig',
    en: 'complete',
    tr: 'tamamlandı' },
  'audit.incomplete': {
    de: 'unvollständig',
    en: 'incomplete',
    tr: 'eksik' },
  'audit.closed': {
    de: 'abgeschlossen',
    en: 'closed',
    tr: 'kapatıldı' },
  'audit.open': {
    de: 'offen',
    en: 'open',
    tr: 'açık' },
  'audit.noSteps': {
    de: 'Kein Schritt gelaufen',
    en: 'No step has run',
    tr: 'Hiçbir adım çalışmadı' },
  'audit.step.rollover': {
    de: 'Tageswechsel',
    en: 'Date rollover',
    tr: 'Gün değişimi' },
  'audit.step.post_accommodation': {
    de: 'Logis buchen',
    en: 'Post accommodation',
    tr: 'Konaklama bedelini kaydet' },
  'audit.step.post_city_tax': {
    de: 'Kurtaxe buchen',
    en: 'Post city tax',
    tr: 'Konaklama vergisini kaydet' },
  'audit.step.no_shows': {
    de: 'No-Shows setzen',
    en: 'Mark no-shows',
    tr: 'No-Show olarak işaretle' },
  'audit.step.expire_options': {
    de: 'Optionen verfallen',
    en: 'Expire options',
    tr: 'Opsiyonların süresini doldur' },
  'audit.step.release_blocks': {
    de: 'Kontingente freigeben',
    en: 'Release blocks',
    tr: 'Kontenjanları serbest bırak' },
  'audit.step.statistics': {
    de: 'Kennzahlen festschreiben',
    en: 'Record key figures',
    tr: 'Göstergeleri kesinleştir' },

  'stat.month': {
    de: 'Monat',
    en: 'Month',
    tr: 'Ay' },
  'stat.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Oda' },
  'stat.beds': {
    de: 'Schlafgelegenheiten',
    en: 'Beds',
    tr: 'Yatak sayısı' },
  'stat.required': {
    de: 'Meldepflichtig ab zehn Schlafgelegenheiten.',
    en: 'Reporting is required from ten beds upwards.',
    tr: 'On yataktan itibaren bildirim zorunludur.' },
  'stat.notRequired': {
    de: 'Nicht meldepflichtig: weniger als zehn Schlafgelegenheiten.',
    en: 'Not required to report: fewer than ten beds.',
    tr: 'Bildirim zorunlu değil: on yataktan az.' },
  'stat.country': {
    de: 'Wohnsitzland',
    en: 'Country of residence',
    tr: 'İkamet ülkesi' },
  'stat.arrivals': {
    de: 'Ankünfte',
    en: 'Arrivals',
    tr: 'Gelişler' },
  'stat.nights': {
    de: 'Übernachtungen',
    en: 'Nights',
    tr: 'Geceleme' },
  'stat.total': {
    de: 'Zusammen',
    en: 'Total',
    tr: 'Toplam' },
  'stat.unknownCountry': {
    de: 'Kein Wohnsitzland erfasst',
    en: 'No country of residence recorded',
    tr: 'İkamet ülkesi kaydedilmemiş' },

  'export.datev': {
    de: 'DATEV-Buchungsstapel',
    en: 'DATEV posting batch',
    tr: 'DATEV kayıt paketi' },
  'export.datevHint': {
    de: 'CSV im Format EXTF. Zahlungen stehen nicht im Stapel; sie '
      + 'werden über Kasse oder Bank gebucht.',
    en: 'CSV in EXTF format. Payments are not in the batch; they are '
      + 'posted through cash or bank.',
    tr: 'EXTF biçiminde CSV. Ödemeler pakette yer almaz; onlar kasa veya banka üzerinden kaydedilir.' },
  'export.gobd': {
    de: 'GoBD-Export',
    en: 'GoBD export',
    tr: 'GoBD aktarımı' },
  'export.gobdHint': {
    de: 'Rechnungen, Positionen und Verrechnungen des Zeitraums in '
      + 'offener Form, mit Feldbeschreibung.',
    en: 'Invoices, charges and settlements of the period in open form, '
      + 'with a description of the fields.',
    tr: 'Dönemin faturaları, kalemleri ve mahsupları açık biçimde, alan açıklamalarıyla birlikte.' },
  'export.tenant': {
    de: 'Mandantenexport',
    en: 'Tenant export',
    tr: 'Mandant aktarımı' },
  'export.tenantHint': {
    de: 'Alles, was zu diesem Haus gehört, in JSON. Die Daten '
      + 'gehören dem Betrieb, nicht uns.',
    en: 'Everything belonging to this property, as JSON. The data '
      + 'belongs to the business, not to us.',
    tr: 'Bu tesise ait olan her şey, JSON olarak. Veriler işletmenindir, bizim değil.' },
  'export.consultantNumber': {
    de: 'Beraternummer',
    en: 'Consultant number',
    tr: 'Müşavir numarası' },
  'export.clientNumber': {
    de: 'Mandantennummer',
    en: 'Client number',
    tr: 'Mandant numarası' },
  'export.start': {
    de: 'Ausgeben',
    en: 'Export',
    tr: 'Aktar' },
  'export.running': {
    de: 'Wird erzeugt…',
    en: 'Generating…',
    tr: 'Oluşturuluyor…' },
  'export.training': {
    de: 'Ein Übungshaus gibt nichts nach draußen. Ein Stapel aus '
      + 'Übungsdaten ist in der echten Buchhaltung schwerer zu '
      + 'entfernen als zu verhindern.',
    en: 'A training property sends nothing outside. A batch of '
      + 'practice data is harder to remove from real bookkeeping than '
      + 'to prevent.',
    tr: 'Eğitim tesisi dışarıya hiçbir şey vermez. Alıştırma verilerinden oluşan bir paketi gerçek muhasebeden çıkarmak, onu baştan önlemekten daha zordur.' },
} as const satisfies Record<string, LocalizedText>
