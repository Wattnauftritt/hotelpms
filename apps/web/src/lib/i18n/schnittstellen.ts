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
  'user.noCreate': {
    de: 'Einen Benutzer anzulegen gehört zur Einladung mit Erstkennwort '
      + 'und zweitem Faktor; das ist ein eigener Vorgang. Hier werden '
      + 'Rollen von Menschen geändert, die es im Account schon gibt.',
    en: 'Creating a user belongs to the invitation flow with a first '
      + 'password and a second factor; that is a separate matter. Here '
      + 'the roles of people who already exist in the account are changed.',
    tr: 'Kullanıcı oluşturmak, ilk parola ve ikinci faktörle yapılan davetin parçasıdır; o ayrı bir işlemdir. Burada, account\'ta zaten bulunan kişilerin rolleri değiştirilir.' },
} as const satisfies Record<string, LocalizedText>
