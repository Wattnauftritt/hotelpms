import type { LocalizedText } from '@hotelpms/contracts'

/** Support-Sitzungen: Anfrage, Freigabe, Widerruf. */
export const support = {
  'deploy.rollback': {
    de: 'Zurück auf',
    en: 'Roll back to',
    tr: 'Şuna geri dön' },
  'deploy.rollbackHint': {
    de: 'Schaltet auf einen früheren Stand zurück — ohne Bau, '
      + 'in Sekunden. Das Datenbankschema bleibt dabei auf dem '
      + 'neueren Stand.',
    en: 'Switches back to an earlier release — no build, done '
      + 'in seconds. The database schema stays at the newer '
      + 'state.',
    tr: 'Daha önceki bir sürüme geri alır — derleme olmadan, saniyeler içinde. Veritabanı şeması bu sırada yeni sürümde kalır.' },
  'deploy.rollbackNone': {
    de: 'Kein früherer Stand verfügbar.',
    en: 'No earlier release available.',
    tr: 'Daha önceki bir sürüm yok.' },
  'deploy.kind.rollback': {
    de: 'zurückgerollt',
    en: 'rolled back',
    tr: 'geri alındı' },
  'deploy.title': {
    de: 'Ausrollen',
    en: 'Deploy',
    tr: 'Dağıtım' },
  'deploy.hint': {
    de: 'Ausgerollt wird der Stand, der auf GitHub mit dem Tag '
      + '„produktion“ markiert ist — nie einfach der letzte. Dieser '
      + 'Knopf bestimmt nur den Zeitpunkt.',
    en: 'What gets deployed is the commit tagged “produktion” on '
      + 'GitHub — never simply the latest one. This button only '
      + 'decides when.',
    tr: 'Dağıtılan sürüm, GitHub\'da „produktion“ etiketiyle işaretlenmiş olandır — hiçbir zaman öylesine sonuncusu değil. Bu düğme yalnızca zamanı belirler.' },
  'deploy.request': {
    de: 'Jetzt ausrollen',
    en: 'Deploy now',
    tr: 'Şimdi dağıt' },
  'deploy.requested': {
    de: 'Angefordert. Die Maschine holt sich das binnen einer Minute.',
    en: 'Requested. The machine picks it up within a minute.',
    tr: 'İstendi. Makine bunu bir dakika içinde alır.' },
  'deploy.current': {
    de: 'Läuft gerade',
    en: 'Currently running',
    tr: 'Şu anda çalışıyor' },
  /*
   * Die Zeit neben einem Stand ist die seines Baus auf der Maschine, nicht
   * die des Commits und nicht die des Ausrollens: vier Hashes ohne Zeit
   * sagten nicht, welcher der von gestern Mittag war.
   */
  'deploy.builtAt': {
    de: 'gebaut {when}',
    en: 'built {when}',
    tr: '{when} derlendi' },
  'deploy.currentUnknown': {
    de: 'Noch kein Lauf verzeichnet',
    en: 'No run recorded yet',
    tr: 'Henüz kayıtlı bir çalışma yok' },
  'deploy.byHand': {
    de: 'von Hand auf der Maschine',
    en: 'by hand on the machine',
    tr: 'makinede elle' },
  'deploy.state.pending': {
    de: 'Wartet',
    en: 'Waiting',
    tr: 'Bekliyor' },
  'deploy.state.running': {
    de: 'Läuft',
    en: 'Running',
    tr: 'Çalışıyor' },
  'deploy.state.done': {
    de: 'Durch',
    en: 'Done',
    tr: 'Tamam' },
  'deploy.state.failed': {
    de: 'Gescheitert',
    en: 'Failed',
    tr: 'Başarısız' },
  'deploy.showLog': {
    de: 'Ausgabe zeigen',
    en: 'Show output',
    tr: 'Çıktıyı göster' },
  'support.title': {
    de: 'Support-Zugriff',
    en: 'Support access',
    tr: 'Destek erişimi' },
  'support.hint': {
    de: 'Unser Support sieht Ihre Daten nur, wenn Sie es hier '
      + 'freigeben — befristet, und jede Handlung steht im Protokoll.',
    en: 'Our support team sees your data only if you approve it here '
      + '— for a limited time, and every action is recorded in the log.',
    tr: 'Desteğimiz verilerinizi yalnızca buradan izin verdiğinizde görür — süreli olarak, ve her işlem kayda geçer.' },
  'support.none': {
    de: 'Zurzeit bittet niemand um Zugriff.',
    en: 'Nobody is currently asking for access.',
    tr: 'Şu anda kimse erişim istemiyor.' },
  'support.reason': {
    de: 'Anlass',
    en: 'Reason',
    tr: 'Gerekçe' },
  'support.who': {
    de: 'Angefragt von',
    en: 'Requested by',
    tr: 'İsteyen' },
  'support.level': {
    de: 'Umfang',
    en: 'Scope',
    tr: 'Kapsam' },
  'support.level.read': {
    de: 'Nur lesen',
    en: 'Read only',
    tr: 'Yalnızca okuma' },
  'support.level.write': {
    de: 'Lesen und ändern',
    en: 'Read and change',
    tr: 'Okuma ve değiştirme' },
  'support.until': {
    de: 'Läuft ab',
    en: 'Expires',
    tr: 'Bitiş' },
  'support.grant': {
    de: 'Freigeben',
    en: 'Approve',
    tr: 'İzin ver' },
  'support.deny': {
    de: 'Ablehnen',
    en: 'Decline',
    tr: 'Reddet' },
  'support.revoke': {
    de: 'Jetzt beenden',
    en: 'End now',
    tr: 'Şimdi sonlandır' },
  'support.grantedBy': {
    de: 'Freigegeben von {name}',
    en: 'Approved by {name}',
    tr: '{name} tarafından onaylandı' },
  'support.state.pending': {
    de: 'Wartet auf Ihre Entscheidung',
    en: 'Waiting for your decision',
    tr: 'Kararınızı bekliyor' },
  'support.state.active': {
    de: 'Läuft',
    en: 'Running',
    tr: 'Sürüyor' },
  'support.state.expired': {
    de: 'Abgelaufen',
    en: 'Expired',
    tr: 'Süresi doldu' },
  'support.state.revoked': {
    de: 'Beendet',
    en: 'Ended',
    tr: 'Sonlandırıldı' },
  'support.showPermissions': {
    de: 'Was wird damit erlaubt?',
    en: 'What does this allow?',
    tr: 'Bununla neye izin verilmiş olur?' },
  // Die Auslassungen sind der Punkt: der Kunde soll sehen, was auch bei
  // Freigabe nicht geht.
  'support.never': {
    de: 'Nie enthalten: Ausweisdaten, DSGVO-Auskunft und Löschung, '
      + 'Rechnungen festschreiben, Exporte nach außen, Benutzer '
      + 'und Schnittstellen verwalten.',
    en: 'Never included: identity documents, GDPR access and erasure, '
      + 'issuing invoices, exports out of the house, managing users '
      + 'and integrations.',
    tr: 'Hiçbir zaman kapsamda değildir: kimlik verileri, DSGVO bilgi dökümü ve silme, faturaların kesinleştirilmesi, dışarıya aktarımlar, kullanıcı ve arayüz yönetimi.' },

  'support.console': {
    de: 'Support',
    en: 'Support',
    tr: 'Destek' },
  'support.console.hint': {
    de: 'Ohne Freigabe des Kunden sehen Sie keine Kundendaten. '
      + 'Fragen Sie mit einem Anlass an; der Kunde entscheidet.',
    en: 'Without the customer’s approval you see no customer '
      + 'data. Ask with a stated reason; the customer decides.',
    tr: 'Müşterinin izni olmadan müşteri verisi göremezsiniz. Bir gerekçeyle talep edin; kararı müşteri verir.' },
  'support.accountId': {
    de: 'Account-Nummer',
    en: 'Account number',
    tr: 'Account numarası' },
  'support.hours': {
    de: 'Laufzeit in Stunden',
    en: 'Duration in hours',
    tr: 'Saat cinsinden süre' },
  'support.request': {
    de: 'Zugriff anfragen',
    en: 'Request access',
    tr: 'Erişim talep et' },
  'support.requested': {
    de: 'Angefragt. Der Kunde wurde benachrichtigt.',
    en: 'Requested. The customer has been notified.',
    tr: 'Talep edildi. Müşteri bilgilendirildi.' },
  'support.mine': {
    de: 'Meine Anfragen',
    en: 'My requests',
    tr: 'Taleplerim' },
} as const satisfies Record<string, LocalizedText>
