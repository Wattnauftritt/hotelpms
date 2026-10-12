import { createContext, useContext } from 'react'
import { FOLDER_LOCALES, sprachKuerzel, type FolderLocale } from '@hotelpms/contracts'

/**
 * Die Saetze der Gaestemappe, in den Sprachen der Gaeste (Sven,
 * 11.10.2026: wie die Gastpost; seit dem 12.10.2026 alle vierzehn).
 *
 * **Ein eigener Katalog**, aus demselben Grund wie in der Personal-App: die
 * Mappe laedt auf dem Telefon des Gastes, und zweitausend Saetze der
 * Rezeption dorthin mitzuschicken hiesse, ihn fuer Bildschirme zahlen zu
 * lassen, die er nie sieht. In der Mappe ist jede ihrer Sprachen
 * vollstaendig -- `satisfies` macht eine vergessene zum Typfehler an genau
 * dem Schluessel.
 *
 * Die Seiten des Hauses selbst schreibt das Haus; sie erscheinen in seiner
 * Fassung, bis die automatische Uebersetzung dazukommt.
 */
type MappeText = { readonly [L in FolderLocale]: string }

const texte = {
  'title': {
    de: 'Gästemappe',
    en: 'Guest folder',
    nl: 'Gastenmap',
    pl: 'Informator dla gości',
    da: 'Gæstemappe',
    sv: 'Gästmapp',
    nb: 'Gjestemappe',
    cs: 'Složka pro hosty',
    fr: 'Livret d’accueil',
    it: 'Cartella ospite',
    es: 'Carpeta del huésped',
    tr: 'Misafir rehberi',
    ru: 'Папка гостя',
    uk: 'Папка гостя' },
  'language': {
    de: 'Sprache',
    en: 'Language',
    nl: 'Taal',
    pl: 'Język',
    da: 'Sprog',
    sv: 'Språk',
    nb: 'Språk',
    cs: 'Jazyk',
    fr: 'Langue',
    it: 'Lingua',
    es: 'Idioma',
    tr: 'Dil',
    ru: 'Язык',
    uk: 'Мова' },
  'loading': {
    de: 'Wird geladen …',
    en: 'Loading …',
    nl: 'Bezig met laden …',
    pl: 'Ładowanie …',
    da: 'Indlæser …',
    sv: 'Laddar …',
    nb: 'Laster …',
    cs: 'Načítá se …',
    fr: 'Chargement …',
    it: 'Caricamento …',
    es: 'Cargando …',
    tr: 'Yükleniyor …',
    ru: 'Загрузка …',
    uk: 'Завантаження …' },
  'room': {
    de: 'Zimmer {room}',
    en: 'Room {room}',
    nl: 'Kamer {room}',
    pl: 'Pokój {room}',
    da: 'Værelse {room}',
    sv: 'Rum {room}',
    nb: 'Rom {room}',
    cs: 'Pokoj {room}',
    fr: 'Chambre {room}',
    it: 'Camera {room}',
    es: 'Habitación {room}',
    tr: 'Oda {room}',
    ru: 'Номер {room}',
    uk: 'Номер {room}' },
  'unknown': {
    de: 'Diese Karte kennen wir nicht. Bitte scannen Sie den Code auf der Karte in Ihrem Zimmer oder fragen Sie an der Rezeption.',
    en: 'We do not recognise this card. Please scan the code on the card in your room or ask at reception.',
    nl: 'We herkennen deze kaart niet. Scan de code op de kaart in uw kamer of vraag het bij de receptie.',
    pl: 'Nie rozpoznajemy tej karty. Proszę zeskanować kod z karty w pokoju lub zapytać w recepcji.',
    sv: 'Vi känner inte igen detta kort. Skanna koden på kortet i ditt rum eller fråga i receptionen.',
    tr: 'Bu kartı tanımıyoruz. Lütfen odanızdaki karttaki kodu tarayın veya resepsiyona sorun.',
    ru: 'Мы не знаем эту карточку. Пожалуйста, отсканируйте код на карточке в Вашем номере или обратитесь на ресепшен.',
    da: 'Vi kender ikke dette kort. Scan venligst koden på kortet på dit værelse, eller spørg i receptionen.',
    nb: 'Vi kjenner ikke igjen dette kortet. Skann koden på kortet på rommet ditt, eller spør i resepsjonen.',
    fr: 'Nous ne reconnaissons pas cette carte. Veuillez scanner le code de la carte dans votre chambre ou vous adresser à la réception.',
    it: 'Non riconosciamo questa scheda. La preghiamo di scansionare il codice sulla scheda nella Sua camera o di chiedere alla reception.',
    es: 'No reconocemos esta tarjeta. Escanee el código de la tarjeta de su habitación o pregunte en la recepción.',
    cs: 'Tuto kartu neznáme. Naskenujte prosím kód na kartě ve Vašem pokoji nebo se zeptejte na recepci.',
    uk: 'Ми не впізнаємо цю картку. Будь ласка, відскануйте код на картці у Вашому номері або зверніться до рецепції.' },
  'off': {
    de: 'Die Gästemappe ist gerade nicht verfügbar. Bei Fragen hilft Ihnen die Rezeption gern.',
    en: 'The guest folder is not available at the moment. Reception will be happy to help.',
    nl: 'De gastenmap is op dit moment niet beschikbaar. De receptie helpt u graag.',
    pl: 'Informator jest obecnie niedostępny. Recepcja chętnie pomoże.',
    sv: 'Gästmappen är inte tillgänglig just nu. Receptionen hjälper dig gärna.',
    tr: 'Misafir rehberi şu anda kullanılamıyor. Sorularınız için resepsiyon size memnuniyetle yardımcı olur.',
    ru: 'Гостевая папка сейчас недоступна. Если у Вас есть вопросы, ресепшен с радостью поможет.',
    da: 'Gæstemappen er ikke tilgængelig lige nu. Receptionen hjælper dig gerne med spørgsmål.',
    nb: 'Gjestemappen er ikke tilgjengelig for øyeblikket. Resepsjonen hjelper deg gjerne hvis du har spørsmål.',
    fr: 'Le livret d’accueil n’est pas disponible pour le moment. La réception se fera un plaisir de répondre à vos questions.',
    it: 'La cartella ospite non è disponibile al momento. Per qualsiasi domanda la reception La aiuterà volentieri.',
    es: 'La carpeta del huésped no está disponible en este momento. Si tiene alguna pregunta, la recepción le ayudará con gusto.',
    cs: 'Informace pro hosty momentálně nejsou k dispozici. S dotazy Vám rád pomůže recepce.',
    uk: 'Гостьова папка зараз недоступна. Якщо маєте запитання, рецепція охоче допоможе.' },
  'offline': {
    de: 'Keine Verbindung. Prüfen Sie WLAN oder mobile Daten.',
    en: 'No connection. Please check Wi-Fi or mobile data.',
    nl: 'Geen verbinding. Controleer wifi of mobiele data.',
    pl: 'Brak połączenia. Sprawdź Wi-Fi lub dane komórkowe.',
    sv: 'Ingen anslutning. Kontrollera wifi eller mobildata.',
    tr: 'Bağlantı yok. Lütfen Wi-Fi\'yi veya mobil veriyi kontrol edin.',
    ru: 'Нет соединения. Проверьте Wi-Fi или мобильный интернет.',
    da: 'Ingen forbindelse. Tjek venligst Wi-Fi eller mobildata.',
    nb: 'Ingen forbindelse. Sjekk Wi-Fi eller mobildata.',
    fr: 'Pas de connexion. Veuillez vérifier le Wi-Fi ou les données mobiles.',
    it: 'Nessuna connessione. Controlli il Wi-Fi o i dati mobili.',
    es: 'Sin conexión. Compruebe el Wi-Fi o los datos móviles.',
    cs: 'Bez připojení. Zkontrolujte prosím Wi-Fi nebo mobilní data.',
    uk: 'Немає з’єднання. Перевірте Wi-Fi або мобільний інтернет.' },
  'retry': {
    de: 'Erneut versuchen',
    en: 'Try again',
    nl: 'Opnieuw proberen',
    pl: 'Spróbuj ponownie',
    da: 'Prøv igen',
    sv: 'Försök igen',
    nb: 'Prøv igjen',
    cs: 'Zkusit znovu',
    fr: 'Réessayer',
    it: 'Riprova',
    es: 'Reintentar',
    tr: 'Tekrar dene',
    ru: 'Повторить',
    uk: 'Спробувати ще раз' },
  'wifi.title': {
    de: 'WLAN',
    en: 'Wi-Fi',
    nl: 'Wifi',
    pl: 'Wi-Fi',
    sv: 'Wi-Fi',
    tr: 'Wi-Fi',
    ru: 'Wi-Fi',
    da: 'Wi-Fi',
    nb: 'Wi-Fi',
    fr: 'Wi-Fi',
    it: 'Wi-Fi',
    es: 'Wi-Fi',
    cs: 'Wi-Fi',
    uk: 'Wi-Fi' },
  'wifi.network': {
    de: 'Netzwerk',
    en: 'Network',
    nl: 'Netwerk',
    pl: 'Sieć',
    sv: 'Nätverk',
    tr: 'Ağ',
    ru: 'Сеть',
    da: 'Netværk',
    nb: 'Nettverk',
    fr: 'Réseau',
    it: 'Rete',
    es: 'Red',
    cs: 'Síť',
    uk: 'Мережа' },
  'wifi.password': {
    de: 'Passwort',
    en: 'Password',
    nl: 'Wachtwoord',
    pl: 'Hasło',
    da: 'Adgangskode',
    sv: 'Lösenord',
    nb: 'Passord',
    cs: 'Heslo',
    fr: 'Mot de passe',
    it: 'Password',
    es: 'Contraseña',
    tr: 'Şifre',
    ru: 'Пароль',
    uk: 'Пароль' },
  'wifi.noPassword': {
    de: 'Offenes Netz, kein Passwort nötig.',
    en: 'Open network, no password needed.',
    nl: 'Open netwerk, geen wachtwoord nodig.',
    pl: 'Sieć otwarta, hasło nie jest potrzebne.',
    sv: 'Öppet nätverk, inget lösenord behövs.',
    tr: 'Açık ağ, şifre gerekmez.',
    ru: 'Открытая сеть, пароль не нужен.',
    da: 'Åbent netværk, ingen adgangskode nødvendig.',
    nb: 'Åpent nettverk, ikke behov for passord.',
    fr: 'Réseau ouvert, aucun mot de passe nécessaire.',
    it: 'Rete aperta, nessuna password necessaria.',
    es: 'Red abierta, no hace falta contraseña.',
    cs: 'Otevřená síť, heslo není potřeba.',
    uk: 'Відкрита мережа, пароль не потрібен.' },
  'wifi.hidden': {
    de: 'Das Netz ist verborgen: bitte den Namen von Hand eingeben.',
    en: 'The network is hidden: please enter its name manually.',
    nl: 'Het netwerk is verborgen: voer de naam handmatig in.',
    pl: 'Sieć jest ukryta: proszę wpisać jej nazwę ręcznie.',
    sv: 'Nätverket är dolt: ange dess namn manuellt.',
    tr: 'Ağ gizli: lütfen adını elle girin.',
    ru: 'Сеть скрыта: пожалуйста, введите её имя вручную.',
    da: 'Netværket er skjult: indtast venligst navnet manuelt.',
    nb: 'Nettverket er skjult: skriv inn navnet manuelt.',
    fr: 'Le réseau est masqué : veuillez saisir son nom manuellement.',
    it: 'La rete è nascosta: inserisca il nome a mano.',
    es: 'La red está oculta: introduzca el nombre a mano, por favor.',
    cs: 'Síť je skrytá: zadejte prosím její název ručně.',
    uk: 'Мережа прихована: будь ласка, введіть її назву вручну.' },
  'wifi.copy': {
    de: 'Passwort kopieren',
    en: 'Copy password',
    nl: 'Wachtwoord kopiëren',
    pl: 'Kopiuj hasło',
    sv: 'Kopiera lösenord',
    tr: 'Şifreyi kopyala',
    ru: 'Скопировать пароль',
    da: 'Kopiér adgangskode',
    nb: 'Kopier passord',
    fr: 'Copier le mot de passe',
    it: 'Copia password',
    es: 'Copiar contraseña',
    cs: 'Kopírovat heslo',
    uk: 'Копіювати пароль' },
  'wifi.copied': {
    de: 'Kopiert',
    en: 'Copied',
    nl: 'Gekopieerd',
    pl: 'Skopiowano',
    da: 'Kopieret',
    sv: 'Kopierad',
    nb: 'Kopiert',
    cs: 'Zkopírováno',
    fr: 'Copié',
    it: 'Copiato',
    es: 'Copiado',
    tr: 'Kopyalandı',
    ru: 'Скопировано',
    uk: 'Скопійовано' },
  'wifi.qr': {
    de: 'Für ein weiteres Gerät: diesen Code mit der Kamera scannen.',
    en: 'For another device: scan this code with the camera.',
    nl: 'Voor een ander apparaat: scan deze code met de camera.',
    pl: 'Dla kolejnego urządzenia: zeskanuj ten kod aparatem.',
    sv: 'För en annan enhet: skanna denna kod med kameran.',
    tr: 'Başka bir cihaz için: bu kodu kamerayla tarayın.',
    ru: 'Для другого устройства: отсканируйте этот код камерой.',
    da: 'Til en anden enhed: scan denne kode med kameraet.',
    nb: 'For en annen enhet: skann denne koden med kameraet.',
    fr: 'Pour un autre appareil : scannez ce code avec l’appareil photo.',
    it: 'Per un altro dispositivo: scansioni questo codice con la fotocamera.',
    es: 'Para otro dispositivo: escanee este código con la cámara.',
    cs: 'Pro další zařízení: naskenujte tento kód fotoaparátem.',
    uk: 'Для іншого пристрою: відскануйте цей код камерою.' },
  'times.title': {
    de: 'Anreise und Abreise',
    en: 'Arrival and departure',
    nl: 'Aankomst en vertrek',
    pl: 'Przyjazd i wyjazd',
    sv: 'Ankomst och avresa',
    tr: 'Giriş ve çıkış',
    ru: 'Заезд и выезд',
    da: 'Ankomst og afrejse',
    nb: 'Ankomst og avreise',
    fr: 'Arrivée et départ',
    it: 'Arrivo e partenza',
    es: 'Llegada y salida',
    cs: 'Příjezd a odjezd',
    uk: 'Заїзд і виїзд' },
  'times.checkin': {
    de: 'Zimmer bereit ab {time} Uhr',
    en: 'Room ready from {time}',
    nl: 'Kamer beschikbaar vanaf {time} uur',
    pl: 'Pokój gotowy od godz. {time}',
    sv: 'Rummet klart från {time}',
    tr: 'Oda saat {time}\'dan itibaren hazır',
    ru: 'Номер готов с {time}',
    da: 'Værelset er klar fra kl. {time}',
    nb: 'Rommet er klart fra kl. {time}',
    fr: 'Chambre prête à partir de {time}',
    it: 'Camera pronta dalle {time}',
    es: 'Habitación lista a partir de las {time}',
    cs: 'Pokoj připraven od {time}',
    uk: 'Номер готовий з {time}' },
  'times.checkout': {
    de: 'Abreise bis {time} Uhr',
    en: 'Check-out by {time}',
    nl: 'Vertrek uiterlijk om {time} uur',
    pl: 'Wymeldowanie do godz. {time}',
    sv: 'Utcheckning senast {time}',
    tr: 'Çıkış en geç saat {time}',
    ru: 'Выезд до {time}',
    da: 'Afrejse senest kl. {time}',
    nb: 'Utsjekking innen kl. {time}',
    fr: 'Départ avant {time}',
    it: 'Partenza entro le {time}',
    es: 'Salida hasta las {time}',
    cs: 'Odjezd do {time}',
    uk: 'Виїзд до {time}' }
} as const satisfies Record<string, MappeText>

export type MappeTextKey = keyof typeof texte
export { FOLDER_LOCALES }

export const MappeSprache = createContext<FolderLocale>('de')

/** Die Sprache, mit der die Mappe beginnt: die des Telefons, sonst Englisch. */
export function startSprache(browser: string): FolderLocale {
  const b = sprachKuerzel(browser)
  return (FOLDER_LOCALES as readonly string[]).includes(b) ? b as FolderLocale : 'en'
}

/** Ein Satz in einer Sprache, ohne React -- auch fuer die gedruckte Zimmerkarte. */
export function mappeText(
  k: MappeTextKey, l: FolderLocale, werte: Record<string, string> = {}
): string {
  let s: string = texte[k][l]
  for (const [n, v] of Object.entries(werte)) s = s.replaceAll(`{${n}}`, v)
  return s
}

export function useMappeT(): (k: MappeTextKey, werte?: Record<string, string>) => string {
  const l = useContext(MappeSprache)
  return (k, werte) => mappeText(k, l, werte)
}

/** Fuer den Test des Katalogs: jeder Schluessel, jede Sprache, nichts leer. */
export const MAPPE_TEXTE: Readonly<Record<string, MappeText>> = texte
