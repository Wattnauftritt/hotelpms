import type { EmailLanguage } from '@hotelpms/contracts'
import { formatCent } from './money.js'

/**
 * Ausgehende Post an den Gast: Arten, Vorlagen und Wiederholungsregel.
 *
 * Liegt in der Domaene, weil beide Seiten sie brauchen: die API rendert und
 * reiht ein, der Worker stellt zu, und die Vorlagen sind Fachtext und kein
 * Darstellungsdetail -- in ihnen stehen Pflichtangaben.
 */

export const EMAIL_KINDS = ['invoice', 'reservation_confirmation'] as const
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
}

const TEXTE: Record<EmailLanguage, Gastposttexte> = {
  de: {
    // Ohne Namen kein "Sehr geehrte Damen und Herren" an eine Privatperson:
    // das liest sich wie ein Serienbrief. "Guten Tag" passt in beiden Faellen.
    anredeMitName: 'Guten Tag {name},',
    anredeOhneName: 'Guten Tag,',

    rechnungBetreff: 'Rechnung {nummer} — {haus}',
    rechnungAnhang: 'anbei erhalten Sie Ihre Rechnung {nummer} des Hauses {haus} '
      + 'als PDF, ueber insgesamt {betrag}.',
    rechnungOffenMitFrist: 'Offen sind davon {offen}, zahlbar bis zum {frist}.',
    rechnungOffenOhneFrist: 'Offen sind davon {offen}.',
    rechnungBeglichen: 'Die Rechnung ist vollstaendig beglichen. '
      + 'Dieses Exemplar ist fuer Ihre Unterlagen.',
    rechnungDank: 'Vielen Dank fuer Ihren Aufenthalt — wir wuerden uns freuen, '
      + 'Sie wieder begruessen zu duerfen.',

    buchungBetreff: 'Buchungsbestaetigung {ref} — {haus}',
    buchungBestaetigt: 'wir haben Ihre Buchung im Hause {haus} bestaetigt.',
    buchungNummer: 'Buchungsnummer: {ref}',
    buchungAnreise: 'Anreise: {datum} ab {zeit} Uhr',
    buchungAbreise: 'Abreise: {datum} bis {zeit} Uhr',
    buchungZimmer: 'Zimmer: {zimmer}',
    buchungGesamt: 'Gesamtbetrag: {betrag}',
    buchungHinweis: 'Bitte geben Sie die Buchungsnummer bei Rueckfragen an. '
      + 'Sie koennen auf diese E-Mail antworten, wenn sich etwas aendern soll.'
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
      + 'You can reply to this email if anything needs changing.'
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
      + 'U kunt op deze e-mail antwoorden als er iets gewijzigd moet worden.'
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
      + 'Na tę wiadomość można odpowiedzieć, jeśli coś wymaga zmiany.'
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

/**
 * Einladung eines neuen Benutzers.
 *
 * **Warum der Link und kein Kennwort im Text.** Ein Kennwort in einer Mail
 * bleibt im Postfach stehen, wird weitergeleitet und landet in Sicherungen.
 * Ein Einmaltoken verfaellt.
 */
export function renderInviteEmail(
  d: AuthEmailData, lang: EmailLanguage = 'de'
): RenderedEmail {
  if (lang === 'en') {
    const lines = [
      d.userName ? `Dear ${d.userName},` : 'Hello,',
      'an account has been created for you. Choose your password using the link below:',
      d.link,
      `The link is valid for ${d.gueltigStunden} hours and can be used once.`,
      'If you were not expecting this message, you can ignore it — '
        + 'without the link nothing happens.'
    ]
    return { subject: 'Your access', text: lines.join('\n\n'), html: htmlBody(lines) }
  }
  const lines = [
    d.userName ? `Guten Tag ${d.userName},` : 'Guten Tag,',
    'fuer Sie wurde ein Zugang eingerichtet. Ueber den folgenden Link vergeben '
      + 'Sie Ihr Kennwort:',
    d.link,
    `Der Link gilt ${d.gueltigStunden} Stunden und laesst sich einmal verwenden.`,
    'Haben Sie diese Nachricht nicht erwartet, koennen Sie sie liegen lassen — '
      + 'ohne den Link geschieht nichts.'
  ]
  return { subject: 'Ihr Zugang', text: lines.join('\n\n'), html: htmlBody(lines) }
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
