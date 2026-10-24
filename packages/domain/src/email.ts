import { schreibrichtung, type EmailLanguage } from '@hotelpms/contracts'
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
 * Gehoert diese Domain der Plattform selbst -- gleich oder darunter?
 *
 * Ein Haus darf sie nicht als **eigene** Absenderdomain beantragen (N5,
 * Audit 11.10.2026). Nach einer Freigabe duerfte es sonst mit jedem
 * Namensteil darunter senden, `rechnung@mail.staygrid.cloud` eingeschlossen,
 * und waere damit von unserer eigenen Post nicht mehr zu unterscheiden. Der
 * Weg fuer ein Haus ohne eigene Domain ist `relay`: dort vergeben wir den
 * Namensteil, nicht das Haus.
 *
 * Verglichen wird an der Punktgrenze, damit `nichtstaygrid.cloud` nicht
 * faelschlich als Plattformdomain gilt. Nimmt wie `isFreemailDomain` auch
 * eine ganze Adresse entgegen.
 */
export function isPlatformDomain(
  value: string | null | undefined, platformDomains: readonly string[]
): boolean {
  if (!value) return false
  let v = value.trim().toLowerCase()
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1)
  // Ein abschliessender Punkt ist im DNS dieselbe Domain.
  v = v.replace(/\.+$/, '')
  if (v === '') return false
  return platformDomains.some(d => {
    const p = d.trim().toLowerCase().replace(/\.+$/, '')
    return p !== '' && (v === p || v.endsWith(`.${p}`))
  })
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
  /**
   * Bankverbindung fuer die Ueberweisung. Aus der Momentaufnahme der
   * Rechnung, nicht aus den aktuellen Einstellungen: zieht das Haus zur
   * anderen Bank um, gilt fuer die alte Rechnung das, was darauf steht.
   */
  transfer?: { payee: string; iban: string; bic: string | null; bankName: string | null } | null
  /** Zahlungslink ueber den offenen Betrag, fertig mit Token. */
  paymentLink?: { url: string; validUntil: string } | null
}

/** Zahlungserinnerung (Stufe 1) oder Mahnung (ab Stufe 2) zu einer Rechnung. */
export interface ReminderEmailData {
  propertyName: string
  guestName: string | null
  invoiceNumber: string
  /** Ausstellungstag der Rechnung, schon fuer den Leser geschrieben. */
  issuedOn: string
  openCent: number
  currency: string
  /** Neue Frist, schon fuer den Leser geschrieben. */
  dueDate: string
  level: number
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

/**
 * Aus Zeilen einen HTML-Rumpf machen. Keine Vorlagensprache, keine Bilder.
 *
 * `dir="rtl"` fuer Arabisch: ohne die Angabe setzt ein Mailprogramm den
 * Satz linksbuendig und stellt Satzzeichen ans falsche Ende. `lang` daneben,
 * damit ein Vorleseprogramm die Sprache nicht raten muss.
 */
function htmlBody(lines: string[], lang: EmailLanguage = 'de'): string {
  const absaetze = lines.map(l => l === ''
    ? ''
    : `<p style="margin:0 0 12px 0">${esc(l).replace(/\n/g, '<br>')}</p>`)
    .filter(Boolean).join('\n')
  return `<div lang="${lang}" dir="${schreibrichtung(lang)}" `
    + 'style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;'
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
  rechnungUeberweisung: string
  rechnungEmpfaenger: string
  rechnungVerwendungszweck: string

  // Zahlungserinnerung und Mahnung (Pruefung Rechnungssystem 13.10.2026)
  erinnerungBetreff: string
  mahnungBetreff: string
  mahnungOffen: string
  mahnungFrist: string
  mahnungUeberschneidung: string

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

    rechnungUeberweisung: 'Bitte überweisen Sie den offenen Betrag auf folgendes Konto:',
    rechnungEmpfaenger: 'Empfänger: {name}',
    rechnungVerwendungszweck: 'Verwendungszweck: {nummer}',
    erinnerungBetreff: 'Zahlungserinnerung zu Rechnung {nummer} — {haus}',
    mahnungBetreff: 'Mahnung zu Rechnung {nummer} — {haus}',
    mahnungOffen: 'zu unserer Rechnung {nummer} vom {datum} ist noch ein Betrag von {offen} offen.',
    mahnungFrist: 'Bitte überweisen Sie ihn bis zum {frist}. Die Rechnung liegt noch einmal bei.',
    mahnungUeberschneidung: 'Sollte sich Ihre Zahlung mit dieser Nachricht überschnitten haben, betrachten Sie sie bitte als gegenstandslos.',

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

    rechnungUeberweisung: 'Please transfer the outstanding amount to the following account:',
    rechnungEmpfaenger: 'Payee: {name}',
    rechnungVerwendungszweck: 'Reference: {nummer}',
    erinnerungBetreff: 'Payment reminder for invoice {nummer} — {haus}',
    mahnungBetreff: 'Overdue notice for invoice {nummer} — {haus}',
    mahnungOffen: 'an amount of {offen} is still outstanding on our invoice {nummer} dated {datum}.',
    mahnungFrist: 'Please transfer it by {frist}. The invoice is attached once more.',
    mahnungUeberschneidung: 'If your payment has crossed with this message, please disregard it.',

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

    rechnungUeberweisung: 'Gelieve het openstaande bedrag over te maken naar de volgende rekening:',
    rechnungEmpfaenger: 'Begunstigde: {name}',
    rechnungVerwendungszweck: 'Omschrijving: {nummer}',
    erinnerungBetreff: 'Betalingsherinnering voor factuur {nummer} — {haus}',
    mahnungBetreff: 'Aanmaning voor factuur {nummer} — {haus}',
    mahnungOffen: 'van onze factuur {nummer} van {datum} staat nog een bedrag van {offen} open.',
    mahnungFrist: 'Wij verzoeken u dit uiterlijk {frist} over te maken. De factuur is nogmaals bijgevoegd.',
    mahnungUeberschneidung: 'Mocht uw betaling deze herinnering hebben gekruist, dan kunt u dit bericht als niet verzonden beschouwen.',

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

    rechnungUeberweisung: 'Prosimy o przelanie pozostałej kwoty na następujące konto:',
    rechnungEmpfaenger: 'Odbiorca: {name}',
    rechnungVerwendungszweck: 'Tytuł przelewu: {nummer}',
    erinnerungBetreff: 'Przypomnienie o płatności faktury {nummer} — {haus}',
    mahnungBetreff: 'Wezwanie do zapłaty faktury {nummer} — {haus}',
    mahnungOffen: 'z naszej faktury {nummer} z dnia {datum} pozostaje do zapłaty kwota {offen}.',
    mahnungFrist: 'Prosimy o przelew do dnia {frist}. Fakturę załączamy ponownie.',
    mahnungUeberschneidung: 'Jeśli Państwa płatność minęła się z tą wiadomością, prosimy ją zignorować.',

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
  },

  da: {
    anredeMitName: 'Kære {name}',
    anredeOhneName: 'Kære gæst',
    rechnungBetreff: 'Faktura {nummer} — {haus}',
    rechnungAnhang: 'Vedhæftet finder du din faktura {nummer} fra {haus} som PDF på i alt {betrag}.',
    rechnungOffenMitFrist: 'Heraf udestår {offen}, der skal betales senest den {frist}.',
    rechnungOffenOhneFrist: 'Heraf udestår {offen}.',
    rechnungBeglichen: 'Fakturaen er betalt fuldt ud. Dette eksemplar er til dine papirer.',
    rechnungDank: 'Mange tak for dit ophold — vi glæder os til at byde dig velkommen igen.',
    rechnungUeberweisung: 'Overfør venligst det udestående beløb til følgende konto:',
    rechnungEmpfaenger: 'Modtager: {name}',
    rechnungVerwendungszweck: 'Reference: {nummer}',
    erinnerungBetreff: 'Betalingspåmindelse for faktura {nummer} — {haus}',
    mahnungBetreff: 'Rykker for faktura {nummer} — {haus}',
    mahnungOffen: 'på vores faktura {nummer} af {datum} står der stadig {offen} åbent.',
    mahnungFrist: 'Vi beder Dem overføre beløbet senest {frist}. Fakturaen er vedhæftet igen.',
    mahnungUeberschneidung: 'Hvis Deres betaling har krydset denne meddelelse, bedes De se bort fra den.',

    buchungBetreff: 'Bookingbekræftelse {ref} — {haus}',
    buchungBestaetigt: 'Vi har bekræftet din booking hos {haus}.',
    buchungNummer: 'Bookingnummer: {ref}',
    buchungAnreise: 'Ankomst: {datum} fra kl. {zeit}',
    buchungAbreise: 'Afrejse: {datum} senest kl. {zeit}',
    buchungZimmer: 'Værelse: {zimmer}',
    buchungGesamt: 'Samlet beløb: {betrag}',
    buchungHinweis: 'Angiv venligst bookingnummeret ved henvendelser. Du kan svare på denne e-mail, hvis noget skal ændres.',
    zahlungBetreff: 'Betaling for dit ophold {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'For dit ophold fra {anreise} til {abreise} beder vi om et depositum på {betrag} senest den {frist}.',
    zahlungAnzahlungOhneFrist: 'For dit ophold fra {anreise} til {abreise} beder vi om et depositum på {betrag}.',
    zahlungAllgemein: 'For dit ophold fra {anreise} til {abreise} beder vi om en betaling på {betrag}.',
    zahlungLink: 'Via følgende link betaler du sikkert hos hotellets betalingsudbyder:',
    zahlungKarte: 'Dine kortoplysninger indtaster du kun der; hotellet modtager dem aldrig.',
    zahlungGueltig: 'Linket gælder til og med {gueltig}. Er det udløbet, sender vi dig gerne et nyt.',
    zahlungHinweis: 'Har du spørgsmål, så svar blot på denne e-mail, og angiv bookingnummeret {ref}.',
    checkinAnredeMitName: 'Hej {name}',
    checkinAnredeOhneName: 'Hej',
    checkinBetreff: 'Online check-in til dit ophold — {haus}',
    checkinEinladung: 'Vi glæder os til at byde dig velkommen hos {haus} den {anreise}. For at gøre ankomsten hurtigere kan du allerede nu udfylde registreringsblanketten (Meldeschein):',
    checkinFrist: 'Linket gælder til {bis} og kun for din booking {ref}.',
    checkinFreiwillig: 'Du er naturligvis også velkommen til at udfylde registreringsblanketten på stedet på ankomstdagen.',
    checkinWeitergabe: 'Giv venligst ikke linket videre: den, der har det, kan indtaste oplysninger om dit ophold.',
    checkinTest: 'TESTMAIL — sådan ser invitationen til online check-in ud for dine gæster. Navn, booking og datoer er eksempler; linket fører ikke til en rigtig registreringsblanket.'
  },

  sv: {
    anredeMitName: 'Hej {name},',
    anredeOhneName: 'Bästa gäst,',
    rechnungBetreff: 'Faktura {nummer} – {haus}',
    rechnungAnhang: 'Bifogat finner du din faktura {nummer} från {haus} som PDF, på totalt {betrag}.',
    rechnungOffenMitFrist: 'Ett belopp på {offen} återstår att betala, senast {frist}.',
    rechnungOffenOhneFrist: 'Ett belopp på {offen} återstår att betala.',
    rechnungBeglichen: 'Fakturan är betald i sin helhet. Denna kopia är för dina handlingar.',
    rechnungDank: 'Tack för din vistelse – vi välkomnar dig gärna igen.',
    rechnungUeberweisung: 'Vänligen överför det utestående beloppet till följande konto:',
    rechnungEmpfaenger: 'Mottagare: {name}',
    rechnungVerwendungszweck: 'Referens: {nummer}',
    erinnerungBetreff: 'Betalningspåminnelse för faktura {nummer} — {haus}',
    mahnungBetreff: 'Inkassovarning för faktura {nummer} — {haus}',
    mahnungOffen: 'på vår faktura {nummer} från {datum} återstår fortfarande {offen} att betala.',
    mahnungFrist: 'Vänligen betala beloppet senast {frist}. Fakturan bifogas på nytt.',
    mahnungUeberschneidung: 'Om er betalning har korsat detta meddelande kan ni bortse från det.',

    buchungBetreff: 'Bokningsbekräftelse {ref} – {haus}',
    buchungBestaetigt: 'Vi har bekräftat din bokning på {haus}.',
    buchungNummer: 'Bokningsnummer: {ref}',
    buchungAnreise: 'Ankomst: {datum} från {zeit}',
    buchungAbreise: 'Avresa: {datum} senast {zeit}',
    buchungZimmer: 'Rum: {zimmer}',
    buchungGesamt: 'Totalt: {betrag}',
    buchungHinweis: 'Ange bokningsnumret i all korrespondens. Du kan svara på detta mejl om något behöver ändras.',
    zahlungBetreff: 'Betalning för din vistelse {ref} – {haus}',
    zahlungAnzahlungMitFrist: 'För din vistelse från {anreise} till {abreise} ber vi vänligen om ett förskott på {betrag} senast {frist}.',
    zahlungAnzahlungOhneFrist: 'För din vistelse från {anreise} till {abreise} ber vi vänligen om ett förskott på {betrag}.',
    zahlungAllgemein: 'För din vistelse från {anreise} till {abreise} ber vi vänligen om en betalning på {betrag}.',
    zahlungLink: 'Du kan betala säkert hos hotellets betalleverantör via följande länk:',
    zahlungKarte: 'Du anger dina kortuppgifter bara där; hotellet får aldrig ta del av dem.',
    zahlungGueltig: 'Länken gäller till och med {gueltig}. Om den har gått ut skickar vi gärna en ny.',
    zahlungHinweis: 'Har du frågor, svara bara på detta mejl och ange bokningsnumret {ref}.',
    checkinAnredeMitName: 'Hej {name},',
    checkinAnredeOhneName: 'Hej,',
    checkinBetreff: 'Onlineincheckning för din vistelse – {haus}',
    checkinEinladung: 'Vi ser fram emot att välkomna dig till {haus} den {anreise}. För att göra din ankomst snabbare kan du redan nu fylla i registreringskortet (Meldeschein):',
    checkinFrist: 'Länken gäller till {bis} och bara för din bokning {ref}.',
    checkinFreiwillig: 'Du är givetvis också välkommen att fylla i registreringskortet på plats på ankomstdagen.',
    checkinWeitergabe: 'Lämna inte vidare länken: den som har den kan ange uppgifter om din vistelse.',
    checkinTest: 'TESTMEDDELANDE – så här ser inbjudan till onlineincheckning ut för dina gäster. Namn, bokning och datum är exempel; länken leder inte till ett riktigt registreringskort.'
  },

  nb: {
    anredeMitName: 'Hei {name},',
    anredeOhneName: 'Hei,',
    rechnungBetreff: 'Faktura {nummer} — {haus}',
    rechnungAnhang: 'Vedlagt finner du fakturaen din {nummer} fra {haus} som PDF, på totalt {betrag}.',
    rechnungOffenMitFrist: 'Av dette gjenstår {offen}, som betales innen {frist}.',
    rechnungOffenOhneFrist: 'Av dette gjenstår {offen}.',
    rechnungBeglichen: 'Fakturaen er betalt i sin helhet. Dette eksemplaret er til ditt eget arkiv.',
    rechnungDank: 'Tusen takk for oppholdet — vi ser frem til å ønske deg velkommen igjen.',
    rechnungUeberweisung: 'Vennligst overfør det utestående beløpet til følgende konto:',
    rechnungEmpfaenger: 'Mottaker: {name}',
    rechnungVerwendungszweck: 'Referanse: {nummer}',
    erinnerungBetreff: 'Betalingspåminnelse for faktura {nummer} — {haus}',
    mahnungBetreff: 'Purring på faktura {nummer} — {haus}',
    mahnungOffen: 'på vår faktura {nummer} datert {datum} står det fortsatt {offen} utestående.',
    mahnungFrist: 'Vennligst overfør beløpet innen {frist}. Fakturaen er vedlagt på nytt.',
    mahnungUeberschneidung: 'Dersom betalingen din har krysset denne meldingen, kan du se bort fra den.',

    buchungBetreff: 'Bookingbekreftelse {ref} — {haus}',
    buchungBestaetigt: 'Vi har bekreftet bookingen din hos {haus}.',
    buchungNummer: 'Bookingnummer: {ref}',
    buchungAnreise: 'Ankomst: {datum} fra kl. {zeit}',
    buchungAbreise: 'Avreise: {datum} innen kl. {zeit}',
    buchungZimmer: 'Rom: {zimmer}',
    buchungGesamt: 'Totalbeløp: {betrag}',
    buchungHinweis: 'Oppgi bookingnummeret ved henvendelser. Du kan svare på denne e-posten hvis noe skal endres.',
    zahlungBetreff: 'Betaling for oppholdet ditt {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'For oppholdet ditt fra {anreise} til {abreise} ber vi om et forskudd på {betrag} innen {frist}.',
    zahlungAnzahlungOhneFrist: 'For oppholdet ditt fra {anreise} til {abreise} ber vi om et forskudd på {betrag}.',
    zahlungAllgemein: 'For oppholdet ditt fra {anreise} til {abreise} ber vi om en betaling på {betrag}.',
    zahlungLink: 'Via lenken nedenfor betaler du trygt hos hotellets betalingsleverandør:',
    zahlungKarte: 'Kortopplysningene dine legger du bare inn der; hotellet mottar dem aldri.',
    zahlungGueltig: 'Lenken gjelder til og med {gueltig}. Har den utløpt, sender vi deg gjerne en ny.',
    zahlungHinweis: 'Har du spørsmål, svarer du bare på denne e-posten og oppgir bookingnummeret {ref}.',
    checkinAnredeMitName: 'Hei {name},',
    checkinAnredeOhneName: 'Hei,',
    checkinBetreff: 'Nettinnsjekking for oppholdet ditt — {haus}',
    checkinEinladung: 'Vi ser frem til å ta imot deg hos {haus} {anreise}. For at ankomsten skal gå raskere, kan du allerede nå fylle ut registreringsskjemaet (Meldeschein):',
    checkinFrist: 'Lenken gjelder til {bis} og bare for bookingen din {ref}.',
    checkinFreiwillig: 'Du kan selvfølgelig også fylle ut registreringsskjemaet på stedet på ankomstdagen.',
    checkinWeitergabe: 'Ikke del lenken med andre: den som har den, kan legge inn opplysninger om oppholdet ditt.',
    checkinTest: 'TESTMELDING — slik ser invitasjonen til nettinnsjekking ut for gjestene dine. Navn, booking og datoer er eksempler; lenken fører ikke til et ekte registreringsskjema.'
  },

  fr: {
    anredeMitName: 'Bonjour {name},',
    anredeOhneName: 'Bonjour,',
    rechnungBetreff: 'Facture {nummer} — {haus}',
    rechnungAnhang: 'Veuillez trouver ci-joint votre facture {nummer} de {haus} au format PDF, d’un montant total de {betrag}.',
    rechnungOffenMitFrist: 'Il reste {offen} à régler, payable d’ici le {frist}.',
    rechnungOffenOhneFrist: 'Il reste {offen} à régler.',
    rechnungBeglichen: 'La facture est entièrement réglée. Cet exemplaire est destiné à vos archives.',
    rechnungDank: 'Merci pour votre séjour — nous serions ravis de vous accueillir à nouveau.',
    rechnungUeberweisung: 'Merci de virer le montant restant dû sur le compte suivant :',
    rechnungEmpfaenger: 'Bénéficiaire : {name}',
    rechnungVerwendungszweck: 'Référence : {nummer}',
    erinnerungBetreff: 'Rappel de paiement pour la facture {nummer} — {haus}',
    mahnungBetreff: 'Relance pour la facture {nummer} — {haus}',
    mahnungOffen: 'un montant de {offen} reste dû sur notre facture {nummer} du {datum}.',
    mahnungFrist: 'Nous vous prions de le virer d’ici le {frist}. La facture est de nouveau jointe.',
    mahnungUeberschneidung: 'Si votre paiement a croisé ce message, veuillez ne pas en tenir compte.',

    buchungBetreff: 'Confirmation de réservation {ref} — {haus}',
    buchungBestaetigt: 'Nous avons confirmé votre réservation à {haus}.',
    buchungNummer: 'Numéro de réservation : {ref}',
    buchungAnreise: 'Arrivée : {datum} à partir de {zeit}',
    buchungAbreise: 'Départ : {datum} avant {zeit}',
    buchungZimmer: 'Chambre : {zimmer}',
    buchungGesamt: 'Montant total : {betrag}',
    buchungHinweis: 'Veuillez indiquer le numéro de réservation pour toute question. Vous pouvez répondre à cet e-mail si quelque chose doit être modifié.',
    zahlungBetreff: 'Paiement de votre séjour {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Pour votre séjour du {anreise} au {abreise}, nous vous prions de bien vouloir verser un acompte de {betrag} d’ici le {frist}.',
    zahlungAnzahlungOhneFrist: 'Pour votre séjour du {anreise} au {abreise}, nous vous prions de bien vouloir verser un acompte de {betrag}.',
    zahlungAllgemein: 'Pour votre séjour du {anreise} au {abreise}, nous vous prions de bien vouloir effectuer un paiement de {betrag}.',
    zahlungLink: 'Le lien suivant vous permet de payer en toute sécurité auprès du prestataire de paiement de l’établissement :',
    zahlungKarte: 'Vous saisissez vos données de carte uniquement là-bas ; l’établissement ne les reçoit pas.',
    zahlungGueltig: 'Le lien est valable jusqu’au {gueltig} inclus. S’il a expiré, nous vous en enverrons volontiers un nouveau.',
    zahlungHinweis: 'Pour toute question, répondez simplement à cet e-mail en indiquant le numéro de réservation {ref}.',
    checkinAnredeMitName: 'Bonjour {name},',
    checkinAnredeOhneName: 'Bonjour,',
    checkinBetreff: 'Check-in en ligne pour votre séjour — {haus}',
    checkinEinladung: 'Nous vous attendons le {anreise} à {haus}. Pour accélérer votre arrivée, vous pouvez dès maintenant remplir la fiche d’enregistrement (Meldeschein) :',
    checkinFrist: 'Le lien est valable jusqu’au {bis} et uniquement pour votre réservation {ref}.',
    checkinFreiwillig: 'Vous pouvez bien sûr aussi remplir la fiche d’enregistrement sur place le jour de votre arrivée.',
    checkinWeitergabe: 'Veuillez ne pas transmettre ce lien : quiconque le possède peut saisir des informations sur votre séjour.',
    checkinTest: 'E-MAIL DE TEST — voici à quoi ressemble l’invitation au check-in en ligne pour vos clients. Le nom, la réservation et les dates sont des exemples ; le lien ne mène à aucune vraie fiche d’enregistrement.'
  },

  it: {
    anredeMitName: 'Gentile {name},',
    anredeOhneName: 'Gentile ospite,',
    rechnungBetreff: 'Fattura {nummer} — {haus}',
    rechnungAnhang: 'in allegato trova in PDF la Sua fattura {nummer} di {haus}, per un totale di {betrag}.',
    rechnungOffenMitFrist: 'Resta da pagare un importo di {offen}, entro il {frist}.',
    rechnungOffenOhneFrist: 'Resta da pagare un importo di {offen}.',
    rechnungBeglichen: 'La fattura è stata saldata per intero. Questa copia è per i Suoi archivi.',
    rechnungDank: 'Grazie per il Suo soggiorno — saremo lieti di accoglierLa di nuovo.',
    rechnungUeberweisung: 'Vi preghiamo di bonificare l’importo residuo sul seguente conto:',
    rechnungEmpfaenger: 'Beneficiario: {name}',
    rechnungVerwendungszweck: 'Causale: {nummer}',
    erinnerungBetreff: 'Promemoria di pagamento per la fattura {nummer} — {haus}',
    mahnungBetreff: 'Sollecito per la fattura {nummer} — {haus}',
    mahnungOffen: 'sulla nostra fattura {nummer} del {datum} risulta ancora aperto un importo di {offen}.',
    mahnungFrist: 'La preghiamo di bonificarlo entro il {frist}. Alleghiamo nuovamente la fattura.',
    mahnungUeberschneidung: 'Se il Suo pagamento si è incrociato con questo messaggio, La preghiamo di non tenerne conto.',

    buchungBetreff: 'Conferma di prenotazione {ref} — {haus}',
    buchungBestaetigt: 'abbiamo confermato la Sua prenotazione presso {haus}.',
    buchungNummer: 'Numero di prenotazione: {ref}',
    buchungAnreise: 'Arrivo: {datum} dalle {zeit}',
    buchungAbreise: 'Partenza: {datum} entro le {zeit}',
    buchungZimmer: 'Camera: {zimmer}',
    buchungGesamt: 'Importo totale: {betrag}',
    buchungHinweis: 'La preghiamo di indicare il numero di prenotazione in caso di domande. Può rispondere a questa e-mail se desidera modificare qualcosa.',
    zahlungBetreff: 'Pagamento per il Suo soggiorno {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'per il Suo soggiorno dal {anreise} al {abreise} Le chiediamo un acconto di {betrag} entro il {frist}.',
    zahlungAnzahlungOhneFrist: 'per il Suo soggiorno dal {anreise} al {abreise} Le chiediamo un acconto di {betrag}.',
    zahlungAllgemein: 'per il Suo soggiorno dal {anreise} al {abreise} Le chiediamo un pagamento di {betrag}.',
    zahlungLink: 'Tramite il seguente link può pagare in modo sicuro presso il fornitore di pagamento della struttura:',
    zahlungKarte: 'I dati della Sua carta li inserisce solo lì; la struttura non li riceve.',
    zahlungGueltig: 'Il link è valido fino al {gueltig} incluso. Se è scaduto, Le invieremo volentieri un nuovo link.',
    zahlungHinweis: 'Per qualsiasi domanda risponda semplicemente a questa e-mail indicando il numero di prenotazione {ref}.',
    checkinAnredeMitName: 'Buongiorno {name},',
    checkinAnredeOhneName: 'Buongiorno,',
    checkinBetreff: 'Check-in online per il Suo soggiorno — {haus}',
    checkinEinladung: 'il {anreise} La aspettiamo presso {haus}. Per rendere più rapido il Suo arrivo, può compilare già ora la scheda di registrazione (Meldeschein):',
    checkinFrist: 'Il link è valido fino al {bis} e solo per la Sua prenotazione {ref}.',
    checkinFreiwillig: 'Naturalmente può anche compilare la scheda di registrazione sul posto il giorno dell’arrivo.',
    checkinWeitergabe: 'La preghiamo di non inoltrare il link: chi lo possiede può inserire dati sul Suo soggiorno.',
    checkinTest: 'E-MAIL DI PROVA — così appare ai Suoi ospiti l’invito al check-in online. Nome, prenotazione e dati sono esempi; il link non porta a una vera scheda di registrazione.'
  },

  es: {
    anredeMitName: 'Estimado/a {name}:',
    anredeOhneName: 'Estimado/a huésped:',
    rechnungBetreff: 'Factura {nummer} — {haus}',
    rechnungAnhang: 'Adjunta le enviamos en PDF su factura {nummer} de {haus}, por un total de {betrag}.',
    rechnungOffenMitFrist: 'De ese importe quedan pendientes {offen}, a pagar antes del {frist}.',
    rechnungOffenOhneFrist: 'De ese importe quedan pendientes {offen}.',
    rechnungBeglichen: 'La factura está pagada en su totalidad. Este ejemplar es para su archivo.',
    rechnungDank: 'Muchas gracias por su estancia; será un placer volver a recibirle.',
    rechnungUeberweisung: 'Le rogamos que transfiera el importe pendiente a la siguiente cuenta:',
    rechnungEmpfaenger: 'Beneficiario: {name}',
    rechnungVerwendungszweck: 'Concepto: {nummer}',
    erinnerungBetreff: 'Recordatorio de pago de la factura {nummer} — {haus}',
    mahnungBetreff: 'Requerimiento de pago de la factura {nummer} — {haus}',
    mahnungOffen: 'de nuestra factura {nummer} del {datum} queda pendiente un importe de {offen}.',
    mahnungFrist: 'Le rogamos que lo transfiera antes del {frist}. Adjuntamos de nuevo la factura.',
    mahnungUeberschneidung: 'Si su pago se ha cruzado con este mensaje, le rogamos que lo ignore.',

    buchungBetreff: 'Confirmación de reserva {ref} — {haus}',
    buchungBestaetigt: 'Hemos confirmado su reserva en {haus}.',
    buchungNummer: 'Número de reserva: {ref}',
    buchungAnreise: 'Llegada: {datum} a partir de las {zeit}',
    buchungAbreise: 'Salida: {datum} hasta las {zeit}',
    buchungZimmer: 'Habitación: {zimmer}',
    buchungGesamt: 'Importe total: {betrag}',
    buchungHinweis: 'Indique el número de reserva en cualquier consulta. Si desea cambiar algo, puede responder a este e-mail.',
    zahlungBetreff: 'Pago de su estancia {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Para su estancia del {anreise} al {abreise} le rogamos un anticipo de {betrag} antes del {frist}.',
    zahlungAnzahlungOhneFrist: 'Para su estancia del {anreise} al {abreise} le rogamos un anticipo de {betrag}.',
    zahlungAllgemein: 'Para su estancia del {anreise} al {abreise} le rogamos un pago de {betrag}.',
    zahlungLink: 'Mediante el siguiente enlace puede pagar de forma segura a través del proveedor de pagos del establecimiento:',
    zahlungKarte: 'Sus datos de tarjeta solo los introduce allí; el establecimiento no los recibe.',
    zahlungGueltig: 'El enlace es válido hasta el {gueltig} inclusive. Si ha caducado, le enviaremos uno nuevo con mucho gusto.',
    zahlungHinweis: 'Si tiene alguna pregunta, responda simplemente a este e-mail indicando el número de reserva {ref}.',
    checkinAnredeMitName: 'Hola, {name}:',
    checkinAnredeOhneName: 'Hola:',
    checkinBetreff: 'Check-in online para su estancia — {haus}',
    checkinEinladung: 'Le esperamos el {anreise} en {haus}. Para agilizar su llegada, ya puede rellenar ahora el formulario de registro (Meldeschein):',
    checkinFrist: 'El enlace es válido hasta el {bis} y solo para su reserva {ref}.',
    checkinFreiwillig: 'Por supuesto, también puede rellenar el formulario de registro en el establecimiento el día de llegada.',
    checkinWeitergabe: 'Por favor, no comparta el enlace: quien lo tenga puede introducir datos sobre su estancia.',
    checkinTest: 'E-MAIL DE PRUEBA — así ven sus huéspedes la invitación al check-in online. El nombre, la reserva y las fechas son ejemplos; el enlace no lleva a ningún formulario de registro real.'
  },

  tr: {
    anredeMitName: 'Sayın {name},',
    anredeOhneName: 'Sayın misafirimiz,',
    rechnungBetreff: 'Fatura {nummer} — {haus}',
    rechnungAnhang: '{haus} tesisine ait toplam {betrag} tutarındaki {nummer} numaralı faturanızı ekte PDF olarak bulabilirsiniz.',
    rechnungOffenMitFrist: 'Bunun {offen} tutarındaki kısmı henüz ödenmemiştir; son ödeme tarihi {frist}.',
    rechnungOffenOhneFrist: 'Bunun {offen} tutarındaki kısmı henüz ödenmemiştir.',
    rechnungBeglichen: 'Fatura tamamen ödenmiştir. Bu nüsha kayıtlarınız içindir.',
    rechnungDank: 'Konaklamanız için çok teşekkür ederiz — sizi yeniden ağırlamaktan mutluluk duyarız.',
    rechnungUeberweisung: 'Lütfen kalan tutarı aşağıdaki hesaba havale edin:',
    rechnungEmpfaenger: 'Alıcı: {name}',
    rechnungVerwendungszweck: 'Açıklama: {nummer}',
    erinnerungBetreff: '{nummer} numaralı fatura için ödeme hatırlatması — {haus}',
    mahnungBetreff: '{nummer} numaralı fatura için ihtar — {haus}',
    mahnungOffen: '{datum} tarihli {nummer} numaralı faturamızdan hâlâ {offen} tutarında ödeme açık.',
    mahnungFrist: 'Lütfen tutarı {frist} tarihine kadar havale edin. Fatura tekrar ektedir.',
    mahnungUeberschneidung: 'Ödemeniz bu mesajla aynı anda yapıldıysa lütfen bu mesajı dikkate almayın.',

    buchungBetreff: 'Rezervasyon onayı {ref} — {haus}',
    buchungBestaetigt: '{haus} tesisindeki rezervasyonunuzu onayladık.',
    buchungNummer: 'Rezervasyon numarası: {ref}',
    buchungAnreise: 'Giriş: {datum}, saat {zeit} itibarıyla',
    buchungAbreise: 'Çıkış: {datum}, en geç saat {zeit}',
    buchungZimmer: 'Oda: {zimmer}',
    buchungGesamt: 'Toplam tutar: {betrag}',
    buchungHinweis: 'Lütfen sorularınızda rezervasyon numarasını belirtin. Bir değişiklik isterseniz bu e-postayı yanıtlayabilirsiniz.',
    zahlungBetreff: '{ref} konaklamanız için ödeme — {haus}',
    zahlungAnzahlungMitFrist: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için {frist} tarihine kadar {betrag} tutarında ön ödeme rica ederiz.',
    zahlungAnzahlungOhneFrist: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için {betrag} tutarında ön ödeme rica ederiz.',
    zahlungAllgemein: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için {betrag} tutarında ödeme rica ederiz.',
    zahlungLink: 'Aşağıdaki bağlantı üzerinden tesisin ödeme hizmet sağlayıcısında güvenle ödeme yapabilirsiniz:',
    zahlungKarte: 'Kart bilgilerinizi yalnızca orada girersiniz; tesis bu bilgileri almaz.',
    zahlungGueltig: 'Bağlantı {gueltig} tarihi dahil geçerlidir. Süresi dolmuşsa size memnuniyetle yenisini göndeririz.',
    zahlungHinweis: 'Sorularınız için bu e-postayı yanıtlamanız ve {ref} rezervasyon numarasını belirtmeniz yeterlidir.',
    checkinAnredeMitName: 'Merhaba {name},',
    checkinAnredeOhneName: 'Merhaba,',
    checkinBetreff: 'Konaklamanız için online check-in — {haus}',
    checkinEinladung: '{anreise} tarihinde sizi {haus} tesisimizde ağırlamayı dört gözle bekliyoruz. Varışınızın daha hızlı olması için kayıt formunu (Meldeschein) şimdiden doldurabilirsiniz:',
    checkinFrist: 'Bağlantı {bis} tarihine kadar ve yalnızca {ref} rezervasyonunuz için geçerlidir.',
    checkinFreiwillig: 'Kayıt formunu elbette varış gününde tesiste de doldurabilirsiniz.',
    checkinWeitergabe: 'Lütfen bağlantıyı başkalarıyla paylaşmayın: bağlantıya sahip olan herkes konaklamanızla ilgili bilgi girebilir.',
    checkinTest: 'TEST E-POSTASI — online check-in daveti misafirlerinize böyle görünür. Ad, rezervasyon ve tarihler örnektir; bağlantı gerçek bir kayıt formuna yönlendirmez.'
  },

  ru: {
    anredeMitName: 'Здравствуйте, {name}!',
    anredeOhneName: 'Здравствуйте!',
    rechnungBetreff: 'Счёт {nummer} — {haus}',
    rechnungAnhang: 'Во вложении Вы найдёте Ваш счёт {nummer} от {haus} в формате PDF на общую сумму {betrag}.',
    rechnungOffenMitFrist: 'Из них к оплате остаётся {offen}, срок оплаты — до {frist}.',
    rechnungOffenOhneFrist: 'Из них к оплате остаётся {offen}.',
    rechnungBeglichen: 'Счёт полностью оплачен. Этот экземпляр — для Ваших документов.',
    rechnungDank: 'Благодарим Вас за пребывание — будем рады снова видеть Вас у нас.',
    rechnungUeberweisung: 'Просим перевести оставшуюся сумму на следующий счёт:',
    rechnungEmpfaenger: 'Получатель: {name}',
    rechnungVerwendungszweck: 'Назначение платежа: {nummer}',
    erinnerungBetreff: 'Напоминание об оплате счёта {nummer} — {haus}',
    mahnungBetreff: 'Претензия по счёту {nummer} — {haus}',
    mahnungOffen: 'по нашему счёту {nummer} от {datum} остаётся неоплаченной сумма {offen}.',
    mahnungFrist: 'Просим перевести её до {frist}. Счёт прилагаем повторно.',
    mahnungUeberschneidung: 'Если ваш платёж разминулся с этим сообщением, просим считать его недействительным.',

    buchungBetreff: 'Подтверждение бронирования {ref} — {haus}',
    buchungBestaetigt: 'Мы подтвердили Ваше бронирование в {haus}.',
    buchungNummer: 'Номер бронирования: {ref}',
    buchungAnreise: 'Заезд: {datum} с {zeit}',
    buchungAbreise: 'Выезд: {datum} до {zeit}',
    buchungZimmer: 'Номер: {zimmer}',
    buchungGesamt: 'Общая сумма: {betrag}',
    buchungHinweis: 'Пожалуйста, указывайте номер бронирования при обращении к нам. Если что-то нужно изменить, Вы можете ответить на это письмо.',
    zahlungBetreff: 'Оплата Вашего пребывания {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Просим Вас внести предоплату в размере {betrag} до {frist} за Ваше пребывание с {anreise} по {abreise}.',
    zahlungAnzahlungOhneFrist: 'Просим Вас внести предоплату в размере {betrag} за Ваше пребывание с {anreise} по {abreise}.',
    zahlungAllgemein: 'Просим Вас оплатить {betrag} за Ваше пребывание с {anreise} по {abreise}.',
    zahlungLink: 'По следующей ссылке Вы можете безопасно оплатить у платёжного провайдера отеля:',
    zahlungKarte: 'Данные карты Вы вводите только там; отель их не получает.',
    zahlungGueltig: 'Ссылка действует до {gueltig} включительно. Если срок её действия истёк, мы с удовольствием пришлём Вам новую.',
    zahlungHinweis: 'Если у Вас есть вопросы, просто ответьте на это письмо и укажите номер бронирования {ref}.',
    checkinAnredeMitName: 'Здравствуйте, {name}!',
    checkinAnredeOhneName: 'Здравствуйте!',
    checkinBetreff: 'Онлайн-check-in для Вашего пребывания — {haus}',
    checkinEinladung: '{anreise} мы ждём Вас в нашем отеле {haus}. Чтобы заселение прошло быстрее, Вы можете уже сейчас заполнить регистрационную карту (Meldeschein):',
    checkinFrist: 'Ссылка действует до {bis} и только для Вашего бронирования {ref}.',
    checkinFreiwillig: 'Разумеется, Вы также можете заполнить регистрационную карту на месте в день заезда.',
    checkinWeitergabe: 'Пожалуйста, не передавайте ссылку другим: тот, у кого она есть, может вносить данные о Вашем пребывании.',
    checkinTest: 'ТЕСТОВОЕ ПИСЬМО — так выглядит приглашение на онлайн-check-in для Ваших гостей. Имя, бронирование и даты приведены для примера; ссылка не ведёт к настоящей регистрационной карте.'
  },

  cs: {
    anredeMitName: 'Dobrý den, {name},',
    anredeOhneName: 'Dobrý den,',
    rechnungBetreff: 'Faktura {nummer} — {haus}',
    rechnungAnhang: 'v příloze Vám zasíláme fakturu {nummer} od {haus} ve formátu PDF na celkovou částku {betrag}.',
    rechnungOffenMitFrist: 'Z toho zbývá uhradit {offen}, splatné do {frist}.',
    rechnungOffenOhneFrist: 'Z toho zbývá uhradit {offen}.',
    rechnungBeglichen: 'Faktura je zcela uhrazena. Tento výtisk je pro Vaši evidenci.',
    rechnungDank: 'Děkujeme za Váš pobyt — budeme rádi, když Vás opět přivítáme.',
    rechnungUeberweisung: 'Prosíme o převod zbývající částky na následující účet:',
    rechnungEmpfaenger: 'Příjemce: {name}',
    rechnungVerwendungszweck: 'Účel platby: {nummer}',
    erinnerungBetreff: 'Upomínka platby faktury {nummer} — {haus}',
    mahnungBetreff: 'Upomínka k faktuře {nummer} — {haus}',
    mahnungOffen: 'z naší faktury {nummer} ze dne {datum} zůstává neuhrazeno {offen}.',
    mahnungFrist: 'Prosíme o úhradu do {frist}. Fakturu přikládáme znovu.',
    mahnungUeberschneidung: 'Pokud se Vaše platba s touto zprávou minula, považujte ji prosím za bezpředmětnou.',

    buchungBetreff: 'Potvrzení rezervace {ref} — {haus}',
    buchungBestaetigt: 'potvrdili jsme Vaši rezervaci v {haus}.',
    buchungNummer: 'Číslo rezervace: {ref}',
    buchungAnreise: 'Příjezd: {datum} od {zeit}',
    buchungAbreise: 'Odjezd: {datum} do {zeit}',
    buchungZimmer: 'Pokoj: {zimmer}',
    buchungGesamt: 'Celková částka: {betrag}',
    buchungHinweis: 'Při dotazech prosím uveďte číslo rezervace. Pokud je třeba něco změnit, můžete na tento e-mail odpovědět.',
    zahlungBetreff: 'Platba za Váš pobyt {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o zálohu ve výši {betrag} do {frist}.',
    zahlungAnzahlungOhneFrist: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o zálohu ve výši {betrag}.',
    zahlungAllgemein: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o platbu ve výši {betrag}.',
    zahlungLink: 'Pomocí následujícího odkazu zaplatíte bezpečně u poskytovatele platebních služeb hotelu:',
    zahlungKarte: 'Údaje o kartě zadáváte pouze tam; hotel je nedostane.',
    zahlungGueltig: 'Odkaz platí do {gueltig} včetně. Pokud vyprší, rádi Vám pošleme nový.',
    zahlungHinweis: 'S dotazy jednoduše odpovězte na tento e-mail a uveďte číslo rezervace {ref}.',
    checkinAnredeMitName: 'Dobrý den, {name},',
    checkinAnredeOhneName: 'Dobrý den,',
    checkinBetreff: 'Online check-in pro Váš pobyt — {haus}',
    checkinEinladung: 'dne {anreise} Vás očekáváme v {haus}. Aby byl příjezd rychlejší, můžete registrační formulář (Meldeschein) vyplnit už nyní:',
    checkinFrist: 'Odkaz platí do {bis} a pouze pro Vaši rezervaci {ref}.',
    checkinFreiwillig: 'Registrační formulář můžete samozřejmě vyplnit také v den příjezdu na místě.',
    checkinWeitergabe: 'Odkaz prosím nikomu nepředávejte: kdo jej má, může zadávat údaje k Vašemu pobytu.',
    checkinTest: 'TESTOVACÍ E-MAIL — takto vidí Vaši hosté pozvánku k online check-inu. Jméno, rezervace a údaje jsou příklady; odkaz nevede ke skutečnému registračnímu formuláři.'
  },

  uk: {
    anredeMitName: 'Доброго дня, {name},',
    anredeOhneName: 'Доброго дня,',
    rechnungBetreff: 'Рахунок {nummer} — {haus}',
    rechnungAnhang: 'надсилаємо Вам у вкладенні рахунок {nummer} від {haus} у форматі PDF на загальну суму {betrag}.',
    rechnungOffenMitFrist: 'З неї залишається до сплати {offen}, термін сплати — до {frist}.',
    rechnungOffenOhneFrist: 'З неї залишається до сплати {offen}.',
    rechnungBeglichen: 'Рахунок повністю оплачено. Цей примірник — для Ваших документів.',
    rechnungDank: 'Дякуємо за Ваше перебування — будемо раді вітати Вас знову.',
    rechnungUeberweisung: 'Просимо переказати залишок суми на такий рахунок:',
    rechnungEmpfaenger: 'Одержувач: {name}',
    rechnungVerwendungszweck: 'Призначення платежу: {nummer}',
    erinnerungBetreff: 'Нагадування про оплату рахунку {nummer} — {haus}',
    mahnungBetreff: 'Вимога щодо оплати рахунку {nummer} — {haus}',
    mahnungOffen: 'за нашим рахунком {nummer} від {datum} залишається неоплаченою сума {offen}.',
    mahnungFrist: 'Просимо переказати її до {frist}. Рахунок додаємо повторно.',
    mahnungUeberschneidung: 'Якщо ваш платіж розминувся з цим повідомленням, просимо вважати його недійсним.',

    buchungBetreff: 'Підтвердження бронювання {ref} — {haus}',
    buchungBestaetigt: 'ми підтвердили Ваше бронювання в {haus}.',
    buchungNummer: 'Номер бронювання: {ref}',
    buchungAnreise: 'Заїзд: {datum} з {zeit}',
    buchungAbreise: 'Виїзд: {datum} до {zeit}',
    buchungZimmer: 'Номер: {zimmer}',
    buchungGesamt: 'Загальна сума: {betrag}',
    buchungHinweis: 'У разі запитань, будь ласка, вказуйте номер бронювання. Якщо щось потрібно змінити, Ви можете відповісти на цей лист.',
    zahlungBetreff: 'Оплата Вашого перебування {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'просимо внести аванс у розмірі {betrag} до {frist} за Ваше перебування з {anreise} по {abreise}.',
    zahlungAnzahlungOhneFrist: 'просимо внести аванс у розмірі {betrag} за Ваше перебування з {anreise} по {abreise}.',
    zahlungAllgemein: 'просимо внести оплату в розмірі {betrag} за Ваше перебування з {anreise} по {abreise}.',
    zahlungLink: 'За наведеним нижче посиланням Ви можете безпечно оплатити через платіжного провайдера готелю:',
    zahlungKarte: 'Дані своєї картки Ви вводите лише там; готель їх не отримує.',
    zahlungGueltig: 'Посилання дійсне до {gueltig} включно. Якщо термін його дії минув, ми охоче надішлемо Вам нове.',
    zahlungHinweis: 'Якщо у Вас є запитання, просто дайте відповідь на цей лист і вкажіть номер бронювання {ref}.',
    checkinAnredeMitName: 'Вітаємо, {name},',
    checkinAnredeOhneName: 'Вітаємо,',
    checkinBetreff: 'Онлайн-check-in для Вашого перебування — {haus}',
    checkinEinladung: '{anreise} ми чекаємо Вас у {haus}. Щоб прибуття пройшло швидше, Ви можете вже зараз заповнити реєстраційний бланк (Meldeschein):',
    checkinFrist: 'Посилання дійсне до {bis} і лише для Вашого бронювання {ref}.',
    checkinFreiwillig: 'Звісно, Ви можете заповнити реєстраційний бланк і на місці в день заїзду.',
    checkinWeitergabe: 'Будь ласка, не передавайте це посилання іншим: хто його має, може вносити дані про Ваше перебування.',
    checkinTest: 'ТЕСТОВИЙ ЛИСТ — так виглядає запрошення на онлайн-check-in для Ваших гостей. Ім’я, бронювання та дати — приклади; посилання не веде до справжнього реєстраційного бланка.'
  },

  zh: {
    anredeMitName: '{name}，您好：',
    anredeOhneName: '尊敬的宾客，您好：',
    rechnungBetreff: '发票 {nummer} — {haus}',
    rechnungAnhang: '随信附上 {haus} 为您开具的发票 {nummer}（PDF），总金额 {betrag}。',
    rechnungOffenMitFrist: '其中尚有 {offen} 未付，请于 {frist} 前支付。',
    rechnungOffenOhneFrist: '其中尚有 {offen} 未付。',
    rechnungBeglichen: '此发票已全额结清。本副本供您存档。',
    rechnungDank: '感谢您的光临——期待再次欢迎您。',
    rechnungUeberweisung: '请将未付金额转账至以下账户：',
    rechnungEmpfaenger: '收款人：{name}',
    rechnungVerwendungszweck: '付款备注：{nummer}',
    erinnerungBetreff: '发票 {nummer} 付款提醒 — {haus}',
    mahnungBetreff: '发票 {nummer} 催款通知 — {haus}',
    mahnungOffen: '我们于 {datum} 开具的发票 {nummer} 仍有 {offen} 未付。',
    mahnungFrist: '请于 {frist} 前汇款。随函再次附上发票。',
    mahnungUeberschneidung: '如您的付款与本消息错过，请忽略本消息。',

    buchungBetreff: '预订确认 {ref} — {haus}',
    buchungBestaetigt: '我们已确认您在 {haus} 的预订。',
    buchungNummer: '预订编号：{ref}',
    buchungAnreise: '入住：{datum}，{zeit} 起',
    buchungAbreise: '退房：{datum}，{zeit} 前',
    buchungZimmer: '房间：{zimmer}',
    buchungGesamt: '总金额：{betrag}',
    buchungHinweis: '如有疑问，请提供预订编号。如需更改，您可以直接回复此邮件。',
    zahlungBetreff: '您的住宿付款 {ref} — {haus}',
    zahlungAnzahlungMitFrist: '关于您 {anreise} 至 {abreise} 的住宿，敬请于 {frist} 前支付预付款 {betrag}。',
    zahlungAnzahlungOhneFrist: '关于您 {anreise} 至 {abreise} 的住宿，敬请支付预付款 {betrag}。',
    zahlungAllgemein: '关于您 {anreise} 至 {abreise} 的住宿，敬请支付 {betrag}。',
    zahlungLink: '您可以通过以下链接，在酒店的支付服务商处安全付款：',
    zahlungKarte: '您只需在那里输入银行卡信息；酒店不会获得这些信息。',
    zahlungGueltig: '此链接有效期至 {gueltig}（含当日）。如已过期，我们很乐意为您发送新链接。',
    zahlungHinweis: '如有任何疑问，请直接回复此邮件并注明预订编号 {ref}。',
    checkinAnredeMitName: '{name}，您好：',
    checkinAnredeOhneName: '您好：',
    checkinBetreff: '您的住宿在线入住 — {haus}',
    checkinEinladung: '我们期待于 {anreise} 在 {haus} 迎接您。为使您到店时更加快捷，您现在即可填写入住登记表（Meldeschein）：',
    checkinFrist: '此链接有效期至 {bis}，且仅适用于您的预订 {ref}。',
    checkinFreiwillig: '当然，您也可以在到店当天于现场填写入住登记表。',
    checkinWeitergabe: '请勿转发此链接：任何持有此链接的人都可以填写有关您住宿的信息。',
    checkinTest: '测试邮件——这是您的宾客看到的在线入住邀请。姓名、预订和日期均为示例；此链接不会指向真实的入住登记表。'
  },

  ko: {
    anredeMitName: '{name} 님께,',
    anredeOhneName: '안녕하세요,',
    rechnungBetreff: '청구서 {nummer} — {haus}',
    rechnungAnhang: '{haus}의 청구서 {nummer}을(를) PDF 파일로 첨부해 드립니다. 총액은 {betrag}입니다.',
    rechnungOffenMitFrist: '이 중 미결제 금액은 {offen}이며, {frist}까지 납부해 주시기 바랍니다.',
    rechnungOffenOhneFrist: '이 중 미결제 금액은 {offen}입니다.',
    rechnungBeglichen: '청구서가 전액 결제되었습니다. 이 사본은 보관용입니다.',
    rechnungDank: '숙박해 주셔서 진심으로 감사드립니다. 다시 모실 수 있기를 바랍니다.',
    rechnungUeberweisung: '미결제 금액을 다음 계좌로 송금해 주십시오:',
    rechnungEmpfaenger: '수취인: {name}',
    rechnungVerwendungszweck: '송금 메모: {nummer}',
    erinnerungBetreff: '청구서 {nummer} 결제 안내 — {haus}',
    mahnungBetreff: '청구서 {nummer} 독촉 — {haus}',
    mahnungOffen: '{datum}자 청구서 {nummer}에 아직 {offen}이 미결제 상태입니다.',
    mahnungFrist: '{frist}까지 송금해 주시기 바랍니다. 청구서를 다시 첨부합니다.',
    mahnungUeberschneidung: '이미 결제하셨다면 이 메시지는 무시해 주십시오.',

    buchungBetreff: '예약 확인 {ref} — {haus}',
    buchungBestaetigt: '{haus} 예약이 확정되었음을 알려 드립니다.',
    buchungNummer: '예약 번호: {ref}',
    buchungAnreise: '체크인: {datum} {zeit}부터',
    buchungAbreise: '체크아웃: {datum} {zeit}까지',
    buchungZimmer: '객실: {zimmer}',
    buchungGesamt: '총액: {betrag}',
    buchungHinweis: '문의하실 때는 예약 번호를 알려 주세요. 변경 사항이 있으시면 이 이메일에 회신해 주시면 됩니다.',
    zahlungBetreff: '숙박 {ref} 결제 안내 — {haus}',
    zahlungAnzahlungMitFrist: '{anreise}부터 {abreise}까지의 숙박에 대해 {frist}까지 선금 {betrag}을(를) 결제해 주시기 바랍니다.',
    zahlungAnzahlungOhneFrist: '{anreise}부터 {abreise}까지의 숙박에 대해 선금 {betrag}을(를) 결제해 주시기 바랍니다.',
    zahlungAllgemein: '{anreise}부터 {abreise}까지의 숙박에 대해 {betrag}을(를) 결제해 주시기 바랍니다.',
    zahlungLink: '아래 링크를 통해 호텔의 결제 대행사에서 안전하게 결제하실 수 있습니다:',
    zahlungKarte: '카드 정보는 그곳에서만 입력하시며, 호텔은 카드 정보를 받지 않습니다.',
    zahlungGueltig: '이 링크는 {gueltig}까지(당일 포함) 유효합니다. 만료된 경우 새 링크를 보내 드리겠습니다.',
    zahlungHinweis: '궁금하신 점이 있으시면 예약 번호 {ref}와 함께 이 이메일에 회신해 주세요.',
    checkinAnredeMitName: '안녕하세요, {name} 님,',
    checkinAnredeOhneName: '안녕하세요,',
    checkinBetreff: '숙박 온라인 체크인 안내 — {haus}',
    checkinEinladung: '{anreise}에 {haus}에서 고객님을 맞이하기를 기다리고 있습니다. 도착 시 더 빠르게 진행되도록 지금 숙박 신고서(Meldeschein)를 미리 작성하실 수 있습니다:',
    checkinFrist: '이 링크는 {bis}까지 유효하며 예약 {ref}에만 사용하실 수 있습니다.',
    checkinFreiwillig: '물론 도착 당일 현장에서 숙박 신고서를 작성하셔도 됩니다.',
    checkinWeitergabe: '이 링크를 다른 사람에게 전달하지 마세요. 링크를 가진 사람은 누구나 고객님의 숙박 정보를 입력할 수 있습니다.',
    checkinTest: '테스트 메일 — 고객에게 보내는 온라인 체크인 안내는 이렇게 보입니다. 이름, 예약, 날짜는 예시이며 링크는 실제 숙박 신고서로 연결되지 않습니다.'
  },

  ar: {
    anredeMitName: 'السيد/السيدة {name}،',
    anredeOhneName: 'ضيفنا العزيز،',
    rechnungBetreff: 'الفاتورة {nummer} — {haus}',
    rechnungAnhang: 'نرفق لكم فاتورتكم {nummer} من {haus} بصيغة PDF، بإجمالي {betrag}.',
    rechnungOffenMitFrist: 'المبلغ المتبقي منها {offen}، ويستحق الدفع حتى {frist}.',
    rechnungOffenOhneFrist: 'المبلغ المتبقي منها {offen}.',
    rechnungBeglichen: 'سُدّدت الفاتورة بالكامل. هذه النسخة لسجلاتكم.',
    rechnungDank: 'شكرًا جزيلًا على إقامتكم — يسعدنا أن نرحّب بكم مجددًا.',
    rechnungUeberweisung: 'يرجى تحويل المبلغ المستحق إلى الحساب التالي:',
    rechnungEmpfaenger: 'المستفيد: {name}',
    rechnungVerwendungszweck: 'مرجع التحويل: {nummer}',
    erinnerungBetreff: 'تذكير بالدفع للفاتورة {nummer} — {haus}',
    mahnungBetreff: 'إنذار بشأن الفاتورة {nummer} — {haus}',
    mahnungOffen: 'لا يزال مبلغ {offen} مستحقاً من فاتورتنا رقم {nummer} بتاريخ {datum}.',
    mahnungFrist: 'يرجى تحويله حتى {frist}. نرفق الفاتورة مرة أخرى.',
    mahnungUeberschneidung: 'إذا تزامن دفعك مع هذه الرسالة، فيرجى تجاهلها.',

    buchungBetreff: 'تأكيد الحجز {ref} — {haus}',
    buchungBestaetigt: 'يسعدنا تأكيد حجزكم في {haus}.',
    buchungNummer: 'رقم الحجز: {ref}',
    buchungAnreise: 'الوصول: {datum} من الساعة {zeit}',
    buchungAbreise: 'المغادرة: {datum} حتى الساعة {zeit}',
    buchungZimmer: 'الغرفة: {zimmer}',
    buchungGesamt: 'المبلغ الإجمالي: {betrag}',
    buchungHinweis: 'يرجى ذكر رقم الحجز عند أي استفسار. يمكنكم الرد على هذه الرسالة إذا رغبتم في تغيير أي شيء.',
    zahlungBetreff: 'الدفع لإقامتكم {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'نرجو منكم، لإقامتكم من {anreise} إلى {abreise}، دفع دفعة مقدمة قدرها {betrag} حتى {frist}.',
    zahlungAnzahlungOhneFrist: 'نرجو منكم، لإقامتكم من {anreise} إلى {abreise}، دفع دفعة مقدمة قدرها {betrag}.',
    zahlungAllgemein: 'نرجو منكم، لإقامتكم من {anreise} إلى {abreise}، دفع مبلغ {betrag}.',
    zahlungLink: 'عبر الرابط التالي يمكنكم الدفع بأمان لدى مزوّد خدمة الدفع الخاص بالمنشأة:',
    zahlungKarte: 'تُدخلون بيانات بطاقتكم هناك فقط؛ ولا تحصل عليها المنشأة.',
    zahlungGueltig: 'الرابط صالح حتى {gueltig} شاملًا. وإذا انتهت صلاحيته، يسعدنا أن نرسل لكم رابطًا جديدًا.',
    zahlungHinweis: 'إذا كانت لديكم أي أسئلة، فما عليكم إلا الرد على هذه الرسالة مع ذكر رقم الحجز {ref}.',
    checkinAnredeMitName: 'مرحبًا {name}،',
    checkinAnredeOhneName: 'مرحبًا،',
    checkinBetreff: 'تسجيل الوصول عبر الإنترنت لإقامتكم — {haus}',
    checkinEinladung: 'نتطلع إلى استقبالكم في {haus} يوم {anreise}. ولتسريع إجراءات وصولكم، يمكنكم ملء استمارة التسجيل (Meldeschein) من الآن:',
    checkinFrist: 'الرابط صالح حتى {bis} ولحجزكم {ref} فقط.',
    checkinFreiwillig: 'ويمكنكم بالطبع أيضًا ملء استمارة التسجيل في المكان يوم الوصول.',
    checkinWeitergabe: 'يرجى عدم مشاركة الرابط: فمن يملكه يستطيع إدخال بيانات عن إقامتكم.',
    checkinTest: 'رسالة تجريبية — هكذا تبدو دعوة تسجيل الوصول عبر الإنترنت لنزلائكم. الاسم والحجز والتواريخ أمثلة؛ والرابط لا يقود إلى استمارة تسجيل حقيقية.'
  },

  pt: {
    anredeMitName: 'Caro(a) {name},',
    anredeOhneName: 'Caro(a) hóspede,',
    rechnungBetreff: 'Fatura {nummer} — {haus}',
    rechnungAnhang: 'em anexo encontra a sua fatura {nummer} de {haus} em PDF, no valor total de {betrag}.',
    rechnungOffenMitFrist: 'Encontra-se em aberto o montante de {offen}, a pagar até {frist}.',
    rechnungOffenOhneFrist: 'Encontra-se em aberto o montante de {offen}.',
    rechnungBeglichen: 'A fatura está integralmente paga. Este exemplar destina-se aos seus registos.',
    rechnungDank: 'Muito obrigado pela sua estadia — teremos todo o gosto em recebê-lo(a) novamente.',
    rechnungUeberweisung: 'Por favor, transfira o montante em falta para a seguinte conta:',
    rechnungEmpfaenger: 'Beneficiário: {name}',
    rechnungVerwendungszweck: 'Referência: {nummer}',
    erinnerungBetreff: 'Lembrete de pagamento da fatura {nummer} — {haus}',
    mahnungBetreff: 'Interpelação relativa à fatura {nummer} — {haus}',
    mahnungOffen: 'da nossa fatura {nummer} de {datum} continua em aberto o montante de {offen}.',
    mahnungFrist: 'Solicitamos a transferência até {frist}. Voltamos a anexar a fatura.',
    mahnungUeberschneidung: 'Caso o seu pagamento se tenha cruzado com esta mensagem, queira ignorá-la.',

    buchungBetreff: 'Confirmação de reserva {ref} — {haus}',
    buchungBestaetigt: 'confirmámos a sua reserva em {haus}.',
    buchungNummer: 'Número da reserva: {ref}',
    buchungAnreise: 'Chegada: {datum} a partir das {zeit}',
    buchungAbreise: 'Partida: {datum} até às {zeit}',
    buchungZimmer: 'Quarto: {zimmer}',
    buchungGesamt: 'Montante total: {betrag}',
    buchungHinweis: 'Por favor, indique o número da reserva em caso de dúvidas. Pode responder a este e-mail se pretender alterar algo.',
    zahlungBetreff: 'Pagamento da sua estadia {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'para a sua estadia de {anreise} a {abreise}, solicitamos um adiantamento de {betrag} até {frist}.',
    zahlungAnzahlungOhneFrist: 'para a sua estadia de {anreise} a {abreise}, solicitamos um adiantamento de {betrag}.',
    zahlungAllgemein: 'para a sua estadia de {anreise} a {abreise}, solicitamos um pagamento de {betrag}.',
    zahlungLink: 'Através do seguinte link pode pagar em segurança junto do prestador de serviços de pagamento do hotel:',
    zahlungKarte: 'Os dados do seu cartão são introduzidos apenas aí; o hotel nunca os recebe.',
    zahlungGueltig: 'O link é válido até {gueltig}, inclusive. Se tiver expirado, teremos todo o gosto em enviar-lhe um novo.',
    zahlungHinweis: 'Em caso de dúvidas, responda simplesmente a este e-mail e indique o número da reserva {ref}.',
    checkinAnredeMitName: 'Olá, {name},',
    checkinAnredeOhneName: 'Olá,',
    checkinBetreff: 'Check-in online para a sua estadia — {haus}',
    checkinEinladung: 'a {anreise} esperamos por si no nosso {haus}. Para que a chegada seja mais rápida, pode preencher já o Meldeschein (boletim de alojamento):',
    checkinFrist: 'O link é válido até {bis} e apenas para a sua reserva {ref}.',
    checkinFreiwillig: 'Naturalmente, também pode preencher o boletim de alojamento no local, no dia de chegada.',
    checkinWeitergabe: 'Por favor, não partilhe o link: quem o tiver pode introduzir dados sobre a sua estadia.',
    checkinTest: 'E-MAIL DE TESTE — é assim que os seus hóspedes veem o convite para o check-in online. Nome, reserva e datas são exemplos; o link não leva a nenhum boletim de alojamento real.'
  },

  fi: {
    anredeMitName: 'Hyvä {name},',
    anredeOhneName: 'Hyvä asiakkaamme,',
    rechnungBetreff: 'Lasku {nummer} — {haus}',
    rechnungAnhang: 'Liitteenä on laskunne {nummer} majoituspaikasta {haus} PDF-muodossa, yhteensä {betrag}.',
    rechnungOffenMitFrist: 'Siitä on avoinna {offen}, maksettava viimeistään {frist}.',
    rechnungOffenOhneFrist: 'Siitä on avoinna {offen}.',
    rechnungBeglichen: 'Lasku on maksettu kokonaan. Tämä kappale on arkistoanne varten.',
    rechnungDank: 'Kiitos oleskelustanne — toivotamme teidät mielellämme uudelleen tervetulleeksi.',
    rechnungUeberweisung: 'Pyydämme maksamaan avoimen summan seuraavalle tilille:',
    rechnungEmpfaenger: 'Saaja: {name}',
    rechnungVerwendungszweck: 'Viite: {nummer}',
    erinnerungBetreff: 'Maksumuistutus laskusta {nummer} — {haus}',
    mahnungBetreff: 'Maksukehotus laskusta {nummer} — {haus}',
    mahnungOffen: 'laskustamme {nummer} ({datum}) on yhä maksamatta {offen}.',
    mahnungFrist: 'Pyydämme maksamaan summan viimeistään {frist}. Lasku on liitteenä uudelleen.',
    mahnungUeberschneidung: 'Jos maksunne on mennyt ristiin tämän viestin kanssa, voitte jättää sen huomiotta.',

    buchungBetreff: 'Varausvahvistus {ref} — {haus}',
    buchungBestaetigt: 'olemme vahvistaneet varauksenne majoituspaikkaan {haus}.',
    buchungNummer: 'Varausnumero: {ref}',
    buchungAnreise: 'Saapuminen: {datum} klo {zeit} alkaen',
    buchungAbreise: 'Lähtö: {datum} viimeistään klo {zeit}',
    buchungZimmer: 'Huone: {zimmer}',
    buchungGesamt: 'Kokonaissumma: {betrag}',
    buchungHinweis: 'Mainitsettehan varausnumeron yhteydenotoissanne. Voitte vastata tähän sähköpostiin, jos jotain on muutettava.',
    zahlungBetreff: 'Maksu oleskelustanne {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'pyydämme oleskelustanne {anreise}–{abreise} ennakkomaksua {betrag} viimeistään {frist}.',
    zahlungAnzahlungOhneFrist: 'pyydämme oleskelustanne {anreise}–{abreise} ennakkomaksua {betrag}.',
    zahlungAllgemein: 'pyydämme oleskelustanne {anreise}–{abreise} maksua {betrag}.',
    zahlungLink: 'Seuraavan linkin kautta maksatte turvallisesti majoituspaikan maksupalveluntarjoajalle:',
    zahlungKarte: 'Syötätte korttitietonne vain siellä; majoituspaikka ei saa niitä.',
    zahlungGueltig: 'Linkki on voimassa {gueltig} asti (mukaan lukien). Jos se on vanhentunut, lähetämme mielellämme uuden.',
    zahlungHinweis: 'Jos teillä on kysyttävää, vastatkaa tähän sähköpostiin ja mainitkaa varausnumero {ref}.',
    checkinAnredeMitName: 'Hei {name},',
    checkinAnredeOhneName: 'Hei,',
    checkinBetreff: 'Verkkosisäänkirjautuminen oleskeluanne varten — {haus}',
    checkinEinladung: 'odotamme teitä majoituspaikkaamme {haus} {anreise}. Saapumisen nopeuttamiseksi voitte täyttää majoittujailmoituksen (Meldeschein) jo nyt:',
    checkinFrist: 'Linkki on voimassa {bis} asti ja vain varauksellenne {ref}.',
    checkinFreiwillig: 'Voitte toki täyttää majoittujailmoituksen myös paikan päällä saapumispäivänä.',
    checkinWeitergabe: 'Älkää välittäkö linkkiä eteenpäin: sen haltija voi antaa tietoja oleskelustanne.',
    checkinTest: 'TESTIVIESTI — tältä verkkosisäänkirjautumisen kutsu näyttää asiakkaillenne. Nimi, varaus ja päivämäärät ovat esimerkkejä; linkki ei johda oikeaan majoittujailmoitukseen.'
  },

  is: {
    anredeMitName: 'Góðan dag {name},',
    anredeOhneName: 'Góðan dag,',
    rechnungBetreff: 'Reikningur {nummer} — {haus}',
    rechnungAnhang: 'meðfylgjandi er reikningur þinn {nummer} frá {haus} sem PDF, samtals {betrag}.',
    rechnungOffenMitFrist: 'Ógreitt er {offen}, greiðist í síðasta lagi {frist}.',
    rechnungOffenOhneFrist: 'Ógreitt er {offen}.',
    rechnungBeglichen: 'Reikningurinn er að fullu greiddur. Þetta eintak er fyrir þín gögn.',
    rechnungDank: 'Kærar þakkir fyrir dvölina — við myndum gleðjast yfir að taka á móti þér aftur.',
    rechnungUeberweisung: 'Vinsamlegast millifærið eftirstöðvarnar á eftirfarandi reikning:',
    rechnungEmpfaenger: 'Viðtakandi: {name}',
    rechnungVerwendungszweck: 'Skýring: {nummer}',
    erinnerungBetreff: 'Greiðsluáminning vegna reiknings {nummer} — {haus}',
    mahnungBetreff: 'Innheimtubréf vegna reiknings {nummer} — {haus}',
    mahnungOffen: 'af reikningi okkar {nummer} dags. {datum} eru enn {offen} ógreiddar.',
    mahnungFrist: 'Vinsamlegast millifærið upphæðina fyrir {frist}. Reikningurinn fylgir aftur.',
    mahnungUeberschneidung: 'Ef greiðsla þín hefur farið á mis við þessi skilaboð, vinsamlegast hunsaðu þau.',

    buchungBetreff: 'Bókunarstaðfesting {ref} — {haus}',
    buchungBestaetigt: 'við höfum staðfest bókun þína hjá {haus}.',
    buchungNummer: 'Bókunarnúmer: {ref}',
    buchungAnreise: 'Koma: {datum} frá kl. {zeit}',
    buchungAbreise: 'Brottför: {datum} fyrir kl. {zeit}',
    buchungZimmer: 'Herbergi: {zimmer}',
    buchungGesamt: 'Heildarupphæð: {betrag}',
    buchungHinweis: 'Vinsamlegast tilgreindu bókunarnúmerið í öllum fyrirspurnum. Þú getur svarað þessum tölvupósti ef eitthvað á að breytast.',
    zahlungBetreff: 'Greiðsla fyrir dvöl þína {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'fyrir dvöl þína frá {anreise} til {abreise} biðjum við vinsamlegast um innborgun að upphæð {betrag} fyrir {frist}.',
    zahlungAnzahlungOhneFrist: 'fyrir dvöl þína frá {anreise} til {abreise} biðjum við vinsamlegast um innborgun að upphæð {betrag}.',
    zahlungAllgemein: 'fyrir dvöl þína frá {anreise} til {abreise} biðjum við vinsamlegast um greiðslu að upphæð {betrag}.',
    zahlungLink: 'Með eftirfarandi tengli greiðir þú á öruggan hátt hjá greiðsluþjónustu hótelsins:',
    zahlungKarte: 'Kortaupplýsingarnar slærðu aðeins inn þar; hótelið fær þær aldrei.',
    zahlungGueltig: 'Tengillinn gildir til og með {gueltig}. Ef hann er útrunninn sendum við þér gjarnan nýjan.',
    zahlungHinweis: 'Ef þú hefur spurningar skaltu einfaldlega svara þessum tölvupósti og tilgreina bókunarnúmerið {ref}.',
    checkinAnredeMitName: 'Halló {name},',
    checkinAnredeOhneName: 'Halló,',
    checkinBetreff: 'Netinnritun fyrir dvöl þína — {haus}',
    checkinEinladung: 'við hlökkum til að taka á móti þér hjá {haus} {anreise}. Til að flýta fyrir við komuna geturðu fyllt út skráningareyðublaðið (Meldeschein) strax núna:',
    checkinFrist: 'Tengillinn gildir til {bis} og aðeins fyrir bókun þína {ref}.',
    checkinFreiwillig: 'Þú getur að sjálfsögðu líka fyllt út skráningareyðublaðið á staðnum á komudegi.',
    checkinWeitergabe: 'Vinsamlegast láttu tengilinn ekki ganga áfram: hver sem hefur hann getur slegið inn upplýsingar um dvöl þína.',
    checkinTest: 'PRÓFUNARPÓSTUR — svona lítur boð um netinnritun út fyrir gestina ykkar. Nafn, bókun og dagsetningar eru dæmi; tengillinn leiðir ekki á raunverulegt skráningareyðublað.'
  },

  sk: {
    anredeMitName: 'Dobrý deň, {name},',
    anredeOhneName: 'Dobrý deň,',
    rechnungBetreff: 'Faktúra {nummer} — {haus}',
    rechnungAnhang: 'v prílohe Vám posielame Vašu faktúru {nummer} od {haus} vo formáte PDF na celkovú sumu {betrag}.',
    rechnungOffenMitFrist: 'Z toho zostáva neuhradených {offen}, splatných do {frist}.',
    rechnungOffenOhneFrist: 'Z toho zostáva neuhradených {offen}.',
    rechnungBeglichen: 'Faktúra je úplne uhradená. Tento exemplár je pre Vaše záznamy.',
    rechnungDank: 'Ďakujeme za Váš pobyt — radi Vás opäť privítame.',
    rechnungUeberweisung: 'Prosíme o prevod zostávajúcej sumy na nasledujúci účet:',
    rechnungEmpfaenger: 'Príjemca: {name}',
    rechnungVerwendungszweck: 'Účel platby: {nummer}',
    erinnerungBetreff: 'Pripomienka platby faktúry {nummer} — {haus}',
    mahnungBetreff: 'Upomienka k faktúre {nummer} — {haus}',
    mahnungOffen: 'z našej faktúry {nummer} zo dňa {datum} zostáva neuhradených {offen}.',
    mahnungFrist: 'Prosíme o úhradu do {frist}. Faktúru prikladáme znova.',
    mahnungUeberschneidung: 'Ak sa Vaša platba s touto správou minula, považujte ju, prosím, za bezpredmetnú.',

    buchungBetreff: 'Potvrdenie rezervácie {ref} — {haus}',
    buchungBestaetigt: 'potvrdili sme Vašu rezerváciu v {haus}.',
    buchungNummer: 'Číslo rezervácie: {ref}',
    buchungAnreise: 'Príchod: {datum} od {zeit}',
    buchungAbreise: 'Odchod: {datum} do {zeit}',
    buchungZimmer: 'Izba: {zimmer}',
    buchungGesamt: 'Celková suma: {betrag}',
    buchungHinweis: 'Pri otázkach, prosím, uveďte číslo rezervácie. Ak by sa malo niečo zmeniť, môžete odpovedať na tento e-mail.',
    zahlungBetreff: 'Platba za Váš pobyt {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o zálohu vo výške {betrag} do {frist}.',
    zahlungAnzahlungOhneFrist: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o zálohu vo výške {betrag}.',
    zahlungAllgemein: 'za Váš pobyt od {anreise} do {abreise} Vás prosíme o platbu vo výške {betrag}.',
    zahlungLink: 'Prostredníctvom nasledujúceho odkazu zaplatíte bezpečne u poskytovateľa platobných služieb hotela:',
    zahlungKarte: 'Údaje o svojej karte zadávate len tam; hotel ich nedostane.',
    zahlungGueltig: 'Odkaz platí do {gueltig} vrátane. Ak vyprší, radi Vám pošleme nový.',
    zahlungHinweis: 'Ak máte otázky, jednoducho odpovedzte na tento e-mail a uveďte číslo rezervácie {ref}.',
    checkinAnredeMitName: 'Dobrý deň, {name},',
    checkinAnredeOhneName: 'Dobrý deň,',
    checkinBetreff: 'Online check-in pre Váš pobyt — {haus}',
    checkinEinladung: 'dňa {anreise} Vás očakávame v našom hoteli {haus}. Aby bol Váš príchod rýchlejší, môžete registračný formulár (Meldeschein) vyplniť už teraz:',
    checkinFrist: 'Odkaz platí do {bis} a len pre Vašu rezerváciu {ref}.',
    checkinFreiwillig: 'Registračný formulár môžete samozrejme vyplniť aj na mieste v deň príchodu.',
    checkinWeitergabe: 'Odkaz, prosím, nikomu neposielajte: kto ho má, môže zadávať údaje o Vašom pobyte.',
    checkinTest: 'TESTOVACÍ E-MAIL — takto vyzerá pozvánka na online check-in pre Vašich hostí. Meno, rezervácia a dátumy sú príklady; odkaz nevedie k skutočnému registračnému formuláru.'
  },

  sl: {
    anredeMitName: 'Dober dan, {name},',
    anredeOhneName: 'Dober dan,',
    rechnungBetreff: 'Račun {nummer} — {haus}',
    rechnungAnhang: 'v prilogi vam pošiljamo račun {nummer} hotela {haus} v obliki PDF, v skupnem znesku {betrag}.',
    rechnungOffenMitFrist: 'Od tega je odprtih še {offen}, plačljivo do {frist}.',
    rechnungOffenOhneFrist: 'Od tega je odprtih še {offen}.',
    rechnungBeglichen: 'Račun je v celoti poravnan. Ta izvod je za vašo evidenco.',
    rechnungDank: 'Najlepša hvala za vaše bivanje — veseli bomo, če vas bomo lahko spet pozdravili.',
    rechnungUeberweisung: 'Prosimo, nakažite odprti znesek na naslednji račun:',
    rechnungEmpfaenger: 'Prejemnik: {name}',
    rechnungVerwendungszweck: 'Namen plačila: {nummer}',
    erinnerungBetreff: 'Opomnik za plačilo računa {nummer} — {haus}',
    mahnungBetreff: 'Opomin za račun {nummer} — {haus}',
    mahnungOffen: 'pri našem računu {nummer} z dne {datum} je še neplačanih {offen}.',
    mahnungFrist: 'Prosimo, nakažite znesek do {frist}. Račun ponovno prilagamo.',
    mahnungUeberschneidung: 'Če se je vaše plačilo križalo s tem sporočilom, ga prosimo prezrite.',

    buchungBetreff: 'Potrditev rezervacije {ref} — {haus}',
    buchungBestaetigt: 'potrdili smo vašo rezervacijo v hotelu {haus}.',
    buchungNummer: 'Številka rezervacije: {ref}',
    buchungAnreise: 'Prihod: {datum} od {zeit}',
    buchungAbreise: 'Odhod: {datum} do {zeit}',
    buchungZimmer: 'Soba: {zimmer}',
    buchungGesamt: 'Skupni znesek: {betrag}',
    buchungHinweis: 'Pri vprašanjih navedite številko rezervacije. Če želite kaj spremeniti, lahko odgovorite na to e-pošto.',
    zahlungBetreff: 'Plačilo za vaše bivanje {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'za vaše bivanje od {anreise} do {abreise} vas prosimo za predplačilo v višini {betrag} do {frist}.',
    zahlungAnzahlungOhneFrist: 'za vaše bivanje od {anreise} do {abreise} vas prosimo za predplačilo v višini {betrag}.',
    zahlungAllgemein: 'za vaše bivanje od {anreise} do {abreise} vas prosimo za plačilo v višini {betrag}.',
    zahlungLink: 'Prek naslednje povezave varno plačate pri ponudniku plačilnih storitev hotela:',
    zahlungKarte: 'Podatke kartice vnesete le tam; hotel jih ne prejme.',
    zahlungGueltig: 'Povezava velja do vključno {gueltig}. Če je potekla, vam bomo z veseljem poslali novo.',
    zahlungHinweis: 'Če imate vprašanja, preprosto odgovorite na to e-pošto in navedite številko rezervacije {ref}.',
    checkinAnredeMitName: 'Pozdravljeni, {name},',
    checkinAnredeOhneName: 'Pozdravljeni,',
    checkinBetreff: 'Spletni check-in za vaše bivanje — {haus}',
    checkinEinladung: 'dne {anreise} vas pričakujemo v našem hotelu {haus}. Da bo prihod hitrejši, lahko prijavnico (Meldeschein) izpolnite že zdaj:',
    checkinFrist: 'Povezava velja do {bis} in samo za vašo rezervacijo {ref}.',
    checkinFreiwillig: 'Prijavnico lahko seveda izpolnite tudi na dan prihoda na kraju samem.',
    checkinWeitergabe: 'Prosimo, povezave ne posredujte naprej: kdor jo ima, lahko vnaša podatke o vašem bivanju.',
    checkinTest: 'TESTNO SPOROČILO — tako vabilo na spletni check-in vidijo vaši gostje. Ime, rezervacija in datumi so primeri; povezava ne vodi do prave prijavnice.'
  },

  hu: {
    anredeMitName: 'Kedves {name}!',
    anredeOhneName: 'Kedves Vendégünk!',
    rechnungBetreff: 'Számla {nummer} — {haus}',
    rechnungAnhang: 'Mellékelten küldjük a(z) {haus} {nummer} számú számláját PDF formátumban, összesen {betrag} értékben.',
    rechnungOffenMitFrist: 'Ebből {offen} még nyitott, fizetendő {frist}-ig.',
    rechnungOffenOhneFrist: 'Ebből {offen} még nyitott.',
    rechnungBeglichen: 'A számla teljes egészében ki van egyenlítve. Ez a példány az Ön nyilvántartására szolgál.',
    rechnungDank: 'Köszönjük, hogy nálunk szállt meg — örömmel látjuk újra vendégül.',
    rechnungUeberweisung: 'Kérjük, a fennmaradó összeget utalja át a következő számlára:',
    rechnungEmpfaenger: 'Kedvezményezett: {name}',
    rechnungVerwendungszweck: 'Közlemény: {nummer}',
    erinnerungBetreff: 'Fizetési emlékeztető a(z) {nummer} számú számláról — {haus}',
    mahnungBetreff: 'Fizetési felszólítás a(z) {nummer} számú számláról — {haus}',
    mahnungOffen: '{datum} keltű, {nummer} számú számlánkból még {offen} nyitott.',
    mahnungFrist: 'Kérjük, utalja át {frist} napjáig. A számlát ismét mellékeljük.',
    mahnungUeberschneidung: 'Ha fizetése keresztezte ezt az üzenetet, kérjük, tekintse tárgytalannak.',

    buchungBetreff: 'Foglalás visszaigazolása {ref} — {haus}',
    buchungBestaetigt: 'Visszaigazoltuk foglalását a(z) {haus} szállodában.',
    buchungNummer: 'Foglalási szám: {ref}',
    buchungAnreise: 'Érkezés: {datum}, {zeit} órától',
    buchungAbreise: 'Távozás: {datum}, {zeit} óráig',
    buchungZimmer: 'Szoba: {zimmer}',
    buchungGesamt: 'Teljes összeg: {betrag}',
    buchungHinweis: 'Kérdés esetén kérjük, adja meg a foglalási számot. Ha valamit módosítani szeretne, válaszolhat erre az e-mailre.',
    zahlungBetreff: 'Fizetés a(z) {ref} tartózkodásáért — {haus}',
    zahlungAnzahlungMitFrist: '{anreise} és {abreise} közötti tartózkodásához kérjük, fizessen {betrag} előleget {frist}-ig.',
    zahlungAnzahlungOhneFrist: '{anreise} és {abreise} közötti tartózkodásához kérjük, fizessen {betrag} előleget.',
    zahlungAllgemein: '{anreise} és {abreise} közötti tartózkodásához kérjük, fizessen {betrag} összeget.',
    zahlungLink: 'Az alábbi linken biztonságosan fizethet a szálloda fizetési szolgáltatójánál:',
    zahlungKarte: 'Kártyaadatait csak ott adja meg; a szálloda nem kapja meg őket.',
    zahlungGueltig: 'A link {gueltig} napjával bezárólag érvényes. Ha lejárt, szívesen küldünk újat.',
    zahlungHinweis: 'Kérdés esetén egyszerűen válaszoljon erre az e-mailre, és adja meg a(z) {ref} foglalási számot.',
    checkinAnredeMitName: 'Kedves {name}!',
    checkinAnredeOhneName: 'Üdvözöljük!',
    checkinBetreff: 'Online check-in a tartózkodásához — {haus}',
    checkinEinladung: '{anreise} napján várjuk Önt a(z) {haus} szállodában. Hogy az érkezés gyorsabb legyen, a bejelentőlapot (Meldeschein) már most kitöltheti:',
    checkinFrist: 'A link {bis}-ig érvényes, és csak a(z) {ref} foglalására.',
    checkinFreiwillig: 'Természetesen a bejelentőlapot az érkezés napján a helyszínen is kitöltheti.',
    checkinWeitergabe: 'Kérjük, ne adja tovább a linket: akinél megvan, adatokat adhat meg a tartózkodásáról.',
    checkinTest: 'TESZTÜZENET — így látják vendégei az online check-in meghívót. A név, a foglalás és az adatok csak példák; a link nem vezet valódi bejelentőlaphoz.'
  },

  ro: {
    anredeMitName: 'Bună ziua, {name},',
    anredeOhneName: 'Bună ziua,',
    rechnungBetreff: 'Factura {nummer} — {haus}',
    rechnungAnhang: 'vă trimitem atașat factura dumneavoastră {nummer} de la {haus} în format PDF, în valoare totală de {betrag}.',
    rechnungOffenMitFrist: 'Din aceasta rămâne de plată {offen}, scadent până la {frist}.',
    rechnungOffenOhneFrist: 'Din aceasta rămâne de plată {offen}.',
    rechnungBeglichen: 'Factura a fost achitată integral. Acest exemplar este pentru evidența dumneavoastră.',
    rechnungDank: 'Vă mulțumim pentru sejur — ne-ar face plăcere să vă primim din nou.',
    rechnungUeberweisung: 'Vă rugăm să transferați suma restantă în următorul cont:',
    rechnungEmpfaenger: 'Beneficiar: {name}',
    rechnungVerwendungszweck: 'Referință: {nummer}',
    erinnerungBetreff: 'Memento de plată pentru factura {nummer} — {haus}',
    mahnungBetreff: 'Somație pentru factura {nummer} — {haus}',
    mahnungOffen: 'din factura noastră {nummer} din {datum} a rămas neachitată suma de {offen}.',
    mahnungFrist: 'Vă rugăm să o virați până la {frist}. Atașăm din nou factura.',
    mahnungUeberschneidung: 'Dacă plata dumneavoastră s-a încrucișat cu acest mesaj, vă rugăm să îl ignorați.',

    buchungBetreff: 'Confirmarea rezervării {ref} — {haus}',
    buchungBestaetigt: 'am confirmat rezervarea dumneavoastră la {haus}.',
    buchungNummer: 'Număr de rezervare: {ref}',
    buchungAnreise: 'Sosire: {datum} de la ora {zeit}',
    buchungAbreise: 'Plecare: {datum} până la ora {zeit}',
    buchungZimmer: 'Cameră: {zimmer}',
    buchungGesamt: 'Suma totală: {betrag}',
    buchungHinweis: 'Vă rugăm să menționați numărul de rezervare în orice corespondență. Puteți răspunde la acest e-mail dacă doriți să modificați ceva.',
    zahlungBetreff: 'Plată pentru sejurul dumneavoastră {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'pentru sejurul dumneavoastră din {anreise} până în {abreise} vă rugăm să achitați un avans de {betrag} până la {frist}.',
    zahlungAnzahlungOhneFrist: 'pentru sejurul dumneavoastră din {anreise} până în {abreise} vă rugăm să achitați un avans de {betrag}.',
    zahlungAllgemein: 'pentru sejurul dumneavoastră din {anreise} până în {abreise} vă rugăm să efectuați o plată de {betrag}.',
    zahlungLink: 'Prin linkul următor plătiți în siguranță la furnizorul de plăți al hotelului:',
    zahlungKarte: 'Datele cardului le introduceți doar acolo; hotelul nu le primește.',
    zahlungGueltig: 'Linkul este valabil până la {gueltig} inclusiv. Dacă a expirat, vă trimitem cu plăcere unul nou.',
    zahlungHinweis: 'Pentru întrebări, răspundeți pur și simplu la acest e-mail și menționați numărul de rezervare {ref}.',
    checkinAnredeMitName: 'Bună, {name},',
    checkinAnredeOhneName: 'Bună,',
    checkinBetreff: 'Check-in online pentru sejurul dumneavoastră — {haus}',
    checkinEinladung: 'vă așteptăm pe {anreise} la {haus}. Pentru ca sosirea să fie mai rapidă, puteți completa deja acum fișa de înregistrare (Meldeschein):',
    checkinFrist: 'Linkul este valabil până la {bis} și doar pentru rezervarea dumneavoastră {ref}.',
    checkinFreiwillig: 'Desigur, puteți completa fișa de înregistrare și la fața locului, în ziua sosirii.',
    checkinWeitergabe: 'Vă rugăm să nu transmiteți linkul mai departe: cine îl are poate introduce date despre sejurul dumneavoastră.',
    checkinTest: 'E-MAIL DE TEST — așa arată invitația la check-in online pentru oaspeții dumneavoastră. Numele, rezervarea și datele sunt exemple; linkul nu duce la o fișă de înregistrare reală.'
  },

  bg: {
    anredeMitName: 'Здравейте, {name},',
    anredeOhneName: 'Здравейте,',
    rechnungBetreff: 'Фактура {nummer} — {haus}',
    rechnungAnhang: 'Приложено Ви изпращаме фактура {nummer} на {haus} във формат PDF на обща стойност {betrag}.',
    rechnungOffenMitFrist: 'От тях остават за плащане {offen}, платими до {frist}.',
    rechnungOffenOhneFrist: 'От тях остават за плащане {offen}.',
    rechnungBeglichen: 'Фактурата е изцяло платена. Този екземпляр е за Вашия архив.',
    rechnungDank: 'Благодарим Ви за престоя — ще се радваме да Ви посрещнем отново.',
    rechnungUeberweisung: 'Моля, преведете оставащата сума по следната сметка:',
    rechnungEmpfaenger: 'Получател: {name}',
    rechnungVerwendungszweck: 'Основание за плащане: {nummer}',
    erinnerungBetreff: 'Напомняне за плащане по фактура {nummer} — {haus}',
    mahnungBetreff: 'Покана за плащане по фактура {nummer} — {haus}',
    mahnungOffen: 'по нашата фактура {nummer} от {datum} остава неплатена сума от {offen}.',
    mahnungFrist: 'Моля, преведете я до {frist}. Прилагаме фактурата отново.',
    mahnungUeberschneidung: 'Ако плащането ви се е разминало с това съобщение, моля, не го вземайте предвид.',

    buchungBetreff: 'Потвърждение на резервация {ref} — {haus}',
    buchungBestaetigt: 'Потвърдихме Вашата резервация в {haus}.',
    buchungNummer: 'Номер на резервация: {ref}',
    buchungAnreise: 'Пристигане: {datum} от {zeit} ч.',
    buchungAbreise: 'Заминаване: {datum} до {zeit} ч.',
    buchungZimmer: 'Стая: {zimmer}',
    buchungGesamt: 'Обща сума: {betrag}',
    buchungHinweis: 'Моля, посочвайте номера на резервацията при запитвания. Можете да отговорите на този имейл, ако желаете промяна.',
    zahlungBetreff: 'Плащане за Вашия престой {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'За Вашия престой от {anreise} до {abreise} Ви молим за авансово плащане от {betrag} до {frist}.',
    zahlungAnzahlungOhneFrist: 'За Вашия престой от {anreise} до {abreise} Ви молим за авансово плащане от {betrag}.',
    zahlungAllgemein: 'За Вашия престой от {anreise} до {abreise} Ви молим за плащане от {betrag}.',
    zahlungLink: 'Чрез следния линк плащате сигурно при доставчика на платежни услуги на хотела:',
    zahlungKarte: 'Данните от картата си въвеждате само там; хотелът не ги получава.',
    zahlungGueltig: 'Линкът е валиден до {gueltig} включително. Ако е изтекъл, с удоволствие ще Ви изпратим нов.',
    zahlungHinweis: 'При въпроси просто отговорете на този имейл и посочете номера на резервацията {ref}.',
    checkinAnredeMitName: 'Здравейте, {name},',
    checkinAnredeOhneName: 'Здравейте,',
    checkinBetreff: 'Онлайн check-in за Вашия престой — {haus}',
    checkinEinladung: 'На {anreise} Ви очакваме в нашия хотел {haus}. За да мине пристигането по-бързо, можете да попълните регистрационната карта (Meldeschein) още сега:',
    checkinFrist: 'Линкът е валиден до {bis} и само за Вашата резервация {ref}.',
    checkinFreiwillig: 'Разбира се, можете да попълните регистрационната карта и на място в деня на пристигане.',
    checkinWeitergabe: 'Моля, не предавайте линка на други: който го има, може да въвежда данни за Вашия престой.',
    checkinTest: 'ТЕСТОВ ИМЕЙЛ — така изглежда поканата за онлайн check-in за Вашите гости. Име, резервация и дати са примерни; линкът не води до реална регистрационна карта.'
  },

  hr: {
    anredeMitName: 'Dobar dan, {name},',
    anredeOhneName: 'Dobar dan,',
    rechnungBetreff: 'Račun {nummer} — {haus}',
    rechnungAnhang: 'u privitku Vam šaljemo Vaš račun {nummer} objekta {haus} u PDF-u, na ukupan iznos od {betrag}.',
    rechnungOffenMitFrist: 'Od toga je otvoreno {offen}, plativo do {frist}.',
    rechnungOffenOhneFrist: 'Od toga je otvoreno {offen}.',
    rechnungBeglichen: 'Račun je u cijelosti podmiren. Ovaj primjerak je za Vašu evidenciju.',
    rechnungDank: 'Hvala Vam na boravku — bit će nam drago ponovno Vas ugostiti.',
    rechnungUeberweisung: 'Molimo uplatite preostali iznos na sljedeći račun:',
    rechnungEmpfaenger: 'Primatelj: {name}',
    rechnungVerwendungszweck: 'Opis plaćanja: {nummer}',
    erinnerungBetreff: 'Podsjetnik za plaćanje računa {nummer} — {haus}',
    mahnungBetreff: 'Opomena za račun {nummer} — {haus}',
    mahnungOffen: 'po našem računu {nummer} od {datum} još je otvoren iznos od {offen}.',
    mahnungFrist: 'Molimo uplatite ga do {frist}. Račun ponovno prilažemo.',
    mahnungUeberschneidung: 'Ako se vaša uplata mimoišla s ovom porukom, molimo zanemarite je.',

    buchungBetreff: 'Potvrda rezervacije {ref} — {haus}',
    buchungBestaetigt: 'potvrdili smo Vašu rezervaciju u objektu {haus}.',
    buchungNummer: 'Broj rezervacije: {ref}',
    buchungAnreise: 'Dolazak: {datum} od {zeit} sati',
    buchungAbreise: 'Odlazak: {datum} do {zeit} sati',
    buchungZimmer: 'Soba: {zimmer}',
    buchungGesamt: 'Ukupni iznos: {betrag}',
    buchungHinweis: 'Molimo navedite broj rezervacije pri upitima. Možete odgovoriti na ovu e-poruku ako nešto treba promijeniti.',
    zahlungBetreff: 'Plaćanje za Vaš boravak {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za predujam od {betrag} do {frist}.',
    zahlungAnzahlungOhneFrist: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za predujam od {betrag}.',
    zahlungAllgemein: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za uplatu od {betrag}.',
    zahlungLink: 'Putem sljedeće poveznice sigurno plaćate kod pružatelja platnih usluga objekta:',
    zahlungKarte: 'Podatke svoje kartice unosite samo ondje; objekt ih ne dobiva.',
    zahlungGueltig: 'Poveznica vrijedi do uključivo {gueltig}. Ako je istekla, rado ćemo Vam poslati novu.',
    zahlungHinweis: 'Za pitanja jednostavno odgovorite na ovu e-poruku i navedite broj rezervacije {ref}.',
    checkinAnredeMitName: 'Pozdrav, {name},',
    checkinAnredeOhneName: 'Pozdrav,',
    checkinBetreff: 'Online check-in za Vaš boravak — {haus}',
    checkinEinladung: '{anreise} očekujemo Vas u našem objektu {haus}. Kako bi dolazak bio brži, prijavnicu (Meldeschein) možete ispuniti već sada:',
    checkinFrist: 'Poveznica vrijedi do {bis} i samo za Vašu rezervaciju {ref}.',
    checkinFreiwillig: 'Prijavnicu, naravno, možete ispuniti i na licu mjesta na dan dolaska.',
    checkinWeitergabe: 'Molimo ne prosljeđujte poveznicu: tko je ima, može unositi podatke o Vašem boravku.',
    checkinTest: 'TESTNA PORUKA — ovako izgleda poziv na online check-in za Vaše goste. Ime, rezervacija i datumi su primjeri; poveznica ne vodi do stvarne prijavnice.'
  },

  sr: {
    anredeMitName: 'Poštovani/a {name},',
    anredeOhneName: 'Poštovani,',
    rechnungBetreff: 'Račun {nummer} — {haus}',
    rechnungAnhang: 'u prilogu Vam dostavljamo račun {nummer} objekta {haus} u PDF formatu, na ukupan iznos od {betrag}.',
    rechnungOffenMitFrist: 'Od toga je otvoreno {offen}, plativo do {frist}.',
    rechnungOffenOhneFrist: 'Od toga je otvoreno {offen}.',
    rechnungBeglichen: 'Račun je u potpunosti izmiren. Ovaj primerak je za Vašu evidenciju.',
    rechnungDank: 'Hvala Vam na boravku — bilo bi nam drago da Vas ponovo dočekamo.',
    rechnungUeberweisung: 'Molimo uplatite preostali iznos na sledeći račun:',
    rechnungEmpfaenger: 'Primalac: {name}',
    rechnungVerwendungszweck: 'Svrha uplate: {nummer}',
    erinnerungBetreff: 'Podsetnik za plaćanje računa {nummer} — {haus}',
    mahnungBetreff: 'Opomena za račun {nummer} — {haus}',
    mahnungOffen: 'po našem računu {nummer} od {datum} još je otvoren iznos od {offen}.',
    mahnungFrist: 'Molimo uplatite ga do {frist}. Račun ponovo prilažemo.',
    mahnungUeberschneidung: 'Ako se vaša uplata mimoišla sa ovom porukom, molimo zanemarite je.',

    buchungBetreff: 'Potvrda rezervacije {ref} — {haus}',
    buchungBestaetigt: 'potvrdili smo Vašu rezervaciju u objektu {haus}.',
    buchungNummer: 'Broj rezervacije: {ref}',
    buchungAnreise: 'Dolazak: {datum} od {zeit} h',
    buchungAbreise: 'Odlazak: {datum} do {zeit} h',
    buchungZimmer: 'Soba: {zimmer}',
    buchungGesamt: 'Ukupan iznos: {betrag}',
    buchungHinweis: 'Molimo navedite broj rezervacije u slučaju pitanja. Možete odgovoriti na ovu e-poruku ako nešto treba da se promeni.',
    zahlungBetreff: 'Plaćanje za Vaš boravak {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za avans od {betrag} do {frist}.',
    zahlungAnzahlungOhneFrist: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za avans od {betrag}.',
    zahlungAllgemein: 'za Vaš boravak od {anreise} do {abreise} molimo Vas za uplatu od {betrag}.',
    zahlungLink: 'Preko sledećeg linka bezbedno plaćate kod pružaoca platnih usluga objekta:',
    zahlungKarte: 'Podatke o kartici unosite samo tamo; objekat ih ne dobija.',
    zahlungGueltig: 'Link važi do uključno {gueltig}. Ako je istekao, rado ćemo Vam poslati novi.',
    zahlungHinweis: 'Za pitanja jednostavno odgovorite na ovu e-poruku i navedite broj rezervacije {ref}.',
    checkinAnredeMitName: 'Dobar dan, {name},',
    checkinAnredeOhneName: 'Dobar dan,',
    checkinBetreff: 'Online check-in za Vaš boravak — {haus}',
    checkinEinladung: 'dana {anreise} očekujemo Vas u našem objektu {haus}. Da bi dolazak prošao brže, već sada možete popuniti prijavu boravka (Meldeschein):',
    checkinFrist: 'Link važi do {bis} i samo za Vašu rezervaciju {ref}.',
    checkinFreiwillig: 'Naravno, prijavu boravka možete popuniti i na licu mesta na dan dolaska.',
    checkinWeitergabe: 'Molimo ne prosleđujte link: ko ga ima, može da unosi podatke o Vašem boravku.',
    checkinTest: 'TEST PORUKA — ovako izgleda poziv za online check-in za Vaše goste. Ime, rezervacija i podaci su primeri; link ne vodi do prave prijave boravka.'
  },

  mk: {
    anredeMitName: 'Почитувани {name},',
    anredeOhneName: 'Почитувани,',
    rechnungBetreff: 'Фактура {nummer} — {haus}',
    rechnungAnhang: 'во прилог Ви ја доставуваме Вашата фактура {nummer} од {haus} како PDF, во вкупен износ од {betrag}.',
    rechnungOffenMitFrist: 'Од тоа сè уште е отворено {offen}, платливо до {frist}.',
    rechnungOffenOhneFrist: 'Од тоа сè уште е отворено {offen}.',
    rechnungBeglichen: 'Фактурата е целосно платена. Овој примерок е за Вашата евиденција.',
    rechnungDank: 'Ви благодариме за престојот — ќе ни биде задоволство повторно да Ве пречекаме.',
    rechnungUeberweisung: 'Ве молиме уплатете ја преостанатата сума на следнава сметка:',
    rechnungEmpfaenger: 'Примач: {name}',
    rechnungVerwendungszweck: 'Цел на плаќањето: {nummer}',
    erinnerungBetreff: 'Потсетник за плаќање на фактура {nummer} — {haus}',
    mahnungBetreff: 'Опомена за фактура {nummer} — {haus}',
    mahnungOffen: 'по нашата фактура {nummer} од {datum} сè уште е отворен износ од {offen}.',
    mahnungFrist: 'Ве молиме уплатете го до {frist}. Фактурата повторно ја приложуваме.',
    mahnungUeberschneidung: 'Ако вашата уплата се разминала со оваа порака, ве молиме занемарете ја.',

    buchungBetreff: 'Потврда на резервација {ref} — {haus}',
    buchungBestaetigt: 'ја потврдивме Вашата резервација во {haus}.',
    buchungNummer: 'Број на резервација: {ref}',
    buchungAnreise: 'Пристигнување: {datum} од {zeit} ч.',
    buchungAbreise: 'Заминување: {datum} до {zeit} ч.',
    buchungZimmer: 'Соба: {zimmer}',
    buchungGesamt: 'Вкупен износ: {betrag}',
    buchungHinweis: 'Ве молиме наведете го бројот на резервацијата при прашања. Можете да одговорите на оваа е-порака ако треба нешто да се смени.',
    zahlungBetreff: 'Плаќање за Вашиот престој {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'за Вашиот престој од {anreise} до {abreise} Ве молиме за аванс од {betrag} до {frist}.',
    zahlungAnzahlungOhneFrist: 'за Вашиот престој од {anreise} до {abreise} Ве молиме за аванс од {betrag}.',
    zahlungAllgemein: 'за Вашиот престој од {anreise} до {abreise} Ве молиме за плаќање од {betrag}.',
    zahlungLink: 'Преку следниот линк безбедно плаќате кај давателот на платежни услуги на објектот:',
    zahlungKarte: 'Податоците за Вашата картичка ги внесувате само таму; објектот не ги добива.',
    zahlungGueltig: 'Линкот важи до и вклучително {gueltig}. Ако истече, со задоволство ќе Ви испратиме нов.',
    zahlungHinweis: 'Ако имате прашања, едноставно одговорете на оваа е-порака и наведете го бројот на резервацијата {ref}.',
    checkinAnredeMitName: 'Добар ден {name},',
    checkinAnredeOhneName: 'Добар ден,',
    checkinBetreff: 'Онлајн check-in за Вашиот престој — {haus}',
    checkinEinladung: 'на {anreise} Ве очекуваме во {haus}. За побрзо пристигнување, можете уште сега да го пополните пријавниот лист (Meldeschein):',
    checkinFrist: 'Линкот важи до {bis} и само за Вашата резервација {ref}.',
    checkinFreiwillig: 'Се разбира, пријавниот лист можете да го пополните и на лице место на денот на пристигнувањето.',
    checkinWeitergabe: 'Ве молиме не го проследувајте линкот: кој го има, може да внесува податоци за Вашиот престој.',
    checkinTest: 'ТЕСТ-ПОРАКА — вака изгледа поканата за онлајн check-in за Вашите гости. Името, резервацијата и датумите се примери; линкот не води до вистински пријавен лист.'
  },

  sq: {
    anredeMitName: 'Përshëndetje {name},',
    anredeOhneName: 'Përshëndetje,',
    rechnungBetreff: 'Fatura {nummer} — {haus}',
    rechnungAnhang: 'bashkëngjitur gjeni faturën tuaj {nummer} nga {haus} në format PDF, me një shumë totale prej {betrag}.',
    rechnungOffenMitFrist: 'Prej saj mbeten të papaguara {offen}, për t\'u paguar deri më {frist}.',
    rechnungOffenOhneFrist: 'Prej saj mbeten të papaguara {offen}.',
    rechnungBeglichen: 'Fatura është shlyer plotësisht. Kjo kopje është për dokumentet tuaja.',
    rechnungDank: 'Faleminderit për qëndrimin tuaj — do të ishim të lumtur t\'ju mirëpresim sërish.',
    rechnungUeberweisung: 'Ju lutemi transferoni shumën e mbetur në llogarinë e mëposhtme:',
    rechnungEmpfaenger: 'Përfituesi: {name}',
    rechnungVerwendungszweck: 'Përshkrimi: {nummer}',
    erinnerungBetreff: 'Kujtesë pagese për faturën {nummer} — {haus}',
    mahnungBetreff: 'Paralajmërim për faturën {nummer} — {haus}',
    mahnungOffen: 'nga fatura jonë {nummer} e datës {datum} mbetet ende e papaguar shuma {offen}.',
    mahnungFrist: 'Ju lutemi ta transferoni deri më {frist}. Fatura bashkëngjitet sërish.',
    mahnungUeberschneidung: 'Nëse pagesa juaj është kryqëzuar me këtë mesazh, ju lutemi ta shpërfillni.',

    buchungBetreff: 'Konfirmimi i rezervimit {ref} — {haus}',
    buchungBestaetigt: 'e kemi konfirmuar rezervimin tuaj në {haus}.',
    buchungNummer: 'Numri i rezervimit: {ref}',
    buchungAnreise: 'Mbërritja: {datum} nga ora {zeit}',
    buchungAbreise: 'Largimi: {datum} deri në orën {zeit}',
    buchungZimmer: 'Dhoma: {zimmer}',
    buchungGesamt: 'Shuma totale: {betrag}',
    buchungHinweis: 'Ju lutemi përmendni numrin e rezervimit në çdo pyetje. Mund t\'i përgjigjeni këtij e-maili nëse dëshironi të ndryshoni diçka.',
    zahlungBetreff: 'Pagesa për qëndrimin tuaj {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'për qëndrimin tuaj nga {anreise} deri më {abreise} ju lutemi për një paradhënie prej {betrag} deri më {frist}.',
    zahlungAnzahlungOhneFrist: 'për qëndrimin tuaj nga {anreise} deri më {abreise} ju lutemi për një paradhënie prej {betrag}.',
    zahlungAllgemein: 'për qëndrimin tuaj nga {anreise} deri më {abreise} ju lutemi për një pagesë prej {betrag}.',
    zahlungLink: 'Përmes lidhjes së mëposhtme paguani në mënyrë të sigurt te ofruesi i shërbimit të pagesave i hotelit:',
    zahlungKarte: 'Të dhënat e kartës i futni vetëm atje; hoteli nuk i merr ato.',
    zahlungGueltig: 'Lidhja është e vlefshme deri më {gueltig} përfshirë. Nëse ka skaduar, do t\'ju dërgojmë me kënaqësi një të re.',
    zahlungHinweis: 'Për pyetje thjesht përgjigjuni këtij e-maili dhe përmendni numrin e rezervimit {ref}.',
    checkinAnredeMitName: 'Përshëndetje {name},',
    checkinAnredeOhneName: 'Përshëndetje,',
    checkinBetreff: 'Check-in online për qëndrimin tuaj — {haus}',
    checkinEinladung: 'më {anreise} ju presim në {haus}. Që mbërritja të shkojë më shpejt, mund ta plotësoni formularin e regjistrimit (Meldeschein) që tani:',
    checkinFrist: 'Lidhja është e vlefshme deri më {bis} dhe vetëm për rezervimin tuaj {ref}.',
    checkinFreiwillig: 'Sigurisht, formularin e regjistrimit mund ta plotësoni me kënaqësi edhe në vend, në ditën e mbërritjes.',
    checkinWeitergabe: 'Ju lutemi mos ua jepni lidhjen të tjerëve: kush e ka, mund të japë të dhëna për qëndrimin tuaj.',
    checkinTest: 'E-MAIL PROVË — kështu duket ftesa për check-in online për mysafirët tuaj. Emri, rezervimi dhe datat janë shembuj; lidhja nuk çon te asnjë formular i vërtetë regjistrimi.'
  },

  el: {
    anredeMitName: 'Γεια σας {name},',
    anredeOhneName: 'Αγαπητοί επισκέπτες,',
    rechnungBetreff: 'Τιμολόγιο {nummer} — {haus}',
    rechnungAnhang: 'Σας επισυνάπτουμε το τιμολόγιό σας {nummer} από το {haus} σε μορφή PDF, συνολικού ποσού {betrag}.',
    rechnungOffenMitFrist: 'Από αυτό εκκρεμεί ποσό {offen}, πληρωτέο έως τις {frist}.',
    rechnungOffenOhneFrist: 'Από αυτό εκκρεμεί ποσό {offen}.',
    rechnungBeglichen: 'Το τιμολόγιο έχει εξοφληθεί πλήρως. Αυτό το αντίγραφο είναι για το αρχείο σας.',
    rechnungDank: 'Σας ευχαριστούμε για τη διαμονή σας — θα χαρούμε να σας υποδεχθούμε ξανά.',
    rechnungUeberweisung: 'Παρακαλούμε μεταφέρετε το υπόλοιπο ποσό στον ακόλουθο λογαριασμό:',
    rechnungEmpfaenger: 'Δικαιούχος: {name}',
    rechnungVerwendungszweck: 'Αιτιολογία: {nummer}',
    erinnerungBetreff: 'Υπενθύμιση πληρωμής για το τιμολόγιο {nummer} — {haus}',
    mahnungBetreff: 'Όχληση για το τιμολόγιο {nummer} — {haus}',
    mahnungOffen: 'από το τιμολόγιό μας {nummer} της {datum} παραμένει ανεξόφλητο ποσό {offen}.',
    mahnungFrist: 'Παρακαλούμε μεταφέρετέ το έως {frist}. Επισυνάπτουμε ξανά το τιμολόγιο.',
    mahnungUeberschneidung: 'Αν η πληρωμή σας διασταυρώθηκε με αυτό το μήνυμα, παρακαλούμε αγνοήστε το.',

    buchungBetreff: 'Επιβεβαίωση κράτησης {ref} — {haus}',
    buchungBestaetigt: 'Επιβεβαιώσαμε την κράτησή σας στο {haus}.',
    buchungNummer: 'Αριθμός κράτησης: {ref}',
    buchungAnreise: 'Άφιξη: {datum} από τις {zeit}',
    buchungAbreise: 'Αναχώρηση: {datum} έως τις {zeit}',
    buchungZimmer: 'Δωμάτιο: {zimmer}',
    buchungGesamt: 'Συνολικό ποσό: {betrag}',
    buchungHinweis: 'Παρακαλούμε αναφέρετε τον αριθμό κράτησης σε κάθε επικοινωνία. Μπορείτε να απαντήσετε σε αυτό το email αν θέλετε να αλλάξει κάτι.',
    zahlungBetreff: 'Πληρωμή για τη διαμονή σας {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Για τη διαμονή σας από {anreise} έως {abreise} σας παρακαλούμε για προκαταβολή {betrag} έως τις {frist}.',
    zahlungAnzahlungOhneFrist: 'Για τη διαμονή σας από {anreise} έως {abreise} σας παρακαλούμε για προκαταβολή {betrag}.',
    zahlungAllgemein: 'Για τη διαμονή σας από {anreise} έως {abreise} σας παρακαλούμε για πληρωμή {betrag}.',
    zahlungLink: 'Μέσω του παρακάτω συνδέσμου πληρώνετε με ασφάλεια στον πάροχο πληρωμών του καταλύματος:',
    zahlungKarte: 'Τα στοιχεία της κάρτας σας τα εισάγετε μόνο εκεί· το κατάλυμα δεν τα λαμβάνει.',
    zahlungGueltig: 'Ο σύνδεσμος ισχύει έως και {gueltig}. Αν έχει λήξει, θα σας στείλουμε ευχαρίστως νέο.',
    zahlungHinweis: 'Για οποιαδήποτε ερώτηση απαντήστε απλώς σε αυτό το email αναφέροντας τον αριθμό κράτησης {ref}.',
    checkinAnredeMitName: 'Γεια σας {name},',
    checkinAnredeOhneName: 'Γεια σας,',
    checkinBetreff: 'Online check-in για τη διαμονή σας — {haus}',
    checkinEinladung: 'Στις {anreise} σας περιμένουμε στο {haus}. Για να γίνει πιο γρήγορα η άφιξή σας, μπορείτε να συμπληρώσετε ήδη από τώρα το δελτίο εγγραφής (Meldeschein):',
    checkinFrist: 'Ο σύνδεσμος ισχύει έως τις {bis} και μόνο για την κράτησή σας {ref}.',
    checkinFreiwillig: 'Φυσικά μπορείτε επίσης να συμπληρώσετε το δελτίο εγγραφής επί τόπου την ημέρα της άφιξης.',
    checkinWeitergabe: 'Παρακαλούμε μην προωθήσετε τον σύνδεσμο: όποιος τον έχει μπορεί να καταχωρίσει στοιχεία για τη διαμονή σας.',
    checkinTest: 'ΔΟΚΙΜΑΣΤΙΚΟ EMAIL — έτσι βλέπουν οι επισκέπτες σας την πρόσκληση για online check-in. Όνομα, κράτηση και ημερομηνίες είναι παραδείγματα· ο σύνδεσμος δεν οδηγεί σε πραγματικό δελτίο εγγραφής.'
  },

  lt: {
    anredeMitName: 'Laba diena, {name},',
    anredeOhneName: 'Laba diena,',
    rechnungBetreff: 'Sąskaita {nummer} — {haus}',
    rechnungAnhang: 'Prisegame Jūsų sąskaitą {nummer} iš {haus} PDF formatu, bendra suma {betrag}.',
    rechnungOffenMitFrist: 'Dar neapmokėta {offen}, mokėtina iki {frist}.',
    rechnungOffenOhneFrist: 'Dar neapmokėta {offen}.',
    rechnungBeglichen: 'Sąskaita visiškai apmokėta. Šis egzempliorius skirtas Jūsų dokumentams.',
    rechnungDank: 'Dėkojame, kad apsistojote pas mus — būtume laimingi vėl Jus pasveikinti.',
    rechnungUeberweisung: 'Prašome pervesti likusią sumą į šią sąskaitą:',
    rechnungEmpfaenger: 'Gavėjas: {name}',
    rechnungVerwendungszweck: 'Mokėjimo paskirtis: {nummer}',
    erinnerungBetreff: 'Priminimas apie sąskaitos {nummer} apmokėjimą — {haus}',
    mahnungBetreff: 'Raginimas dėl sąskaitos {nummer} — {haus}',
    mahnungOffen: 'pagal mūsų {datum} sąskaitą {nummer} dar neapmokėta {offen}.',
    mahnungFrist: 'Prašome sumokėti iki {frist}. Sąskaitą pridedame dar kartą.',
    mahnungUeberschneidung: 'Jei jūsų mokėjimas prasilenkė su šia žinute, prašome į ją neatsižvelgti.',

    buchungBetreff: 'Rezervacijos patvirtinimas {ref} — {haus}',
    buchungBestaetigt: 'Patvirtinome Jūsų rezervaciją {haus}.',
    buchungNummer: 'Rezervacijos numeris: {ref}',
    buchungAnreise: 'Atvykimas: {datum} nuo {zeit}',
    buchungAbreise: 'Išvykimas: {datum} iki {zeit}',
    buchungZimmer: 'Kambarys: {zimmer}',
    buchungGesamt: 'Bendra suma: {betrag}',
    buchungHinweis: 'Kreipdamiesi nurodykite rezervacijos numerį. Jei norite ką nors pakeisti, galite atsakyti į šį el. laišką.',
    zahlungBetreff: 'Mokėjimas už Jūsų viešnagę {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Už Jūsų viešnagę nuo {anreise} iki {abreise} maloniai prašome sumokėti {betrag} avansą iki {frist}.',
    zahlungAnzahlungOhneFrist: 'Už Jūsų viešnagę nuo {anreise} iki {abreise} maloniai prašome sumokėti {betrag} avansą.',
    zahlungAllgemein: 'Už Jūsų viešnagę nuo {anreise} iki {abreise} maloniai prašome sumokėti {betrag}.',
    zahlungLink: 'Šia nuoroda saugiai sumokėsite per viešbučio mokėjimo paslaugų teikėją:',
    zahlungKarte: 'Kortelės duomenis įvedate tik ten; viešbutis jų negauna.',
    zahlungGueltig: 'Nuoroda galioja iki {gueltig} imtinai. Jei ji nebegalios, mielai atsiųsime naują.',
    zahlungHinweis: 'Kilus klausimams, tiesiog atsakykite į šį el. laišką ir nurodykite rezervacijos numerį {ref}.',
    checkinAnredeMitName: 'Sveiki, {name},',
    checkinAnredeOhneName: 'Sveiki,',
    checkinBetreff: 'Internetinė registracija Jūsų viešnagei — {haus}',
    checkinEinladung: '{anreise} laukiame Jūsų {haus}. Kad atvykus viskas vyktų greičiau, registracijos formą (Meldeschein) galite užpildyti jau dabar:',
    checkinFrist: 'Nuoroda galioja iki {bis} ir tik Jūsų rezervacijai {ref}.',
    checkinFreiwillig: 'Žinoma, registracijos formą taip pat galite užpildyti vietoje atvykimo dieną.',
    checkinWeitergabe: 'Prašome neperduoti šios nuorodos kitiems: kas ją turi, gali pateikti duomenis apie Jūsų viešnagę.',
    checkinTest: 'BANDOMASIS LAIŠKAS — taip Jūsų svečiams atrodo kvietimas į internetinę registraciją. Vardas, rezervacija ir datos yra pavyzdžiai; nuoroda neveda į tikrą registracijos formą.'
  },

  lv: {
    anredeMitName: 'Labdien, {name},',
    anredeOhneName: 'Labdien,',
    rechnungBetreff: 'Rēķins {nummer} — {haus}',
    rechnungAnhang: 'pielikumā PDF formātā atradīsiet savu rēķinu {nummer} no {haus} par kopējo summu {betrag}.',
    rechnungOffenMitFrist: 'Vēl jāsamaksā {offen}, termiņš līdz {frist}.',
    rechnungOffenOhneFrist: 'Vēl jāsamaksā {offen}.',
    rechnungBeglichen: 'Rēķins ir pilnībā apmaksāts. Šī kopija ir Jūsu dokumentācijai.',
    rechnungDank: 'Paldies par Jūsu uzturēšanos — mēs labprāt Jūs atkal sagaidīsim.',
    rechnungUeberweisung: 'Lūdzu, pārskaitiet atlikušo summu uz šādu kontu:',
    rechnungEmpfaenger: 'Saņēmējs: {name}',
    rechnungVerwendungszweck: 'Maksājuma mērķis: {nummer}',
    erinnerungBetreff: 'Maksājuma atgādinājums par rēķinu {nummer} — {haus}',
    mahnungBetreff: 'Brīdinājums par rēķinu {nummer} — {haus}',
    mahnungOffen: 'par mūsu {datum} rēķinu {nummer} vēl nav samaksāti {offen}.',
    mahnungFrist: 'Lūdzam pārskaitīt summu līdz {frist}. Rēķinu pievienojam atkārtoti.',
    mahnungUeberschneidung: 'Ja jūsu maksājums ir pārklājies ar šo ziņu, lūdzu, neņemiet to vērā.',

    buchungBetreff: 'Rezervācijas apstiprinājums {ref} — {haus}',
    buchungBestaetigt: 'esam apstiprinājuši Jūsu rezervāciju {haus}.',
    buchungNummer: 'Rezervācijas numurs: {ref}',
    buchungAnreise: 'Ierašanās: {datum} no {zeit}',
    buchungAbreise: 'Izbraukšana: {datum} līdz {zeit}',
    buchungZimmer: 'Numurs: {zimmer}',
    buchungGesamt: 'Kopā: {betrag}',
    buchungHinweis: 'Lūdzu, saziņā norādiet rezervācijas numuru. Ja kaut kas jāmaina, varat atbildēt uz šo e-pastu.',
    zahlungBetreff: 'Maksājums par Jūsu uzturēšanos {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'par Jūsu uzturēšanos no {anreise} līdz {abreise} laipni lūdzam samaksāt avansu {betrag} līdz {frist}.',
    zahlungAnzahlungOhneFrist: 'par Jūsu uzturēšanos no {anreise} līdz {abreise} laipni lūdzam samaksāt avansu {betrag}.',
    zahlungAllgemein: 'par Jūsu uzturēšanos no {anreise} līdz {abreise} laipni lūdzam samaksāt {betrag}.',
    zahlungLink: 'Jūs varat droši samaksāt pie viesnīcas maksājumu pakalpojumu sniedzēja, izmantojot šo saiti:',
    zahlungKarte: 'Kartes datus Jūs ievadāt tikai tur; viesnīca tos nekad nesaņem.',
    zahlungGueltig: 'Saite ir derīga līdz {gueltig} ieskaitot. Ja tās derīgums ir beidzies, mēs labprāt nosūtīsim Jums jaunu.',
    zahlungHinweis: 'Ja Jums ir jautājumi, vienkārši atbildiet uz šo e-pastu un norādiet rezervācijas numuru {ref}.',
    checkinAnredeMitName: 'Sveiki, {name},',
    checkinAnredeOhneName: 'Sveiki,',
    checkinBetreff: 'Tiešsaistes reģistrēšanās Jūsu uzturēšanās reizei — {haus}',
    checkinEinladung: '{anreise} gaidām Jūs mūsu viesnīcā {haus}. Lai ierašanās būtu ātrāka, Jūs jau tagad varat aizpildīt reģistrācijas veidlapu (Meldeschein):',
    checkinFrist: 'Saite ir derīga līdz {bis} un tikai Jūsu rezervācijai {ref}.',
    checkinFreiwillig: 'Protams, reģistrācijas veidlapu varat aizpildīt arī uz vietas ierašanās dienā.',
    checkinWeitergabe: 'Lūdzu, nenododiet saiti tālāk: ikviens, kam tā ir, var ievadīt datus par Jūsu uzturēšanos.',
    checkinTest: 'TESTA ZIŅOJUMS — šādi Jūsu viesi redz tiešsaistes reģistrēšanās ielūgumu. Vārds, rezervācija un datumi ir piemēri; saite neved uz īstu reģistrācijas veidlapu.'
  },

  et: {
    anredeMitName: 'Lugupeetud {name}',
    anredeOhneName: 'Lugupeetud külaline',
    rechnungBetreff: 'Arve {nummer} — {haus}',
    rechnungAnhang: 'Manuses on Teie arve {nummer} hotellilt {haus} PDF-failina, kogusummas {betrag}.',
    rechnungOffenMitFrist: 'Sellest on tasumata {offen}, tasuda hiljemalt {frist}.',
    rechnungOffenOhneFrist: 'Sellest on tasumata {offen}.',
    rechnungBeglichen: 'Arve on täielikult tasutud. See eksemplar on Teie dokumentide jaoks.',
    rechnungDank: 'Täname Teid viibimise eest — meil oleks hea meel Teid taas tervitada.',
    rechnungUeberweisung: 'Palun kandke tasumata summa üle järgmisele kontole:',
    rechnungEmpfaenger: 'Saaja: {name}',
    rechnungVerwendungszweck: 'Selgitus: {nummer}',
    erinnerungBetreff: 'Maksemeeldetuletus arve {nummer} kohta — {haus}',
    mahnungBetreff: 'Maksenõue arve {nummer} kohta — {haus}',
    mahnungOffen: 'meie {datum} arvest {nummer} on veel tasumata {offen}.',
    mahnungFrist: 'Palume summa üle kanda hiljemalt {frist}. Arve on uuesti lisatud.',
    mahnungUeberschneidung: 'Kui teie makse ristus selle teatega, palume seda mitte arvestada.',

    buchungBetreff: 'Broneeringu kinnitus {ref} — {haus}',
    buchungBestaetigt: 'Oleme kinnitanud Teie broneeringu hotellis {haus}.',
    buchungNummer: 'Broneeringu number: {ref}',
    buchungAnreise: 'Saabumine: {datum} alates kell {zeit}',
    buchungAbreise: 'Lahkumine: {datum} kuni kella {zeit}',
    buchungZimmer: 'Tuba: {zimmer}',
    buchungGesamt: 'Kogusumma: {betrag}',
    buchungHinweis: 'Palun märkige päringute korral broneeringu number. Kui midagi tuleb muuta, võite sellele e-kirjale vastata.',
    zahlungBetreff: 'Makse Teie viibimise eest {ref} — {haus}',
    zahlungAnzahlungMitFrist: 'Palume Teie viibimise eest ajavahemikus {anreise} kuni {abreise} ettemaksu summas {betrag} hiljemalt {frist}.',
    zahlungAnzahlungOhneFrist: 'Palume Teie viibimise eest ajavahemikus {anreise} kuni {abreise} ettemaksu summas {betrag}.',
    zahlungAllgemein: 'Palume Teie viibimise eest ajavahemikus {anreise} kuni {abreise} makset summas {betrag}.',
    zahlungLink: 'Järgmise lingi kaudu saate turvaliselt maksta hotelli makseteenuse pakkuja juures:',
    zahlungKarte: 'Kaardiandmed sisestate ainult seal; hotell neid ei saa.',
    zahlungGueltig: 'Link kehtib kuni {gueltig} (kaasa arvatud). Kui see on aegunud, saadame Teile hea meelega uue.',
    zahlungHinweis: 'Küsimuste korral vastake lihtsalt sellele e-kirjale ja märkige broneeringu number {ref}.',
    checkinAnredeMitName: 'Tere, {name}!',
    checkinAnredeOhneName: 'Tere!',
    checkinBetreff: 'Veebipõhine check-in Teie viibimiseks — {haus}',
    checkinEinladung: 'Ootame Teid {anreise} oma hotelli {haus}. Et saabumine kiiremini läheks, saate registreerimislehe (Meldeschein) täita juba praegu:',
    checkinFrist: 'Link kehtib kuni {bis} ja ainult Teie broneeringu {ref} jaoks.',
    checkinFreiwillig: 'Loomulikult võite registreerimislehe täita ka saabumispäeval kohapeal.',
    checkinWeitergabe: 'Palun ärge andke linki edasi: kellel see on, saab sisestada andmeid Teie viibimise kohta.',
    checkinTest: 'TESTKIRI — nii näeb veebipõhise check-in\'i kutse Teie külaliste jaoks välja. Nimi, broneering ja andmed on näited; link ei vii päris registreerimislehele.'
  }
}

/** IBAN in Vierergruppen, wie sie auf Papier und im Banking steht. */
function ibanLesbar(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ')
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

  /*
   * Ueberweisung und Link nur, wenn etwas offen ist; eine beglichene
   * Rechnung mit Bankverbindung liest sich wie eine Zahlungsaufforderung.
   * Die Bankdaten als ein Absatz mit Zeilenumbruechen, damit sie sich am
   * Stueck abschreiben lassen; der Link als eigener Absatz, aus demselben
   * Grund wie in `renderPaymentLinkEmail`.
   */
  const offen = d.openCent > 0
  const ueberweisung = offen && d.transfer ? [
    t.rechnungUeberweisung,
    [einsetzen(t.rechnungEmpfaenger, { name: d.transfer.payee }),
     `IBAN: ${ibanLesbar(d.transfer.iban)}`,
     ...(d.transfer.bic ? [`BIC: ${d.transfer.bic}`] : []),
     ...(d.transfer.bankName ? [d.transfer.bankName] : []),
     einsetzen(t.rechnungVerwendungszweck, werte)].join('\n')
  ] : []
  const link = offen && d.paymentLink ? [
    t.zahlungLink,
    d.paymentLink.url,
    t.zahlungKarte,
    einsetzen(t.zahlungGueltig, { gueltig: kalendertag(d.paymentLink.validUntil, lang) })
  ] : []

  const lines = [
    anrede(d.guestName, lang),
    einsetzen(t.rechnungAnhang, werte),
    offen
      ? einsetzen(d.dueDate ? t.rechnungOffenMitFrist : t.rechnungOffenOhneFrist, werte)
      : t.rechnungBeglichen,
    ...ueberweisung,
    ...link,
    t.rechnungDank,
    d.propertyName
  ]
  return {
    subject: einsetzen(t.rechnungBetreff, werte),
    text: lines.join('\n\n'),
    html: htmlBody(lines, lang)
  }
}

/**
 * Erinnerung und Mahnung. Die erste Stufe heisst freundlich Zahlungs-
 * erinnerung; wer zweimal schreibt, mahnt. Der Satz ueber die
 * ueberschnittene Zahlung steht immer da: der haeufigste Grund fuer einen
 * offenen Posten ist eine Zahlung, die noch nicht zugeordnet ist.
 */
export function renderReminderEmail(
  d: ReminderEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const t = TEXTE[lang]
  const werte = {
    nummer: d.invoiceNumber,
    haus: d.propertyName,
    datum: d.issuedOn,
    offen: `${formatCent(d.openCent)} ${d.currency}`,
    frist: d.dueDate
  }
  const lines = [
    anrede(d.guestName, lang),
    einsetzen(t.mahnungOffen, werte),
    einsetzen(t.mahnungFrist, werte),
    t.mahnungUeberschneidung,
    d.propertyName
  ]
  return {
    subject: einsetzen(d.level <= 1 ? t.erinnerungBetreff : t.mahnungBetreff, werte),
    text: lines.join('\n\n'),
    html: htmlBody(lines, lang)
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
    html: htmlBody(lines, lang)
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
const JAHR_ZUERST: ReadonlySet<EmailLanguage> = new Set(['en', 'sv', 'hu', 'lt', 'zh', 'ko'])

function kalendertag(iso: string, lang: EmailLanguage): string {
  const [jahr, monat, tag] = iso.split('-')
  if (jahr === undefined || monat === undefined || tag === undefined) return iso
  // Schwedisch, Ungarisch, Litauisch, Chinesisch und Koreanisch schreiben
  // das Jahr selbst zuerst; dieselbe Wahl wie `DATUMSFORM` der Oberflaeche.
  if (JAHR_ZUERST.has(lang)) return iso
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
    html: htmlBody(lines, lang)
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
  const html = htmlBody(lines, lang).replace(
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
      text: lines.join('\n\n'), html: linkKlickbar(htmlBody(lines, lang), d.link)
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
    text: lines.join('\n\n'), html: linkKlickbar(htmlBody(lines, lang), d.link)
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
    return { subject: 'Reset your password', text: lines.join('\n\n'), html: htmlBody(lines, lang) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    'ueber den folgenden Link vergeben Sie ein neues Kennwort:',
    d.link,
    `Der Link gilt ${d.gueltigStunden} Stunde(n) und laesst sich einmal verwenden.`,
    'Haben Sie das nicht angefordert, hat sich nichts geaendert: Ihr bisheriges '
      + 'Kennwort gilt weiter, und dieser Link verfaellt von selbst.'
  ]
  return { subject: 'Kennwort zuruecksetzen', text: lines.join('\n\n'), html: htmlBody(lines, lang) }
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
             html: htmlBody(lines, lang) }
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
           html: htmlBody(lines, lang) }
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

/*
 * Tickets (Migration 0208): zwei Hinweise, **beide ohne Inhalt**.
 *
 * Was im Ticket steht, schreibt eine Rezeption mitten im Betrieb, und das
 * ist oft ein Gast. In einem Postfach liegt es ohne Frist und ohne
 * Zeilenrichtlinie, und eine weitergeleitete Mail nimmt es mit. Die Mail
 * sagt deshalb nur, dass es etwas Neues gibt, und wo -- gelesen und
 * geantwortet wird in StayGrid.
 *
 * Nur deutsch, wie die uebrige Post an Benutzer: die Zugangspost bleibt
 * deutsch (Dokument 16, Sprachen), und die an uns sowieso.
 */
export interface TicketNoticeData {
  ticketId: number
  /** Name des Kunden, nicht der Person: der Eingang sortiert nach Kunden. */
  accountName: string
  /** Neues Ticket oder Antwort auf ein bestehendes. */
  neu: boolean
  /** "Betrieb steht" -- das Einzige, was am Betreff etwas aendern soll. */
  dringend: boolean
  link: string
}

export function renderTicketNotice(d: TicketNoticeData): RenderedEmail {
  const lines = [
    'Guten Tag,',
    d.neu
      ? `${d.accountName} hat eine neue Anfrage gestellt (#${d.ticketId}).`
      : `${d.accountName} hat auf die Anfrage #${d.ticketId} geantwortet.`,
    ...(d.dringend ? ['Der Kunde meldet: der Betrieb steht.'] : []),
    'Gelesen und beantwortet wird im Adminpanel, nicht per Antwort auf diese Nachricht:',
    d.link
  ]
  const betreff = `${d.dringend ? 'DRINGEND: ' : ''}`
    + `${d.neu ? 'Neue Anfrage' : 'Antwort'} #${d.ticketId} von ${d.accountName}`
  return { subject: betreff, text: lines.join('\n\n'), html: htmlBody(lines) }
}

export interface TicketReplyData {
  userName: string | null
  ticketId: number
  link: string
}

export function renderTicketReplyEmail(d: TicketReplyData): RenderedEmail {
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `der StayGrid-Support hat auf Ihre Anfrage #${d.ticketId} geantwortet.`,
    'Die Antwort lesen Sie in StayGrid unter "Hilfe & Support":',
    d.link,
    'Bitte antworten Sie dort und nicht auf diese Nachricht. Den Inhalt Ihrer '
      + 'Anfrage schicken wir bewusst nicht per Mail.'
  ]
  return { subject: `Antwort auf Ihre Anfrage #${d.ticketId}`, text: lines.join('\n\n'),
           html: htmlBody(lines) }
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
             html: htmlBody(lines, lang) }
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
           html: htmlBody(lines, lang) }
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
             text: lines.join('\n\n'), html: htmlBody(lines, lang) }
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
           text: lines.join('\n\n'), html: htmlBody(lines, lang) }
}

/**
 * Hinweis an die eigene Adresse, dass ein Passkey dazugekommen ist.
 *
 * Aus demselben Grund wie der Hinweis bei der Adressaenderung: wer eine
 * offene Sitzung samt Kennwort in die Hand bekommt, legte sich sonst
 * lautlos einen dauerhaften Zugang an, der jede Kennwortaenderung
 * ueberlebt. Ohne Link, aus demselben Grund wie dort.
 */
export interface PasskeyAddedNoticeData {
  userName: string | null
  /** Die Bezeichnung, die beim Anlegen getippt wurde. */
  passkeyName: string
}

export function renderPasskeyAddedNotice(
  d: PasskeyAddedNoticeData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      `a passkey named "${d.passkeyName}" was added to your account. `
        + 'It can now be used to sign in without a password.',
      'If this was not you, remove the passkey under "Workstation", change your '
        + 'password and tell your administrator. This message contains no link '
        + 'on purpose.'
    ]
    return { subject: 'New passkey on your account',
             text: lines.join('\n\n'), html: htmlBody(lines, lang) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `an Ihrem Zugang wurde ein Passkey mit der Bezeichnung „${d.passkeyName}“ `
      + 'angelegt. Mit ihm ist jetzt eine Anmeldung ohne Kennwort moeglich.',
    'Waren Sie das nicht, entfernen Sie den Passkey unter „Arbeitsplatz“, aendern '
      + 'Sie Ihr Kennwort und sagen Sie Ihrer Verwaltung Bescheid. Diese '
      + 'Nachricht enthaelt bewusst keinen Link.'
  ]
  return { subject: 'Neuer Passkey an Ihrem Zugang',
           text: lines.join('\n\n'), html: htmlBody(lines, lang) }
}

/**
 * Hinweis auf eine kritische Handlung (Migration 0209, Bedrohungsanalyse
 * 23.10.2026, T3).
 *
 * Geht an alle mit settings:account im Betrieb und an die Hausleitung, auch an den, der gehandelt
 * hat: der Angreifer mit einer geliehenen Sitzung ist meist nicht der, dem
 * sie gehoert. **Ohne Link**, aus demselben Grund wie der Hinweis auf eine
 * Mailaenderung -- eine Nachricht ueber etwas, das man nicht veranlasst
 * hat, mit einem Knopf darin, ist die Bauform jeder Phishing-Mail. Der Weg
 * zum Nachsehen ist der, den der Empfaenger ohnehin kennt.
 */
export interface SecurityNoticeData {
  userName: string | null
  accountName: string
  propertyName: string | null
  actorName: string
  /** Schon in der Ortszeit des Betriebs formatiert. */
  when: string
  action: SecurityNoticeAction
  /** Gekuerzter Wert, etwa die letzten vier Stellen einer IBAN. */
  hint: string | null
}

export type SecurityNoticeAction =
  | 'bank_details_changed' | 'payment_account_connected'
  | 'payment_account_disconnected' | 'oauth_client_created'
  | 'oauth_client_changed' | 'webhook_created' | 'webhook_changed'
  | 'channel_connection_created' | 'role_granted' | 'support_granted'
  | 'export' | 'login_new_device' | 'access_volume' | 'honeytoken'
  | 'client_origin_denied'

const NOTICE_ACTION: Record<SecurityNoticeAction, { de: string; en: string }> = {
  bank_details_changed: { de: 'die Bankverbindung auf den Rechnungen geändert',
                          en: 'changed the bank details printed on invoices' },
  payment_account_connected: { de: 'ein Zahlungskonto (Stripe) verbunden',
                               en: 'connected a payment account (Stripe)' },
  payment_account_disconnected: { de: 'das Zahlungskonto (Stripe) getrennt',
                                  en: 'disconnected the payment account (Stripe)' },
  oauth_client_created: { de: 'einen Maschinenzugang zur Schnittstelle angelegt',
                          en: 'created a machine access to the API' },
  oauth_client_changed: { de: 'die Rechte eines Maschinenzugangs geändert',
                          en: 'changed the permissions of a machine access' },
  webhook_created: { de: 'ein Webhook-Ziel angelegt',
                     en: 'created a webhook target' },
  webhook_changed: { de: 'die Adresse eines Webhook-Ziels geändert',
                     en: 'changed the address of a webhook target' },
  channel_connection_created: { de: 'einen Kanalzugang angelegt',
                                en: 'created a channel connection' },
  role_granted: { de: 'eine Leitungsrolle vergeben',
                  en: 'granted a management role' },
  support_granted: { de: 'dem StayGrid-Support Zugriff gegeben',
                     en: 'granted StayGrid support access' },
  export: { de: 'einen Datenexport heruntergeladen',
            en: 'downloaded a data export' },
  login_new_device: { de: 'sich von einem neuen Gerät angemeldet',
                      en: 'signed in from a new device' },
  access_volume: { de: 'ungewöhnlich viele Gastdaten abgerufen',
                   en: 'retrieved an unusual amount of guest data' },
  honeytoken: { de: 'einen Köderdatensatz abgerufen, den niemand im Betrieb kennt',
                en: 'retrieved a decoy record that nobody in your business knows' },
  client_origin_denied: { de: 'den Zugang aus einem Netz benutzt, das für ihn nicht freigegeben ist',
                          en: 'used the access from a network that is not allowed for it' }
}

export function renderSecurityNotice(
  d: SecurityNoticeData, lang: EmailLanguage = 'de'
): RenderedEmail {
  const a = NOTICE_ACTION[d.action]
  const wo = d.propertyName ? ` (${d.propertyName})` : ''
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      `in ${d.accountName}${wo}, ${d.actorName} has ${a.en} on ${d.when}.`
        + (d.hint ? ` Detail: ${d.hint}.` : ''),
      'If this was planned, there is nothing to do.',
      'If nobody in your business did this, sign in as usual, check the '
        + 'security log under Settings and change your password. Then tell '
        + 'StayGrid support. This message contains no link on purpose.'
    ]
    return { subject: `Security notice: ${a.en}`,
             text: lines.join('\n\n'), html: htmlBody(lines, lang) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    `im Betrieb ${d.accountName}${wo} hat ${d.actorName} am ${d.when} ${a.de}.`
      + (d.hint ? ` Angabe: ${d.hint}.` : ''),
    'War das so geplant, ist nichts zu tun.',
    'Hat das niemand aus Ihrem Betrieb getan, melden Sie sich wie gewohnt an, '
      + 'prüfen Sie das Sicherheitsprotokoll unter Einstellungen und ändern '
      + 'Sie Ihr Kennwort. Sagen Sie danach dem StayGrid-Support Bescheid. '
      + 'Diese Nachricht enthält bewusst keinen Link.'
  ]
  return { subject: `Sicherheitshinweis: ${a.de}`,
           text: lines.join('\n\n'), html: htmlBody(lines, lang) }
}
