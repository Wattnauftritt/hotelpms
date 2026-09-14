/** Berichte: Kennzahlen, Nachtlauf, Statistik, Ausgaben. */
export const berichte = {
  de: {
    'nav.reports': 'Berichte',
    'report.title': 'Berichte',
    'report.tab.kpi': 'Kennzahlen',
    'report.tab.audit': 'Nachtlauf',
    'report.tab.statistics': 'Beherbergung',
    'report.tab.exports': 'Ausgaben',
    'report.nothingAllowed': 'Dieses Konto hat in diesem Haus kein Recht auf Berichte.',

    'kpi.occupancy': 'Belegung',
    'kpi.adr': 'ADR',
    'kpi.revpar': 'RevPAR',
    'kpi.sold': 'Verkauft',
    'kpi.available': 'Verfügbar',
    'kpi.revenue': 'Logiserlös',
    'kpi.adrHint': 'Logiserlös je verkaufter Einheit.',
    'kpi.revparHint': 'Logiserlös je verfügbarer Einheit. Der Unterschied zum ADR '
                    + 'ist der Punkt: ein hoher ADR bei leeren Zimmern verdient nichts.',
    'kpi.compare': 'Vorjahr vergleichen',
    'kpi.previousYear': 'Vorjahr',
    'kpi.change': 'Veränderung',
    'kpi.period': 'Zeitraum',
    'kpi.source': 'Quelle',
    'kpi.source.recorded': 'aufgezeichnet',
    'kpi.source.books': 'auf den Büchern',
    'kpi.sourceHint': 'Vergangene Tage stehen fest; ab dem offenen Geschäftstag ist '
                    + 'es der Stand der Bücher und ändert sich noch.',

    'audit.businessDate': 'Geschäftsdatum',
    'audit.openDay': 'Offener Tag',
    'audit.daysBehind': 'Rückstand',
    'audit.days': 'Tage',
    'audit.ok': 'Der Nachtlauf ist aktuell.',
    'audit.overdue': 'Der Nachtlauf ist im Rückstand. Ohne ihn fehlt die Logis auf '
                   + 'den Folios, und es fällt erst dem Gast beim Check-out auf.',
    'audit.noOpenDay': 'Für dieses Haus ist kein Geschäftstag geöffnet. Bis das '
                     + 'behoben ist, läuft nichts, was ein Geschäftsdatum braucht.',
    'audit.steps': 'Schritte',
    'audit.complete': 'vollständig',
    'audit.incomplete': 'unvollständig',
    'audit.closed': 'abgeschlossen',
    'audit.open': 'offen',
    'audit.noSteps': 'Kein Schritt gelaufen',
    'audit.step.rollover': 'Tageswechsel',
    'audit.step.post_accommodation': 'Logis buchen',
    'audit.step.post_city_tax': 'Kurtaxe buchen',
    'audit.step.no_shows': 'No-Shows setzen',
    'audit.step.expire_options': 'Optionen verfallen',
    'audit.step.release_blocks': 'Kontingente freigeben',
    'audit.step.statistics': 'Kennzahlen festschreiben',

    'stat.month': 'Monat',
    'stat.rooms': 'Zimmer',
    'stat.beds': 'Schlafgelegenheiten',
    'stat.required': 'Meldepflichtig ab zehn Schlafgelegenheiten.',
    'stat.notRequired': 'Nicht meldepflichtig: weniger als zehn Schlafgelegenheiten.',
    'stat.country': 'Wohnsitzland',
    'stat.arrivals': 'Ankünfte',
    'stat.nights': 'Übernachtungen',
    'stat.total': 'Zusammen',
    'stat.unknownCountry': 'Kein Wohnsitzland erfasst',

    'export.datev': 'DATEV-Buchungsstapel',
    'export.datevHint': 'CSV im Format EXTF. Zahlungen stehen nicht im Stapel; sie '
                      + 'werden über Kasse oder Bank gebucht.',
    'export.gobd': 'GoBD-Export',
    'export.gobdHint': 'Rechnungen, Positionen und Verrechnungen des Zeitraums in '
                     + 'offener Form, mit Feldbeschreibung.',
    'export.tenant': 'Mandantenexport',
    'export.tenantHint': 'Alles, was zu diesem Haus gehört, in JSON. Die Daten '
                       + 'gehören dem Betrieb, nicht uns.',
    'export.consultantNumber': 'Beraternummer',
    'export.clientNumber': 'Mandantennummer',
    'export.start': 'Ausgeben',
    'export.running': 'Wird erzeugt…',
    'export.training': 'Ein Übungshaus gibt nichts nach draußen. Ein Stapel aus '
                     + 'Übungsdaten ist in der echten Buchhaltung schwerer zu '
                     + 'entfernen als zu verhindern.'
  },
  en: {
    'nav.reports': 'Reports',
    'report.title': 'Reports',
    'report.tab.kpi': 'Key figures',
    'report.tab.audit': 'Night audit',
    'report.tab.statistics': 'Accommodation',
    'report.tab.exports': 'Exports',
    'report.nothingAllowed': 'This account has no reporting rights in this property.',

    'kpi.occupancy': 'Occupancy',
    'kpi.adr': 'ADR',
    'kpi.revpar': 'RevPAR',
    'kpi.sold': 'Sold',
    'kpi.available': 'Available',
    'kpi.revenue': 'Room revenue',
    'kpi.adrHint': 'Room revenue per unit sold.',
    'kpi.revparHint': 'Room revenue per unit available. The difference to ADR is the '
                    + 'whole point: a high ADR with empty rooms earns nothing.',
    'kpi.compare': 'Compare previous year',
    'kpi.previousYear': 'Previous year',
    'kpi.change': 'Change',
    'kpi.period': 'Period',
    'kpi.source': 'Source',
    'kpi.source.recorded': 'recorded',
    'kpi.source.books': 'on the books',
    'kpi.sourceHint': 'Past days are settled; from the open business day onwards it '
                    + 'is the state of the books and still changes.',

    'audit.businessDate': 'Business date',
    'audit.openDay': 'Open day',
    'audit.daysBehind': 'Behind by',
    'audit.days': 'days',
    'audit.ok': 'The night audit is up to date.',
    'audit.overdue': 'The night audit is behind. Without it accommodation is missing '
                   + 'from the folios, and the guest notices at check-out.',
    'audit.noOpenDay': 'No business day is open for this property. Until that is '
                     + 'fixed nothing that needs a business date will run.',
    'audit.steps': 'Steps',
    'audit.complete': 'complete',
    'audit.incomplete': 'incomplete',
    'audit.closed': 'closed',
    'audit.open': 'open',
    'audit.noSteps': 'No step has run',
    'audit.step.rollover': 'Date rollover',
    'audit.step.post_accommodation': 'Post accommodation',
    'audit.step.post_city_tax': 'Post city tax',
    'audit.step.no_shows': 'Mark no-shows',
    'audit.step.expire_options': 'Expire options',
    'audit.step.release_blocks': 'Release blocks',
    'audit.step.statistics': 'Record key figures',

    'stat.month': 'Month',
    'stat.rooms': 'Rooms',
    'stat.beds': 'Beds',
    'stat.required': 'Reporting is required from ten beds upwards.',
    'stat.notRequired': 'Not required to report: fewer than ten beds.',
    'stat.country': 'Country of residence',
    'stat.arrivals': 'Arrivals',
    'stat.nights': 'Nights',
    'stat.total': 'Total',
    'stat.unknownCountry': 'No country of residence recorded',

    'export.datev': 'DATEV posting batch',
    'export.datevHint': 'CSV in EXTF format. Payments are not in the batch; they are '
                      + 'posted through cash or bank.',
    'export.gobd': 'GoBD export',
    'export.gobdHint': 'Invoices, charges and settlements of the period in open form, '
                     + 'with a description of the fields.',
    'export.tenant': 'Tenant export',
    'export.tenantHint': 'Everything belonging to this property, as JSON. The data '
                       + 'belongs to the business, not to us.',
    'export.consultantNumber': 'Consultant number',
    'export.clientNumber': 'Client number',
    'export.start': 'Export',
    'export.running': 'Generating…',
    'export.training': 'A training property sends nothing outside. A batch of '
                     + 'practice data is harder to remove from real bookkeeping than '
                     + 'to prevent.'
  }
} as const
