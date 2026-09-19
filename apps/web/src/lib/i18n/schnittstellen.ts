import type { LocalizedText } from '@hotelpms/contracts'

/** Schnittstellen: Webhooks, Maschinenzugänge, Channel Manager, Benutzer. */
export const schnittstellen = {
  'nav.integrations': {
    de: 'Schnittstellen',
    en: 'Integrations',
    tr: 'Arayüzler' },
  'int.title': {
    de: 'Schnittstellen',
    en: 'Integrations',
    tr: 'Arayüzler' },
  'int.tab.webhooks': {
    de: 'Webhooks',
    en: 'Webhooks',
    tr: 'Webhook\'lar' },
  'int.tab.clients': {
    de: 'Maschinenzugänge',
    en: 'Machine access',
    tr: 'Makine erişimleri' },
  'int.tab.channel': {
    de: 'Channel Manager',
    en: 'Channel manager',
    tr: 'Channel Manager' },
  'int.tab.users': {
    de: 'Benutzer und Rollen',
    en: 'Users and roles',
    tr: 'Kullanıcılar ve roller' },

  'secret.title': {
    de: 'Einmal zu sehen',
    en: 'Shown once',
    tr: 'Bir kez görünür' },
  'secret.hint': {
    de: 'Dieses Geheimnis wird jetzt gezeigt und nie wieder. Ein Geheimnis, '
      + 'das sich erneut abrufen lässt, liegt in jedem Bildschirmfoto.',
    en: 'This secret is shown now and never again. A secret that can be '
      + 'fetched again is a secret that sits in every screenshot.',
    tr: 'Bu gizli anahtar şimdi gösteriliyor ve bir daha asla. Yeniden çağrılabilen bir gizli anahtar, her ekran görüntüsünde durur.' },
  'secret.copy': {
    de: 'Kopieren',
    en: 'Copy',
    tr: 'Kopyala' },
  'secret.done': {
    de: 'Habe ich notiert',
    en: 'I have written it down',
    tr: 'Not aldım' },

  'hook.new': {
    de: 'Abonnement anlegen',
    en: 'New subscription',
    tr: 'Abonelik oluştur' },
  'hook.url': {
    de: 'Zieladresse',
    en: 'Target address',
    tr: 'Hedef adres' },
  'hook.urlHint': {
    de: 'Muss mit https:// beginnen. Über http reist der Inhalt im Klartext; '
      + 'die Signatur schützt seine Echtheit, nicht seine Vertraulichkeit.',
    en: 'Must start with https://. Over http the body travels in the clear; '
      + 'the signature protects its authenticity, not its confidentiality.',
    tr: 'https:// ile başlamalı. http üzerinden içerik açık metin olarak gider; imza içeriğin gerçekliğini korur, gizliliğini değil.' },
  'hook.eventTypes': {
    de: 'Ereignisarten',
    en: 'Event types',
    tr: 'Olay türleri' },
  'hook.allEventTypes': {
    de: 'Alle Ereignisarten',
    en: 'All event types',
    tr: 'Bütün olay türleri' },
  'hook.status.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'hook.status.disabled': {
    de: 'Stillgelegt',
    en: 'Disabled',
    tr: 'Devre dışı' },
  'hook.disabledBecause': {
    de: 'Stillgelegt, weil',
    en: 'Disabled because',
    tr: 'Devre dışı, çünkü' },
  'hook.enable': {
    de: 'Wieder einschalten',
    en: 'Re-enable',
    tr: 'Yeniden etkinleştir' },
  'hook.disable': {
    de: 'Stilllegen',
    en: 'Disable',
    tr: 'Devre dışı bırak' },
  'hook.deliveries': {
    de: 'Zustellprotokoll',
    en: 'Delivery log',
    tr: 'İletim kaydı' },
  'hook.noDeliveries': {
    de: 'Noch nichts zugestellt',
    en: 'Nothing delivered yet',
    tr: 'Henüz bir iletim yok' },
  'hook.attempts': {
    de: 'Versuche',
    en: 'Attempts',
    tr: 'Deneme' },
  'hook.nextAttempt': {
    de: 'Nächster Versuch',
    en: 'Next attempt',
    tr: 'Sonraki deneme' },
  'hook.deliveredAt': {
    de: 'Zugestellt',
    en: 'Delivered',
    tr: 'İletildi' },
  'hook.lastError': {
    de: 'Letzter Fehler',
    en: 'Last error',
    tr: 'Son hata' },
  'hook.signature': {
    de: 'Signatur: HMAC-SHA256 über „Zeitstempel.Rumpf".',
    en: 'Signature: HMAC-SHA256 over "timestamp.body".',
    tr: 'İmza: „zaman damgası.gövde" üzerinden HMAC-SHA256.' },
  'hook.enableHint': {
    de: 'Verpasste Ereignisse werden beim Einschalten nicht nachgeholt. '
      + 'Was fehlt, steht im Protokoll.',
    en: 'Missed events are not replayed on re-enabling. What is missing '
      + 'is in the log.',
    tr: 'Kaçırılan olaylar yeniden açıldığında telafi edilmez. Eksik olan, kayıtta durur.' },

  'client.new': {
    de: 'Maschinenzugang anlegen',
    en: 'New machine access',
    tr: 'Makine erişimi oluştur' },
  'client.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Tanım' },
  'client.scopes': {
    de: 'Zugriffsbereiche',
    en: 'Scopes',
    tr: 'Erişim alanları' },
  'client.scopesHint': {
    de: 'Zugriffsbereiche sind dieselben Rechte wie im Haus. Es gibt '
      + 'kein zweites Rechtesystem daneben.',
    en: 'Scopes are the same permissions as in the property. There is '
      + 'no second rights system beside it.',
    tr: 'Erişim alanları, tesisteki yetkilerin aynısıdır. Yanında ikinci bir yetki sistemi yoktur.' },
  'client.status.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'client.status.disabled': {
    de: 'Gesperrt',
    en: 'Revoked',
    tr: 'Engelli' },
  'client.revoke': {
    de: 'Sperren',
    en: 'Revoke',
    tr: 'Engelle' },
  'client.revokeConfirm': {
    de: 'Zugang sperren und alle laufenden Token entwerten?',
    en: 'Revoke this access and invalidate all its live tokens?',
    tr: 'Erişim engellensin ve süren bütün token\'lar geçersiz kılınsın mı?' },
  'client.activeTokens': {
    de: 'Laufende Token',
    en: 'Live tokens',
    tr: 'Süren token\'lar' },
  'client.lastUsed': {
    de: 'Zuletzt benutzt',
    en: 'Last used',
    tr: 'Son kullanım' },
  'client.never': {
    de: 'Noch nie',
    en: 'Never',
    tr: 'Hiç' },
  'client.allProperties': {
    de: 'Alle Häuser',
    en: 'All properties',
    tr: 'Bütün tesisler' },
  'client.tokenHint': {
    de: 'Token holen: POST /oauth/token mit grant_type=client_credentials.',
    en: 'Get a token: POST /oauth/token with grant_type=client_credentials.',
    tr: 'Token almak için: POST /oauth/token, grant_type=client_credentials.' },

  'chan.new': {
    de: 'Zugang anlegen',
    en: 'New connection',
    tr: 'Erişim oluştur' },
  'chan.provider': {
    de: 'Anbieter',
    en: 'Provider',
    tr: 'Sağlayıcı' },
  'chan.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Tanım' },
  'chan.status.active': {
    de: 'Aktiv',
    en: 'Active',
    tr: 'Aktif' },
  'chan.status.disabled': {
    de: 'Gesperrt',
    en: 'Disabled',
    tr: 'Engelli' },
  'chan.disable': {
    de: 'Sperren',
    en: 'Disable',
    tr: 'Engelle' },
  'chan.lastUsed': {
    de: 'Zuletzt geholt',
    en: 'Last fetched',
    tr: 'Son çekim' },
  'chan.never': {
    de: 'Noch nie',
    en: 'Never',
    tr: 'Hiç' },
  'chan.pullHint': {
    de: 'Der Channel Manager holt Preise, Verfügbarkeit und Restriktionen '
      + 'selbst ab. Wer gerade nicht erreichbar ist, verliert nichts.',
    en: 'The channel manager fetches rates, availability and restrictions '
      + 'itself. Anyone unreachable for a while loses nothing.',
    tr: 'Channel Manager fiyatları, müsaitliği ve kısıtları kendisi çeker. O sırada erişilemeyen bir taraf hiçbir şey kaybetmez.' },

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
    de: 'Die Person bekommt eine Einladung per E-Mail und setzt ihr Kennwort '
      + 'selbst. Sie bekommt die gewählten Rollen in diesem Haus.',
    en: 'The person receives an invitation by email and sets their own '
      + 'password. They get the chosen roles in this property.',
    tr: 'Kişi e-posta ile bir davet alır ve parolasını kendisi belirler. Bu '
      + 'tesiste seçilen rolleri alır.' },
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
    tr: 'Tüm işletme için rolleri işletmeyi yöneten kişi verir.' },
} as const satisfies Record<string, LocalizedText>
