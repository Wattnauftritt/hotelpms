import type { EmailLanguage } from '@hotelpms/contracts'
import { formatCent } from './money.js'

/**
 * Die Seite, die der Gast hinter seinem Zahlungslink sieht (Migration 0068).
 *
 * **Warum eine Seite und keine sofortige Weiterleitung.** Erstens: Mail-
 * programme und Virenscanner rufen Links in einer Mail vorab auf. Leitete
 * schon dieser Aufruf zum Anbieter weiter, entstuende bei jedem Scan ein
 * Checkout. Erst der Knopf auf der Seite tut das. Zweitens: eine Mail mit
 * einem Zahlungslink sieht aus wie jede Phishing-Mail. Die Seite sagt, an
 * wen, wofuer und wie viel -- bevor der Gast seine Karte irgendwo eingibt.
 *
 * **Fachtext, kein Darstellungsdetail**, deshalb in der Domaene neben den
 * Vorlagen der Gastpost und in denselben Sprachen.
 *
 * **Keine `<style>`-Elemente, nur Stilattribute.** Die Inhaltsrichtlinie im
 * Caddyfile erlaubt eingebettete Stylesheets nicht (H7, Dokument 25), und
 * eine Seite, die nur mit ihnen gut aussieht, saehe beim Gast nackt aus.
 * Kein Skript, keine fremden Herkuenfte, kein Formular: der Knopf ist ein
 * Link, denn `form-action 'self'` verbietet einem Formular die Weiterleitung
 * zum Anbieter.
 *
 * **Kein Gastname.** Wer den Link hat, ist nicht zwingend der Gast -- eine
 * weitergeleitete Mail, ein geteilter Rechner. Haus, Zeitraum und Betrag
 * genuegen, um die Zahlung zuzuordnen.
 */

export type PayPageKind =
  | 'open' | 'paid' | 'processing' | 'revoked' | 'expired' | 'training'
  | 'unavailable' | 'unknown' | 'returned' | 'abandoned'

export interface PayPageData {
  propertyName?: string
  arrival?: string
  departure?: string
  amountCent?: number
  currency?: string
  /** Faelligkeit einer Anzahlung; null bei einem freien Betrag. */
  dueDate?: string | null
  deposit?: boolean
  /** Bis wann der Link annimmt, Kalendertag. */
  validUntil?: string
  /** Wohin der Knopf fuehrt. Relativ, auf dieselbe Herkunft. */
  checkoutHref?: string
}

interface Seitentexte {
  titel: string
  offenAnzahlung: string
  offenAnzahlungFrist: string
  offenZahlung: string
  betrag: string
  gueltig: string
  knopf: string
  karte: string
  bezahlt: string
  inBearbeitung: string
  widerrufen: string
  abgelaufen: string
  uebung: string
  nichtMoeglich: string
  unbekannt: string
  zurueck: string
  abgebrochen: string
  rueckfrage: string
}

const TEXTE: Record<EmailLanguage, Seitentexte> = {
  // Echte Umlaute: anders als die Gastpost, deren Text seit jeher in
  // Umschrift steht, ist diese Seite HTML mit erklaertem Zeichensatz, und
  // "faellig" auf einer Zahlungsseite sieht aus wie eine Phishing-Seite.
  de: {
    titel: 'Zahlung',
    offenAnzahlung: 'Anzahlung für Ihren Aufenthalt vom {anreise} bis {abreise}.',
    offenAnzahlungFrist: 'Anzahlung für Ihren Aufenthalt vom {anreise} bis {abreise}, '
      + 'fällig am {frist}.',
    offenZahlung: 'Zahlung für Ihren Aufenthalt vom {anreise} bis {abreise}.',
    betrag: 'Offener Betrag',
    gueltig: 'Dieser Link gilt bis einschließlich {datum}.',
    knopf: 'Weiter zur Zahlung',
    karte: 'Sie zahlen beim Zahlungsdienstleister des Hauses. Ihre Kartendaten '
      + 'geben Sie nur dort ein; das Haus erhält sie nicht.',
    bezahlt: 'Diese Zahlung ist eingegangen. Vielen Dank.',
    inBearbeitung: 'Ihre Zahlung wird gerade verarbeitet. Sie müssen nichts weiter '
      + 'tun; bitte zahlen Sie nicht ein zweites Mal.',
    widerrufen: 'Dieser Zahlungslink gilt nicht mehr. Bitte wenden Sie sich an das Haus.',
    abgelaufen: 'Dieser Zahlungslink ist abgelaufen. Bitte wenden Sie sich an das Haus; '
      + 'es schickt Ihnen gern einen neuen.',
    uebung: 'Dies ist ein Übungshaus. Hier wird nichts bezahlt.',
    nichtMoeglich: 'Die Zahlung ist gerade nicht möglich. Bitte versuchen Sie es '
      + 'später noch einmal.',
    unbekannt: 'Dieser Link ist ungültig. Bitte prüfen Sie, ob er vollständig '
      + 'aus der E-Mail übernommen wurde.',
    zurueck: 'Vielen Dank. Sobald der Zahlungsdienstleister die Zahlung bestätigt, '
      + 'vermerkt das Haus sie. Sie können dieses Fenster schließen.',
    abgebrochen: 'Die Zahlung wurde nicht abgeschlossen. Sie können den Link aus '
      + 'Ihrer E-Mail erneut öffnen.',
    rueckfrage: 'Bei Fragen antworten Sie auf die E-Mail, mit der Sie diesen Link '
      + 'erhalten haben.'
  },
  en: {
    titel: 'Payment',
    offenAnzahlung: 'Deposit for your stay from {anreise} to {abreise}.',
    offenAnzahlungFrist: 'Deposit for your stay from {anreise} to {abreise}, due on {frist}.',
    offenZahlung: 'Payment for your stay from {anreise} to {abreise}.',
    betrag: 'Amount due',
    gueltig: 'This link is valid up to and including {datum}.',
    knopf: 'Continue to payment',
    karte: 'You pay with the property’s payment provider. You enter your card '
      + 'details only there; the property never receives them.',
    bezahlt: 'This payment has been received. Thank you.',
    inBearbeitung: 'Your payment is being processed. There is nothing more to do; '
      + 'please do not pay a second time.',
    widerrufen: 'This payment link is no longer valid. Please contact the property.',
    abgelaufen: 'This payment link has expired. Please contact the property; it will '
      + 'gladly send you a new one.',
    uebung: 'This is a training property. Nothing is paid here.',
    nichtMoeglich: 'Payment is not possible right now. Please try again later.',
    unbekannt: 'This link is invalid. Please check that it was copied completely '
      + 'from the email.',
    zurueck: 'Thank you. As soon as the payment provider confirms the payment, the '
      + 'property will record it. You can close this window.',
    abgebrochen: 'The payment was not completed. You can open the link from your '
      + 'email again.',
    rueckfrage: 'If you have any questions, reply to the email in which you '
      + 'received this link.'
  },
  nl: {
    titel: 'Betaling',
    offenAnzahlung: 'Aanbetaling voor uw verblijf van {anreise} tot {abreise}.',
    offenAnzahlungFrist: 'Aanbetaling voor uw verblijf van {anreise} tot {abreise}, '
      + 'te voldoen uiterlijk {frist}.',
    offenZahlung: 'Betaling voor uw verblijf van {anreise} tot {abreise}.',
    betrag: 'Openstaand bedrag',
    gueltig: 'Deze link is geldig tot en met {datum}.',
    knopf: 'Verder naar betaling',
    karte: 'U betaalt bij de betaaldienst van het hotel. Uw kaartgegevens voert u '
      + 'alleen daar in; het hotel ontvangt ze niet.',
    bezahlt: 'Deze betaling is ontvangen. Hartelijk dank.',
    inBearbeitung: 'Uw betaling wordt verwerkt. U hoeft verder niets te doen; '
      + 'betaal alstublieft niet nog een keer.',
    widerrufen: 'Deze betaallink is niet meer geldig. Neem contact op met het hotel.',
    abgelaufen: 'Deze betaallink is verlopen. Neem contact op met het hotel; het '
      + 'stuurt u graag een nieuwe.',
    uebung: 'Dit is een oefenhotel. Hier wordt niets betaald.',
    nichtMoeglich: 'Betalen is op dit moment niet mogelijk. Probeer het later nog eens.',
    unbekannt: 'Deze link is ongeldig. Controleer of hij volledig uit de e-mail is '
      + 'overgenomen.',
    zurueck: 'Hartelijk dank. Zodra de betaaldienst de betaling bevestigt, legt het '
      + 'hotel haar vast. U kunt dit venster sluiten.',
    abgebrochen: 'De betaling is niet afgerond. U kunt de link uit uw e-mail opnieuw '
      + 'openen.',
    rueckfrage: 'Heeft u vragen, antwoord dan op de e-mail waarmee u deze link heeft '
      + 'ontvangen.'
  },
  pl: {
    titel: 'Płatność',
    offenAnzahlung: 'Zaliczka za pobyt w terminie {anreise} – {abreise}.',
    offenAnzahlungFrist: 'Zaliczka za pobyt w terminie {anreise} – {abreise}, '
      + 'płatna do dnia {frist}.',
    offenZahlung: 'Płatność za pobyt w terminie {anreise} – {abreise}.',
    betrag: 'Kwota do zapłaty',
    gueltig: 'Ten link jest ważny do dnia {datum} włącznie.',
    knopf: 'Przejdź do płatności',
    karte: 'Płatności dokonują Państwo u operatora płatności obiektu. Dane karty '
      + 'podają Państwo wyłącznie tam; obiekt ich nie otrzymuje.',
    bezahlt: 'Ta płatność została zaksięgowana. Dziękujemy.',
    inBearbeitung: 'Płatność jest właśnie przetwarzana. Nie trzeba nic więcej robić; '
      + 'prosimy nie płacić drugi raz.',
    widerrufen: 'Ten link do płatności nie jest już ważny. Prosimy o kontakt z obiektem.',
    abgelaufen: 'Ten link do płatności wygasł. Prosimy o kontakt z obiektem; '
      + 'chętnie prześle nowy.',
    uebung: 'To jest obiekt szkoleniowy. Tutaj nic nie jest płacone.',
    nichtMoeglich: 'Płatność nie jest w tej chwili możliwa. Prosimy spróbować później.',
    unbekannt: 'Ten link jest nieprawidłowy. Prosimy sprawdzić, czy został w całości '
      + 'skopiowany z wiadomości.',
    zurueck: 'Dziękujemy. Gdy operator płatności potwierdzi płatność, obiekt ją '
      + 'odnotuje. Można zamknąć to okno.',
    abgebrochen: 'Płatność nie została zakończona. Link z wiadomości można otworzyć '
      + 'ponownie.',
    rueckfrage: 'W razie pytań prosimy odpowiedzieć na wiadomość, w której '
      + 'otrzymali Państwo ten link.'
  }
}

/** Die Saetze einer Sprache. Fuer den Test, der Platzhalter und Luecken sucht. */
export function payPageTexts(lang: EmailLanguage): Readonly<Record<string, string>> {
  return { ...TEXTE[lang] }
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function einsetzen(satz: string, werte: Record<string, string>): string {
  return satz.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    Object.prototype.hasOwnProperty.call(werte, name) ? werte[name]! : ganz)
}

/** Kalendertag in der Schreibweise der Sprache, ohne `Date` (wie in der Gastpost). */
function kalendertag(iso: string, lang: EmailLanguage): string {
  const [jahr, monat, tag] = iso.split('-')
  if (jahr === undefined || monat === undefined || tag === undefined) return iso
  if (lang === 'en') return iso
  if (lang === 'nl') return `${tag}-${monat}-${jahr}`
  return `${tag}.${monat}.${jahr}`
}

const P = 'margin:0 0 14px 0'

export function renderPayPage(
  kind: PayPageKind, d: PayPageData, lang: EmailLanguage = 'de'
): string {
  const t = TEXTE[lang]
  const werte = {
    anreise: d.arrival === undefined ? '' : kalendertag(d.arrival, lang),
    abreise: d.departure === undefined ? '' : kalendertag(d.departure, lang),
    frist: d.dueDate == null ? '' : kalendertag(d.dueDate, lang),
    datum: d.validUntil === undefined ? '' : kalendertag(d.validUntil, lang)
  }

  const teile: string[] = []
  if (d.propertyName !== undefined) {
    teile.push(`<h1 style="font-size:20px;margin:0 0 18px 0">${esc(d.propertyName)}</h1>`)
  }

  const absatz = (s: string): string => `<p style="${P}">${esc(s)}</p>`
  switch (kind) {
    case 'open': {
      const satz = !d.deposit ? t.offenZahlung
        : d.dueDate == null ? t.offenAnzahlung : t.offenAnzahlungFrist
      teile.push(absatz(einsetzen(satz, werte)))
      teile.push(`<p style="${P}"><span style="color:#555">${esc(t.betrag)}</span><br>`
        + `<strong style="font-size:28px">${esc(formatCent(d.amountCent ?? 0))} `
        + `${esc(d.currency ?? 'EUR')}</strong></p>`)
      teile.push(`<p style="margin:0 0 18px 0"><a href="${esc(d.checkoutHref ?? '#')}" `
        + 'style="display:inline-block;background:#111;color:#fff;padding:12px 20px;'
        + `border-radius:6px;text-decoration:none">${esc(t.knopf)}</a></p>`)
      teile.push(absatz(t.karte))
      if (d.validUntil !== undefined) teile.push(absatz(einsetzen(t.gueltig, werte)))
      break
    }
    case 'paid': teile.push(absatz(t.bezahlt)); break
    case 'processing': teile.push(absatz(t.inBearbeitung)); break
    case 'revoked': teile.push(absatz(t.widerrufen)); break
    case 'expired': teile.push(absatz(t.abgelaufen)); break
    case 'training': teile.push(absatz(t.uebung)); break
    case 'unavailable': teile.push(absatz(t.nichtMoeglich)); break
    case 'unknown': teile.push(absatz(t.unbekannt)); break
    case 'returned': teile.push(absatz(t.zurueck)); break
    case 'abandoned': teile.push(absatz(t.abgebrochen)); break
  }
  if (kind !== 'unknown') teile.push(`<p style="${P};color:#555">${esc(t.rueckfrage)}</p>`)

  return '<!doctype html>\n'
    + `<html lang="${lang}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + `<title>${esc(d.propertyName === undefined ? t.titel
                                                  : `${t.titel} — ${d.propertyName}`)}</title>`
    + '</head><body style="margin:0;background:#f5f5f5;'
    + 'font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111">'
    + '<main style="max-width:520px;margin:40px auto;background:#fff;padding:28px;'
    + 'border:1px solid #e5e5e5;border-radius:8px;font-size:16px;line-height:1.5">'
    + teile.join('\n')
    + '</main></body></html>'
}
