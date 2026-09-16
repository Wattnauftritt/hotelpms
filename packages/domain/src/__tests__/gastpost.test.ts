import { describe, it, expect } from 'vitest'
import { EMAIL_LANGUAGES, emailLanguage, renderInvoiceEmail, renderReservationEmail,
         type EmailLanguage } from '../email.js'

/**
 * Die Gastpost in allen Sprachen, in denen wir sie anbieten.
 *
 * Geprueft wird, was ein Gast merken wuerde und wir nicht: ein Platzhalter,
 * der stehen bleibt, weil eine Uebersetzung ihn anders geschrieben hat; eine
 * Sprache, die auf Deutsch zurueckfaellt, weil sie in der Zuordnung fehlt;
 * eine Zeile, die in einer Sprache leer bleibt.
 *
 * Nicht geprueft wird die Uebersetzung selbst. Das kann kein Test, das kann
 * nur jemand, der die Sprache spricht.
 */

const rechnung = {
  propertyName: 'Hotel Nordsee', guestName: 'Anna Beispiel',
  invoiceNumber: '2026-000007', grossCent: 34_900, currency: 'EUR',
  dueDate: '2026-10-15', openCent: 12_000
}

const buchung = {
  propertyName: 'Hotel Nordsee', guestName: 'Anna Beispiel',
  reservationRef: 'ABC123', arrival: '2026-10-01', departure: '2026-10-04',
  categoryName: 'Doppelzimmer', totalCent: 34_900, currency: 'EUR',
  checkinTime: '15:00', checkoutTime: '11:00'
}

/** Alles, was ein Gast zu sehen bekommt, in einer Zeichenkette. */
function alles(lang: EmailLanguage): string[] {
  return [
    renderInvoiceEmail(rechnung, lang),
    renderInvoiceEmail({ ...rechnung, dueDate: null }, lang),
    renderInvoiceEmail({ ...rechnung, openCent: 0, dueDate: null }, lang),
    renderInvoiceEmail({ ...rechnung, guestName: null }, lang),
    renderReservationEmail(buchung, lang),
    renderReservationEmail({ ...buchung, guestName: null }, lang)
  ].flatMap(m => [m.subject, m.text, m.html])
}

describe('Gastpost in jeder angebotenen Sprache', () => {
  /**
   * Der teuerste stille Fehler: eine Uebersetzung schreibt `{nummer}` anders,
   * und der Gast bekommt eine Rechnung, in der die Rechnungsnummer als
   * geschweifte Klammer steht. Auffallen wuerde es ihm, nicht uns.
   */
  it('laesst keinen Platzhalter stehen', () => {
    for (const lang of EMAIL_LANGUAGES) {
      for (const stueck of alles(lang)) {
        expect(stueck, `${lang}: ${stueck.slice(0, 60)}`).not.toMatch(/\{\w+\}/)
      }
    }
  })

  it('schreibt in jeder Sprache Betreff und Rumpf', () => {
    for (const lang of EMAIL_LANGUAGES) {
      for (const m of [renderInvoiceEmail(rechnung, lang),
                       renderReservationEmail(buchung, lang)]) {
        expect(m.subject.trim().length, lang).toBeGreaterThan(0)
        expect(m.text.trim().length, lang).toBeGreaterThan(0)
        expect(m.html).toContain('<p')
      }
    }
  })

  /**
   * Jede Sprache muss ihre **eigenen** Saetze haben. Faellt eine auf Deutsch
   * zurueck, weil ein Eintrag fehlt, sieht die Mail vollstaendig aus und ist
   * es nicht -- sie ist nur in der falschen Sprache.
   */
  it('faellt in keiner Sprache auf deutschen Text zurueck', () => {
    const deutsch = renderInvoiceEmail(rechnung, 'de')
    for (const lang of EMAIL_LANGUAGES) {
      if (lang === 'de') continue
      expect(renderInvoiceEmail(rechnung, lang).subject, lang)
        .not.toBe(deutsch.subject)
      expect(renderReservationEmail(buchung, lang).text, lang)
        .not.toBe(renderReservationEmail(buchung, 'de').text)
    }
  })

  /** Die Eckdaten stehen in jeder Sprache vollzaehlig und in derselben Folge. */
  it('traegt die Buchungsdaten in jeder Sprache', () => {
    for (const lang of EMAIL_LANGUAGES) {
      const t = renderReservationEmail(buchung, lang).text
      for (const wert of [buchung.reservationRef, buchung.arrival, buchung.departure,
                          buchung.categoryName, buchung.checkinTime]) {
        expect(t, `${lang} vermisst ${wert}`).toContain(wert)
      }
    }
  })

  it('nennt die offene Summe nur, solange etwas offen ist', () => {
    for (const lang of EMAIL_LANGUAGES) {
      const offen = renderInvoiceEmail(rechnung, lang).text
      const bezahlt = renderInvoiceEmail(
        { ...rechnung, openCent: 0, dueDate: null }, lang).text
      expect(offen, lang).toContain('120,00')
      expect(bezahlt, lang).not.toContain('120,00')
      // Ohne Zahlungsziel steht auch keines da -- ein leeres Datum im Satz
      // waere schlimmer als gar keine Frist.
      const ohneFrist = renderInvoiceEmail({ ...rechnung, dueDate: null }, lang).text
      expect(ohneFrist, lang).not.toContain('2026-10-15')
    }
  })
})

describe('Sprachwahl am Gastprofil', () => {
  it('nimmt jede angebotene Sprache an', () => {
    for (const lang of EMAIL_LANGUAGES) expect(emailLanguage(lang)).toBe(lang)
  })

  /**
   * Am Profil steht mal `en`, mal `en-GB`. Einen Gast deutsch anzuschreiben,
   * weil sein Profil die Region mitfuehrt, waere eine seltsame Art, genau
   * zu sein.
   */
  it('versteht eine Sprache mit Region und ignoriert Gross- und Kleinschreibung', () => {
    expect(emailLanguage('en-GB')).toBe('en')
    expect(emailLanguage('NL')).toBe('nl')
    expect(emailLanguage('pl_PL')).toBe('pl')
  })

  /** Was wir nicht schreiben, geht auf Deutsch hinaus -- und nicht gar nicht. */
  it('faellt bei einer unbekannten Sprache auf Deutsch zurueck', () => {
    for (const unbekannt of ['fr', 'zz', '', null, undefined]) {
      expect(emailLanguage(unbekannt)).toBe('de')
    }
  })
})
