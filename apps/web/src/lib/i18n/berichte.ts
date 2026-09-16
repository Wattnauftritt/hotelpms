import type { LocalizedText } from '@hotelpms/contracts'

/** Berichte: Kennzahlen, Nachtlauf, Statistik, Ausgaben. */
export const berichte = {
  'nav.reports': {
    de: 'Berichte',
    en: 'Reports' },
  'report.title': {
    de: 'Berichte',
    en: 'Reports' },
  'report.tab.kpi': {
    de: 'Kennzahlen',
    en: 'Key figures' },
  'report.tab.audit': {
    de: 'Nachtlauf',
    en: 'Night audit' },
  'report.tab.statistics': {
    de: 'Beherbergung',
    en: 'Accommodation' },
  'report.tab.exports': {
    de: 'Ausgaben',
    en: 'Exports' },
  'report.nothingAllowed': {
    de: 'Dieses Konto hat in diesem Haus kein Recht auf Berichte.',
    en: 'This account has no reporting rights in this property.' },

  'kpi.occupancy': {
    de: 'Belegung',
    en: 'Occupancy' },
  'kpi.adr': {
    de: 'ADR',
    en: 'ADR' },
  'kpi.revpar': {
    de: 'RevPAR',
    en: 'RevPAR' },
  'kpi.sold': {
    de: 'Verkauft',
    en: 'Sold' },
  'kpi.available': {
    de: 'Verfügbar',
    en: 'Available' },
  'kpi.revenue': {
    de: 'Logiserlös',
    en: 'Room revenue' },
  'kpi.adrHint': {
    de: 'Logiserlös je verkaufter Einheit.',
    en: 'Room revenue per unit sold.' },
  'kpi.revparHint': {
    de: 'Logiserlös je verfügbarer Einheit. Der Unterschied zum ADR '
      + 'ist der Punkt: ein hoher ADR bei leeren Zimmern verdient nichts.',
    en: 'Room revenue per unit available. The difference to ADR is the '
      + 'whole point: a high ADR with empty rooms earns nothing.' },
  'kpi.compare': {
    de: 'Vorjahr vergleichen',
    en: 'Compare previous year' },
  'kpi.previousYear': {
    de: 'Vorjahr',
    en: 'Previous year' },
  'kpi.change': {
    de: 'Veränderung',
    en: 'Change' },
  'kpi.period': {
    de: 'Zeitraum',
    en: 'Period' },
  'kpi.source': {
    de: 'Quelle',
    en: 'Source' },
  'kpi.source.recorded': {
    de: 'aufgezeichnet',
    en: 'recorded' },
  'kpi.source.books': {
    de: 'auf den Büchern',
    en: 'on the books' },
  'kpi.sourceHint': {
    de: 'Vergangene Tage stehen fest; ab dem offenen Geschäftstag ist '
      + 'es der Stand der Bücher und ändert sich noch.',
    en: 'Past days are settled; from the open business day onwards it '
      + 'is the state of the books and still changes.' },

  'audit.businessDate': {
    de: 'Geschäftsdatum',
    en: 'Business date' },
  'audit.openDay': {
    de: 'Offener Tag',
    en: 'Open day' },
  'audit.daysBehind': {
    de: 'Rückstand',
    en: 'Behind by' },
  'audit.days': {
    de: 'Tage',
    en: 'days' },
  'audit.ok': {
    de: 'Der Nachtlauf ist aktuell.',
    en: 'The night audit is up to date.' },
  'audit.overdue': {
    de: 'Der Nachtlauf ist im Rückstand. Ohne ihn fehlt die Logis auf '
      + 'den Folios, und es fällt erst dem Gast beim Check-out auf.',
    en: 'The night audit is behind. Without it accommodation is missing '
      + 'from the folios, and the guest notices at check-out.' },
  'audit.noOpenDay': {
    de: 'Für dieses Haus ist kein Geschäftstag geöffnet. Bis das '
      + 'behoben ist, läuft nichts, was ein Geschäftsdatum braucht.',
    en: 'No business day is open for this property. Until that is '
      + 'fixed nothing that needs a business date will run.' },
  'audit.steps': {
    de: 'Schritte',
    en: 'Steps' },
  'audit.complete': {
    de: 'vollständig',
    en: 'complete' },
  'audit.incomplete': {
    de: 'unvollständig',
    en: 'incomplete' },
  'audit.closed': {
    de: 'abgeschlossen',
    en: 'closed' },
  'audit.open': {
    de: 'offen',
    en: 'open' },
  'audit.noSteps': {
    de: 'Kein Schritt gelaufen',
    en: 'No step has run' },
  'audit.step.rollover': {
    de: 'Tageswechsel',
    en: 'Date rollover' },
  'audit.step.post_accommodation': {
    de: 'Logis buchen',
    en: 'Post accommodation' },
  'audit.step.post_city_tax': {
    de: 'Kurtaxe buchen',
    en: 'Post city tax' },
  'audit.step.no_shows': {
    de: 'No-Shows setzen',
    en: 'Mark no-shows' },
  'audit.step.expire_options': {
    de: 'Optionen verfallen',
    en: 'Expire options' },
  'audit.step.release_blocks': {
    de: 'Kontingente freigeben',
    en: 'Release blocks' },
  'audit.step.statistics': {
    de: 'Kennzahlen festschreiben',
    en: 'Record key figures' },

  'stat.month': {
    de: 'Monat',
    en: 'Month' },
  'stat.rooms': {
    de: 'Zimmer',
    en: 'Rooms' },
  'stat.beds': {
    de: 'Schlafgelegenheiten',
    en: 'Beds' },
  'stat.required': {
    de: 'Meldepflichtig ab zehn Schlafgelegenheiten.',
    en: 'Reporting is required from ten beds upwards.' },
  'stat.notRequired': {
    de: 'Nicht meldepflichtig: weniger als zehn Schlafgelegenheiten.',
    en: 'Not required to report: fewer than ten beds.' },
  'stat.country': {
    de: 'Wohnsitzland',
    en: 'Country of residence' },
  'stat.arrivals': {
    de: 'Ankünfte',
    en: 'Arrivals' },
  'stat.nights': {
    de: 'Übernachtungen',
    en: 'Nights' },
  'stat.total': {
    de: 'Zusammen',
    en: 'Total' },
  'stat.unknownCountry': {
    de: 'Kein Wohnsitzland erfasst',
    en: 'No country of residence recorded' },

  'export.datev': {
    de: 'DATEV-Buchungsstapel',
    en: 'DATEV posting batch' },
  'export.datevHint': {
    de: 'CSV im Format EXTF. Zahlungen stehen nicht im Stapel; sie '
      + 'werden über Kasse oder Bank gebucht.',
    en: 'CSV in EXTF format. Payments are not in the batch; they are '
      + 'posted through cash or bank.' },
  'export.gobd': {
    de: 'GoBD-Export',
    en: 'GoBD export' },
  'export.gobdHint': {
    de: 'Rechnungen, Positionen und Verrechnungen des Zeitraums in '
      + 'offener Form, mit Feldbeschreibung.',
    en: 'Invoices, charges and settlements of the period in open form, '
      + 'with a description of the fields.' },
  'export.tenant': {
    de: 'Mandantenexport',
    en: 'Tenant export' },
  'export.tenantHint': {
    de: 'Alles, was zu diesem Haus gehört, in JSON. Die Daten '
      + 'gehören dem Betrieb, nicht uns.',
    en: 'Everything belonging to this property, as JSON. The data '
      + 'belongs to the business, not to us.' },
  'export.consultantNumber': {
    de: 'Beraternummer',
    en: 'Consultant number' },
  'export.clientNumber': {
    de: 'Mandantennummer',
    en: 'Client number' },
  'export.start': {
    de: 'Ausgeben',
    en: 'Export' },
  'export.running': {
    de: 'Wird erzeugt…',
    en: 'Generating…' },
  'export.training': {
    de: 'Ein Übungshaus gibt nichts nach draußen. Ein Stapel aus '
      + 'Übungsdaten ist in der echten Buchhaltung schwerer zu '
      + 'entfernen als zu verhindern.',
    en: 'A training property sends nothing outside. A batch of '
      + 'practice data is harder to remove from real bookkeeping than '
      + 'to prevent.' },
} as const satisfies Record<string, LocalizedText>
