import type { LocalizedText } from '@hotelpms/contracts'

/** Preissteuerung: Regeln, Leitplanken, Vorschau, Verlauf (Dokument 32). */
export const preissteuerung = {
  'steer.tab.grid': {
    de: 'Preisraster',
    en: 'Rate grid',
    tr: 'Fiyat tablosu' },
  'steer.tab.steering': {
    de: 'Preissteuerung',
    en: 'Pricing rules',
    tr: 'Fiyat yönetimi' },
  'steer.title': {
    de: 'Preissteuerung',
    en: 'Pricing rules',
    tr: 'Fiyat yönetimi' },
  'steer.intro': {
    de: 'Regeln rechnen den Verkaufspreis aus dem Grundpreis, nie aus dem zuletzt '
      + 'gesteuerten Preis. Gebuchte Reservierungen behalten ihren Preis.',
    en: 'Rules derive the selling price from the base price, never from the last '
      + 'steered price. Existing reservations keep their price.',
    tr: 'Kurallar satış fiyatını taban fiyattan hesaplar, asla en son yönetilen '
      + 'fiyattan değil. Mevcut rezervasyonlar fiyatlarını korur.' },
  'steer.mode': {
    de: 'Modus',
    en: 'Mode',
    tr: 'Mod' },
  'steer.mode.suggest': {
    de: 'Vorschlag – übernommen wird von Hand',
    en: 'Suggest – prices are applied by hand',
    tr: 'Öneri – fiyatlar elle uygulanır' },
  'steer.mode.auto': {
    de: 'Automatisch – einmal je Geschäftstag, innerhalb der Leitplanken',
    en: 'Automatic – once per business day, within the guardrails',
    tr: 'Otomatik – her iş gününde bir kez, sınırlar içinde' },
  'steer.horizon': {
    de: 'Horizont (Tage)',
    en: 'Horizon (days)',
    tr: 'Ufuk (gün)' },
  'steer.businessDate': {
    de: 'Geschäftstag {datum}',
    en: 'Business day {datum}',
    tr: 'İş günü {datum}' },
  'steer.noBusinessDay': {
    de: 'Für dieses Haus ist kein Geschäftstag geöffnet. Ohne ihn lässt sich der '
      + 'Vorlauf nicht rechnen.',
    en: 'No business day is open for this property. Lead time cannot be computed '
      + 'without one.',
    tr: 'Bu tesis için açık bir iş günü yok. O olmadan öncelik süresi hesaplanamaz.' },
  'steer.saved': {
    de: 'Gespeichert.',
    en: 'Saved.',
    tr: 'Kaydedildi.' },

  // ----------------------------------------------------------- Ratenplaene
  'steer.plans': {
    de: 'Ratenpläne und Leitplanken',
    en: 'Rate plans and guardrails',
    tr: 'Fiyat planları ve sınırlar' },
  'steer.plans.hint': {
    de: 'Ein externes RMS kann einen Plan der Regeln nicht beschreiben, und die Regeln '
      + 'lassen einen extern geführten Plan in Ruhe. Leitplanken begrenzen, was die '
      + 'Regeln tun; den Grundpreis fassen sie nicht an.',
    en: 'An external RMS cannot write to a plan managed by rules, and the rules leave '
      + 'an externally managed plan alone. Guardrails limit what the rules do; they '
      + 'never touch the base price.',
    tr: 'Harici bir RMS kurallarla yönetilen bir plana yazamaz ve kurallar harici '
      + 'yönetilen bir plana dokunmaz. Sınırlar kuralların etkisini sınırlar; taban '
      + 'fiyata dokunmaz.' },
  'steer.source': {
    de: 'Preis führt',
    en: 'Price managed by',
    tr: 'Fiyatı yöneten' },
  'steer.source.manual': {
    de: 'von Hand',
    en: 'by hand',
    tr: 'elle' },
  'steer.source.rules': {
    de: 'Regeln',
    en: 'rules',
    tr: 'kurallar' },
  'steer.source.external': {
    de: 'externes RMS',
    en: 'external RMS',
    tr: 'harici RMS' },
  'steer.min': {
    de: 'Mindestpreis',
    en: 'Minimum price',
    tr: 'En düşük fiyat' },
  'steer.max': {
    de: 'Höchstpreis',
    en: 'Maximum price',
    tr: 'En yüksek fiyat' },
  'steer.rounding': {
    de: 'Rundung',
    en: 'Rounding',
    tr: 'Yuvarlama' },
  'steer.rounding.none': {
    de: 'centgenau',
    en: 'to the cent',
    tr: 'kuruşuna kadar' },
  'steer.rounding.euro': {
    de: 'volle Euro',
    en: 'whole euros',
    tr: 'tam avro' },
  'steer.rounding.ninety': {
    de: 'auf ,90',
    en: 'to .90',
    tr: ',90\'a' },
  'steer.maxStep': {
    de: 'Höchstens je Lauf (%)',
    en: 'At most per run (%)',
    tr: 'Çalışma başına en fazla (%)' },
  'steer.derived': {
    de: 'abgeleitet – folgt ihrer Basis',
    en: 'derived – follows its base',
    tr: 'türetilmiş – tabanını izler' },

  // ------------------------------------------------------------- Regeln
  'steer.rules': {
    de: 'Regeln',
    en: 'Rules',
    tr: 'Kurallar' },
  'steer.rules.hint': {
    de: 'Je Auslöser wirkt die stärkste passende Regel; verschiedene Auslöser '
      + 'addieren sich – alle auf den Grundpreis.',
    en: 'Per trigger the strongest matching rule applies; different triggers add up '
      + '– all on the base price.',
    tr: 'Her tetikleyici için en güçlü uygun kural geçerlidir; farklı tetikleyiciler '
      + 'toplanır – hepsi taban fiyat üzerinden.' },
  'steer.rules.none': {
    de: 'Noch keine Regel.',
    en: 'No rule yet.',
    tr: 'Henüz kural yok.' },
  'steer.rule.new': {
    de: 'Neue Regel',
    en: 'New rule',
    tr: 'Yeni kural' },
  'steer.rule.edit': {
    de: 'Bearbeiten',
    en: 'Edit',
    tr: 'Düzenle' },
  'steer.rule.editTitle': {
    de: 'Regel bearbeiten',
    en: 'Edit rule',
    tr: 'Kuralı düzenle' },
  'steer.rule.delete': {
    de: 'Entfernen',
    en: 'Remove',
    tr: 'Kaldır' },
  'steer.rule.inactive': {
    de: 'ausgeschaltet',
    en: 'switched off',
    tr: 'kapalı' },
  'steer.rule.name': {
    de: 'Bezeichnung (frei)',
    en: 'Label (optional)',
    tr: 'Ad (isteğe bağlı)' },
  'steer.rule.kind': {
    de: 'Auslöser',
    en: 'Trigger',
    tr: 'Tetikleyici' },
  'steer.kind.occupancy': {
    de: 'Belegung',
    en: 'Occupancy',
    tr: 'Doluluk' },
  'steer.kind.lead_time': {
    de: 'Vorlauf',
    en: 'Lead time',
    tr: 'Öncelik süresi' },
  'steer.kind.weekday': {
    de: 'Wochentag',
    en: 'Weekday',
    tr: 'Haftanın günü' },
  'steer.kind.period': {
    de: 'Zeitraum',
    en: 'Period',
    tr: 'Dönem' },
  'steer.rule.moreConditions': {
    de: 'Weitere Bedingungen – frei, es müssen alle gelten',
    en: 'More conditions – optional, all must hold',
    tr: 'Ek koşullar – isteğe bağlı, hepsi sağlanmalı' },
  'steer.rule.occMin': {
    de: 'Belegung ab (%)',
    en: 'Occupancy from (%)',
    tr: 'Doluluk en az (%)' },
  'steer.rule.occBelow': {
    de: 'Belegung unter (%)',
    en: 'Occupancy below (%)',
    tr: 'Doluluk altında (%)' },
  'steer.rule.scope': {
    de: 'gemessen an',
    en: 'measured on',
    tr: 'ölçüldüğü yer' },
  'steer.scope.category': {
    de: 'der Kategorie',
    en: 'the category',
    tr: 'kategori' },
  'steer.scope.house': {
    de: 'dem ganzen Haus',
    en: 'the whole property',
    tr: 'tüm tesis' },
  'steer.rule.leadMin': {
    de: 'Anreise frühestens in (Tagen)',
    en: 'Arrival at the earliest in (days)',
    tr: 'Varış en erken (gün sonra)' },
  'steer.rule.leadBelow': {
    de: 'Anreise in weniger als (Tagen)',
    en: 'Arrival in fewer than (days)',
    tr: 'Varış şu günden az (gün)' },
  'steer.rule.weekdays': {
    de: 'Wochentage',
    en: 'Weekdays',
    tr: 'Haftanın günleri' },
  'steer.rule.period': {
    de: 'Zeitraum',
    en: 'Period',
    tr: 'Dönem' },
  'steer.rule.target': {
    de: 'Gilt für',
    en: 'Applies to',
    tr: 'Geçerli olduğu' },
  'steer.target.all': {
    de: 'alle gesteuerten Pläne',
    en: 'all steered plans',
    tr: 'yönetilen tüm planlar' },
  'steer.target.plan': {
    de: 'nur {plan}',
    en: 'only {plan}',
    tr: 'yalnızca {plan}' },
  'steer.target.category': {
    de: 'nur Kategorie {kategorie}',
    en: 'only category {kategorie}',
    tr: 'yalnızca {kategorie} kategorisi' },
  'steer.rule.effect': {
    de: 'Wirkung',
    en: 'Effect',
    tr: 'Etki' },
  'steer.effect.up': {
    de: 'Aufschlag',
    en: 'Surcharge',
    tr: 'Artış' },
  'steer.effect.down': {
    de: 'Abschlag',
    en: 'Discount',
    tr: 'İndirim' },
  'steer.effect.percent': {
    de: 'Prozent',
    en: 'Percent',
    tr: 'Yüzde' },
  'steer.effect.amount': {
    de: 'Betrag (€)',
    en: 'Amount (€)',
    tr: 'Tutar (€)' },
  'steer.effect.value': {
    de: 'Wert',
    en: 'Value',
    tr: 'Değer' },
  'steer.rule.active': {
    de: 'eingeschaltet',
    en: 'switched on',
    tr: 'açık' },
  'steer.rule.reads': {
    de: 'So liest sich die Regel',
    en: 'The rule reads',
    tr: 'Kural şöyle okunur' },
  'steer.rule.incomplete': {
    de: 'Noch unvollständig: der Auslöser braucht seine Bedingung, die Wirkung einen Wert.',
    en: 'Not complete yet: the trigger needs its condition, the effect a value.',
    tr: 'Henüz eksik: tetikleyicinin koşulu, etkinin bir değeri olmalı.' },

  // Satzteile einer Regel. Ganze Saetze mit Platzhaltern, nie Woerter, die
  // zusammengesetzt werden: die Wortstellung ist in jeder Sprache eine andere.
  'steer.sentence': {
    de: 'Wenn {bedingungen}: {wirkung}',
    en: 'If {bedingungen}: {wirkung}',
    tr: '{bedingungen} ise: {wirkung}' },
  'steer.and': {
    de: ' und ',
    en: ' and ',
    tr: ' ve ' },
  'steer.cond.occMin.category': {
    de: 'die Belegung der Kategorie mindestens {pct} % beträgt',
    en: 'the category occupancy is at least {pct} %',
    tr: 'kategori doluluğu en az %{pct}' },
  'steer.cond.occMin.house': {
    de: 'die Belegung des Hauses mindestens {pct} % beträgt',
    en: 'the property occupancy is at least {pct} %',
    tr: 'tesis doluluğu en az %{pct}' },
  'steer.cond.occBelow.category': {
    de: 'die Belegung der Kategorie unter {pct} % liegt',
    en: 'the category occupancy is below {pct} %',
    tr: 'kategori doluluğu %{pct} altında' },
  'steer.cond.occBelow.house': {
    de: 'die Belegung des Hauses unter {pct} % liegt',
    en: 'the property occupancy is below {pct} %',
    tr: 'tesis doluluğu %{pct} altında' },
  'steer.cond.leadMin': {
    de: 'die Anreise mindestens {n} Tage entfernt ist',
    en: 'arrival is at least {n} days away',
    tr: 'varışa en az {n} gün var' },
  'steer.cond.leadBelow': {
    de: 'die Anreise in weniger als {n} Tagen ist',
    en: 'arrival is fewer than {n} days away',
    tr: 'varışa {n} günden az var' },
  'steer.cond.weekdays': {
    de: 'der Tag auf {tage} fällt',
    en: 'the day is {tage}',
    tr: 'gün {tage}' },
  'steer.cond.period': {
    de: 'der Tag zwischen {von} und {bis} liegt',
    en: 'the day is between {von} and {bis}',
    tr: 'gün {von} ile {bis} arasında' },
  'steer.effect.percentUp': {
    de: 'Preis +{v} %',
    en: 'price +{v} %',
    tr: 'fiyat +%{v}' },
  'steer.effect.percentDown': {
    de: 'Preis −{v} %',
    en: 'price −{v} %',
    tr: 'fiyat −%{v}' },
  'steer.effect.amountUp': {
    de: 'Preis +{v}',
    en: 'price +{v}',
    tr: 'fiyat +{v}' },
  'steer.effect.amountDown': {
    de: 'Preis −{v}',
    en: 'price −{v}',
    tr: 'fiyat −{v}' },

  // ------------------------------------------------------------- Vorschau
  'steer.preview': {
    de: 'Vorschau',
    en: 'Preview',
    tr: 'Önizleme' },
  'steer.days': {
    de: '{n} Tage',
    en: '{n} days',
    tr: '{n} gün' },
  'steer.preview.empty': {
    de: 'Kein Ratenplan wird von Regeln geführt. Oben bei einem Plan „Preis führt“ '
      + 'auf „Regeln“ stellen – dann erscheinen hier seine Vorschläge.',
    en: 'No rate plan is managed by rules. Set "Price managed by" to "rules" for a '
      + 'plan above – its suggestions then appear here.',
    tr: 'Hiçbir fiyat planı kurallarla yönetilmiyor. Yukarıda bir plan için "Fiyatı '
      + 'yöneten" alanını "kurallar" yapın – önerileri burada görünür.' },
  'steer.preview.legend': {
    de: 'Grün: Aufschlag, orange: Abschlag, grau: unverändert. Ein Klick wählt einen '
      + 'Tag aus und zeigt darunter den Grund.',
    en: 'Green: surcharge, orange: discount, grey: unchanged. A click selects a day '
      + 'and shows the reason below.',
    tr: 'Yeşil: artış, turuncu: indirim, gri: değişmedi. Tıklama bir günü seçer ve '
      + 'nedenini altta gösterir.' },
  'steer.preview.autoHint': {
    de: 'Automatischer Modus: der Worker übernimmt diese Vorschläge am nächsten '
      + 'Geschäftstag selbst. Wer nicht warten will, übernimmt hier.',
    en: 'Automatic mode: the worker applies these suggestions on the next business '
      + 'day by itself. To act now, apply them here.',
    tr: 'Otomatik mod: çalışan bu önerileri bir sonraki iş gününde kendisi uygular. '
      + 'Beklemek istemeyen burada uygular.' },
  'steer.apply.all': {
    de: 'Alle übernehmen ({n})',
    en: 'Apply all ({n})',
    tr: 'Tümünü uygula ({n})' },
  'steer.apply.selected': {
    de: 'Auswahl übernehmen ({n})',
    en: 'Apply selection ({n})',
    tr: 'Seçimi uygula ({n})' },
  'steer.selection.clear': {
    de: 'Auswahl aufheben',
    en: 'Clear selection',
    tr: 'Seçimi kaldır' },
  'steer.applied': {
    de: '{n} Tage übernommen.',
    en: '{n} days applied.',
    tr: '{n} gün uygulandı.' },
  'steer.detail.base': {
    de: 'Grundpreis',
    en: 'Base price',
    tr: 'Taban fiyat' },
  'steer.detail.current': {
    de: 'Aktuell',
    en: 'Current',
    tr: 'Güncel' },
  'steer.detail.suggested': {
    de: 'Vorschlag',
    en: 'Suggested',
    tr: 'Öneri' },
  'steer.detail.occupancy': {
    de: 'Belegung Kategorie {kat} % · Haus {haus} %',
    en: 'Occupancy category {kat} % · property {haus} %',
    tr: 'Doluluk kategori %{kat} · tesis %{haus}' },
  'steer.detail.lead': {
    de: 'Vorlauf {n} Tage',
    en: 'Lead time {n} days',
    tr: 'Öncelik {n} gün' },
  'steer.detail.noRule': {
    de: 'Keine Regel greift – es gilt der Grundpreis.',
    en: 'No rule applies – the base price holds.',
    tr: 'Hiçbir kural uygulanmıyor – taban fiyat geçerli.' },
  'steer.detail.choose': {
    de: 'Einen Tag anklicken, um Grundpreis, Belegung und Regel zu sehen.',
    en: 'Click a day to see base price, occupancy and rule.',
    tr: 'Taban fiyatı, doluluğu ve kuralı görmek için bir güne tıklayın.' },

  // -------------------------------------------------------------- Verlauf
  'steer.runs': {
    de: 'Verlauf der Läufe',
    en: 'Run history',
    tr: 'Çalışma geçmişi' },
  'steer.runs.none': {
    de: 'Noch kein Lauf.',
    en: 'No run yet.',
    tr: 'Henüz çalışma yok.' },
  'steer.run.auto': {
    de: 'automatisch',
    en: 'automatic',
    tr: 'otomatik' },
  'steer.run.apply': {
    de: 'übernommen von {name}',
    en: 'applied by {name}',
    tr: '{name} tarafından uygulandı' },
  'steer.run.changed': {
    de: '{n} Tage geändert',
    en: '{n} days changed',
    tr: '{n} gün değişti' },
  'steer.run.unknownRule': {
    de: 'Regel {id}',
    en: 'Rule {id}',
    tr: 'Kural {id}' }
} as const satisfies Record<string, LocalizedText>
