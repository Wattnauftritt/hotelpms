import type { EmailLanguage } from '@hotelpms/contracts'
import { formatCent } from './money.js'

/**
 * Ausgehende Post an den Gast: Arten, Vorlagen und Wiederholungsregel.
 *
 * Liegt in der Domaene, weil beide Seiten sie brauchen: die API rendert und
 * reiht ein, der Worker stellt zu, und die Vorlagen sind Fachtext und kein
 * Darstellungsdetail -- in ihnen stehen Pflichtangaben.
 */

export const EMAIL_KINDS = ['invoice', 'reservation_confirmation', 'payment_link',
                            'checkin_invitation', 'checkin_invitation_test',
                            // An die DATEV-Uploadmail, nicht an einen Gast (Migration 0098).
                            'cashbook_receipt'] as const
export type EmailKind = (typeof EMAIL_KINDS)[number]

/**
 * Die Sprachliste und die Abbildung stehen im Vertrag, nicht hier.
 *
 * Hier standen sie, solange nur API und Worker sie brauchten. Die Gastmaske
 * braucht sie auch -- und holte sie sich ueber das Barrel der Domaene, das
 * `node:crypto` mitbringt. Im Browser gibt es das nicht; der Build der
 * Oberflaeche brach. Die Liste ist ohnehin eine Zusage des Produkts und
 * damit Vertrag; die Vorlagen darunter sind Fachtext und bleiben hier.
 */
export { EMAIL_LANGUAGES, emailLanguage } from '@hotelpms/contracts'
export type { EmailLanguage } from '@hotelpms/contracts'

/**
 * Genuegt die Adresse fuer einen Zustellversuch?
 *
 * Absichtlich grob. Eine Adresse endgueltig zu pruefen kann nur der
 * annehmende Server; jede strengere Regel hier wirft irgendwann eine gueltige
 * Adresse weg, und der Gast bekommt seine Rechnung nicht, weil ein
 * regulaerer Ausdruck eine Meinung hatte. Abgefangen werden soll nur, was
 * offensichtlich keine Adresse ist -- ein leeres Feld, ein Name, ein
 * Zeilenumbruch, der sich in die Kopfzeilen schmuggeln koennte.
 */
export function isSendableAddress(value: string | null | undefined): boolean {
  if (!value) return false
  const v = value.trim()
  if (v.length < 6 || v.length > 320) return false
  if (/[\r\n\t<>,;\s]/.test(v)) return false
  const at = v.indexOf('@')
  if (at < 1 || at !== v.lastIndexOf('@')) return false
  const domain = v.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

/*
 * Anbieter, unter deren Domain niemand eine Absenderdomain anmelden kann --
 * und zwar mit gutem Grund: wer `gmx.de` anmelden koennte, koennte im Namen
 * jedes GMX-Kunden schreiben. Der Versandanbieter weist das ohnehin ab.
 *
 * Die Liste steht hier trotzdem, weil die Fehlermeldung ankommen muss,
 * **bevor** ein Antrag gestellt und von einem Menschen bearbeitet wird. Ein
 * Haus, das drei Tage auf eine Freigabe wartet, um dann zu erfahren, dass
 * seine GMX-Adresse nie gehen konnte, hat drei Tage verloren.
 *
 * Sie ist bewusst kurz und deckt den deutschsprachigen Alltag ab. Sie muss
 * nicht vollstaendig sein: was durchrutscht, faellt beim Anbieter, und das
 * ist der Zaun dahinter.
 */
const FREEMAIL = new Set([
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de',
  'freenet.de', 'arcor.de', 'gmail.com', 'googlemail.com', 'outlook.com',
  'outlook.de', 'hotmail.com', 'hotmail.de', 'live.de', 'live.com',
  'yahoo.com', 'yahoo.de', 'aol.com', 'icloud.com', 'me.com', 'mail.de',
  'posteo.de', 'mailbox.org', 'protonmail.com', 'proton.me', 'bluewin.ch',
  'a1.net', 'chello.at', 'aon.at'
])

/**
 * Laesst sich unter dieser Domain eine eigene Absenderdomain anmelden?
 *
 * Nimmt eine Domain **oder** eine ganze Adresse entgegen: an der Oberflaeche
 * tippt jemand mal das eine, mal das andere ein, und ein Formular, das bei
 * `info@hotel.de` etwas anderes antwortet als bei `hotel.de`, ist ein
 * Formular, dem man nicht glaubt.
 */
export function isFreemailDomain(value: string | null | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return FREEMAIL.has(v.includes('@') ? v.slice(v.lastIndexOf('@') + 1) : v)
}

/**
 * Die Domain aus einer Adresse, kleingeschrieben. Leer, wenn keine drin ist.
 *
 * Eine eigene Funktion, weil dieselbe Zeile sonst an vier Stellen stuende --
 * und an der fuenften mit `split('@')[1]` statt `lastIndexOf`, was bei einer
 * Adresse mit zwei Klammeraffen etwas anderes ergibt.
 */
export function domainOf(value: string | null | undefined): string {
  if (!value) return ''
  const v = value.trim().toLowerCase()
  const at = v.lastIndexOf('@')
  return at < 0 ? '' : v.slice(at + 1)
}

/**
 * Versuche, bis eine Nachricht aufgegeben wird. Groesser als bei den
 * Webhooks (dort drei), und der Unterschied hat einen Grund: ein Webhook
 * spricht mit einer Maschine, die entweder da ist oder nicht. Hier liegt ein
 * Anbieter dazwischen, der auch mal eine Minute lang zumacht, und das
 * Ergebnis eines Fehlschlags ist nicht ein verpasstes Ereignis, sondern eine
 * Rechnung, die der Gast nie bekommt.
 */
export const EMAIL_MAX_ATTEMPTS = 5

/** Wiederholungsabstand, exponentiell wachsend, wie bei den Webhooks. */
export function emailRetryDelaySeconds(attempts: number, baseSeconds = 120): number {
  return baseSeconds * 2 ** Math.max(0, attempts - 1)
}

/**
 * Lohnt sich ein weiterer Versuch?
 *
 * Der entscheidende Unterschied zum Webhook: eine abgelehnte Adresse wird
 * beim zehnten Versuch genauso abgelehnt wie beim ersten. Fuenfmal gegen
 * eine 400 zu laufen kostet Zeit, verzoegert die Nachricht an alle anderen
 * und faerbt beim Anbieter die eigene Absenderbewertung ein. Wiederholt
 * wird deshalb nur, was voruebergehend sein kann.
 *
 * `null` steht fuer einen Fehler ohne Antwort -- Zeitueberschreitung,
 * Namensaufloesung, abgelehnte Verbindung. Das ist voruebergehend.
 */
export function emailShouldRetry(statusCode: number | null): boolean {
  if (statusCode === null) return true
  if (statusCode === 429) return true          // Drosselung, also warten
  return statusCode >= 500                     // Anbieter kaputt, nicht wir
}

// ---------------------------------------------------------------------------
// Vorlagen
// ---------------------------------------------------------------------------

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

export interface InvoiceEmailData {
  propertyName: string
  guestName: string | null
  invoiceNumber: string
  grossCent: number
  currency: string
  /** Zahlungsziel als Kalenderdatum, falls die Rechnung offen ist. */
  dueDate?: string | null
  /** Offener Betrag. 0 heisst beglichen, und dann steht keine Zahlungsbitte drin. */
  openCent: number
}

export interface ReservationEmailData {
  propertyName: string
  guestName: string | null
  reservationRef: string
  arrival: string
  departure: string
  categoryName: string
  totalCent: number
  currency: string
  checkinTime: string
  checkoutTime: string
}

/**
 * Ein Zahlungslink an den Gast (Migrationen 0060, 0068).
 *
 * `url` ist der dauerhafte Link von uns (`/v1/pay?t=...`), nicht die Adresse
 * eines Checkouts beim Anbieter: der gilt hoechstens 24 Stunden, der Link
 * bis zur Frist. Das Token steht nirgends im Klartext ausser im Rumpf dieser
 * Nachricht, und dort nur, bis sie zugestellt ist -- danach ersetzt ein
 * Trigger es (0068).
 */
export interface PaymentLinkEmailData {
  propertyName: string
  guestName: string | null
  reservationRef: string
  /** Kalendertage `YYYY-MM-DD`. */
  arrival: string
  departure: string
  amountCent: number
  currency: string
  /** Faelligkeit einer Anzahlungsanforderung; null bei einem freien Betrag. */
  dueDate: string | null
  /** Zahlt der Link auf eine Anzahlungsanforderung? Sonst ist es eine Zahlung. */
  deposit: boolean
  /** Bis wann der Link annimmt, Kalendertag (0068). */
  validUntil: string
  url: string
}

/** HTML-Sonderzeichen entschaerfen. Ein Gastname kann alles enthalten. */
function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Aus Zeilen einen HTML-Rumpf machen. Keine Vorlagensprache, keine Bilder. */
function htmlBody(lines: string[]): string {
  const absaetze = lines.map(l => l === ''
    ? ''
    : `<p style="margin:0 0 12px 0">${esc(l).replace(/\n/g, '<br>')}</p>`)
    .filter(Boolean).join('\n')
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;'
    + `font-size:15px;line-height:1.5;color:#111">\n${absaetze}\n</div>`
}

/**
 * Die Saetze der Gastpost, je Sprache.
 *
 * **Warum eine Tabelle und nicht ein Block je Sprache.** Vorher stand jede
 * Vorlage zweimal untereinander, einmal deutsch und einmal englisch, mit
 * derselben Struktur. Bei vier Sprachen waeren das acht Bloecke, in denen
 * die Reihenfolge der Zeilen und die Bedingung fuer den offenen Betrag
 * jeweils nachgebaut werden -- und irgendwann weicht einer ab, ohne dass es
 * jemand merkt: die Sprache, in der man den Fehler sieht, ist ja nicht die,
 * in der man arbeitet. Jetzt steht die Struktur einmal und die Saetze
 * viermal.
 *
 * **Vollstaendige Saetze, keine Bausteine.** `offenMitFrist` und
 * `offenOhneFrist` sind zwei eigene Saetze und nicht einer plus ein
 * angehaengtes Komma. Wo im Deutschen ein Nachsatz passt, steht im
 * Polnischen ein eigener Hauptsatz; wer den Satz zusammenklebt, bekommt in
 * jeder Sprache mit anderer Wortstellung Unsinn.
 *
 * Platzhalter in geschweiften Klammern, wie ueberall im Haus.
 */
interface Gastposttexte {
  anredeMitName: string
  anredeOhneName: string

  rechnungBetreff: string
  rechnungAnhang: string
  rechnungOffenMitFrist: string
  rechnungOffenOhneFrist: string
  rechnungBeglichen: string
  rechnungDank: string

  buchungBetreff: string
  buchungBestaetigt: string
  buchungNummer: string
  buchungAnreise: string
  buchungAbreise: string
  buchungZimmer: string
  buchungGesamt: string
  buchungHinweis: string

  zahlungBetreff: string
  zahlungAnzahlungMitFrist: string
  zahlungAnzahlungOhneFrist: string
  zahlungAllgemein: string
  zahlungLink: string
  zahlungKarte: string
  zahlungGueltig: string
  zahlungHinweis: string
  // Online-Check-in (Dokument 30)
  checkinAnredeMitName: string
  checkinAnredeOhneName: string
  checkinBetreff: string
  checkinEinladung: string
  checkinFrist: string
  checkinFreiwillig: string
  checkinWeitergabe: string
  checkinTest: string
}

const TEXTE: Record<EmailLanguage, Gastposttexte> = {
  de: {
    // Ohne Namen kein "Sehr geehrte Damen und Herren" an eine Privatperson:
    // das liest sich wie ein Serienbrief. "Guten Tag" passt in beiden Faellen.
    anredeMitName: 'Guten Tag {name},',
    anredeOhneName: 'Guten Tag,',

    rechnungBetreff: 'Rechnung {nummer} — {haus}',
    rechnungAnhang: 'anbei erhalten Sie Ihre Rechnung {nummer} des Hauses {haus} '
      + 'als PDF, über insgesamt {betrag}.',
    rechnungOffenMitFrist: 'Offen sind davon {offen}, zahlbar bis zum {frist}.',
    rechnungOffenOhneFrist: 'Offen sind davon {offen}.',
    rechnungBeglichen: 'Die Rechnung ist vollständig beglichen. '
      + 'Dieses Exemplar ist für Ihre Unterlagen.',
    rechnungDank: 'Vielen Dank für Ihren Aufenthalt — wir würden uns freuen, '
      + 'Sie wieder begrüßen zu dürfen.',

    buchungBetreff: 'Buchungsbestätigung {ref} — {haus}',
    buchungBestaetigt: 'wir haben Ihre Buchung im Hause {haus} bestätigt.',
    buchungNummer: 'Buchungsnummer: {ref}',
    buchungAnreise: 'Anreise: {datum} ab {zeit} Uhr',
    buchungAbreise: 'Abreise: {datum} bis {zeit} Uhr',
    buchungZimmer: 'Zimmer: {zimmer}',
    buchungGesamt: 'Gesamtbetrag: {betrag}',
    buchungHinweis: 'Bitte geben Sie die Buchungsnummer bei Rückfragen an. '
      + 'Sie können auf diese E-Mail antworten, wenn sich etwas ändern soll.',

    zahlungBetreff: 'Zahlung für Ihren Aufenthalt {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'für Ihren Aufenthalt vom {anreise} bis {abreise} '
      + 'bitten wir um eine Anzahlung von {betrag} bis zum {frist}.',
    zahlungAnzahlungOhneFrist: 'für Ihren Aufenthalt vom {anreise} bis {abreise} '
      + 'bitten wir um eine Anzahlung von {betrag}.',
    zahlungAllgemein: 'für Ihren Aufenthalt vom {anreise} bis {abreise} '
      + 'bitten wir um eine Zahlung von {betrag}.',
    zahlungLink: 'Ueber den folgenden Link bezahlen Sie sicher beim '
      + 'Zahlungsdienstleister des Hauses:',
    zahlungKarte: 'Ihre Kartendaten geben Sie nur dort ein; das Haus erhält sie '
      + 'nicht.',
    zahlungGueltig: 'Der Link gilt bis einschließlich {gueltig}. Ist er abgelaufen, '
      + 'schicken wir Ihnen gern einen neuen.',
    zahlungHinweis: 'Bei Fragen antworten Sie einfach auf diese E-Mail und nennen '
      + 'Sie die Buchungsnummer {ref}.',
    // Herzlicher als die Anrede der uebrigen Post, auf Wunsch des Hauses
    // (Sven, 07.10.2026): die Einladung ist eine Begruessung, kein Beleg.
    checkinAnredeMitName: 'Hallo {name},',
    checkinAnredeOhneName: 'Hallo,',
    checkinBetreff: 'Online-Check-in für Ihren Aufenthalt — {haus}',
    checkinEinladung: 'am {anreise} erwarten wir Sie in unserem Hause {haus}. Damit es bei '
      + 'der Ankunft schneller geht, können Sie den Meldeschein schon jetzt '
      + 'ausfüllen:',
    checkinFrist: 'Der Link gilt bis zum {bis} und nur für Ihre Buchung {ref}.',
    checkinFreiwillig: 'Gerne können Sie den Meldeschein natürlich auch am '
      + 'Anreisetag vor Ort ausfüllen.',
    checkinWeitergabe: 'Bitte geben Sie den Link nicht weiter: wer ihn hat, kann '
      + 'Angaben zu Ihrem Aufenthalt machen.',
    checkinTest: 'TESTMAIL — so sieht die Einladung zum Online-Check-in für Ihre Gäste aus. '
      + 'Name, Buchung und Daten sind Beispiele; der Link führt zu keinem echten '
      + 'Meldeschein.'
  },

  en: {
    anredeMitName: 'Dear {name},',
    anredeOhneName: 'Dear guest,',

    rechnungBetreff: 'Invoice {nummer} — {haus}',
    rechnungAnhang: 'please find your invoice {nummer} from {haus} attached '
      + 'as a PDF, totalling {betrag}.',
    rechnungOffenMitFrist: 'An amount of {offen} is still outstanding, '
      + 'payable by {frist}.',
    rechnungOffenOhneFrist: 'An amount of {offen} is still outstanding.',
    rechnungBeglichen: 'The invoice has been settled in full. '
      + 'This copy is for your records.',
    rechnungDank: 'Thank you for your stay — we would be glad to welcome you again.',

    buchungBetreff: 'Booking confirmation {ref} — {haus}',
    buchungBestaetigt: 'we have confirmed your booking at {haus}.',
    buchungNummer: 'Booking reference: {ref}',
    buchungAnreise: 'Arrival: {datum} from {zeit}',
    buchungAbreise: 'Departure: {datum} until {zeit}',
    buchungZimmer: 'Room: {zimmer}',
    buchungGesamt: 'Total: {betrag}',
    buchungHinweis: 'Please quote the booking reference in any correspondence. '
      + 'You can reply to this email if anything needs changing.',

    zahlungBetreff: 'Payment for your stay {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'for your stay from {anreise} to {abreise} we kindly '
      + 'ask for a deposit of {betrag} by {frist}.',
    zahlungAnzahlungOhneFrist: 'for your stay from {anreise} to {abreise} we kindly '
      + 'ask for a deposit of {betrag}.',
    zahlungAllgemein: 'for your stay from {anreise} to {abreise} we kindly ask for '
      + 'a payment of {betrag}.',
    zahlungLink: 'You can pay securely with the property’s payment provider '
      + 'using the following link:',
    zahlungKarte: 'You enter your card details only there; the property never '
      + 'receives them.',
    zahlungGueltig: 'The link is valid up to and including {gueltig}. If it has '
      + 'expired, we will gladly send you a new one.',
    zahlungHinweis: 'If you have any questions, simply reply to this email and '
      + 'quote the booking reference {ref}.',
    checkinAnredeMitName: 'Hello {name},',
    checkinAnredeOhneName: 'Hello,',
    checkinBetreff: 'Online check-in for your stay — {haus}',
    checkinEinladung: 'we look forward to welcoming you to our {haus} on {anreise}. '
      + 'To make your arrival quicker, you can fill in the registration form '
      + '(Meldeschein) now:',
    checkinFrist: 'The link is valid until {bis} and only for your booking {ref}.',
    checkinFreiwillig: 'You are of course also welcome to fill in the registration '
      + 'form on site on the day of arrival.',
    checkinWeitergabe: 'Please do not pass the link on: whoever has it can enter '
      + 'details about your stay.',
    checkinTest: 'TEST MESSAGE — this is how the online check-in invitation looks to '
      + 'your guests. Name, booking and dates are examples; the link does not lead '
      + 'to a real registration form.'
  },

  nl: {
    anredeMitName: 'Beste {name},',
    anredeOhneName: 'Geachte gast,',

    rechnungBetreff: 'Factuur {nummer} — {haus}',
    rechnungAnhang: 'hierbij ontvangt u factuur {nummer} van {haus} als pdf, '
      + 'voor een totaalbedrag van {betrag}.',
    rechnungOffenMitFrist: 'Hiervan staat nog {offen} open, '
      + 'te voldoen uiterlijk {frist}.',
    rechnungOffenOhneFrist: 'Hiervan staat nog {offen} open.',
    rechnungBeglichen: 'De factuur is volledig voldaan. '
      + 'Dit exemplaar is voor uw administratie.',
    rechnungDank: 'Hartelijk dank voor uw verblijf — wij verwelkomen u graag opnieuw.',

    buchungBetreff: 'Boekingsbevestiging {ref} — {haus}',
    buchungBestaetigt: 'wij hebben uw boeking bij {haus} bevestigd.',
    buchungNummer: 'Boekingsnummer: {ref}',
    buchungAnreise: 'Aankomst: {datum} vanaf {zeit}',
    buchungAbreise: 'Vertrek: {datum} tot {zeit}',
    buchungZimmer: 'Kamer: {zimmer}',
    buchungGesamt: 'Totaalbedrag: {betrag}',
    buchungHinweis: 'Vermeld het boekingsnummer bij vragen. '
      + 'U kunt op deze e-mail antwoorden als er iets gewijzigd moet worden.',

    zahlungBetreff: 'Betaling voor uw verblijf {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'voor uw verblijf van {anreise} tot {abreise} vragen '
      + 'wij u een aanbetaling van {betrag} te voldoen uiterlijk {frist}.',
    zahlungAnzahlungOhneFrist: 'voor uw verblijf van {anreise} tot {abreise} vragen '
      + 'wij u een aanbetaling van {betrag}.',
    zahlungAllgemein: 'voor uw verblijf van {anreise} tot {abreise} vragen wij u '
      + 'een betaling van {betrag}.',
    zahlungLink: 'Via de volgende link betaalt u veilig bij de betaaldienst van '
      + 'het hotel:',
    zahlungKarte: 'Uw kaartgegevens voert u alleen daar in; het hotel ontvangt ze '
      + 'niet.',
    zahlungGueltig: 'De link is geldig tot en met {gueltig}. Is hij verlopen, dan '
      + 'sturen wij u graag een nieuwe.',
    zahlungHinweis: 'Heeft u vragen, antwoord dan gewoon op deze e-mail en vermeld '
      + 'het boekingsnummer {ref}.',
    checkinAnredeMitName: 'Hallo {name},',
    checkinAnredeOhneName: 'Hallo,',
    checkinBetreff: 'Online inchecken voor uw verblijf — {haus}',
    checkinEinladung: 'op {anreise} verwelkomen wij u graag in ons {haus}. Om uw '
      + 'aankomst te versnellen, kunt u het inschrijvingsformulier (Meldeschein) '
      + 'nu al invullen:',
    checkinFrist: 'De link is geldig tot {bis} en alleen voor uw boeking {ref}.',
    checkinFreiwillig: 'U kunt het formulier natuurlijk ook graag op de dag van '
      + 'aankomst ter plaatse invullen.',
    checkinWeitergabe: 'Geef de link niet door: wie hem heeft, kan gegevens over '
      + 'uw verblijf invullen.',
    checkinTest: 'TESTBERICHT — zo ziet de uitnodiging voor online inchecken eruit voor '
      + 'uw gasten. Naam, boeking en data zijn voorbeelden; de link leidt niet naar '
      + 'een echt formulier.'
  },

  pl: {
    /*
     * Im Polnischen **ohne** Namen, auch wenn einer vorliegt.
     *
     * Eine Anrede verlangt dort den Vokativ und das grammatische Geschlecht
     * ("Szanowna Pani Anno", "Szanowny Panie Janie"). Das Gastprofil traegt
     * weder das eine noch das andere, und ein falsch gebeugter Name ist
     * unhoeflicher als gar keiner. "Dzień dobry" ist im polnischen
     * Geschaeftsverkehr die uebliche neutrale Anrede und braucht beides
     * nicht.
     */
    anredeMitName: 'Dzień dobry,',
    anredeOhneName: 'Dzień dobry,',

    rechnungBetreff: 'Faktura {nummer} — {haus}',
    // Grossschreibung am Satzanfang, anders als im Deutschen: nach
    // "Dzień dobry," beginnt der Brief mit einem eigenen Hauptsatz.
    rechnungAnhang: 'W załączeniu przesyłamy fakturę {nummer} z obiektu {haus} '
      + 'w formacie PDF, na łączną kwotę {betrag}.',
    rechnungOffenMitFrist: 'Do zapłaty pozostaje {offen}, '
      + 'termin płatności: {frist}.',
    rechnungOffenOhneFrist: 'Do zapłaty pozostaje {offen}.',
    rechnungBeglichen: 'Faktura została opłacona w całości. '
      + 'Ten egzemplarz jest dla Państwa dokumentacji.',
    rechnungDank: 'Dziękujemy za pobyt — będzie nam miło gościć Państwa ponownie.',

    buchungBetreff: 'Potwierdzenie rezerwacji {ref} — {haus}',
    buchungBestaetigt: 'Potwierdzamy Państwa rezerwację w obiekcie {haus}.',
    buchungNummer: 'Numer rezerwacji: {ref}',
    buchungAnreise: 'Przyjazd: {datum} od godz. {zeit}',
    buchungAbreise: 'Wyjazd: {datum} do godz. {zeit}',
    buchungZimmer: 'Pokój: {zimmer}',
    buchungGesamt: 'Kwota łączna: {betrag}',
    buchungHinweis: 'Prosimy o podanie numeru rezerwacji w korespondencji. '
      + 'Na tę wiadomość można odpowiedzieć, jeśli coś wymaga zmiany.',

    zahlungBetreff: 'Płatność za pobyt {ref} — {haus}',
    // Wie bei der Rechnung: nach "Dzień dobry," ein eigener Hauptsatz,
    // deshalb gross.
    zahlungAnzahlungMitFrist: 'Za pobyt w terminie {anreise} – {abreise} prosimy '
      + 'o wpłatę zaliczki w wysokości {betrag} do dnia {frist}.',
    zahlungAnzahlungOhneFrist: 'Za pobyt w terminie {anreise} – {abreise} prosimy '
      + 'o wpłatę zaliczki w wysokości {betrag}.',
    zahlungAllgemein: 'Za pobyt w terminie {anreise} – {abreise} prosimy o '
      + 'płatność w wysokości {betrag}.',
    zahlungLink: 'Bezpiecznej płatności u operatora płatności obiektu można '
      + 'dokonać, korzystając z poniższego linku:',
    zahlungKarte: 'Dane karty podają Państwo wyłącznie tam; obiekt ich nie '
      + 'otrzymuje.',
    zahlungGueltig: 'Link jest ważny do dnia {gueltig} włącznie. Jeśli wygaśnie, '
      + 'chętnie prześlemy nowy.',
    zahlungHinweis: 'W razie pytań wystarczy odpowiedzieć na tę wiadomość, '
      + 'podając numer rezerwacji {ref}.',
    checkinAnredeMitName: 'Dzień dobry,',
    checkinAnredeOhneName: 'Dzień dobry,',
    checkinBetreff: 'Odprawa online przed pobytem — {haus}',
    checkinEinladung: 'Oczekujemy Państwa w naszym obiekcie {haus} w dniu {anreise}. '
      + 'Aby przyspieszyć przyjazd, można już teraz wypełnić kartę meldunkową '
      + '(Meldeschein):',
    checkinFrist: 'Link jest ważny do {bis} i wyłącznie dla rezerwacji {ref}.',
    checkinFreiwillig: 'Kartę można oczywiście wypełnić również na miejscu w dniu '
      + 'przyjazdu.',
    checkinWeitergabe: 'Prosimy nie przekazywać linku dalej: kto go posiada, może '
      + 'wprowadzać dane dotyczące Państwa pobytu.',
    checkinTest: 'WIADOMOŚĆ TESTOWA — tak wygląda zaproszenie do odprawy online dla '
      + 'Państwa gości. Imię, rezerwacja i daty są przykładowe; link nie prowadzi do '
      + 'prawdziwej karty meldunkowej.'
  }
}

/** Werte einsetzen. Ein Platzhalter ohne Wert bleibt stehen, statt zu verschwinden. */
function einsetzen(satz: string, werte: Record<string, string>): string {
  return satz.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    Object.prototype.hasOwnProperty.call(werte, name) ? werte[name]! : ganz)
}

function anrede(name: string | null, lang: EmailLanguage): string {
  const t = TEXTE[lang]
  return name === null || name === ''
    ? t.anredeOhneName
    : einsetzen(t.anredeMitName, { name })
}

export function renderInvoiceEmail(
  d: InvoiceEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const t = TEXTE[lang]
  const werte = {
    nummer: d.invoiceNumber,
    haus: d.propertyName,
    betrag: `${formatCent(d.grossCent)} ${d.currency}`,
    offen: `${formatCent(d.openCent)} ${d.currency}`,
    frist: d.dueDate ?? ''
  }

  const lines = [
    anrede(d.guestName, lang),
    einsetzen(t.rechnungAnhang, werte),
    d.openCent > 0
      ? einsetzen(d.dueDate ? t.rechnungOffenMitFrist : t.rechnungOffenOhneFrist, werte)
      : t.rechnungBeglichen,
    t.rechnungDank,
    d.propertyName
  ]
  return {
    subject: einsetzen(t.rechnungBetreff, werte),
    text: lines.join('\n\n'),
    html: htmlBody(lines)
  }
}

export function renderReservationEmail(
  d: ReservationEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const t = TEXTE[lang]
  const werte = {
    ref: d.reservationRef,
    haus: d.propertyName,
    zimmer: d.categoryName,
    betrag: `${formatCent(d.totalCent)} ${d.currency}`
  }

  // Die Eckdaten als ein Absatz mit Zeilenumbruechen: in jeder Sprache
  // dieselbe Reihenfolge, damit ein Gast sie wiederfindet, auch wenn er die
  // Sprache nicht liest.
  const eckdaten = [
    einsetzen(t.buchungNummer, werte),
    einsetzen(t.buchungAnreise, { datum: d.arrival, zeit: d.checkinTime }),
    einsetzen(t.buchungAbreise, { datum: d.departure, zeit: d.checkoutTime }),
    einsetzen(t.buchungZimmer, werte),
    einsetzen(t.buchungGesamt, werte)
  ].join('\n')

  const lines = [
    anrede(d.guestName, lang),
    einsetzen(t.buchungBestaetigt, werte),
    eckdaten,
    t.buchungHinweis,
    d.propertyName
  ]
  return {
    subject: einsetzen(t.buchungBetreff, werte),
    text: lines.join('\n\n'),
    html: htmlBody(lines)
  }
}

/**
 * Ein Kalendertag in der Schreibweise der Sprache.
 *
 * Auf Zeichenketten und nicht ueber `Date`: ein Aufenthaltsdatum ist ein
 * Kalendertag, und `new Date('2026-03-29')` ist in Europa/Berlin der Abend
 * davor. Englisch bleibt beim ISO-Format, weil "03/04" diesseits und
 * jenseits des Atlantiks zwei verschiedene Tage sind.
 */
function kalendertag(iso: string, lang: EmailLanguage): string {
  const [jahr, monat, tag] = iso.split('-')
  if (jahr === undefined || monat === undefined || tag === undefined) return iso
  if (lang === 'en') return iso
  if (lang === 'nl') return `${tag}-${monat}-${jahr}`
  return `${tag}.${monat}.${jahr}`
}

/**
 * Zahlungslink an den Gast.
 *
 * **Der Link steht als eigener Absatz**, wie bei der Einladung: in einen Satz
 * eingebettet bricht ihn mancher Leser an einem Satzzeichen um, und der Gast
 * landet auf einer Fehlerseite statt beim Anbieter.
 *
 * **Der Satz ueber die Kartendaten ist kein Beiwerk.** Eine Mail mit einem
 * Zahlungslink sieht aus wie jede Phishing-Mail; der Gast soll lesen, dass
 * das Haus seine Karte nie sieht -- und dass er auf diese Nachricht
 * antworten kann, statt dem Link blind vertrauen zu muessen.
 */
export function renderPaymentLinkEmail(
  d: PaymentLinkEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const t = TEXTE[lang]
  const werte = {
    ref: d.reservationRef,
    haus: d.propertyName,
    anreise: kalendertag(d.arrival, lang),
    abreise: kalendertag(d.departure, lang),
    betrag: `${formatCent(d.amountCent)} ${d.currency}`,
    frist: d.dueDate === null ? '' : kalendertag(d.dueDate, lang),
    gueltig: kalendertag(d.validUntil, lang)
  }
  const bitte = !d.deposit ? t.zahlungAllgemein
    : d.dueDate === null ? t.zahlungAnzahlungOhneFrist : t.zahlungAnzahlungMitFrist

  const lines = [
    anrede(d.guestName, lang),
    einsetzen(bitte, werte),
    t.zahlungLink,
    d.url,
    t.zahlungKarte,
    einsetzen(t.zahlungGueltig, werte),
    einsetzen(t.zahlungHinweis, werte),
    d.propertyName
  ]
  return {
    subject: einsetzen(t.zahlungBetreff, werte),
    text: lines.join('\n\n'),
    html: htmlBody(lines)
  }
}

export interface CheckinInvitationData {
  propertyName: string
  guestName: string | null
  reservationRef: string
  arrival: string
  /** Bis wann der Link gilt, Kalendertag. */
  validUntil: string
  /** Der fertige Link samt Token. Die Domaene weiss nichts von URLs. */
  link: string
}

/**
 * Einladung zum Online-Check-in (Dokument 30).
 *
 * **Rechtsgrundlage ist der Beherbergungsvertrag**, nicht eine Einwilligung:
 * der Meldeschein ist Teil der Beherbergung (§ 29 BMG, Art. 6 Abs. 1 lit. b
 * und c DSGVO), und die Mail bietet nur einen zweiten Weg dorthin an. Sie
 * wirbt fuer nichts und sagt ausdruecklich, dass der Weg freiwillig ist.
 *
 * **Der Link steht im Text, nicht hinter einem Knopf.** Wer ihn nicht
 * anklicken mag, soll ihn lesen koennen; und ein Gast, der stutzt, sieht so,
 * wohin er fuehrt.
 *
 * **Kein Satz zur Unterschrift.** Frueher stand hier fuer jeden Gast, dass
 * auslaendische Gaeste am Anreisetag unterschreiben. Das Haus hat ihn
 * gestrichen (Sven, 07.10.2026): er sprach jeden an und betraf die
 * wenigsten. Wer unterschreiben muss, erfaehrt es auf der Seite selbst
 * (`gastCheckin.done.signatureLater`) und vor Ort.
 */
export function renderCheckinInvitationEmail(
  d: CheckinInvitationData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const t = TEXTE[lang]
  const werte = {
    haus: d.propertyName,
    anreise: kalendertag(d.arrival, lang),
    bis: kalendertag(d.validUntil, lang),
    ref: d.reservationRef
  }
  const lines = [
    d.guestName === null || d.guestName === ''
      ? t.checkinAnredeOhneName
      : einsetzen(t.checkinAnredeMitName, { name: d.guestName }),
    einsetzen(t.checkinEinladung, werte),
    d.link,
    einsetzen(t.checkinFrist, werte),
    t.checkinFreiwillig,
    t.checkinWeitergabe,
    d.propertyName
  ]
  // Im HTML-Teil wird der Link anklickbar. Ersetzt wird der bereits
  // entschaerfte Absatz, damit nichts aus dem Link selbst als Markup gilt.
  const html = htmlBody(lines).replace(
    `>${esc(d.link)}</p>`,
    `><a href="${esc(d.link)}">${esc(d.link)}</a></p>`)
  return {
    subject: einsetzen(t.checkinBetreff, werte),
    text: lines.join('\n\n'),
    html
  }
}

/**
 * Dieselbe Einladung als Testmail, an eine frei waehlbare Adresse.
 *
 * **Dieselbe Vorlage, nicht eine nachgebaute.** Geprueft werden soll, was
 * der Gast bekommt; eine eigene Testvorlage saehe gut aus und wiche
 * irgendwann ab. Davor steht nur ein Absatz, der sie als Test kennzeichnet,
 * und der Betreff traegt "[TEST]" -- wer sie weiterleitet oder in einem
 * geteilten Postfach findet, haelt sie nicht fuer eine echte Einladung.
 *
 * **Beispieldaten und ein Link ohne Zugang.** Eine Testmail an eine beliebige
 * Adresse mit dem Link einer echten Buchung waere genau der Weg, den
 * `/online-checkin/send` verschliesst: den Meldeschein eines Gastes jemand
 * anderem zu geben. Der Aufrufer reicht deshalb einen Link herein, der zu
 * keinem Token gehoert.
 */
export function renderCheckinInvitationTestEmail(
  d: CheckinInvitationData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const echt = renderCheckinInvitationEmail(d, lang)
  const hinweis = TEXTE[lang].checkinTest
  return {
    subject: `[TEST] ${echt.subject}`,
    text: `${hinweis}\n\n${echt.text}`,
    // Abgesetzt, damit die Kennzeichnung nicht als Teil der Einladung
    // gelesen wird -- die Einladung darunter bleibt Zeichen fuer Zeichen
    // die echte.
    html: '<p style="margin:0 0 16px 0;padding:8px 12px;background:#fef3c7;'
      + 'border:1px solid #f59e0b;font-family:system-ui,sans-serif;font-size:14px">'
      + `${esc(hinweis)}</p>\n${echt.html}`
  }
}

// ---------------------------------------------------------------------------
// Zugangspost (Aufgabe 13a)
//
// Getrennt von der Gastpost oben, und nicht nur der Ordnung halber: diese
// Nachrichten gehen an einen **Benutzer** des Systems, nicht an einen Gast
// eines Hauses. Sie tragen kein Haus im Absender, kennen keine Sprache des
// Gastprofils und duerfen nicht ausbleiben, weil ein Haus den Gastversand
// nicht eingeschaltet hat.
// ---------------------------------------------------------------------------

export interface AuthEmailData {
  /** Anzeigename des Benutzers, nicht des Gastes. */
  userName: string | null
  /** Der fertige Link samt Token. Die Domaene weiss nichts von URLs. */
  link: string
  /** Wie lange der Link gilt, in Stunden — ausgeschrieben im Text. */
  gueltigStunden: number
}

export interface InviteEmailData extends AuthEmailData {
  /**
   * Name des Kunden (`account.name`), fuer den der Zugang gilt. Leer bei
   * Plattformpersonal, das zu keinem Kunden gehoert.
   */
  accountName: string | null
  /** Die Adresse, mit der sich der Eingeladene kuenftig anmeldet. */
  email: string
}

/**
 * Einladung eines neuen Benutzers.
 *
 * **Warum der Link und kein Kennwort im Text.** Ein Kennwort in einer Mail
 * bleibt im Postfach stehen, wird weitergeleitet und landet in Sicherungen.
 * Ein Einmaltoken verfaellt.
 *
 * **Angeredet wird der Kunde, nicht der Benutzername.** Der Anzeigename ist
 * beim Onboarding oft ein Kuerzel wie "zurseerobbe" -- als Anrede liest sich
 * das wie ein Formfehler. Der Kundenname ist der, unter dem der Betrieb uns
 * kennt; nur wo es keinen gibt (Plattformpersonal), steht der Anzeigename.
 *
 * **Der Ton ist der einer Begruessung.** Diese Mail ist der erste Kontakt
 * mit dem Produkt. Sie sagt, wer schreibt, was zu tun ist, womit man sich
 * danach anmeldet und was geschieht, wenn der Link abgelaufen ist -- die
 * Fragen, die sonst als Anruf kommen.
 */
export function renderInviteEmail(
  d: InviteEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const name = d.accountName ?? d.userName
  if (lang === 'en') {
    const lines = [
      name ? `Dear ${name},` : 'Hello,',
      'welcome to StayGrid! '
        + (d.accountName
          ? `An account for ${d.accountName} has been set up for you.`
          : 'An account has been set up for you.')
        + ' Only one step is left before you can get started: choose your '
        + 'personal password using the link below.',
      d.link,
      `The link is valid for ${d.gueltigStunden} hours and can be used once. `
        + 'If it has expired, a new invitation can be sent at any time.',
      `Once your password is set, you sign in with your email address ${d.email}.`,
      'If you were not expecting this message, you can simply ignore it — '
        + 'without the link nothing happens.',
      'Kind regards\nYour StayGrid team'
    ]
    return {
      subject: d.accountName
        ? `Welcome to StayGrid – your access for ${d.accountName}`
        : 'Welcome to StayGrid – your access is ready',
      text: lines.join('\n\n'), html: linkKlickbar(htmlBody(lines), d.link)
    }
  }
  const lines = [
    name ? `Guten Tag ${name},` : 'Guten Tag,',
    'herzlich willkommen bei StayGrid! '
      + (d.accountName
        ? `Für ${d.accountName} wurde ein Zugang für Sie eingerichtet.`
        : 'Für Sie wurde ein Zugang eingerichtet.')
      + ' Bis Sie loslegen können, fehlt nur noch ein Schritt: Vergeben Sie über '
      + 'den folgenden Link Ihr persönliches Kennwort.',
    d.link,
    `Der Link ist ${d.gueltigStunden} Stunden gültig und lässt sich einmal `
      + 'verwenden. Ist er abgelaufen, kann Ihnen jederzeit eine neue Einladung '
      + 'geschickt werden.',
    `Sobald Ihr Kennwort steht, melden Sie sich mit Ihrer E-Mail-Adresse `
      + `${d.email} an.`,
    'Haben Sie diese Nachricht nicht erwartet, können Sie sie einfach '
      + 'ignorieren — ohne den Link geschieht nichts.',
    'Wir freuen uns, dass Sie dabei sind.',
    'Freundliche Grüße\nIhr StayGrid-Team'
  ]
  return {
    subject: d.accountName
      ? `Willkommen bei StayGrid – Ihr Zugang für ${d.accountName}`
      : 'Willkommen bei StayGrid – Ihr Zugang ist bereit',
    text: lines.join('\n\n'), html: linkKlickbar(htmlBody(lines), d.link)
  }
}

/**
 * Macht den Link-Absatz im HTML-Teil anklickbar. Ersetzt wird der bereits
 * entschaerfte Absatz, damit nichts aus dem Link selbst als Markup gilt.
 */
function linkKlickbar(html: string, link: string): string {
  return html.replace(`>${esc(link)}</p>`, `><a href="${esc(link)}">${esc(link)}</a></p>`)
}

/**
 * Kennwort zuruecksetzen.
 *
 * Der letzte Absatz ist kein Beiwerk: Diese Mail geht auch an jemanden, der
 * sie nicht angefordert hat — naemlich dann, wenn ein Fremder seine Adresse
 * eingetippt hat. Der Empfaenger muss wissen, dass sein Zugang unveraendert
 * ist und er nichts tun muss.
 */
export function renderPasswordResetEmail(
  d: AuthEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      'you can set a new password using the link below:',
      d.link,
      `The link is valid for ${d.gueltigStunden} hour(s) and can be used once.`,
      'If you did not request this, nothing has changed: your current password '
        + 'remains valid and this link expires on its own.'
    ]
    return { subject: 'Reset your password', text: lines.join('\n\n'), html: htmlBody(lines) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    'ueber den folgenden Link vergeben Sie ein neues Kennwort:',
    d.link,
    `Der Link gilt ${d.gueltigStunden} Stunde(n) und laesst sich einmal verwenden.`,
    'Haben Sie das nicht angefordert, hat sich nichts geaendert: Ihr bisheriges '
      + 'Kennwort gilt weiter, und dieser Link verfaellt von selbst.'
  ]
  return { subject: 'Kennwort zuruecksetzen', text: lines.join('\n\n'), html: htmlBody(lines) }
}

/**
 * Anfrage einer Support-Sitzung.
 *
 * **Der Ton ist Absicht.** Diese Nachricht bittet um Zugriff auf Daten, fuer
 * die der Empfaenger verantwortlich ist -- nicht wir. Sie nennt deshalb
 * Anlass, Stufe und Frist, und sie sagt ausdruecklich, dass Nichtstun die
 * Anfrage verfallen laesst. Eine Mail, die zum Klicken draengt, waere bei
 * einer Einwilligung genau das Falsche.
 */
export interface SupportRequestEmailData {
  userName: string | null
  /** Wer fragt. Ein Mensch, kein "Ihr Support-Team". */
  staffName: string
  reason: string
  /** Was die Stufe erlaubt, schon ausformuliert. */
  levelText: string
  hours: number
  link: string
}

export function renderSupportRequestEmail(
  d: SupportRequestEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      `${d.staffName} is asking for temporary access to your data in order to `
        + `help you. Stated reason:`,
      d.reason,
      `Scope: ${d.levelText}. The session ends automatically after `
        + `${d.hours} hour(s), and you can end it earlier at any time.`,
      'Nothing happens until you approve it here:',
      d.link,
      'If you do nothing, the request expires on its own. Access to your data '
        + 'is never granted without your approval.'
    ]
    return { subject: 'Support is asking for access', text: lines.join('\n\n'),
             html: htmlBody(lines) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `${d.staffName} bittet um befristeten Zugriff auf Ihre Daten, um Ihnen zu `
      + `helfen. Angegebener Anlass:`,
    d.reason,
    `Umfang: ${d.levelText}. Die Sitzung endet nach ${d.hours} Stunde(n) von `
      + `selbst, und Sie koennen sie jederzeit vorher beenden.`,
    'Es geschieht nichts, bevor Sie hier freigeben:',
    d.link,
    'Tun Sie nichts, verfaellt die Anfrage von allein. Ohne Ihre Freigabe '
      + 'bekommt niemand Zugriff auf Ihre Daten.'
  ]
  return { subject: 'Support bittet um Zugriff', text: lines.join('\n\n'),
           html: htmlBody(lines) }
}

/*
 * Hinweis an uns selbst: im Adminpanel liegt ein Antrag auf eine
 * Absenderdomain.
 *
 * **Nur ein Hinweis, keine Anfrage.** Entschieden wird im Adminpanel, wo
 * die Zeile mit allem steht, was zur Entscheidung gehoert. Deshalb steht
 * hier weder ein Knopf noch ein Merkmal, mit dem sich etwas freigeben
 * liesse: eine Freigabe per Antwortmail haenge an einem Postfach, das
 * niemand absichert, und sie liesse sich faelschen.
 *
 * Und deshalb steht hier auch **kein Name eines Menschen**. Die Mail geht
 * an ein Postfach, ihr Inhalt ist "es liegt Arbeit an", und wer den Antrag
 * gestellt hat, sieht das Adminpanel. Ein Name hier waere ein
 * personenbezogener Wert in einer Nachricht, die ihn nicht braucht.
 *
 * Nur deutsch: sie geht an uns, nicht an einen Kunden.
 */
export interface DomainRequestNoticeData {
  /** Wie viele offen sind, nicht welcher. Der Hinweis ist ein Anstoss. */
  offen: number
  link: string
}

export function renderDomainRequestNotice(d: DomainRequestNoticeData): RenderedEmail {
  const lines = [
    'Guten Tag,',
    d.offen === 1
      ? 'im Adminpanel liegt ein Antrag auf eine Absenderdomain zur Freigabe.'
      : `im Adminpanel liegen ${d.offen} Antraege auf eine Absenderdomain zur `
        + 'Freigabe.',
    'Entschieden wird dort, nicht per Antwort auf diese Nachricht:',
    d.link,
    'Solange nichts entschieden ist, verschickt das betroffene Haus keine '
      + 'Gastpost. Es wartet also jemand.'
  ]
  return { subject: d.offen === 1
             ? 'Antrag auf eine Absenderdomain'
             : `${d.offen} Antraege auf eine Absenderdomain`,
           text: lines.join('\n\n'), html: htmlBody(lines) }
}

/**
 * Bestaetigung einer neuen Mailadresse, an die **neue** Adresse.
 *
 * **Warum die Aenderung nicht sofort gilt.** Die Adresse ist die Anmeldung.
 * Wer sich vertippt, kommt ohne diesen Zwischenschritt weder herein noch an
 * eine Ruecksetzung -- der Link ginge an die falsche Adresse. Ein
 * Tippfehler wird so einfach nie bestaetigt, und es geht nichts verloren.
 *
 * Deshalb steht auch die neue Adresse im Text: der Empfaenger soll sie
 * lesen koennen, bevor er klickt. Ein Buchstabendreher faellt auf dem
 * Papier auf, im Adressfeld eines Formulars nicht.
 */
export interface EmailChangeData {
  userName: string | null
  newEmail: string
  link: string
  gueltigStunden: number
}

export function renderEmailChangeEmail(
  d: EmailChangeData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      `you asked to use ${d.newEmail} as your sign-in address. Confirm it here:`,
      d.link,
      `The link is valid for ${d.gueltigStunden} hours and can be used once. `
        + 'Until then, your previous address stays in force.',
      'If this was not you, do nothing. Without the link nothing changes.'
    ]
    return { subject: 'Confirm your new email address', text: lines.join('\n\n'),
             html: htmlBody(lines) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `Sie moechten kuenftig ${d.newEmail} als Anmeldeadresse verwenden. `
      + 'Bestaetigen Sie sie hier:',
    d.link,
    `Der Link gilt ${d.gueltigStunden} Stunden und laesst sich einmal `
      + 'verwenden. Bis dahin gilt Ihre bisherige Adresse weiter.',
    'Waren Sie das nicht, tun Sie nichts. Ohne den Link aendert sich nichts.'
  ]
  return { subject: 'Neue Mailadresse bestaetigen', text: lines.join('\n\n'),
           html: htmlBody(lines) }
}

/**
 * Hinweis an die **alte** Adresse, dass eine Aenderung angefordert wurde.
 *
 * **Ohne Link, und das ist der Punkt.** Eine Nachricht ueber eine Aenderung,
 * die man nicht veranlasst hat, mit einem Knopf "war ich nicht" darin, ist
 * die Bauform jeder Phishing-Mail -- und sie erzieht den Empfaenger dazu,
 * genau so etwas anzuklicken. Diese Mail meldet, sie fordert nicht auf.
 *
 * **Warum sie ueberhaupt hinausgeht.** Wer eine geliehene Sitzung
 * uebernimmt, wuerde das Konto sonst lautlos an sich ziehen. So faellt es
 * dem Betroffenen in dem Moment auf, in dem es passiert, und nicht beim
 * naechsten Anmeldeversuch.
 */
export interface EmailChangeNoticeData {
  userName: string | null
  /** Gekuerzt, nicht vollstaendig: siehe unten. */
  maskedNewEmail: string
}

/**
 * Die neue Adresse nur angedeutet.
 *
 * Sie vollstaendig zu nennen waere bequemer und in genau dem Fall falsch,
 * fuer den diese Mail gebaut ist: hat ein Fremder die Aenderung angestossen,
 * stuende seine Adresse im Postfach des Opfers -- und umgekehrt verraet ein
 * versehentlich falsch eingetippter Empfaenger nichts ueber sich. Zum
 * Wiedererkennen der eigenen Eingabe genuegt der Anfang.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  if (at < 1) return '***'
  return `${value[0]}***@${value.slice(at + 1)}`
}

export function renderEmailChangeNotice(
  d: EmailChangeNoticeData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      `a change of your sign-in address to ${d.maskedNewEmail} was requested.`,
      'Nothing has changed yet. The new address has to be confirmed first, and '
        + 'until then you sign in with this one.',
      'If this was not you, change your password now and tell your '
        + 'administrator. This message contains no link on purpose.'
    ]
    return { subject: 'Change of your email address requested',
             text: lines.join('\n\n'), html: htmlBody(lines) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `fuer Ihren Zugang wurde eine Aenderung der Anmeldeadresse auf `
      + `${d.maskedNewEmail} angefordert.`,
    'Geaendert hat sich noch nichts. Die neue Adresse muss erst bestaetigt '
      + 'werden; bis dahin melden Sie sich mit dieser an.',
    'Waren Sie das nicht, aendern Sie jetzt Ihr Kennwort und sagen Sie Ihrer '
      + 'Verwaltung Bescheid. Diese Nachricht enthaelt bewusst keinen Link.'
  ]
  return { subject: 'Aenderung Ihrer Mailadresse angefordert',
           text: lines.join('\n\n'), html: htmlBody(lines) }
}
