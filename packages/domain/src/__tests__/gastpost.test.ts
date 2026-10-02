import { describe, it, expect } from 'vitest'
import { EMAIL_LANGUAGES, emailLanguage, renderInvoiceEmail, renderReservationEmail,
         renderPaymentLinkEmail, type EmailLanguage } from '../email.js'

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

const zahlung = {
  propertyName: 'Hotel Nordsee', guestName: 'Anna Beispiel',
  reservationRef: 'ABC123', arrival: '2026-10-01', departure: '2026-10-04',
  amountCent: 10_470, currency: 'EUR', dueDate: '2026-09-20', deposit: true,
  validUntil: '2026-09-27',
  url: 'https://app.staygrid.test/v1/pay?t=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
}

/** Alles, was ein Gast zu sehen bekommt, in einer Zeichenkette. */
function alles(lang: EmailLanguage): string[] {
  return [
    renderInvoiceEmail(rechnung, lang),
    renderInvoiceEmail({ ...rechnung, dueDate: null }, lang),
    renderInvoiceEmail({ ...rechnung, openCent: 0, dueDate: null }, lang),
    renderInvoiceEmail({ ...rechnung, guestName: null }, lang),
    renderReservationEmail(buchung, lang),
    renderReservationEmail({ ...buchung, guestName: null }, lang),
    renderPaymentLinkEmail(zahlung, lang),
    renderPaymentLinkEmail({ ...zahlung, dueDate: null }, lang),
    renderPaymentLinkEmail({ ...zahlung, deposit: false, dueDate: null }, lang),
    renderPaymentLinkEmail({ ...zahlung, guestName: null }, lang)
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

describe('Zahlungslink an den Gast', () => {
  it('traegt Link, Betrag, Aufenthalt und Frist in jeder Sprache', () => {
    for (const lang of EMAIL_LANGUAGES) {
      const m = renderPaymentLinkEmail(zahlung, lang)
      expect(m.text, lang).toContain(zahlung.url)
      expect(m.html, lang).toContain(zahlung.url)
      expect(m.text, lang).toContain('104,70 EUR')
      expect(m.subject, lang).toContain('ABC123')
      // Englisch schreibt ISO, damit "03/04" niemand falsch herum liest;
      // die anderen den Tag zuerst.
      expect(m.text, lang).toContain(lang === 'en' ? '2026-09-20'
        : lang === 'nl' ? '20-09-2026' : '20.09.2026')
      // Bis wann der Link gilt -- seit 0059 Tage, nicht Stunden.
      expect(m.text, lang).toContain(lang === 'en' ? '2026-09-27'
        : lang === 'nl' ? '27-09-2026' : '27.09.2026')
    }
  })

  /**
   * Der Link steht allein in seinem Absatz. In einen Satz eingebettet bricht
   * ihn mancher Leser am Punkt danach um, und der Gast landet auf einer
   * Fehlerseite statt beim Anbieter.
   */
  it('setzt den Link als eigenen Absatz', () => {
    for (const lang of EMAIL_LANGUAGES) {
      const absaetze = renderPaymentLinkEmail(zahlung, lang).text.split('\n\n')
      expect(absaetze, lang).toContain(zahlung.url)
    }
  })

  it('nennt ohne Anforderung weder Anzahlung noch Frist', () => {
    const frei = renderPaymentLinkEmail({ ...zahlung, deposit: false, dueDate: null }, 'de')
    expect(frei.text).not.toContain('Anzahlung')
    expect(frei.text).not.toContain('20.09.2026')
    expect(renderPaymentLinkEmail(zahlung, 'de').text).toContain('Anzahlung')
  })

  it('entschaerft einen Gastnamen im HTML-Teil', () => {
    const m = renderPaymentLinkEmail({ ...zahlung, guestName: '<b>Eva</b>' }, 'de')
    expect(m.html).not.toContain('<b>Eva</b>')
    expect(m.html).toContain('&lt;b&gt;Eva&lt;/b&gt;')
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
