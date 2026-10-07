import { createContext, useContext } from 'react'
import { STAFF_LOCALES, type StaffLocale } from '@hotelpms/contracts'
import { ApiError } from '../lib/api.js'

/**
 * Die Saetze der Personal-App, in den vier Sprachen des Personals.
 *
 * **Ein eigener Katalog, nicht ein Bereich des grossen.** Der grosse traegt
 * jeden Satz in den Sprachen der Rezeption (`LOCALES`), und eine Sprache
 * steht dort erst, wenn sie fuer **alle** Bildschirme vollstaendig ist.
 * Russisch und Ukrainisch fuer zweitausend Saetze der Rezeption zu
 * uebersetzen, die das Reinigungspersonal nie sieht, waere Arbeit ohne
 * Leser. Die Personal-App hat ein paar Dutzend Saetze, und **in ihr** ist
 * jede der vier Sprachen vollstaendig -- `satisfies` macht eine vergessene
 * zum Typfehler an genau dem Schluessel, wie im grossen Katalog.
 */
type StaffText = { readonly [L in StaffLocale]: string }

const texte = {
  'app.title': {
    de: 'StayGrid Personal',
    en: 'StayGrid Staff',
    ru: 'StayGrid Персонал',
    uk: 'StayGrid Персонал' },
  'app.loading': {
    de: 'Wird geladen …',
    en: 'Loading …',
    ru: 'Загрузка …',
    uk: 'Завантаження …' },
  'app.offline': {
    de: 'Keine Verbindung zum Server. Prüfe WLAN oder mobile Daten.',
    en: 'No connection to the server. Check Wi-Fi or mobile data.',
    ru: 'Нет связи с сервером. Проверьте Wi-Fi или мобильный интернет.',
    uk: 'Немає звʼязку з сервером. Перевірте Wi-Fi або мобільний інтернет.' },
  'app.retry': {
    de: 'Erneut versuchen',
    en: 'Try again',
    ru: 'Повторить',
    uk: 'Спробувати ще раз' },
  'app.noAccess': {
    de: 'Dieser Zugang ist nicht für die Personal-App freigeschaltet. '
      + 'Bitte an der Rezeption melden.',
    en: 'This account is not enabled for the staff app. Please ask at reception.',
    ru: 'Этот доступ не открыт для приложения персонала. Обратитесь на ресепшен.',
    uk: 'Цей доступ не відкрито для застосунку персоналу. Зверніться на рецепцію.' },

  'login.title': {
    de: 'Anmelden',
    en: 'Sign in',
    ru: 'Вход',
    uk: 'Вхід' },
  'login.name': {
    de: 'Benutzername oder E-Mail',
    en: 'Username or email',
    ru: 'Имя пользователя или e-mail',
    uk: 'Імʼя користувача або e-mail' },
  'login.password': {
    de: 'Kennwort',
    en: 'Password',
    ru: 'Пароль',
    uk: 'Пароль' },
  'login.submit': {
    de: 'Anmelden',
    en: 'Sign in',
    ru: 'Войти',
    uk: 'Увійти' },
  /*
   * Kein "Kennwort vergessen"-Link wie in der Rezeption: der schickt eine
   * Mail, und die meisten hier haben keine Adresse hinterlegt. Ein Knopf,
   * der fuer die Mehrheit still nichts tut, ist schlechter als der Satz,
   * wer weiterhilft -- die Rezeption zeigt einen neuen Link als QR-Code.
   */
  'login.forgot': {
    de: 'Kennwort vergessen? Die Rezeption zeigt dir einen neuen Link.',
    en: 'Forgot your password? Reception can show you a new link.',
    ru: 'Забыли пароль? На ресепшене вам покажут новую ссылку.',
    uk: 'Забули пароль? На рецепції вам покажуть нове посилання.' },

  'set.inviteTitle': {
    de: 'Willkommen',
    en: 'Welcome',
    ru: 'Добро пожаловать',
    uk: 'Ласкаво просимо' },
  'set.inviteHint': {
    de: 'Lege ein Kennwort fest. Damit meldest du dich ab jetzt in der App an.',
    en: 'Choose a password. You will use it to sign in to the app from now on.',
    ru: 'Придумайте пароль. С ним вы будете входить в приложение.',
    uk: 'Придумайте пароль. З ним ви надалі входитимете в застосунок.' },
  'set.resetTitle': {
    de: 'Neues Kennwort',
    en: 'New password',
    ru: 'Новый пароль',
    uk: 'Новий пароль' },
  'set.password': {
    de: 'Kennwort',
    en: 'Password',
    ru: 'Пароль',
    uk: 'Пароль' },
  'set.repeat': {
    de: 'Kennwort wiederholen',
    en: 'Repeat password',
    ru: 'Повторите пароль',
    uk: 'Повторіть пароль' },
  'set.rule': {
    de: 'Mindestens {min} Zeichen. Ein Satz, den du dir merken kannst, ist gut.',
    en: 'At least {min} characters. A sentence you can remember works well.',
    ru: 'Не меньше {min} символов. Хорошо подходит фраза, которую легко запомнить.',
    uk: 'Щонайменше {min} символів. Добре підходить фраза, яку легко запамʼятати.' },
  'set.mismatch': {
    de: 'Die beiden Kennwörter sind nicht gleich.',
    en: 'The two passwords do not match.',
    ru: 'Пароли не совпадают.',
    uk: 'Паролі не збігаються.' },
  'set.submit': {
    de: 'Kennwort speichern',
    en: 'Save password',
    ru: 'Сохранить пароль',
    uk: 'Зберегти пароль' },
  'set.done': {
    de: 'Fertig. Melde dich jetzt mit deinem Kennwort an.',
    en: 'Done. Now sign in with your password.',
    ru: 'Готово. Теперь войдите со своим паролем.',
    uk: 'Готово. Тепер увійдіть зі своїм паролем.' },
  'set.noToken': {
    de: 'Dieser Link ist unvollständig. Bitte an der Rezeption nach einem neuen fragen.',
    en: 'This link is incomplete. Please ask reception for a new one.',
    ru: 'Ссылка неполная. Попросите новую на ресепшене.',
    uk: 'Посилання неповне. Попросіть нове на рецепції.' },
  'set.toLogin': {
    de: 'Zur Anmeldung',
    en: 'Go to sign in',
    ru: 'Ко входу',
    uk: 'До входу' },

  'tab.today': {
    de: 'Heute',
    en: 'Today',
    ru: 'Сегодня',
    uk: 'Сьогодні' },
  'tab.more': {
    de: 'Mehr',
    en: 'More',
    ru: 'Ещё',
    uk: 'Більше' },
  'today.hello': {
    de: 'Hallo {name}',
    en: 'Hello {name}',
    ru: 'Здравствуйте, {name}',
    uk: 'Вітаємо, {name}' },
  /*
   * Platzhalter bis Baustein 2. Er sagt, was hier erscheinen wird, damit
   * eine leere Seite nicht wie ein Fehler aussieht.
   */
  'today.empty': {
    de: 'Hier stehen bald deine Zimmer für heute. Bis dahin gilt der Plan wie gewohnt.',
    en: 'Your rooms for today will appear here soon. Until then, use the plan as usual.',
    ru: 'Скоро здесь появятся ваши номера на сегодня. А пока работайте по плану, как обычно.',
    uk: 'Незабаром тут зʼявляться ваші номери на сьогодні. А поки працюйте за планом, як зазвичай.' },

  'more.language': {
    de: 'Sprache',
    en: 'Language',
    ru: 'Язык',
    uk: 'Мова' },
  'more.password': {
    de: 'Kennwort ändern',
    en: 'Change password',
    ru: 'Сменить пароль',
    uk: 'Змінити пароль' },
  'more.current': {
    de: 'Aktuelles Kennwort',
    en: 'Current password',
    ru: 'Текущий пароль',
    uk: 'Поточний пароль' },
  'more.new': {
    de: 'Neues Kennwort',
    en: 'New password',
    ru: 'Новый пароль',
    uk: 'Новий пароль' },
  'more.passwordSaved': {
    de: 'Kennwort geändert.',
    en: 'Password changed.',
    ru: 'Пароль изменён.',
    uk: 'Пароль змінено.' },
  'more.install': {
    de: 'Auf den Startbildschirm legen',
    en: 'Add to home screen',
    ru: 'Добавить на главный экран',
    uk: 'Додати на головний екран' },
  /*
   * Fuer Safari auf dem iPhone: dort gibt es kein Angebot des Browsers, das
   * die App abfangen koennte, nur den Weg ueber das Teilen-Menue.
   */
  'more.installIos': {
    de: 'Auf dem iPhone: Teilen-Symbol, dann „Zum Home-Bildschirm“.',
    en: 'On iPhone: tap Share, then “Add to Home Screen”.',
    ru: 'На iPhone: «Поделиться», затем «На экран „Домой“».',
    uk: 'На iPhone: «Поділитися», потім «На екран „Додому“».' },
  'more.logout': {
    de: 'Abmelden',
    en: 'Sign out',
    ru: 'Выйти',
    uk: 'Вийти' },
  'more.signedInAs': {
    de: 'Angemeldet als {name}',
    en: 'Signed in as {name}',
    ru: 'Вы вошли как {name}',
    uk: 'Ви увійшли як {name}' },

  /*
   * Die Fehler, die hier vorkommen koennen, mit eigenem Satz. Die
   * Schnittstelle antwortet deutsch und legt den Schluessel daneben; ihr
   * Katalog kennt aber nur die Sprachen der Rezeption. Fuer die wenigen
   * Schluessel dieser App steht der Satz deshalb hier, in allen vier.
   */
  'error.auth.badCredentials': {
    de: 'Benutzername oder Kennwort stimmt nicht.',
    en: 'Username or password is incorrect.',
    ru: 'Неверное имя пользователя или пароль.',
    uk: 'Неправильне імʼя користувача або пароль.' },
  'error.auth.tooManyAttempts': {
    de: 'Zu viele Versuche. Bitte warte ein paar Minuten.',
    en: 'Too many attempts. Please wait a few minutes.',
    ru: 'Слишком много попыток. Подождите несколько минут.',
    uk: 'Забагато спроб. Зачекайте кілька хвилин.' },
  'error.auth.tokenInvalid': {
    de: 'Dieser Link ist abgelaufen oder wurde schon benutzt. '
      + 'Bitte an der Rezeption nach einem neuen fragen.',
    en: 'This link has expired or was already used. Please ask reception for a new one.',
    ru: 'Ссылка устарела или уже использована. Попросите новую на ресепшене.',
    uk: 'Посилання застаріло або вже використане. Попросіть нове на рецепції.' },
  'error.auth.passwordTooShort': {
    de: 'Das Kennwort ist zu kurz: mindestens {min} Zeichen.',
    en: 'The password is too short: at least {min} characters.',
    ru: 'Пароль слишком короткий: не меньше {min} символов.',
    uk: 'Пароль закороткий: щонайменше {min} символів.' },
  'error.auth.passwordUnchanged': {
    de: 'Das neue Kennwort ist dasselbe wie das alte.',
    en: 'The new password is the same as the old one.',
    ru: 'Новый пароль совпадает со старым.',
    uk: 'Новий пароль збігається зі старим.' },
  'error.generic': {
    de: 'Das hat nicht geklappt. Bitte noch einmal versuchen.',
    en: 'That did not work. Please try again.',
    ru: 'Не получилось. Попробуйте ещё раз.',
    uk: 'Не вдалося. Спробуйте ще раз.' }
} as const satisfies Record<string, StaffText>

export type PersonalKey = keyof typeof texte

export function personalKeys(): PersonalKey[] {
  return Object.keys(texte) as PersonalKey[]
}

/**
 * Wie sich eine Sprache selbst nennt -- in der Auswahl steht "Українська",
 * nicht "Ukrainisch": wer die Sprache sucht, liest die anderen nicht.
 */
export const SPRACHNAME: Record<StaffLocale, string> = {
  de: 'Deutsch',
  en: 'English',
  ru: 'Русский',
  uk: 'Українська'
}

/**
 * Die Sprache, in der die App startet: die am Benutzer gespeicherte, sonst
 * die des Telefons, sonst Deutsch. Eine gespeicherte Sprache, die diese App
 * nicht spricht (Tuerkisch aus der Rezeption), faellt auf das Telefon
 * zurueck und nicht gleich auf Deutsch.
 */
export function startSprache(
  gespeichert: string | null | undefined, telefon: string
): StaffLocale {
  const passt = (s: string | null | undefined): s is StaffLocale =>
    typeof s === 'string' && (STAFF_LOCALES as readonly string[]).includes(s)
  if (passt(gespeichert)) return gespeichert
  const kurz = telefon.slice(0, 2).toLowerCase()
  return passt(kurz) ? kurz : 'de'
}

export const SpracheContext = createContext<StaffLocale>('de')

export function text(
  key: PersonalKey, locale: StaffLocale, params?: Record<string, string | number>
): string {
  const t: string = texte[key][locale]
  if (params === undefined) return t
  return t.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
}

export function usePT(): (key: PersonalKey, params?: Record<string, string | number>)
  => string {
  const locale = useContext(SpracheContext)
  return (key, params) => text(key, locale, params)
}

/**
 * Ein Fehler der Schnittstelle als Satz in der Sprache des Personals.
 *
 * Bekannte Schluessel bekommen ihren Satz von hier, auch an einem Feld
 * (`errorKeys` bei 422). Alles andere wird zum allgemeinen Satz -- nicht
 * zum deutschen Text der Schnittstelle: wer kein Deutsch liest, hat von
 * einem genauen Satz, den er nicht versteht, weniger als von einem
 * ungenauen in seiner Sprache. Auf Deutsch steht der genaue Satz da.
 */
export function fehlerText(e: unknown, locale: StaffLocale): string {
  if (!(e instanceof ApiError)) return text('error.generic', locale)
  const p = e.problem
  const schluessel = [p.code, ...Object.values(p.errorKeys ?? {}).flat()]
  const params = (p.params ?? {}) as Record<string, string | number>
  for (const k of schluessel) {
    if (k === undefined) continue
    const eigen = `error.${k}`
    if (Object.prototype.hasOwnProperty.call(texte, eigen)) {
      return text(eigen as PersonalKey, locale, params)
    }
  }
  if (locale === 'de') return p.detail ?? p.title
  return text('error.generic', locale)
}
