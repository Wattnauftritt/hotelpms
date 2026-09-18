import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Das Adminpanel -- der Bildschirm, den nur der Betreiber sieht.
 *
 * **Warum das trotzdem uebersetzt ist.** Der naheliegende Einwand lautet:
 * das sehen ja nur wir, da genuegt Deutsch. Er stimmt heute und hoert in dem
 * Moment auf zu stimmen, in dem der erste Kollege im Support nicht Deutsch
 * als erste Sprache hat -- und dann wird nachtraeglich uebersetzt, was
 * heisst: jede Zeichenkette einzeln aus dem Code ziehen und die Haelfte
 * vergessen. Ausserdem faellt dieser Bildschirm sonst als einziger aus der
 * Bauart heraus, und eine Ausnahme kostet beim Lesen mehr als diese Datei.
 */
export const admin = {
  'nav.admin': {
    de: 'Adminpanel',
    en: 'Admin panel',
    tr: 'Yönetim paneli' },
  'admin.title': {
    de: 'Adminpanel',
    en: 'Admin panel',
    tr: 'Yönetim paneli' },
  'admin.noPermission': {
    de: 'Dieser Zugang hat kein Plattformrecht. Ein Admin muss ihm eine Rolle geben.',
    en: 'This account holds no platform permission. An admin has to give it a role.',
    tr: 'Bu hesabın hiçbir platform yetkisi yok. Bir yöneticinin ona rol vermesi gerekir.' },
  'admin.tab.accounts': {
    de: 'Kunden',
    en: 'Customers',
    tr: 'Müşteriler' },
  'admin.tab.staff': {
    de: 'Plattformbenutzer',
    en: 'Platform users',
    tr: 'Platform kullanıcıları' },
  'admin.tab.operations': {
    de: 'Betrieb',
    en: 'Operations',
    tr: 'İşletim' },
  'admin.tab.support': {
    de: 'Support',
    en: 'Support',
    tr: 'Destek' },

  // ------------------------------------------------------------- Kunden
  'admin.accounts.none': {
    de: 'Noch kein Kunde angelegt.',
    en: 'No customer created yet.',
    tr: 'Henüz müşteri oluşturulmadı.' },
  'admin.accounts.properties': {
    de: 'Häuser',
    en: 'Properties',
    tr: 'Tesisler' },
  'admin.accounts.users': {
    de: 'Benutzer',
    en: 'Users',
    tr: 'Kullanıcılar' },
  'admin.accounts.lastLogin': {
    de: 'Zuletzt angemeldet',
    en: 'Last sign-in',
    tr: 'Son giriş' },
  'admin.accounts.never': {
    de: 'noch nie',
    en: 'never',
    tr: 'hiç' },
  'admin.accounts.created': {
    de: 'Angelegt',
    en: 'Created',
    tr: 'Oluşturuldu' },
  'admin.status.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Etkin' },
  'admin.status.suspended': {
    de: 'Gesperrt',
    en: 'Suspended',
    tr: 'Askıya alınmış' },
  'admin.status.archived': {
    de: 'Archiviert',
    en: 'Archived',
    tr: 'Arşivlenmiş' },
  'admin.status.invited': {
    de: 'Eingeladen',
    en: 'Invited',
    tr: 'Davet edildi' },
  'admin.status.disabled': {
    de: 'Stillgelegt',
    en: 'Disabled',
    tr: 'Devre dışı' },
  'admin.accounts.suspend': {
    de: 'Sperren',
    en: 'Suspend',
    tr: 'Askıya al' },
  'admin.accounts.unsuspend': {
    de: 'Entsperren',
    en: 'Unsuspend',
    tr: 'Askıyı kaldır' },
  'admin.accounts.archive': {
    de: 'Archivieren',
    en: 'Archive',
    tr: 'Arşivle' },
  /*
   * Die Nachfrage sagt, was wirklich passiert, und nicht "Sind Sie sicher?".
   * Gesperrt heisst: niemand dieses Kunden kommt mehr herein -- mitten im
   * Betrieb, ohne Vorwarnung an der Rezeption.
   */
  'admin.accounts.suspendConfirm': {
    de: '{name} sperren? Ab sofort kommt kein Benutzer dieses Kunden mehr '
      + 'herein — auch nicht die Rezeption, die gerade eincheckt. Die Daten '
      + 'bleiben unberührt, und der Support kommt weiterhin hinein.',
    en: 'Suspend {name}? From now on no user of this customer can sign in — '
      + 'not even the front desk in the middle of a check-in. The data stays '
      + 'untouched, and support still gets in.',
    tr: '{name} askıya alınsın mı? Bundan sonra bu müşterinin hiçbir '
      + 'kullanıcısı giriş yapamaz — check-in yapan resepsiyon bile. Veriler '
      + 'olduğu gibi kalır ve destek yine girebilir.' },
  'admin.accounts.archiveConfirm': {
    de: '{name} archivieren? Wie sperren, nur ohne Absicht zurückzukehren. '
      + 'Die Daten bleiben: Aufbewahrungsfristen laufen weiter.',
    en: 'Archive {name}? Like suspending, but without meaning to come back. '
      + 'The data stays: retention periods keep running.',
    tr: '{name} arşivlensin mi? Askıya almak gibi, ama geri dönme niyeti '
      + 'olmadan. Veriler kalır: saklama süreleri işlemeye devam eder.' },
  'admin.accounts.training': {
    de: 'Übungshaus',
    en: 'Training property',
    tr: 'Eğitim tesisi' },
  'admin.accounts.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Oda' },
  'admin.accounts.roles': {
    de: 'Rollen',
    en: 'Roles',
    tr: 'Roller' },
  'admin.accounts.locked': {
    de: 'gesperrt bis {bis}',
    en: 'locked until {bis}',
    tr: '{bis} tarihine kadar kilitli' },
  'admin.accounts.supportHint': {
    de: 'In die Daten dieses Kunden sehen Sie nur über eine Support-Sitzung, '
      + 'die er freigibt. Diese Liste zeigt Namen und Zustände, sonst nichts.',
    en: 'You can only look into this customer’s data through a support '
      + 'session they grant. This list shows names and states, nothing else.',
    tr: 'Bu müşterinin verilerine yalnızca onun onayladığı bir destek '
      + 'oturumu üzerinden bakabilirsiniz. Bu liste yalnızca adları ve '
      + 'durumları gösterir.' },
  'admin.accounts.new': {
    de: 'Kunden anlegen',
    en: 'Create customer',
    tr: 'Müşteri oluştur' },
  'admin.accounts.created.done': {
    de: 'Angelegt. Die Einladung ist unterwegs.',
    en: 'Created. The invitation is on its way.',
    tr: 'Oluşturuldu. Davet yolda.' },
  'admin.field.accountName': {
    de: 'Name des Kunden',
    en: 'Customer name',
    tr: 'Müşteri adı' },
  'admin.field.code': {
    de: 'Kürzel des Hauses',
    en: 'Property code',
    tr: 'Tesis kodu' },
  'admin.field.propertyName': {
    de: 'Name des Hauses',
    en: 'Property name',
    tr: 'Tesis adı' },
  'admin.field.addressLine1': {
    de: 'Straße und Hausnummer',
    en: 'Street and number',
    tr: 'Sokak ve numara' },
  'admin.field.postalCode': {
    de: 'PLZ',
    en: 'Postal code',
    tr: 'Posta kodu' },
  'admin.field.city': {
    de: 'Ort',
    en: 'City',
    tr: 'Şehir' },
  'admin.field.taxNumber': {
    de: 'Steuernummer',
    en: 'Tax number',
    tr: 'Vergi numarası' },
  'admin.field.vatId': {
    de: 'USt-IdNr. (optional)',
    en: 'USt-IdNr. (optional)',
    tr: 'USt-IdNr. (isteğe bağlı)' },
  'admin.field.userEmail': {
    de: 'E-Mail des ersten Benutzers',
    en: 'Email of the first user',
    tr: 'İlk kullanıcının e-postası' },
  'admin.field.userName': {
    de: 'Name des ersten Benutzers',
    en: 'Name of the first user',
    tr: 'İlk kullanıcının adı' },
  'admin.field.isTraining': {
    de: 'Übungshaus — exportiert nichts nach draußen, verschickt keine Gastpost',
    en: 'Training property — exports nothing, sends no guest mail',
    tr: 'Eğitim tesisi — dışarıya hiçbir şey aktarmaz, misafir postası göndermez' },
  /*
   * Die Rechnungsangaben sind keine vier Felder, sondern eine Bedingung:
   * ohne sie ist das Haus nach § 14 UStG nicht rechnungsfaehig. Die Route
   * sagt das genauso, an allen vier Feldern zugleich.
   */
  'admin.accounts.invoiceHint': {
    de: 'Anschrift und Steuernummer sind Pflicht: ohne sie kann das Haus '
      + 'keine Rechnung nach § 14 UStG ausstellen.',
    en: 'Address and tax number are required: without them the property '
      + 'cannot issue invoices under § 14 UStG.',
    tr: 'Adres ve vergi numarası zorunludur: bunlar olmadan tesis § 14 UStG '
      + 'uyarınca fatura kesemez.' },

  // -------------------------------------------------- Plattformbenutzer
  'admin.staff.new': {
    de: 'Plattformbenutzer anlegen',
    en: 'Create platform user',
    tr: 'Platform kullanıcısı oluştur' },
  'admin.staff.hint': {
    de: 'Der neue Zugang bekommt eine Einladung und setzt sein Kennwort '
      + 'selbst. Ein vorhandener Benutzer wird nicht nachträglich zu '
      + 'Plattformpersonal gemacht — dafür gibt es bewusst keinen Weg.',
    en: 'The new account gets an invitation and sets its own password. An '
      + 'existing user is never turned into platform staff after the fact — '
      + 'there is deliberately no way to do that.',
    tr: 'Yeni hesap bir davet alır ve parolasını kendisi belirler. Mevcut bir '
      + 'kullanıcı sonradan platform personeline dönüştürülmez — bunun için '
      + 'bilerek bir yol yoktur.' },
  'admin.staff.email': {
    de: 'E-Mail',
    en: 'Email',
    tr: 'E-posta' },
  'admin.staff.name': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'admin.staff.role': {
    de: 'Rolle',
    en: 'Role',
    tr: 'Rol' },
  'admin.staff.invited': {
    de: 'Angelegt und eingeladen.',
    en: 'Created and invited.',
    tr: 'Oluşturuldu ve davet edildi.' },
  'admin.staff.disable': {
    de: 'Stilllegen',
    en: 'Disable',
    tr: 'Devre dışı bırak' },
  'admin.staff.enable': {
    de: 'Freigeben',
    en: 'Enable',
    tr: 'Etkinleştir' },
  'admin.staff.you': {
    de: 'Sie',
    en: 'you',
    tr: 'siz' },
  /*
   * Zweimal dieselbe Rolle, kurz und lang -- und das ist kein Versehen. In
   * der Liste steht der Name (eine Spalte unter vielen), im Auswahlfeld
   * steht, was die Rolle *kann*: wer einen Zugang vergibt, entscheidet in
   * diesem Moment, wie weit er reicht, und "Support" allein sagt das nicht.
   *
   * Der Name aus der Datenbank (`role.name`) taugt dafuer nicht: er ist
   * deutsch und bliebe es auch in einer englischen Oberflaeche.
   */
  'admin.roleShort.platform_admin': {
    de: 'Plattform-Admin',
    en: 'Platform admin',
    tr: 'Platform yöneticisi' },
  'admin.roleShort.platform_support': {
    de: 'Support',
    en: 'Support',
    tr: 'Destek' },
  'admin.roleShort.platform_billing': {
    de: 'Abrechnung',
    en: 'Billing',
    tr: 'Faturalandırma' },
  'admin.roleShort.platform_ops': {
    de: 'Betrieb',
    en: 'Operations',
    tr: 'İşletim' },
  'admin.role.platform_admin': {
    de: 'Plattform-Admin — alles, einschließlich weiterer Zugänge',
    en: 'Platform admin — everything, including further accounts',
    tr: 'Platform yöneticisi — her şey, yeni hesaplar dahil' },
  'admin.role.platform_support': {
    de: 'Support — Sitzungen anfragen, ausrollen',
    en: 'Support — request sessions, deploy',
    tr: 'Destek — oturum iste, dağıt' },
  'admin.role.platform_billing': {
    de: 'Abrechnung',
    en: 'Billing',
    tr: 'Faturalandırma' },
  'admin.role.platform_ops': {
    de: 'Betrieb — ausrollen, Zustand sehen',
    en: 'Operations — deploy, see state',
    tr: 'İşletim — dağıt, durumu gör' },

  // ------------------------------------------------------------ Betrieb
  'admin.health.title': {
    de: 'Was hängt',
    en: 'What is stuck',
    tr: 'Ne takıldı' },
  'admin.health.hint': {
    de: 'Zahlen, keine Inhalte. Eine Gastpost trägt Namen und Anschrift, ein '
      + 'Webhook den Rumpf einer Buchung — beides gehört nicht hierher.',
    en: 'Numbers, not contents. Guest mail carries names and addresses, a '
      + 'webhook carries the body of a booking — neither belongs here.',
    tr: 'İçerik değil, sayılar. Misafir postası ad ve adres taşır, bir webhook '
      + 'bir rezervasyonun gövdesini taşır — ikisi de buraya ait değildir.' },
  'admin.health.emails': {
    de: 'Post offen',
    en: 'Mail pending',
    tr: 'Bekleyen posta' },
  'admin.health.emailsFailed': {
    de: 'Post gescheitert',
    en: 'Mail failed',
    tr: 'Başarısız posta' },
  'admin.health.webhooks': {
    de: 'Webhooks gescheitert',
    en: 'Webhooks failed',
    tr: 'Başarısız webhook’lar' },
  'admin.health.nightAudit': {
    de: 'Nachtlauf bis',
    en: 'Night audit through',
    tr: 'Gece denetimi şu tarihe kadar' },
  /*
   * Der Nachtlauf ist der eine Vorgang, dessen Ausbleiben niemand bemerkt:
   * er laeuft nachts, und am naechsten Morgen sieht alles normal aus -- bis
   * die Zahlen fehlen.
   */
  'admin.health.nightAuditStale': {
    de: 'Der letzte abgeschlossene Geschäftstag liegt zurück. Läuft der '
      + 'Nachtlauf?',
    en: 'The last closed business day is behind. Is the night audit running?',
    tr: 'Kapatılan son iş günü geride kaldı. Gece denetimi çalışıyor mu?' },
  'admin.health.allClear': {
    de: 'Nichts hängt.',
    en: 'Nothing is stuck.',
    tr: 'Hiçbir şey takılmadı.' },
  'admin.health.since': {
    de: 'seit {seit}',
    en: 'since {seit}',
    tr: '{seit} tarihinden beri' }
} satisfies Record<string, LocalizedText>
