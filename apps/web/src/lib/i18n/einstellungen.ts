import type { LocalizedText } from '@hotelpms/contracts'

/** Haus: Wartung, Gastpost, Zahlungsarten, Stammdatenpflege. */
export const einstellungen = {
  'nav.maintenance': {
    de: 'Wartung',
    en: 'Maintenance',
    tr: 'Bakım' },
  'nav.settings': {
    de: 'Einstellungen',
    en: 'Settings',
    tr: 'Ayarlar' },

  'maint.title': {
    de: 'Wartungsmeldungen',
    en: 'Maintenance tickets',
    tr: 'Bakım bildirimleri' },
  'maint.new': {
    de: 'Meldung anlegen',
    en: 'New ticket',
    tr: 'Bildirim oluştur' },
  'maint.subject': {
    de: 'Was ist zu tun',
    en: 'What needs doing',
    tr: 'Ne yapılacak' },
  'maint.description': {
    de: 'Beschreibung',
    en: 'Description',
    tr: 'Açıklama' },
  'maint.priority': {
    de: 'Dringlichkeit',
    en: 'Priority',
    tr: 'Aciliyet' },
  'maint.priority.low': {
    de: 'Niedrig',
    en: 'Low',
    tr: 'Düşük' },
  'maint.priority.normal': {
    de: 'Normal',
    en: 'Normal',
    tr: 'Normal' },
  'maint.priority.high': {
    de: 'Hoch',
    en: 'High',
    tr: 'Yüksek' },
  'maint.status.open': {
    de: 'Offen',
    en: 'Open',
    tr: 'Açık' },
  'maint.status.in_progress': {
    de: 'In Arbeit',
    en: 'In progress',
    tr: 'İşlemde' },
  'maint.status.done': {
    de: 'Erledigt',
    en: 'Done',
    tr: 'Tamamlandı' },
  'maint.take': {
    de: 'In Arbeit nehmen',
    en: 'Take on',
    tr: 'İşleme al' },
  'maint.done': {
    de: 'Erledigt',
    en: 'Done',
    tr: 'Tamamlandı' },
  'maint.reopen': {
    de: 'Wieder öffnen',
    en: 'Reopen',
    tr: 'Yeniden aç' },
  'maint.showDone': {
    de: 'Erledigte zeigen',
    en: 'Show finished',
    tr: 'Tamamlananları göster' },
  'maint.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'maint.noRoom': {
    de: 'Kein Zimmer',
    en: 'No room',
    tr: 'Oda yok' },
  'maint.block': {
    de: 'Zimmer sperren',
    en: 'Block the room',
    tr: 'Odayı kapat' },
  'maint.block.none': {
    de: 'Nicht sperren',
    en: 'Do not block',
    tr: 'Kapatma' },
  'maint.block.out_of_order': {
    de: 'Out of Order',
    en: 'Out of order',
    tr: 'Out of Order' },
  'maint.block.out_of_service': {
    de: 'Out of Service',
    en: 'Out of service',
    tr: 'Out of Service' },
  'maint.blockHint': {
    de: 'Out of Order senkt die Kapazität: das Zimmer ist nicht mehr '
      + 'verkäuflich. Out of Service nicht — es bleibt im Verkauf und '
      + 'ist nur vorgemerkt.',
    en: 'Out of order lowers capacity: the room can no longer be sold. '
      + 'Out of service does not — it stays on sale and is only noted.',
    tr: 'Out of Order kapasiteyi düşürür: oda artık satılamaz. Out of Service düşürmez — oda satışta kalır, yalnızca not düşülmüştür.' },
  'maint.blockStays': {
    de: 'Eine Sperrung bleibt bestehen, wenn die Meldung erledigt wird. '
      + 'Ob das Zimmer wieder verkäuflich ist, entscheidet, wer '
      + 'hineingesehen hat.',
    en: 'A block stays in place when the ticket is finished. Whether '
      + 'the room can be sold again is decided by whoever looked at it.',
    tr: 'Bildirim tamamlandığında oda kapalı kalmaya devam eder. Odanın yeniden satılabilir olup olmadığına, içine bakan kişi karar verir.' },
  'maint.noDelete': {
    de: 'Eine Meldung wird erledigt, nicht gelöscht: sonst bliebe offen, '
      + 'ob das Zimmer je in Ordnung gebracht wurde.',
    en: 'A ticket is finished, not deleted: otherwise it would stay open '
      + 'whether the room was ever put right.',
    tr: 'Bir bildirim tamamlanır, silinmez: yoksa odanın hiç düzeltilip düzeltilmediği açıkta kalırdı.' },
  'maint.blocked': {
    de: 'gesperrt',
    en: 'blocked',
    tr: 'kapalı' },
  'maint.blockNeedsRoom': {
    de: 'Eine Sperrung braucht ein Zimmer. Ohne Zimmer wäre es '
      + 'eine Sperrung von nichts.',
    en: 'A block needs a room. Without one it would block nothing.',
    tr: 'Kapatma için oda gerekir. Oda olmadan hiçbir şeyi kapatmış olurdunuz.' },
  'master.filter': {
    de: 'Suchen',
    en: 'Search',
    tr: 'Ara' },
  'master.more': {
    de: 'weitere, durch Suchen einzugrenzen',
    en: 'more, narrow down by searching',
    tr: 'tane daha, aramayla daraltın' },

  'mail.title': {
    de: 'Absenderangaben Gastpost',
    en: 'Guest mail sender',
    tr: 'Misafir yazışması gönderen bilgileri' },
  'mail.fromName': {
    de: 'Absendername',
    en: 'Sender name',
    tr: 'Gönderen adı' },
  'mail.fromEmail': {
    de: 'Absenderadresse',
    en: 'Sender address',
    tr: 'Gönderen adresi' },
  'mail.replyTo': {
    de: 'Antwortadresse',
    en: 'Reply-to address',
    tr: 'Yanıt adresi' },
  'mail.bcc': {
    de: 'Blindkopie',
    en: 'Blind copy',
    tr: 'Gizli kopya' },
  'mail.enabled': {
    de: 'Versand eingeschaltet',
    en: 'Sending enabled',
    tr: 'Gönderim açık' },
  'mail.enabledHint': {
    de: 'Ausgeschaltet bleibt die Post in der Warteschlange stehen. '
      + 'Verloren geht nichts.',
    en: 'While it is off, mail stays in the queue. Nothing is lost.',
    tr: 'Kapalıyken posta kuyrukta bekler. Hiçbir şey kaybolmaz.' },
  'mail.training': {
    de: 'In einem Übungshaus lässt sich der Versand nicht einschalten. '
      + 'Ein Übungshaus schreibt keinem echten Gast.',
    en: 'Sending cannot be switched on in a training property. A training '
      + 'property writes to no real guest.',
    tr: 'Eğitim tesisinde gönderim açılamaz. Eğitim tesisi gerçek bir misafire yazmaz.' },
  'mail.updatedAt': {
    de: 'Zuletzt geändert',
    en: 'Last changed',
    tr: 'Son değişiklik' },
  'mail.never': {
    de: 'Noch nicht eingerichtet',
    en: 'Not set up yet',
    tr: 'Henüz kurulmadı' },

  'pay.title': {
    de: 'Zahlungsarten',
    en: 'Payment methods',
    tr: 'Ödeme türleri' },
  'pay.new': {
    de: 'Zahlungsart anlegen',
    en: 'New payment method',
    tr: 'Ödeme türü oluştur' },
  'pay.code': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kod' },
  'pay.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Tanım' },
  'pay.external': {
    de: 'Abwicklung außer Haus',
    en: 'Settled outside the house',
    tr: 'Tahsilat tesis dışında' },
  'pay.sortOrder': {
    de: 'Reihenfolge',
    en: 'Order',
    tr: 'Sıra' },
  'pay.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'pay.deactivate': {
    de: 'Stilllegen',
    en: 'Deactivate',
    tr: 'Devre dışı bırak' },
  'pay.activate': {
    de: 'Wieder einschalten',
    en: 'Reactivate',
    tr: 'Yeniden etkinleştir' },
  'pay.showInactive': {
    de: 'Stillgelegte zeigen',
    en: 'Show deactivated',
    tr: 'Devre dışı olanları göster' },
  'pay.noDelete': {
    de: 'Es gibt kein Löschen: an einer Zahlungsart hängen Verrechnungen, '
      + 'und die sind unveränderlich. Stillgelegt verschwindet sie aus der '
      + 'Auswahl und bleibt in der Geschichte.',
    en: 'There is no delete: settlements hang off a payment method, and '
      + 'those are immutable. Deactivated it disappears from the list of '
      + 'choices and stays in the history.',
    tr: 'Silme diye bir şey yok: bir ödeme türüne mahsuplar bağlıdır ve onlar değiştirilemez. Devre dışı bırakıldığında seçim listesinden kalkar, geçmişte kalır.' },

  'master.title': {
    de: 'Stammdaten pflegen',
    en: 'Maintain master data',
    tr: 'Ana verileri işle' },
  'master.categories': {
    de: 'Zimmergruppen',
    en: 'Room types',
    tr: 'Oda tipleri' },
  'master.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Odalar' },
  'master.edit': {
    de: 'Ändern',
    en: 'Edit',
    tr: 'Değiştir' },
  'master.close': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'master.description': {
    de: 'Beschreibung',
    en: 'Description',
    tr: 'Açıklama' },
  'master.descriptionHint': {
    de: 'Geht an Channel Manager und Buchungsstrecke.',
    en: 'Goes to the channel manager and the booking engine.',
    tr: 'Channel Manager\'a ve rezervasyon akışına gider.' },
  'master.sortOrder': {
    de: 'Reihenfolge',
    en: 'Order',
    tr: 'Sıra' },
  'master.sortOrderHint': {
    de: 'Reihenfolge im Zimmerplan und in Listen.',
    en: 'Order in the room chart and in lists.',
    tr: 'Oda planındaki ve listelerdeki sıra.' },
  'master.overbooking': {
    de: 'Überbuchung',
    en: 'Overbooking',
    tr: 'Aşırı rezervasyon' },
  'master.overbookingHint': {
    de: 'So viele Einheiten über die Kapazität hinaus dürfen '
      + 'verkauft werden.',
    en: 'This many units beyond capacity may be sold.',
    tr: 'Kapasitenin üzerinde bu kadar birim satılabilir.' },
  'master.deactivate': {
    de: 'Stilllegen',
    en: 'Deactivate',
    tr: 'Devre dışı bırak' },
  'master.activate': {
    de: 'Wieder einschalten',
    en: 'Reactivate',
    tr: 'Yeniden etkinleştir' },
  'master.deactivateHint': {
    de: 'Stilllegen zieht Kapazität ab. Liegen künftige '
      + 'Reservierungen darauf, wird es abgewiesen — erst '
      + 'umbuchen, dann stilllegen.',
    en: 'Deactivating removes capacity. If future reservations '
      + 'rest on it, the request is refused — move them first.',
    tr: 'Devre dışı bırakmak kapasiteyi düşürür. Üzerinde gelecek rezervasyonlar varsa işlem reddedilir — önce aktarın, sonra devre dışı bırakın.' },
  'master.occupancyHint': {
    de: 'Die Belegungszahl wirkt auf Preise und Meldeschein, '
      + 'nicht auf die Kapazität.',
    en: 'Occupancy affects prices and the registration form, not '
      + 'capacity.',
    tr: 'Doluluk sayısı fiyatları ve Meldeschein\'i etkiler, kapasiteyi değil.' },
  'master.floor': {
    de: 'Etage',
    en: 'Floor',
    tr: 'Kat' },
  'master.attributes': {
    de: 'Merkmale',
    en: 'Attributes',
    tr: 'Özellikler' },
  'master.attributesHint': {
    de: 'Kommagetrennt, etwa: balkon, barrierefrei, raucher. '
      + 'Daran hängt später die Zimmerzuweisung.',
    en: 'Comma separated, e.g. balcony, accessible, smoking. Room '
      + 'assignment will build on these.',
    tr: 'Virgülle ayrılmış, örneğin: balkon, engelsiz, sigara içilebilir. Oda ataması ileride buna bağlanır.' },
  'master.inactive': {
    de: 'Stillgelegt',
    en: 'Deactivated',
    tr: 'Devre dışı' },
  'master.showInactive': {
    de: 'Stillgelegte zeigen',
    en: 'Show deactivated',
    tr: 'Devre dışı olanları göster' },
  'master.timeUnitHint': {
    de: 'Andere Zeiteinheiten als die Nacht sind noch nicht '
      + 'freigeschaltet.',
    en: 'Time units other than the night are not enabled yet.',
    tr: 'Gece dışındaki zaman birimleri henüz açılmadı.' },
  'terms.hint': {
    de: 'Was das Haus am Tresen unterschreiben lässt — etwa eine Pauschale bei '
      + 'Verlust der Zimmerkarte. Das ist nicht der Meldeschein: der ist '
      + 'öffentlich-rechtlich und wird nach einem Jahr vernichtet. Diese '
      + 'Bedingungen gelten für jeden Gast, auch für den inländischen, der '
      + 'seit dem 1.1.2025 keinen Meldeschein mehr unterschreibt.',
    en: 'What the house has guests sign at the desk — a flat fee for a lost key '
      + 'card, for instance. This is not the Meldeschein: that one is public law '
      + 'and is destroyed after a year. These terms apply to every guest, '
      + 'including the domestic one who has not signed a Meldeschein since '
      + '1 January 2025.',
    tr: 'Otelin resepsiyonda imzalattığı koşullar — örneğin oda kartının '
      + 'kaybında uygulanan sabit ücret. Bu, Meldeschein değildir: o kamu '
      + 'hukukuna tabidir ve bir yıl sonra imha edilir. Bu koşullar her misafir '
      + 'için geçerlidir; 1 Ocak 2025’ten beri Meldeschein imzalamayan yurt içi '
      + 'misafirler için de.' },
  'terms.new': {
    de: 'Neue Fassung',
    en: 'New version',
    tr: 'Yeni sürüm' },
  'terms.newHint': {
    de: 'Eine Bedingung wird nie geändert, sondern neu gefasst: ein geänderter '
      + 'Text unter einer alten Unterschrift wäre als Nachweis wertlos. Wer '
      + 'dasselbe Kürzel wählt, löst die bisherige Fassung ab.',
    en: 'Terms are never edited, only re-issued: changed text under an old '
      + 'signature would be worthless as evidence. Using the same code replaces '
      + 'the previous version.',
    tr: 'Koşullar hiçbir zaman düzenlenmez, yalnızca yeniden yayımlanır: eski '
      + 'bir imzanın altındaki değişmiş metin kanıt olarak değersizdir. Aynı '
      + 'kodu kullanmak önceki sürümün yerine geçer.' },
  'terms.code': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kod' },
  'terms.heading': {
    de: 'Überschrift',
    en: 'Heading',
    tr: 'Başlık' },
  'terms.text': {
    de: 'Text',
    en: 'Text',
    tr: 'Metin' },
  'terms.requiresSignature': {
    de: 'Unterschrift verlangen',
    en: 'Require a signature',
    tr: 'İmza iste' },
  'terms.noSignature': {
    de: 'Ohne Unterschrift, Kenntnisnahme genügt',
    en: 'No signature, acknowledgement is enough',
    tr: 'İmzasız, bilgilendirme yeterli' },
  'terms.version': {
    de: 'Fassung',
    en: 'Version',
    tr: 'Sürüm' },
  'terms.current': {
    de: 'gilt',
    en: 'in force',
    tr: 'yürürlükte' },

  // ------------------------------------------------------- Absenderdomain
  'mailDomain.title': {
    de: 'Absenderdomain',
    en: 'Sender domain',
    tr: 'Gönderen alan adı' },
  'mailDomain.intro': {
    de: 'Damit Gastpost von Ihrem Haus kommt und nicht von uns, muss Ihre '
      + 'Domain einmal freigeschaltet werden. Sie beantragen sie hier, wir '
      + 'geben sie frei, und Sie tragen danach drei Zeilen bei Ihrem '
      + 'Domainanbieter ein.',
    en: 'So guest mail comes from your property and not from us, your domain '
      + 'has to be activated once. You request it here, we approve it, and '
      + 'you then add three records at your domain provider.',
    tr: 'Misafir postasının bizden değil tesisinizden gelmesi için alan adınızın '
      + 'bir kez etkinleştirilmesi gerekir. Buradan başvurursunuz, biz onaylarız, '
      + 'ardından alan adı sağlayıcınızda üç kayıt eklersiniz.' },
  'mailDomain.modeOwn': {
    de: 'Wir haben eine eigene Domain',
    en: 'We have our own domain',
    tr: 'Kendi alan adımız var' },
  'mailDomain.modeRelay': {
    de: 'Wir haben nur eine Adresse bei GMX, Web.de oder T-Online',
    en: 'We only have an address at GMX, Web.de or T-Online',
    tr: 'Yalnızca GMX, Web.de veya T-Online adresimiz var' },
  'mailDomain.domainLabel': {
    de: 'Ihre Domain',
    en: 'Your domain',
    tr: 'Alan adınız' },
  'mailDomain.domainHint': {
    de: 'Nur der Teil hinter dem @, also hotel-wattenblick.de',
    en: 'Only the part after the @, e.g. hotel-wattenblick.de',
    tr: '@ işaretinden sonraki kısım, örneğin hotel-wattenblick.de' },
  'mailDomain.localPartLabel': {
    de: 'Name vor dem @',
    en: 'Name before the @',
    tr: '@ işaretinden önceki ad' },
  'mailDomain.relayHint': {
    de: 'Ihre Post geht dann von {address} hinaus, mit Ihrem Hotelnamen davor. '
      + 'Antworten gehen an Ihre eigene Adresse, nicht an uns.',
    en: 'Your mail then goes out from {address}, with your property name in '
      + 'front. Replies go to your own address, not to us.',
    tr: 'Postanız {address} adresinden, önünde tesis adınızla çıkar. '
      + 'Yanıtlar bize değil kendi adresinize gider.' },
  'mailDomain.request': {
    de: 'Freigabe beantragen',
    en: 'Request approval',
    tr: 'Onay talep et' },
  'mailDomain.withdraw': {
    de: 'Antrag zurücknehmen',
    en: 'Withdraw request',
    tr: 'Başvuruyu geri çek' },
  'mailDomain.check': {
    de: 'Nachsehen, ob die Einträge stehen',
    en: 'Check whether the records are in place',
    tr: 'Kayıtların yerinde olup olmadığını kontrol et' },
  'mailDomain.statusRequested': {
    de: 'Beantragt. Wir sehen es uns an und melden uns.',
    en: 'Requested. We are looking at it and will get back to you.',
    tr: 'Başvuruldu. İnceliyoruz ve size döneceğiz.' },
  'mailDomain.statusRejected': {
    de: 'Abgelehnt',
    en: 'Rejected',
    tr: 'Reddedildi' },
  'mailDomain.statusDnsPending': {
    de: 'Freigegeben. Jetzt fehlen noch die Einträge bei Ihrem Domainanbieter.',
    en: 'Approved. The records at your domain provider are still missing.',
    tr: 'Onaylandı. Alan adı sağlayıcınızdaki kayıtlar hâlâ eksik.' },
  'mailDomain.statusActive': {
    de: 'Freigeschaltet. Der Versand lässt sich einschalten.',
    en: 'Active. Sending can be switched on.',
    tr: 'Etkin. Gönderim açılabilir.' },
  'mailDomain.dnsIntro': {
    de: 'Tragen Sie diese Einträge bei Ihrem Domainanbieter ein, dort wo die '
      + 'DNS-Einträge stehen. Bis sie überall bekannt sind, vergehen meist '
      + 'Minuten, manchmal Stunden.',
    en: 'Add these records at your domain provider, where the DNS records '
      + 'live. It usually takes minutes, sometimes hours, until they are '
      + 'known everywhere.',
    tr: 'Bu kayıtları alan adı sağlayıcınızda, DNS kayıtlarının bulunduğu yere ekleyin. '
      + 'Her yerde bilinmeleri genelde dakikalar, bazen saatler sürer.' },
  'mailDomain.host': {
    de: 'Name',
    en: 'Host',
    tr: 'Ad' },
  'mailDomain.type': {
    de: 'Typ',
    en: 'Type',
    tr: 'Tür' },
  'mailDomain.value': {
    de: 'Wert',
    en: 'Value',
    tr: 'Değer' },
  'mailDomain.recordOk': {
    de: 'steht',
    en: 'in place',
    tr: 'mevcut' },
  'mailDomain.recordMissing': {
    de: 'fehlt noch',
    en: 'still missing',
    tr: 'hâlâ eksik' },
  'mailDomain.lastChecked': {
    de: 'Zuletzt nachgesehen',
    en: 'Last checked',
    tr: 'Son kontrol' },
  'mailDomain.neverChecked': {
    de: 'noch nicht nachgesehen',
    en: 'not checked yet',
    tr: 'henüz kontrol edilmedi' },
  'mailDomain.needed': {
    de: 'Der Versand lässt sich erst einschalten, wenn die Absenderdomain '
      + 'freigeschaltet ist.',
    en: 'Sending can only be switched on once the sender domain is active.',
    tr: 'Gönderim ancak gönderen alan adı etkinleştirildikten sonra açılabilir.' },

} as const satisfies Record<string, LocalizedText>
