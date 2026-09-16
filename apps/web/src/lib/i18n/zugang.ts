import type { LocalizedText } from '@hotelpms/contracts'

/** Einladung, Kennwort vergessen, Kennwort setzen. */
export const zugang = {
  'zugang.forgot': {
    de: 'Kennwort vergessen?',
    en: 'Forgot your password?' },
  'zugang.reset.title': {
    de: 'Kennwort zurücksetzen',
    en: 'Reset your password' },
  'zugang.reset.hint': {
    de: 'Tragen Sie Ihre E-Mail-Adresse ein. Wenn dazu ein Zugang '
      + 'besteht, schicken wir Ihnen einen Link.',
    en: 'Enter your email address. If an account exists for it, '
      + 'we will send you a link.' },
  'zugang.reset.submit': {
    de: 'Link anfordern',
    en: 'Request link' },
  /*
   * Bewusst ohne "falls die Adresse bekannt ist". Der Satz soll denselben
   * Eindruck machen, ob es den Zugang gibt oder nicht -- sonst waere die
   * Seite ein Verzeichnis darueber, wer diese Software benutzt. Die
   * Schnittstelle antwortet aus demselben Grund immer 202.
   */
  'zugang.reset.done': {
    de: 'Wir haben eine E-Mail verschickt. Sehen Sie in Ihrem '
      + 'Postfach nach, auch im Spam-Ordner.',
    en: 'We have sent an email. Please check your inbox, '
      + 'including the spam folder.' },
  'zugang.invite.title': {
    de: 'Willkommen',
    en: 'Welcome' },
  'zugang.invite.hint': {
    de: 'Für Sie wurde ein Zugang eingerichtet. Vergeben Sie '
      + 'jetzt Ihr Kennwort.',
    en: 'An account has been created for you. Please choose '
      + 'your password now.' },
  'zugang.set.title': {
    de: 'Neues Kennwort vergeben',
    en: 'Choose a new password' },
  'zugang.password': {
    de: 'Kennwort',
    en: 'Password' },
  'zugang.passwordRepeat': {
    de: 'Kennwort wiederholen',
    en: 'Repeat password' },
  'zugang.rule': {
    de: 'Mindestens {min} Zeichen. Länge zählt, nicht Sonderzeichen — '
      + 'ein Satz, den Sie sich merken, ist besser als ein kurzes '
      + 'Kunstwort.',
    en: 'At least {min} characters. Length matters, not special '
      + 'characters — a sentence you can remember beats a short '
      + 'invented word.' },
  'zugang.mismatch': {
    de: 'Die beiden Eingaben stimmen nicht überein.',
    en: 'The two entries do not match.' },
  'zugang.set.submit': {
    de: 'Kennwort speichern',
    en: 'Save password' },
  'zugang.set.done': {
    de: 'Das Kennwort ist gesetzt. Sie können sich jetzt anmelden.',
    en: 'Your password is set. You can sign in now.' },
  'zugang.toLogin': {
    de: 'Zur Anmeldung',
    en: 'Go to sign in' },
  'zugang.noToken': {
    de: 'Dieser Link ist unvollständig. Öffnen Sie ihn noch einmal '
      + 'aus der E-Mail, oder fordern Sie einen neuen an.',
    en: 'This link is incomplete. Please open it again from the '
      + 'email, or request a new one.' },
} as const satisfies Record<string, LocalizedText>
