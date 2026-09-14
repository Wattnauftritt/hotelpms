/** Schnittstellen: Webhooks, Maschinenzugänge, Channel Manager, Benutzer. */
export const schnittstellen = {
  de: {
    'nav.integrations': 'Schnittstellen',
    'int.title': 'Schnittstellen',
    'int.tab.webhooks': 'Webhooks',
    'int.tab.clients': 'Maschinenzugänge',
    'int.tab.channel': 'Channel Manager',
    'int.tab.users': 'Benutzer und Rollen',

    'secret.title': 'Einmal zu sehen',
    'secret.hint': 'Dieses Geheimnis wird jetzt gezeigt und nie wieder. Ein Geheimnis, '
                 + 'das sich erneut abrufen lässt, liegt in jedem Bildschirmfoto.',
    'secret.copy': 'Kopieren',
    'secret.done': 'Habe ich notiert',

    'hook.new': 'Abonnement anlegen',
    'hook.url': 'Zieladresse',
    'hook.urlHint': 'Muss mit https:// beginnen. Über http reist der Inhalt im Klartext; '
                  + 'die Signatur schützt seine Echtheit, nicht seine Vertraulichkeit.',
    'hook.eventTypes': 'Ereignisarten',
    'hook.allEventTypes': 'Alle Ereignisarten',
    'hook.status.active': 'Aktiv',
    'hook.status.disabled': 'Stillgelegt',
    'hook.disabledBecause': 'Stillgelegt, weil',
    'hook.enable': 'Wieder einschalten',
    'hook.disable': 'Stilllegen',
    'hook.deliveries': 'Zustellprotokoll',
    'hook.noDeliveries': 'Noch nichts zugestellt',
    'hook.attempts': 'Versuche',
    'hook.nextAttempt': 'Nächster Versuch',
    'hook.deliveredAt': 'Zugestellt',
    'hook.lastError': 'Letzter Fehler',
    'hook.signature': 'Signatur: HMAC-SHA256 über „Zeitstempel.Rumpf".',
    'hook.enableHint': 'Verpasste Ereignisse werden beim Einschalten nicht nachgeholt. '
                     + 'Was fehlt, steht im Protokoll.',

    'client.new': 'Maschinenzugang anlegen',
    'client.name': 'Bezeichnung',
    'client.scopes': 'Zugriffsbereiche',
    'client.scopesHint': 'Zugriffsbereiche sind dieselben Rechte wie im Haus. Es gibt '
                       + 'kein zweites Rechtesystem daneben.',
    'client.status.active': 'Aktiv',
    'client.status.disabled': 'Gesperrt',
    'client.revoke': 'Sperren',
    'client.revokeConfirm': 'Zugang sperren und alle laufenden Token entwerten?',
    'client.activeTokens': 'Laufende Token',
    'client.lastUsed': 'Zuletzt benutzt',
    'client.never': 'Noch nie',
    'client.allProperties': 'Alle Häuser',
    'client.tokenHint': 'Token holen: POST /oauth/token mit grant_type=client_credentials.',

    'chan.new': 'Zugang anlegen',
    'chan.provider': 'Anbieter',
    'chan.name': 'Bezeichnung',
    'chan.status.active': 'Aktiv',
    'chan.status.disabled': 'Gesperrt',
    'chan.disable': 'Sperren',
    'chan.lastUsed': 'Zuletzt geholt',
    'chan.never': 'Noch nie',
    'chan.pullHint': 'Der Channel Manager holt Preise, Verfügbarkeit und Restriktionen '
                   + 'selbst ab. Wer gerade nicht erreichbar ist, verliert nichts.',

    'user.roles': 'Rollen',
    'user.permissions': 'Rechte',
    'user.noRoles': 'Keine Rolle in diesem Haus',
    'user.lastLogin': 'Zuletzt angemeldet',
    'user.never': 'Noch nie',
    'user.status.active': 'Aktiv',
    'user.status.invited': 'Eingeladen',
    'user.status.disabled': 'Gesperrt',
    'user.edit': 'Rollen ändern',
    'user.rolesHint': 'Die Rechte stehen so da, wie die API sie liefert — sie werden '
                    + 'nicht aus dem Rollennamen erraten.',
    'user.noCreate': 'Einen Benutzer anzulegen gehört zur Einladung mit Erstkennwort '
                   + 'und zweitem Faktor; das ist ein eigener Vorgang. Hier werden '
                   + 'Rollen von Menschen geändert, die es im Account schon gibt.'
  },
  en: {
    'nav.integrations': 'Integrations',
    'int.title': 'Integrations',
    'int.tab.webhooks': 'Webhooks',
    'int.tab.clients': 'Machine access',
    'int.tab.channel': 'Channel manager',
    'int.tab.users': 'Users and roles',

    'secret.title': 'Shown once',
    'secret.hint': 'This secret is shown now and never again. A secret that can be '
                 + 'fetched again is a secret that sits in every screenshot.',
    'secret.copy': 'Copy',
    'secret.done': 'I have written it down',

    'hook.new': 'New subscription',
    'hook.url': 'Target address',
    'hook.urlHint': 'Must start with https://. Over http the body travels in the clear; '
                  + 'the signature protects its authenticity, not its confidentiality.',
    'hook.eventTypes': 'Event types',
    'hook.allEventTypes': 'All event types',
    'hook.status.active': 'Active',
    'hook.status.disabled': 'Disabled',
    'hook.disabledBecause': 'Disabled because',
    'hook.enable': 'Re-enable',
    'hook.disable': 'Disable',
    'hook.deliveries': 'Delivery log',
    'hook.noDeliveries': 'Nothing delivered yet',
    'hook.attempts': 'Attempts',
    'hook.nextAttempt': 'Next attempt',
    'hook.deliveredAt': 'Delivered',
    'hook.lastError': 'Last error',
    'hook.signature': 'Signature: HMAC-SHA256 over "timestamp.body".',
    'hook.enableHint': 'Missed events are not replayed on re-enabling. What is missing '
                     + 'is in the log.',

    'client.new': 'New machine access',
    'client.name': 'Name',
    'client.scopes': 'Scopes',
    'client.scopesHint': 'Scopes are the same permissions as in the property. There is '
                       + 'no second rights system beside it.',
    'client.status.active': 'Active',
    'client.status.disabled': 'Revoked',
    'client.revoke': 'Revoke',
    'client.revokeConfirm': 'Revoke this access and invalidate all its live tokens?',
    'client.activeTokens': 'Live tokens',
    'client.lastUsed': 'Last used',
    'client.never': 'Never',
    'client.allProperties': 'All properties',
    'client.tokenHint': 'Get a token: POST /oauth/token with grant_type=client_credentials.',

    'chan.new': 'New connection',
    'chan.provider': 'Provider',
    'chan.name': 'Name',
    'chan.status.active': 'Active',
    'chan.status.disabled': 'Disabled',
    'chan.disable': 'Disable',
    'chan.lastUsed': 'Last fetched',
    'chan.never': 'Never',
    'chan.pullHint': 'The channel manager fetches rates, availability and restrictions '
                   + 'itself. Anyone unreachable for a while loses nothing.',

    'user.roles': 'Roles',
    'user.permissions': 'Permissions',
    'user.noRoles': 'No role in this property',
    'user.lastLogin': 'Last signed in',
    'user.never': 'Never',
    'user.status.active': 'Active',
    'user.status.invited': 'Invited',
    'user.status.disabled': 'Disabled',
    'user.edit': 'Change roles',
    'user.rolesHint': 'Permissions are shown as the API delivers them — they are not '
                    + 'guessed from the role name.',
    'user.noCreate': 'Creating a user belongs to the invitation flow with a first '
                   + 'password and a second factor; that is a separate matter. Here '
                   + 'the roles of people who already exist in the account are changed.'
  }
} as const
