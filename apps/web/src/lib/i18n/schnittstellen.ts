import type { LocalizedText } from '@hotelpms/contracts'

/** Schnittstellen: Webhooks, Maschinenzugänge, Channel Manager, Benutzer. */
export const schnittstellen = {
  'nav.integrations': {
    de: 'Schnittstellen',
    en: 'Integrations' },
  'int.title': {
    de: 'Schnittstellen',
    en: 'Integrations' },
  'int.tab.webhooks': {
    de: 'Webhooks',
    en: 'Webhooks' },
  'int.tab.clients': {
    de: 'Maschinenzugänge',
    en: 'Machine access' },
  'int.tab.channel': {
    de: 'Channel Manager',
    en: 'Channel manager' },
  'int.tab.users': {
    de: 'Benutzer und Rollen',
    en: 'Users and roles' },

  'secret.title': {
    de: 'Einmal zu sehen',
    en: 'Shown once' },
  'secret.hint': {
    de: 'Dieses Geheimnis wird jetzt gezeigt und nie wieder. Ein Geheimnis, '
      + 'das sich erneut abrufen lässt, liegt in jedem Bildschirmfoto.',
    en: 'This secret is shown now and never again. A secret that can be '
      + 'fetched again is a secret that sits in every screenshot.' },
  'secret.copy': {
    de: 'Kopieren',
    en: 'Copy' },
  'secret.done': {
    de: 'Habe ich notiert',
    en: 'I have written it down' },

  'hook.new': {
    de: 'Abonnement anlegen',
    en: 'New subscription' },
  'hook.url': {
    de: 'Zieladresse',
    en: 'Target address' },
  'hook.urlHint': {
    de: 'Muss mit https:// beginnen. Über http reist der Inhalt im Klartext; '
      + 'die Signatur schützt seine Echtheit, nicht seine Vertraulichkeit.',
    en: 'Must start with https://. Over http the body travels in the clear; '
      + 'the signature protects its authenticity, not its confidentiality.' },
  'hook.eventTypes': {
    de: 'Ereignisarten',
    en: 'Event types' },
  'hook.allEventTypes': {
    de: 'Alle Ereignisarten',
    en: 'All event types' },
  'hook.status.active': {
    de: 'Aktiv',
    en: 'Active' },
  'hook.status.disabled': {
    de: 'Stillgelegt',
    en: 'Disabled' },
  'hook.disabledBecause': {
    de: 'Stillgelegt, weil',
    en: 'Disabled because' },
  'hook.enable': {
    de: 'Wieder einschalten',
    en: 'Re-enable' },
  'hook.disable': {
    de: 'Stilllegen',
    en: 'Disable' },
  'hook.deliveries': {
    de: 'Zustellprotokoll',
    en: 'Delivery log' },
  'hook.noDeliveries': {
    de: 'Noch nichts zugestellt',
    en: 'Nothing delivered yet' },
  'hook.attempts': {
    de: 'Versuche',
    en: 'Attempts' },
  'hook.nextAttempt': {
    de: 'Nächster Versuch',
    en: 'Next attempt' },
  'hook.deliveredAt': {
    de: 'Zugestellt',
    en: 'Delivered' },
  'hook.lastError': {
    de: 'Letzter Fehler',
    en: 'Last error' },
  'hook.signature': {
    de: 'Signatur: HMAC-SHA256 über „Zeitstempel.Rumpf".',
    en: 'Signature: HMAC-SHA256 over "timestamp.body".' },
  'hook.enableHint': {
    de: 'Verpasste Ereignisse werden beim Einschalten nicht nachgeholt. '
      + 'Was fehlt, steht im Protokoll.',
    en: 'Missed events are not replayed on re-enabling. What is missing '
      + 'is in the log.' },

  'client.new': {
    de: 'Maschinenzugang anlegen',
    en: 'New machine access' },
  'client.name': {
    de: 'Bezeichnung',
    en: 'Name' },
  'client.scopes': {
    de: 'Zugriffsbereiche',
    en: 'Scopes' },
  'client.scopesHint': {
    de: 'Zugriffsbereiche sind dieselben Rechte wie im Haus. Es gibt '
      + 'kein zweites Rechtesystem daneben.',
    en: 'Scopes are the same permissions as in the property. There is '
      + 'no second rights system beside it.' },
  'client.status.active': {
    de: 'Aktiv',
    en: 'Active' },
  'client.status.disabled': {
    de: 'Gesperrt',
    en: 'Revoked' },
  'client.revoke': {
    de: 'Sperren',
    en: 'Revoke' },
  'client.revokeConfirm': {
    de: 'Zugang sperren und alle laufenden Token entwerten?',
    en: 'Revoke this access and invalidate all its live tokens?' },
  'client.activeTokens': {
    de: 'Laufende Token',
    en: 'Live tokens' },
  'client.lastUsed': {
    de: 'Zuletzt benutzt',
    en: 'Last used' },
  'client.never': {
    de: 'Noch nie',
    en: 'Never' },
  'client.allProperties': {
    de: 'Alle Häuser',
    en: 'All properties' },
  'client.tokenHint': {
    de: 'Token holen: POST /oauth/token mit grant_type=client_credentials.',
    en: 'Get a token: POST /oauth/token with grant_type=client_credentials.' },

  'chan.new': {
    de: 'Zugang anlegen',
    en: 'New connection' },
  'chan.provider': {
    de: 'Anbieter',
    en: 'Provider' },
  'chan.name': {
    de: 'Bezeichnung',
    en: 'Name' },
  'chan.status.active': {
    de: 'Aktiv',
    en: 'Active' },
  'chan.status.disabled': {
    de: 'Gesperrt',
    en: 'Disabled' },
  'chan.disable': {
    de: 'Sperren',
    en: 'Disable' },
  'chan.lastUsed': {
    de: 'Zuletzt geholt',
    en: 'Last fetched' },
  'chan.never': {
    de: 'Noch nie',
    en: 'Never' },
  'chan.pullHint': {
    de: 'Der Channel Manager holt Preise, Verfügbarkeit und Restriktionen '
      + 'selbst ab. Wer gerade nicht erreichbar ist, verliert nichts.',
    en: 'The channel manager fetches rates, availability and restrictions '
      + 'itself. Anyone unreachable for a while loses nothing.' },

  'user.roles': {
    de: 'Rollen',
    en: 'Roles' },
  'user.permissions': {
    de: 'Rechte',
    en: 'Permissions' },
  'user.noRoles': {
    de: 'Keine Rolle in diesem Haus',
    en: 'No role in this property' },
  'user.lastLogin': {
    de: 'Zuletzt angemeldet',
    en: 'Last signed in' },
  'user.never': {
    de: 'Noch nie',
    en: 'Never' },
  'user.status.active': {
    de: 'Aktiv',
    en: 'Active' },
  'user.status.invited': {
    de: 'Eingeladen',
    en: 'Invited' },
  'user.status.disabled': {
    de: 'Gesperrt',
    en: 'Disabled' },
  'user.edit': {
    de: 'Rollen ändern',
    en: 'Change roles' },
  'user.rolesHint': {
    de: 'Die Rechte stehen so da, wie die API sie liefert — sie werden '
      + 'nicht aus dem Rollennamen erraten.',
    en: 'Permissions are shown as the API delivers them — they are not '
      + 'guessed from the role name.' },
  'user.noCreate': {
    de: 'Einen Benutzer anzulegen gehört zur Einladung mit Erstkennwort '
      + 'und zweitem Faktor; das ist ein eigener Vorgang. Hier werden '
      + 'Rollen von Menschen geändert, die es im Account schon gibt.',
    en: 'Creating a user belongs to the invitation flow with a first '
      + 'password and a second factor; that is a separate matter. Here '
      + 'the roles of people who already exist in the account are changed.' },
} as const satisfies Record<string, LocalizedText>
