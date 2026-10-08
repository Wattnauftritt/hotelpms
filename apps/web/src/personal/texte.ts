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
   * Ohne Zimmer: das ist kein Fehler, sondern ein Tag ohne Plan -- oder
   * jemand aus der Kueche. Der Satz sagt, an wen man sich wendet.
   */
  'today.empty': {
    de: 'Für heute sind dir keine Zimmer zugeteilt. Frag die Hausdame, wenn das nicht stimmt.',
    en: 'No rooms are assigned to you today. Ask the head housekeeper if that seems wrong.',
    ru: 'На сегодня вам не назначены номера. Если это ошибка, спросите у старшей горничной.',
    uk: 'На сьогодні вам не призначено номерів. Якщо це помилка, запитайте старшу покоївку.' },
  'today.progress': {
    de: '{done} von {total} erledigt',
    en: '{done} of {total} done',
    ru: 'Готово: {done} из {total}',
    uk: 'Готово: {done} з {total}' },
  'today.minutes': {
    de: 'Heute {minutes} Min.',
    en: 'Today {minutes} min',
    ru: 'Сегодня {minutes} мин.',
    uk: 'Сьогодні {minutes} хв' },
  'today.open': {
    de: 'Offen',
    en: 'To do',
    ru: 'Осталось',
    uk: 'Залишилось' },
  'today.done': {
    de: 'Erledigt',
    en: 'Done',
    ru: 'Готово',
    uk: 'Готово' },
  'today.property': {
    de: 'Haus',
    en: 'Property',
    ru: 'Объект',
    uk: 'Обʼєкт' },

  'room.number': {
    de: 'Zimmer {code}',
    en: 'Room {code}',
    ru: 'Номер {code}',
    uk: 'Номер {code}' },
  'room.area': {
    de: 'Bereich',
    en: 'Area',
    ru: 'Зона',
    uk: 'Зона' },
  'room.departure': {
    de: 'Abreise',
    en: 'Check-out',
    ru: 'Выезд',
    uk: 'Виїзд' },
  'room.stayover': {
    de: 'Bleiber',
    en: 'Stayover',
    ru: 'Проживающий',
    uk: 'Проживає' },
  'room.free': {
    de: 'Frei',
    en: 'Free',
    ru: 'Свободен',
    uk: 'Вільний' },
  /*
   * Kein Verbot: viele Haeuser checken nicht jeden Gast von Hand aus. Die
   * Kraft sieht, ob das Zimmer leer ist; der Satz sagt nur, was StayGrid
   * weiss.
   */
  'room.ready': {
    de: 'Abgereist – bereit',
    en: 'Checked out – ready',
    ru: 'Выехал – можно убирать',
    uk: 'Виїхав – можна прибирати' },
  'room.waiting': {
    de: 'Gast noch nicht ausgecheckt',
    en: 'Guest not checked out yet',
    ru: 'Гость ещё не выехал',
    uk: 'Гість ще не виїхав' },
  'room.arrival': {
    de: 'Heute Anreise',
    en: 'Arrival today',
    ru: 'Сегодня заезд',
    uk: 'Сьогодні заїзд' },
  'room.original': {
    de: 'Original',
    en: 'Original',
    ru: 'Оригинал',
    uk: 'Оригінал' },
  'room.problems': {
    de: 'Gemeldet: {n}',
    en: 'Reported: {n}',
    ru: 'Сообщено: {n}',
    uk: 'Повідомлено: {n}' },
  'room.minutes': {
    de: '{minutes} Min.',
    en: '{minutes} min',
    ru: '{minutes} мин.',
    uk: '{minutes} хв' },
  /*
   * Die Hausdame hat umgeplant, waehrend die Kraft im Zimmer war, oder der
   * Tag ist abgeschlossen. Die Liste laedt neu; der Satz sagt, warum das
   * Zimmer weg ist.
   */
  'room.gone': {
    de: 'Dieses Zimmer ist dir nicht mehr zugeteilt. Die Liste ist neu geladen.',
    en: 'This room is no longer assigned to you. The list has been reloaded.',
    ru: 'Этот номер вам больше не назначен. Список обновлён.',
    uk: 'Цей номер вам більше не призначено. Список оновлено.' },
  'room.undo': {
    de: 'Zurücknehmen',
    en: 'Undo',
    ru: 'Отменить',
    uk: 'Скасувати' },
  'outcome.cleaned': {
    de: 'Gereinigt',
    en: 'Cleaned',
    ru: 'Убрано',
    uk: 'Прибрано' },
  'room.waived': {
    de: 'Gast verzichtet heute',
    en: 'Guest skips today',
    ru: 'Гость сегодня отказался',
    uk: 'Гість сьогодні відмовився' },
  'room.more': {
    de: 'Weitere Status',
    en: 'More statuses',
    ru: 'Другие статусы',
    uk: 'Інші статуси' },
  'room.water': {
    de: 'Wasser hinstellen',
    en: 'Leave water',
    ru: 'Поставить воду',
    uk: 'Поставити воду' },
  'room.waterDone': {
    de: 'Wasser hingestellt',
    en: 'Water left at the door',
    ru: 'Вода поставлена',
    uk: 'Воду поставлено' },
  'room.waterDelivered': {
    de: 'Wasser steht',
    en: 'Water delivered',
    ru: 'Вода стоит',
    uk: 'Вода стоїть' },
  'outcome.declined': {
    de: 'Gast will keine Reinigung',
    en: 'Guest declined cleaning',
    ru: 'Гость отказался от уборки',
    uk: 'Гість відмовився від прибирання' },
  'outcome.was_clean': {
    de: 'War schon sauber',
    en: 'Was already clean',
    ru: 'Уже было чисто',
    uk: 'Вже було чисто' },

  'tab.inspect': {
    de: 'Kontrolle',
    en: 'Inspection',
    ru: 'Проверка',
    uk: 'Перевірка' },
  'inspect.passed': {
    de: 'Kontrolliert',
    en: 'Inspected',
    ru: 'Проверено',
    uk: 'Перевірено' },
  'inspect.rework': {
    de: 'Nacharbeiten',
    en: 'Rework',
    ru: 'Доработать',
    uk: 'Доопрацювати' },
  'inspect.reworked': {
    de: 'Nachgearbeitet',
    en: 'Rework done',
    ru: 'Доработано',
    uk: 'Доопрацьовано' },
  'inspect.reworkHint': {
    de: 'Was fehlt? Die Kraft sieht den Satz in ihrer Liste.',
    en: 'What is missing? The cleaner sees this sentence in their list.',
    ru: 'Чего не хватает? Горничная увидит это в своём списке.',
    uk: 'Чого бракує? Покоївка побачить це у своєму списку.' },
  'inspect.undo': {
    de: 'Kontrolle zurücknehmen',
    en: 'Undo inspection',
    ru: 'Отменить проверку',
    uk: 'Скасувати перевірку' },
  'inspect.waiting': {
    de: 'Noch nicht gereinigt',
    en: 'Not cleaned yet',
    ru: 'Ещё не убрано',
    uk: 'Ще не прибрано' },
  'inspect.toCheck': {
    de: 'Zu kontrollieren',
    en: 'To inspect',
    ru: 'Проверить',
    uk: 'Перевірити' },
  'inspect.unassigned': {
    de: 'Nicht zugeteilt',
    en: 'Not assigned',
    ru: 'Не назначено',
    uk: 'Не призначено' },
  'inspect.empty': {
    de: 'Für heute ist noch kein Zimmer geplant.',
    en: 'No rooms are planned for today yet.',
    ru: 'На сегодня ещё нет запланированных номеров.',
    uk: 'На сьогодні ще немає запланованих номерів.' },
  'inspect.summary': {
    de: '{passed} kontrolliert · {open} zu kontrollieren · {todo} noch nicht gereinigt',
    en: '{passed} inspected · {open} to inspect · {todo} not cleaned yet',
    ru: 'Проверено: {passed} · проверить: {open} · не убрано: {todo}',
    uk: 'Перевірено: {passed} · перевірити: {open} · не прибрано: {todo}' },
  'inspect.legend': {
    de: 'Weiß offen · … Gast noch da · ✓ gereinigt, prüfen · ✓✓ kontrolliert · ↺ nacharbeiten · ⊘ Gast will keine (rot: heute gesperrt) · ↘ Anreise',
    en: 'White open · … guest still in · ✓ cleaned, inspect · ✓✓ inspected · ↺ rework · ⊘ guest declined (red: locked today) · ↘ arrival',
    ru: 'Белый — не убрано · … гость ещё в номере · ✓ убрано, проверить · ✓✓ проверено · ↺ доработать · ⊘ гость отказался (красный: сегодня закрыт) · ↘ заезд',
    uk: 'Білий — не прибрано · … гість ще в номері · ✓ прибрано, перевірити · ✓✓ перевірено · ↺ доопрацювати · ⊘ гість відмовився (червоний: сьогодні закрито) · ↘ заїзд' },

  'tab.kitchen': {
    de: 'Frühstück',
    en: 'Breakfast',
    ru: 'Завтрак',
    uk: 'Сніданок' },
  'kitchen.today': {
    de: 'Heute',
    en: 'Today',
    ru: 'Сегодня',
    uk: 'Сьогодні' },
  'kitchen.tomorrow': {
    de: 'Morgen',
    en: 'Tomorrow',
    ru: 'Завтра',
    uk: 'Завтра' },
  'kitchen.children': {
    de: 'davon Kinder: {n}',
    en: 'children: {n}',
    ru: 'из них детей: {n}',
    uk: 'з них дітей: {n}' },
  'kitchen.week': {
    de: 'Nächste Tage',
    en: 'Next days',
    ru: 'Следующие дни',
    uk: 'Наступні дні' },
  'kitchen.assumed': {
    de: 'Heute geschätzt: {n} Personen ohne genaue Angabe, gezählt mit der vollen Zimmerbelegung.',
    en: 'Estimated today: {n} guests without an exact count, counted at full room occupancy.',
    ru: 'Сегодня оценка: {n} гостей без точного числа, посчитаны по полной вместимости номера.',
    uk: 'Сьогодні оцінка: {n} гостей без точної кількості, пораховані за повною місткістю номера.' },

  'tab.time': {
    de: 'Zeit',
    en: 'Time',
    ru: 'Время',
    uk: 'Час' },
  'time.prev': {
    de: 'Vormonat',
    en: 'Previous month',
    ru: 'Предыдущий месяц',
    uk: 'Попередній місяць' },
  'time.next': {
    de: 'Folgemonat',
    en: 'Next month',
    ru: 'Следующий месяц',
    uk: 'Наступний місяць' },
  'time.allHouses': {
    de: 'Alle Häuser zusammen',
    en: 'All properties together',
    ru: 'Все объекты вместе',
    uk: 'Усі об’єкти разом' },
  'time.total': {
    de: 'Stunden im Monat ({minutes} Min.)',
    en: 'Hours this month ({minutes} min)',
    ru: 'Часов за месяц ({minutes} мин.)',
    uk: 'Годин за місяць ({minutes} хв)' },
  'time.closed': {
    de: 'Monat abgeschlossen',
    en: 'Month closed',
    ru: 'Месяц закрыт',
    uk: 'Місяць закрито' },
  'time.empty': {
    de: 'In diesem Monat steht noch nichts.',
    en: 'Nothing recorded this month yet.',
    ru: 'В этом месяце пока ничего нет.',
    uk: 'У цьому місяці ще нічого немає.' },
  'time.rooms': {
    de: 'Zimmer gereinigt: {n}',
    en: 'Rooms cleaned: {n}',
    ru: 'Убрано номеров: {n}',
    uk: 'Прибрано номерів: {n}' },
  'time.add': {
    de: 'Arbeit eintragen',
    en: 'Add work',
    ru: 'Добавить работу',
    uk: 'Додати роботу' },
  'time.yesterday': {
    de: 'Gestern',
    en: 'Yesterday',
    ru: 'Вчера',
    uk: 'Вчора' },
  'time.extra': {
    de: 'Zusatzarbeit',
    en: 'Extra work',
    ru: 'Доп. работа',
    uk: 'Додаткова робота' },
  'time.kitchen': {
    de: 'Küche',
    en: 'Kitchen',
    ru: 'Кухня',
    uk: 'Кухня' },
  'time.what': {
    de: 'Was hast du gemacht?',
    en: 'What did you do?',
    ru: 'Что вы делали?',
    uk: 'Що ви робили?' },
  'time.minutes': {
    de: 'Minuten',
    en: 'Minutes',
    ru: 'Минуты',
    uk: 'Хвилини' },
  'time.start': {
    de: 'Beginn',
    en: 'Start',
    ru: 'Начало',
    uk: 'Початок' },
  'time.end': {
    de: 'Ende',
    en: 'End',
    ru: 'Конец',
    uk: 'Кінець' },
  'time.hint': {
    de: 'Eintragen geht für heute und gestern. Für ältere Tage sag der Leitung Bescheid.',
    en: 'You can add today and yesterday. For older days, tell management.',
    ru: 'Можно добавить за сегодня и вчера. За более ранние дни сообщите руководству.',
    uk: 'Можна додати за сьогодні й учора. За раніші дні повідомте керівництво.' },
  'time.save': {
    de: 'Speichern',
    en: 'Save',
    ru: 'Сохранить',
    uk: 'Зберегти' },
  'time.correction': {
    de: 'Korrektur der Leitung',
    en: 'Correction by management',
    ru: 'Исправление руководства',
    uk: 'Виправлення керівництва' },
  'time.withdraw': {
    de: 'Zurückziehen',
    en: 'Withdraw',
    ru: 'Отозвать',
    uk: 'Відкликати' },

  'problem.report': {
    de: 'Problem melden',
    en: 'Report a problem',
    ru: 'Сообщить о проблеме',
    uk: 'Повідомити про проблему' },
  'problem.hint': {
    de: 'Was ist kaputt oder fehlt? Die Hausdame und die Technik sehen es sofort.',
    en: 'What is broken or missing? The head housekeeper and maintenance see it right away.',
    ru: 'Что сломано или чего не хватает? Старшая горничная и техники увидят это сразу.',
    uk: 'Що зламано або чого бракує? Старша покоївка і технічна служба побачать це одразу.' },
  'problem.send': {
    de: 'Melden',
    en: 'Send',
    ru: 'Отправить',
    uk: 'Надіслати' },
  'problem.cancel': {
    de: 'Abbrechen',
    en: 'Cancel',
    ru: 'Отмена',
    uk: 'Скасувати' },
  'problem.sent': {
    de: 'Gemeldet. Danke!',
    en: 'Reported. Thank you!',
    ru: 'Отправлено. Спасибо!',
    uk: 'Надіслано. Дякуємо!' },

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
  'push.title': {
    de: 'Benachrichtigungen',
    en: 'Notifications',
    ru: 'Уведомления',
    uk: 'Сповіщення' },
  'push.hint': {
    de: 'Das Telefon meldet sich, wenn ein Zimmer frei wird, der Plan sich ändert oder etwas nachzuarbeiten ist.',
    en: 'Your phone tells you when a room becomes free, the plan changes or something needs redoing.',
    ru: 'Телефон сообщит, когда номер освободится, план изменится или нужно что-то доделать.',
    uk: 'Телефон повідомить, коли номер звільниться, план зміниться або треба щось доробити.' },
  'push.enable': {
    de: 'Benachrichtigungen einschalten',
    en: 'Turn on notifications',
    ru: 'Включить уведомления',
    uk: 'Увімкнути сповіщення' },
  'push.disable': {
    de: 'Ausschalten',
    en: 'Turn off',
    ru: 'Выключить',
    uk: 'Вимкнути' },
  'push.on': {
    de: 'Dieses Telefon bekommt Benachrichtigungen.',
    en: 'This phone receives notifications.',
    ru: 'Этот телефон получает уведомления.',
    uk: 'Цей телефон отримує сповіщення.' },
  'push.denied': {
    de: 'Benachrichtigungen sind in den Einstellungen des Telefons gesperrt. Dort für diese App erlauben.',
    en: 'Notifications are blocked in the phone settings. Allow them there for this app.',
    ru: 'Уведомления запрещены в настройках телефона. Разрешите их там для этого приложения.',
    uk: 'Сповіщення заборонені в налаштуваннях телефона. Дозвольте їх там для цього застосунку.' },
  'push.ios': {
    de: 'Auf dem iPhone gibt es Benachrichtigungen nur für die installierte App: Teilen-Symbol, dann „Zum Home-Bildschirm“, und die App von dort öffnen.',
    en: 'On iPhone, notifications only work in the installed app: tap Share, then “Add to Home Screen”, and open the app from there.',
    ru: 'На iPhone уведомления работают только в установленном приложении: «Поделиться», затем «На экран „Домой“», и откройте приложение оттуда.',
    uk: 'На iPhone сповіщення працюють лише у встановленому застосунку: «Поділитися», потім «На екран „Додому“», і відкрийте застосунок звідти.' },
  'push.unsupported': {
    de: 'Dieser Browser kann keine Benachrichtigungen empfangen.',
    en: 'This browser cannot receive notifications.',
    ru: 'Этот браузер не может получать уведомления.',
    uk: 'Цей браузер не може отримувати сповіщення.' },
  'more.toReception': {
    de: 'Zur StayGrid-Oberfläche',
    en: 'Open StayGrid desk view',
    ru: 'Открыть StayGrid для ресепшена',
    uk: 'Відкрити StayGrid для рецепції' },
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
  'error.worktime.ownDays': {
    de: 'Eintragen geht für heute und gestern. Für ältere Tage sag der Leitung Bescheid.',
    en: 'You can add today and yesterday. For older days, tell management.',
    ru: 'Можно добавить за сегодня и вчера. За более ранние дни сообщите руководству.',
    uk: 'Можна додати за сьогодні й учора. За раніші дні повідомте керівництво.' },
  'error.worktime.monthClosed': {
    de: 'Der Monat ist abgeschlossen. Sag der Leitung Bescheid.',
    en: 'The month is closed. Please tell management.',
    ru: 'Месяц закрыт. Сообщите руководству.',
    uk: 'Місяць закрито. Повідомте керівництво.' },
  'error.worktime.sameTime': {
    de: 'Beginn und Ende sind gleich.',
    en: 'Start and end are the same.',
    ru: 'Начало и конец совпадают.',
    uk: 'Початок і кінець однакові.' },
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
