/** Einladung, Kennwort vergessen, Kennwort setzen. */
export const zugang = {
  de: {
    'zugang.forgot': 'Kennwort vergessen?',
    'zugang.reset.title': 'Kennwort zurücksetzen',
    'zugang.reset.hint': 'Tragen Sie Ihre E-Mail-Adresse ein. Wenn dazu ein Zugang '
                       + 'besteht, schicken wir Ihnen einen Link.',
    'zugang.reset.submit': 'Link anfordern',
    /*
     * Bewusst ohne "falls die Adresse bekannt ist". Der Satz soll denselben
     * Eindruck machen, ob es den Zugang gibt oder nicht -- sonst waere die
     * Seite ein Verzeichnis darueber, wer diese Software benutzt. Die
     * Schnittstelle antwortet aus demselben Grund immer 202.
     */
    'zugang.reset.done': 'Wir haben eine E-Mail verschickt. Sehen Sie in Ihrem '
                       + 'Postfach nach, auch im Spam-Ordner.',
    'zugang.invite.title': 'Willkommen',
    'zugang.invite.hint': 'Für Sie wurde ein Zugang eingerichtet. Vergeben Sie '
                        + 'jetzt Ihr Kennwort.',
    'zugang.set.title': 'Neues Kennwort vergeben',
    'zugang.password': 'Kennwort',
    'zugang.passwordRepeat': 'Kennwort wiederholen',
    'zugang.rule': 'Mindestens {min} Zeichen. Länge zählt, nicht Sonderzeichen — '
                 + 'ein Satz, den Sie sich merken, ist besser als ein kurzes '
                 + 'Kunstwort.',
    'zugang.mismatch': 'Die beiden Eingaben stimmen nicht überein.',
    'zugang.set.submit': 'Kennwort speichern',
    'zugang.set.done': 'Das Kennwort ist gesetzt. Sie können sich jetzt anmelden.',
    'zugang.toLogin': 'Zur Anmeldung',
    'zugang.noToken': 'Dieser Link ist unvollständig. Öffnen Sie ihn noch einmal '
                    + 'aus der E-Mail, oder fordern Sie einen neuen an.'
  },
  en: {
    'zugang.forgot': 'Forgot your password?',
    'zugang.reset.title': 'Reset your password',
    'zugang.reset.hint': 'Enter your email address. If an account exists for it, '
                       + 'we will send you a link.',
    'zugang.reset.submit': 'Request link',
    'zugang.reset.done': 'We have sent an email. Please check your inbox, '
                       + 'including the spam folder.',
    'zugang.invite.title': 'Welcome',
    'zugang.invite.hint': 'An account has been created for you. Please choose '
                        + 'your password now.',
    'zugang.set.title': 'Choose a new password',
    'zugang.password': 'Password',
    'zugang.passwordRepeat': 'Repeat password',
    'zugang.rule': 'At least {min} characters. Length matters, not special '
                 + 'characters — a sentence you can remember beats a short '
                 + 'invented word.',
    'zugang.mismatch': 'The two entries do not match.',
    'zugang.set.submit': 'Save password',
    'zugang.set.done': 'Your password is set. You can sign in now.',
    'zugang.toLogin': 'Go to sign in',
    'zugang.noToken': 'This link is incomplete. Please open it again from the '
                    + 'email, or request a new one.'
  }
} as const
