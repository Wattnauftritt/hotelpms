import type { LocalizedText } from '@hotelpms/contracts'

/** Einladung, Kennwort vergessen, Kennwort setzen. */
export const zugang = {
  'zugang.forgot': {
    de: 'Kennwort vergessen?',
    en: 'Forgot your password?',
    tr: 'Parolanızı mı unuttunuz?' },
  'zugang.reset.title': {
    de: 'Kennwort zurücksetzen',
    en: 'Reset your password',
    tr: 'Parolayı sıfırla' },
  'zugang.reset.hint': {
    de: 'Tragen Sie Ihre E-Mail-Adresse ein. Wenn dazu ein Zugang '
      + 'besteht, schicken wir Ihnen einen Link.',
    en: 'Enter your email address. If an account exists for it, '
      + 'we will send you a link.',
    tr: 'E-posta adresinizi girin. Buna bağlı bir erişim varsa size bir bağlantı göndeririz.' },
  'zugang.reset.submit': {
    de: 'Link anfordern',
    en: 'Request link',
    tr: 'Bağlantı iste' },
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
      + 'including the spam folder.',
    tr: 'Bir e-posta gönderdik. Gelen kutunuza, ayrıca spam klasörüne de bakın.' },
  'zugang.invite.title': {
    de: 'Willkommen',
    en: 'Welcome',
    tr: 'Hoş geldiniz' },
  'zugang.invite.hint': {
    de: 'Für Sie wurde ein Zugang eingerichtet. Vergeben Sie '
      + 'jetzt Ihr Kennwort.',
    en: 'An account has been created for you. Please choose '
      + 'your password now.',
    tr: 'Sizin için bir erişim oluşturuldu. Şimdi parolanızı belirleyin.' },
  'zugang.set.title': {
    de: 'Neues Kennwort vergeben',
    en: 'Choose a new password',
    tr: 'Yeni parola belirle' },
  'zugang.password': {
    de: 'Kennwort',
    en: 'Password',
    tr: 'Parola' },
  'zugang.passwordRepeat': {
    de: 'Kennwort wiederholen',
    en: 'Repeat password',
    tr: 'Parolayı yineleyin' },
  'zugang.rule': {
    de: 'Mindestens {min} Zeichen. Länge zählt, nicht Sonderzeichen — '
      + 'ein Satz, den Sie sich merken, ist besser als ein kurzes '
      + 'Kunstwort.',
    en: 'At least {min} characters. Length matters, not special '
      + 'characters — a sentence you can remember beats a short '
      + 'invented word.',
    tr: 'En az {min} karakter. Önemli olan uzunluktur, özel karakterler değil — aklınızda kalan bir cümle, kısa bir uydurma sözcükten iyidir.' },
  'zugang.mismatch': {
    de: 'Die beiden Eingaben stimmen nicht überein.',
    en: 'The two entries do not match.',
    tr: 'İki girdi birbiriyle uyuşmuyor.' },
  'zugang.set.submit': {
    de: 'Kennwort speichern',
    en: 'Save password',
    tr: 'Parolayı kaydet' },
  'zugang.set.done': {
    de: 'Das Kennwort ist gesetzt. Sie können sich jetzt anmelden.',
    en: 'Your password is set. You can sign in now.',
    tr: 'Parola belirlendi. Artık oturum açabilirsiniz.' },
  'zugang.toLogin': {
    de: 'Zur Anmeldung',
    en: 'Go to sign in',
    tr: 'Oturum açmaya git' },
  'zugang.noToken': {
    de: 'Dieser Link ist unvollständig. Öffnen Sie ihn noch einmal '
      + 'aus der E-Mail, oder fordern Sie einen neuen an.',
    en: 'This link is incomplete. Please open it again from the '
      + 'email, or request a new one.',
    tr: 'Bu bağlantı eksik. Onu e-postadan bir kez daha açın veya yenisini isteyin.' },
} as const satisfies Record<string, LocalizedText>
