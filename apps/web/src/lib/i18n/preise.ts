import type { LocalizedText } from '@hotelpms/contracts'

/** Preisraster, Massenänderung, Restriktionen (Spur B). */
export const preise = {
  'nav.rates': {
    de: 'Preise',
    en: 'Rates' },
  'rate.title': {
    de: 'Preise und Restriktionen',
    en: 'Rates and restrictions' },
  'rate.plan': {
    de: 'Ratenplan',
    en: 'Rate plan' },
  'rate.days': {
    de: 'Zeitraum',
    en: 'Period' },
  'rate.days.30': {
    de: '30 Tage',
    en: '30 days' },
  'rate.days.90': {
    de: '90 Tage',
    en: '90 days' },
  'rate.days.180': {
    de: '180 Tage',
    en: '180 days' },
  'rate.days.400': {
    de: '400 Tage',
    en: '400 days' },
  'rate.occupancy': {
    de: 'Belegung',
    en: 'Occupancy' },
  'rate.occupancy.n': {
    de: 'Personen',
    en: 'guests' },
  'rate.noPlans': {
    de: 'Für dieses Haus ist kein Ratenplan angelegt.',
    en: 'No rate plan exists for this property.' },
  'rate.noPrice': {
    de: 'kein Preis',
    en: 'no price' },
  'rate.derived': {
    de: 'abgeleitet',
    en: 'derived' },
  'rate.selection': {
    de: 'Auswahl',
    en: 'Selection' },
  'rate.selection.none': {
    de: 'Kein Bereich gewählt. Im Raster über die Tage ziehen '
      + 'oder den Zeitraum unten eintragen.',
    en: 'No range selected. Drag across the days in the grid '
      + 'or enter the period below.' },
  'rate.selection.days': {
    de: 'Tage',
    en: 'days' },
  'rate.weekdays': {
    de: 'Nur an',
    en: 'Only on' },
  'rate.weekdays.all': {
    de: 'allen Tagen',
    en: 'all days' },
  'rate.setPrice': {
    de: 'Preis setzen',
    en: 'Set price' },
  'rate.price.perOccupancy': {
    de: 'Preis je Belegung',
    en: 'Price per occupancy' },
  'rate.price.person': {
    de: 'Person',
    en: 'guest' },
  'rate.price.persons': {
    de: 'Personen',
    en: 'guests' },
  'rate.preview': {
    de: 'Vorschau',
    en: 'Preview' },
  'rate.preview.again': {
    de: 'Vorschau erneuern',
    en: 'Refresh preview' },
  'rate.preview.affected': {
    de: 'betroffene Tage',
    en: 'days affected' },
  'rate.preview.changed': {
    de: 'davon mit abweichendem Preis',
    en: 'of those with a different price' },
  'rate.preview.unchanged': {
    de: 'unverändert',
    en: 'unchanged' },
  'rate.preview.required': {
    de: 'Erst ansehen, dann übernehmen.',
    en: 'Look first, then apply.' },
  'rate.preview.stale': {
    de: 'Die Eingabe hat sich geändert. Vorschau erneuern.',
    en: 'The input changed. Refresh the preview.' },
  'rate.apply': {
    de: 'Übernehmen',
    en: 'Apply' },
  'rate.applied': {
    de: 'Tage geschrieben',
    en: 'days written' },
  'rate.hint.bulk': {
    de: 'Preise einer bestätigten Buchung bleiben, wie sie waren. '
      + 'Eine Änderung hier wirkt nur auf neue Buchungen.',
    en: 'A confirmed booking keeps the price it was made at. '
      + 'A change here only affects new bookings.' },
  'rate.restrictions': {
    de: 'Restriktionen',
    en: 'Restrictions' },
  'rate.minLos': {
    de: 'Mindestaufenthalt',
    en: 'Minimum stay' },
  'rate.maxLos': {
    de: 'Höchstaufenthalt',
    en: 'Maximum stay' },
  'rate.closed': {
    de: 'Geschlossen',
    en: 'Closed' },
  'rate.cta': {
    de: 'Keine Anreise',
    en: 'No arrival' },
  'rate.ctd': {
    de: 'Keine Abreise',
    en: 'No departure' },
  'rate.unchangedField': {
    de: 'unverändert',
    en: 'unchanged' },
  'rate.clear': {
    de: 'löschen',
    en: 'clear' },
  'rate.legend': {
    de: 'G geschlossen · A keine Anreise · B keine Abreise · n Mindestaufenthalt',
    en: 'G closed · A no arrival · B no departure · n minimum stay' },
  'rate.plans': {
    de: 'Ratenpläne',
    en: 'Rate plans' },
  'rate.plan.new': {
    de: 'Ratenplan anlegen',
    en: 'Create a rate plan' },
  'rate.plan.code': {
    de: 'Kürzel',
    en: 'Code' },
  'rate.plan.name': {
    de: 'Name',
    en: 'Name' },
  'rate.plan.base': {
    de: 'Abgeleitet von',
    en: 'Derived from' },
  'rate.plan.base.none': {
    de: 'eigenständig',
    en: 'standalone' },
  'rate.plan.deriveKind': {
    de: 'Ableitung',
    en: 'Derivation' },
  'rate.plan.derive.amount': {
    de: 'Betrag in Cent',
    en: 'Amount in cents' },
  'rate.plan.derive.percent': {
    de: 'Prozent',
    en: 'Percent' },
  'rate.plan.deriveValue': {
    de: 'Wert',
    en: 'Value' },
  'rate.plan.deriveHint': {
    de: 'Negativ heißt günstiger: −15 Prozent oder −1000 Cent.',
    en: 'Negative means cheaper: −15 percent or −1000 cents.' },
  'rate.plan.emptyHint': {
    de: 'Eine abgeleitete Rate steht leer da, bis einmal neu '
      + 'gerechnet wurde — ihre Preise liegen als Zahlen vor, '
      + 'nicht als Formel.',
    en: 'A derived rate stays empty until it has been rebuilt once — '
      + 'its prices are stored as numbers, not as a formula.' },
  'rate.rebuild': {
    de: 'Abgeleitete Raten neu rechnen',
    en: 'Rebuild derived rates' },
  'rate.rebuild.done': {
    de: 'Tage neu gerechnet, über',
    en: 'days rebuilt, across' },
  'rate.rebuild.plan': {
    de: 'abgeleitete Rate',
    en: 'derived rate' },
  'rate.rebuild.plans': {
    de: 'abgeleitete Raten',
    en: 'derived rates' },

  // Was der Channel Manager sieht (B10)
  'cv.title': {
    de: 'Was der Channel Manager sieht',
    en: 'What the channel manager sees' },
  'cv.open': {
    de: 'Auslieferung zu diesem Zeitraum ansehen',
    en: 'Show what goes out for this period' },
  'cv.intro': {
    de: 'Dieselbe Antwort, die der Channel Manager über die Schnittstelle '
      + 'bekommt — nur lesbar dargestellt. Das Raster darüber zeigt den '
      + 'Pflegestand; hier steht, was das Haus verlässt.',
    en: 'The same answer the channel manager gets over the interface — just '
      + 'readable. The grid above shows what is maintained; this shows what '
      + 'leaves the property.' },
  'cv.generatedAt': {
    de: 'Stand',
    en: 'As of' },
  'cv.availability': {
    de: 'Verfügbarkeit',
    en: 'Availability' },
  'cv.rates': {
    de: 'Preise und Restriktionen',
    en: 'Rates and restrictions' },
  'cv.noPrice': {
    de: 'ohne Preis',
    en: 'without a price' },
  'cv.noPriceHint': {
    de: 'Ein Tag ohne Preis geht als „kein Preis“ hinaus und wird drüben '
      + 'nicht verkauft. Das ist der häufigste Grund dafür, dass bei einem '
      + 'Portal nichts oder etwas anderes steht.',
    en: 'A day without a price goes out as “no price” and is not sold over '
      + 'there. That is the most common reason a portal shows nothing or '
      + 'something else.' },
  'cv.closedDays': {
    de: 'gesperrt',
    en: 'closed' },
  'cv.inactiveHint': {
    de: 'Ein stillgelegter Ratenplan steht hier gar nicht: er geht '
      + 'nicht hinaus, auch wenn im Raster noch Preise an ihm hängen.',
    en: 'An inactive rate plan does not appear here at all: it does not '
      + 'go out, even if the grid still carries prices for it.' },
  'cv.days': {
    de: 'Tage',
    en: 'days' },
  'cv.raw': {
    de: 'Rohdaten dieses Tages',
    en: 'Raw answer for this day' },
  'cv.raw.hint': {
    de: 'Ein Klick auf ein Datum zeigt die Antwort zu diesem Tag so, wie sie '
      + 'über die Leitung geht.',
    en: 'Clicking a date shows the answer for that day exactly as it goes '
      + 'over the wire.' },
  'cv.raw.close': {
    de: 'Schließen',
    en: 'Close' },
  'cv.empty': {
    de: 'Zu diesem Zeitraum geht nichts hinaus.',
    en: 'Nothing goes out for this period.' },
} as const satisfies Record<string, LocalizedText>
