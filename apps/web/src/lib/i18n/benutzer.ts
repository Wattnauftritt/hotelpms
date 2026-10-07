import type { LocalizedText } from '@hotelpms/contracts'

/** Benutzer und Rollen: das Personal des Hauses, im Menü „Einstellungen". */
export const benutzer = {
  'nav.users': {
    de: 'Benutzer und Rollen',
    en: 'Users and roles',
    tr: 'Kullanıcılar ve roller' },
  'user.title': {
    de: 'Benutzer und Rollen',
    en: 'Users and roles',
    tr: 'Kullanıcılar ve roller' },
  'user.added': {
    de: 'Die Person hatte schon einen Zugang in Ihrem Betrieb und hat die '
      + 'Rollen in diesem Haus dazubekommen.',
    en: 'The person already had access in your business and now also has '
      + 'the roles in this property.',
    tr: 'Kişinin işletmenizde zaten bir erişimi vardı; bu tesisteki rolleri '
      + 'de eklendi.' },
  'user.roles': {
    de: 'Rollen',
    en: 'Roles',
    tr: 'Roller' },
  'user.permissions': {
    de: 'Rechte',
    en: 'Permissions',
    tr: 'Yetkiler' },
  'user.noRoles': {
    de: 'Keine Rolle in diesem Haus',
    en: 'No role in this property',
    tr: 'Bu tesiste rolü yok' },
  'user.lastLogin': {
    de: 'Zuletzt angemeldet',
    en: 'Last signed in',
    tr: 'Son oturum' },
  'user.never': {
    de: 'Noch nie',
    en: 'Never',
    tr: 'Hiç' },
  'user.status.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'user.status.invited': {
    de: 'Eingeladen',
    en: 'Invited',
    tr: 'Davet edildi' },
  'user.status.disabled': {
    de: 'Gesperrt',
    en: 'Disabled',
    tr: 'Engelli' },
  'user.edit': {
    de: 'Rollen ändern',
    en: 'Change roles',
    tr: 'Rolleri değiştir' },
  'user.rolesHint': {
    de: 'Die Rechte stehen so da, wie die API sie liefert — sie werden '
      + 'nicht aus dem Rollennamen erraten.',
    en: 'Permissions are shown as the API delivers them — they are not '
      + 'guessed from the role name.',
    tr: 'Yetkiler, API\'nin verdiği hâliyle gösterilir — rol adından tahmin edilmez.' },
  'user.invite': {
    de: 'Benutzer einladen',
    en: 'Invite user',
    tr: 'Kullanıcı davet et' },
  'user.inviteHint': {
    de: 'Die Person bekommt eine Einladung und setzt ihr Kennwort selbst – per '
      + 'E-Mail, oder als Link bzw. QR-Code, den Sie ihr persönlich geben. '
      + 'Ohne Mailadresse meldet sie sich mit dem Benutzernamen an. Sie bekommt '
      + 'die gewählten Rollen in diesem Haus. Arbeitet sie schon in einem '
      + 'anderen Haus des Betriebs, genügt ihre Adresse oder ihr Benutzername: '
      + 'sie bekommt die Rollen hier dazu, ohne neue Einladung.',
    en: 'The person receives an invitation and sets their own password – by '
      + 'email, or as a link or QR code you hand them in person. Without an '
      + 'email address they sign in with their username. They get the chosen '
      + 'roles in this property. If they already work in another property of '
      + 'the business, their address or username is enough: they get the '
      + 'roles here as well, without a new invitation.',
    tr: 'Kişi bir davet alır ve parolasını kendisi belirler – e-postayla ya da '
      + 'kendisine elden verdiğiniz bir bağlantı veya QR kodu ile. E-posta '
      + 'adresi yoksa kullanıcı adıyla giriş yapar. Bu tesiste seçilen '
      + 'rolleri alır. İşletmenin başka bir tesisinde zaten çalışıyorsa adresi '
      + 'veya kullanıcı adı yeterlidir: yeni bir davet olmadan buradaki '
      + 'rolleri de alır.' },
  'user.username': {
    de: 'Benutzername',
    en: 'Username',
    tr: 'Kullanıcı adı' },
  'user.usernameHint': {
    de: 'Für Personal ohne Mailadresse, z. B. anna.k',
    en: 'For staff without an email address, e.g. anna.k',
    tr: 'E-posta adresi olmayan personel için, ör. anna.k' },
  'user.emailOptional': {
    de: 'E-Mail (optional)',
    en: 'Email (optional)',
    tr: 'E-posta (isteğe bağlı)' },
  'user.delivery': {
    de: 'Einladung',
    en: 'Invitation',
    tr: 'Davet' },
  'user.deliveryEmail': {
    de: 'per E-Mail',
    en: 'by email',
    tr: 'e-postayla' },
  'user.deliveryLink': {
    de: 'als Link oder QR-Code zum Weitergeben',
    en: 'as a link or QR code to hand over',
    tr: 'elden verilecek bağlantı veya QR kodu olarak' },
  'user.showLink': {
    de: 'Link / QR-Code zeigen',
    en: 'Show link / QR code',
    tr: 'Bağlantıyı / QR kodunu göster' },
  'user.linkTitle': {
    de: 'Zugangslink',
    en: 'Access link',
    tr: 'Erişim bağlantısı' },
  'user.linkHint': {
    de: 'Mit dem Handy scannen oder den Link als Nachricht schicken. Damit '
      + 'setzt die Person ihr Kennwort. Der Link gilt einmal – geben Sie ihn '
      + 'nur dieser Person.',
    en: 'Scan with a phone or send the link as a message. The person uses it '
      + 'to set their password. The link works once – give it to this '
      + 'person only.',
    tr: 'Telefonla tarayın veya bağlantıyı mesaj olarak gönderin. Kişi '
      + 'parolasını bununla belirler. Bağlantı bir kez geçerlidir – yalnızca '
      + 'bu kişiye verin.' },
  'user.linkQr': {
    de: 'QR-Code des Zugangslinks',
    en: 'QR code of the access link',
    tr: 'Erişim bağlantısının QR kodu' },
  'user.linkCopy': {
    de: 'Kopieren',
    en: 'Copy',
    tr: 'Kopyala' },
  'user.linkCopied': {
    de: 'Kopiert',
    en: 'Copied',
    tr: 'Kopyalandı' },
  'user.linkValidUntil': {
    de: 'Gültig bis {bis}',
    en: 'Valid until {bis}',
    tr: '{bis} tarihine kadar geçerli' },
  'user.invitedLink': {
    de: 'Eingeladen. Geben Sie der Person jetzt den Link oder den QR-Code.',
    en: 'Invited. Now give the person the link or the QR code.',
    tr: 'Davet edildi. Şimdi kişiye bağlantıyı veya QR kodunu verin.' },
  'user.invited': {
    de: 'Eingeladen. Die E-Mail ist unterwegs.',
    en: 'Invited. The email is on its way.',
    tr: 'Davet edildi. E-posta yolda.' },
  'user.name': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'user.email': {
    de: 'E-Mail',
    en: 'Email',
    tr: 'E-posta' },
  'user.sendInvite': {
    de: 'Einladung erneut schicken',
    en: 'Resend invitation',
    tr: 'Daveti yeniden gönder' },
  'user.sendReset': {
    de: 'Kennwort-Link schicken',
    en: 'Send password link',
    tr: 'Parola bağlantısı gönder' },
  'user.linkSent': {
    de: 'Link ist unterwegs.',
    en: 'Link is on its way.',
    tr: 'Bağlantı yolda.' },
  'user.unlock': {
    de: 'Entsperren',
    en: 'Unlock',
    tr: 'Kilidi aç' },
  'user.lockedUntil': {
    de: 'nach Fehlversuchen gesperrt bis {bis}',
    en: 'locked after failed attempts until {bis}',
    tr: 'başarısız denemelerden sonra {bis} tarihine kadar kilitli' },
  'user.block': {
    de: 'Sperren',
    en: 'Block',
    tr: 'Engelle' },
  'user.unblock': {
    de: 'Sperre aufheben',
    en: 'Unblock',
    tr: 'Engeli kaldır' },
  'user.blocked': {
    de: 'Gesperrt',
    en: 'Blocked',
    tr: 'Engelli' },
  /*
   * Die Nachfrage sagt, was passiert. Gesperrt heisst: sofort raus, auch
   * mitten im Check-in, und die Rollen bleiben fuer die Rueckkehr stehen.
   */
  'user.blockConfirm': {
    de: '{name} sperren? Die Person kommt sofort nicht mehr herein, auch eine '
      + 'laufende Sitzung endet. Ihre Rollen bleiben stehen — die Sperre '
      + 'lässt sich jederzeit aufheben.',
    en: 'Block {name}? The person is locked out immediately, and any running '
      + 'session ends. Their roles stay — the block can be lifted any time.',
    tr: '{name} engellensin mi? Kişi hemen giremez, süren oturum da sona '
      + 'erer. Rolleri kalır — engel her zaman kaldırılabilir.' },
  'user.remove': {
    de: 'Entfernen',
    en: 'Remove',
    tr: 'Kaldır' },
  'user.removeConfirm': {
    de: '{name} aus dem Betrieb entfernen? Alle Rollen in allen Häusern '
      + 'fallen weg, laufende Sitzungen enden. Zurück geht es nur über eine '
      + 'neue Einladung.',
    en: 'Remove {name} from the business? All roles in all properties are '
      + 'dropped, running sessions end. The only way back is a new '
      + 'invitation.',
    tr: '{name} işletmeden kaldırılsın mı? Tüm tesislerdeki tüm roller '
      + 'düşer, süren oturumlar sona erer. Geri dönüş yalnızca yeni bir '
      + 'davetle mümkündür.' },
  'user.rename': {
    de: 'Name ändern',
    en: 'Rename',
    tr: 'Adı değiştir' },
  'user.accountRoles': {
    de: 'Rollen für den ganzen Betrieb',
    en: 'Roles for the whole business',
    tr: 'Tüm işletme için roller' },
  'user.accountRolesHint': {
    de: 'Inhaber, Buchhaltung, Steuerberatung: diese Rollen gelten in jedem '
      + 'Haus. Wer eine trägt, kann nur von jemandem geändert oder gesperrt '
      + 'werden, der den Betrieb verwaltet.',
    en: 'Owner, accounting, tax advisor: these roles apply in every property. '
      + 'Someone holding one can only be changed or blocked by someone who '
      + 'manages the business.',
    tr: 'Sahip, muhasebe, vergi danışmanı: bu roller her tesiste geçerlidir. '
      + 'Bunlardan birini taşıyan kişi yalnızca işletmeyi yöneten biri '
      + 'tarafından değiştirilebilir veya engellenebilir.' },
  'user.you': {
    de: 'Sie',
    en: 'you',
    tr: 'siz' },
  'user.noCreate': {
    de: 'Rollen für den ganzen Betrieb vergibt, wer den Betrieb verwaltet.',
    en: 'Roles for the whole business are granted by whoever manages the business.',
    tr: 'Tüm işletme için rolleri işletmeyi yöneten kişi verir.' }
} as const satisfies Record<string, LocalizedText>
