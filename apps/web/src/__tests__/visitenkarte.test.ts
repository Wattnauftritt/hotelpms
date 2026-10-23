import { describe, it, expect } from 'vitest'
import { anschriftAusKarte, vorschlagErgaenzen, zeilenAusBoxen, zuweisen, zugeordnet,
         type AnschriftVorschlag, type KartenZeile }
  from '../lib/visitenkarte.js'
import { leserAnlegen } from '../lib/leser.js'

/**
 * Der Vorschlag aus dem Text einer Visitenkarte. Geprueft wird an Karten,
 * wie sie an einer Rezeption tatsaechlich liegen: Anschrift in einer Zeile
 * oder in mehreren, Name gross oben oder nur an der Rechtsform erkennbar,
 * Vorder- und Rueckseite getrennt.
 */

const zeilen = (...t: Array<string | [string, number]>): KartenZeile[] =>
  t.map(z => (typeof z === 'string' ? { text: z, hoehe: 1 } : { text: z[0], hoehe: z[1] }))

describe('Anschrift aus einer Visitenkarte', () => {
  it('liest eine deutsche Karte mit Anschrift in zwei Zeilen', () => {
    const v = anschriftAusKarte(zeilen(
      ['Max Mustermann', 1.4],
      'Vertriebsleiter',
      ['Nordsee Logistik GmbH', 1.2],
      'Hafenstraße 12a',
      '27472 Cuxhaven',
      'Tel. 04721 123456',
      'max.mustermann@nordsee-logistik.de',
      'www.nordsee-logistik.de'))
    expect(v).toEqual({
      name: 'Nordsee Logistik GmbH', contactName: 'Max Mustermann',
      addressLine1: 'Hafenstraße 12a', postalCode: '27472', city: 'Cuxhaven', country: 'DE',
      vatId: '', invoiceEmail: ''
    })
  })

  it('trennt eine Anschrift, die in einer Zeile steht', () => {
    const v = anschriftAusKarte(zeilen(
      ['Elbe Werft AG', 1.6],
      'Am Deich 5 · D-21720 Grünendeich',
      'Fon +49 4141 9988 | Fax +49 4141 9989'))
    expect(v.name).toBe('Elbe Werft AG')
    expect(v.addressLine1).toBe('Am Deich 5')
    expect(v.postalCode).toBe('21720')
    expect(v.city).toBe('Grünendeich')
    expect(v.country).toBe('DE')
  })

  it('nimmt ohne Rechtsform die groesste Zeile als Namen', () => {
    const v = anschriftAusKarte(zeilen(
      'Ihr Partner für Reisen',
      ['Reisebüro Sonnenschein', 2.1],
      'Marktplatz 3, 26122 Oldenburg'))
    expect(v.name).toBe('Reisebüro Sonnenschein')
    expect(v.addressLine1).toBe('Marktplatz 3')
    expect(v.city).toBe('Oldenburg')
  })

  it('erkennt Oesterreich an der Kennung vor der Postleitzahl', () => {
    const v = anschriftAusKarte(zeilen('Alpen Consulting KG', 'Ringstraße 7', 'A-1010 Wien'))
    expect(v.country).toBe('AT')
    expect(v.postalCode).toBe('1010')
    expect(v.city).toBe('Wien')
  })

  it('erkennt eine niederlaendische Postleitzahl', () => {
    const v = anschriftAusKarte(zeilen('Van Dijk Transport B.V.', 'Havenweg 21',
                                       '1013 AB Amsterdam', 'Nederland'))
    expect(v).toMatchObject({ name: 'Van Dijk Transport B.V.', addressLine1: 'Havenweg 21',
                              postalCode: '1013 AB', city: 'Amsterdam', country: 'NL' })
  })

  it('laesst den Landesnamen nicht im Ort stehen', () => {
    const v = anschriftAusKarte(zeilen('Muster SE', 'Hauptstr. 1', '8001 Zürich Schweiz'))
    expect(v.city).toBe('Zürich')
    expect(v.country).toBe('CH')
  })

  it('liest die USt-IdNr. mit und ohne Beschriftung', () => {
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'USt-IdNr.: DE 123 456 789')).vatId)
      .toBe('DE123456789')
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'DE123456789')).vatId).toBe('DE123456789')
    const at = anschriftAusKarte(zeilen('Muster GmbH', 'UID ATU12345678'))
    expect(at.vatId).toBe('ATU12345678')
    // Ohne Ortszeile verraet die Nummer das Land.
    expect(at.country).toBe('AT')
  })

  it('haelt Telefon- und Faxnummern nicht fuer eine Anschrift', () => {
    const v = anschriftAusKarte(zeilen('Muster GmbH', 'Telefon 04721 12345', 'Fax 04721 12346'))
    expect(v.addressLine1).toBe('')
    expect(v.postalCode).toBe('')
    expect(v.city).toBe('')
  })

  it('laesst Felder leer, die die Karte nicht hergibt', () => {
    expect(anschriftAusKarte(zeilen('ä', '???'))).toEqual({
      name: '', contactName: '', addressLine1: '', postalCode: '', city: '', country: '',
      vatId: '', invoiceEmail: ''
    })
  })

  it('setzt eine allein stehende Rechtsform an den Namen darueber', () => {
    // So las die Erkennung eine echte Vorderseite: Name gross, Rechtsform klein darunter.
    expect(anschriftAusKarte(zeilen(['KÜSTENBAU', 2], 'GmbH & Co. KG')).name)
      .toBe('KÜSTENBAU GmbH & Co. KG')
  })

  it('findet Name und Anschrift ueber Vorder- und Rueckseite', () => {
    const vorn = zeilen(['Küstenbau GmbH & Co. KG', 1.8], 'Bauen an der Nordsee')
    const hinten = zeilen('Deichstraße 40', '27472 Cuxhaven', 'info@kuestenbau.de')
    expect(anschriftAusKarte([...vorn, ...hinten])).toMatchObject({
      name: 'Küstenbau GmbH & Co. KG', addressLine1: 'Deichstraße 40',
      postalCode: '27472', city: 'Cuxhaven'
    })
  })
})

describe('Weitere Seite einarbeiten', () => {
  it('fuellt nur, was noch leer ist, und laesst Korrekturen stehen', () => {
    const korrigiert = { name: 'Küstenbau GmbH', contactName: '', addressLine1: '',
                         postalCode: '', city: '', country: 'DE', vatId: '', invoiceEmail: '' }
    const neu = { name: 'Kustenbau GmbH', contactName: 'Anja Schröder',
                  addressLine1: 'Deichstraße 40', postalCode: '27472', city: 'Cuxhaven',
                  country: 'DE', vatId: 'DE123456789', invoiceEmail: '' }
    expect(vorschlagErgaenzen(korrigiert, neu)).toEqual({
      name: 'Küstenbau GmbH', contactName: 'Anja Schröder', addressLine1: 'Deichstraße 40',
      postalCode: '27472', city: 'Cuxhaven', country: 'DE', vatId: 'DE123456789',
      invoiceEmail: ''
    })
  })
})

describe('Zeilen aus einer Erkennung', () => {
  it('ordnet ungeordnete Zeilen von oben nach unten und in einer Hoehe von links', () => {
    // So liefert Apple Vision: in keiner verlaesslichen Reihenfolge.
    const z = zeilenAusBoxen([
      { text: '27472 Cuxhaven', oben: 300, unten: 330, links: 10 },
      { text: 'Nordsee GmbH', oben: 10, unten: 70, links: 10 },
      { text: 'Hafenstraße 1', oben: 250, unten: 280, links: 10 },
      { text: 'Fax 2', oben: 352, unten: 380, links: 300 },
      { text: 'Tel 1', oben: 350, unten: 380, links: 10 }
    ], { sortieren: true })
    expect(z.map(x => x.text))
      .toEqual(['Nordsee GmbH', 'Hafenstraße 1', '27472 Cuxhaven', 'Tel 1', 'Fax 2'])
    // Die Hoehe zaehlt im Verhaeltnis zur mittleren Zeile: der Name ist doppelt so gross.
    expect(z[0]!.hoehe).toBe(2)
  })

  it('laesst die Reihenfolge stehen, wenn die Erkennung sie schon liefert', () => {
    const z = zeilenAusBoxen([
      { text: 'b', oben: 50, unten: 60, links: 0 },
      { text: 'a', oben: 10, unten: 20, links: 0 },
      { text: '  ', oben: 0, unten: 5, links: 0 }
    ], { sortieren: false })
    expect(z.map(x => x.text)).toEqual(['b', 'a'])
  })
})

describe('Wer die Karte liest', () => {
  it('nimmt die Erkennung der App, wenn die App sie anbietet', async () => {
    const vorher = (globalThis as { window?: unknown }).window
    let gelesen = 0
    ;(globalThis as { window?: unknown }).window = {
      staygridNative: {
        texterkennung: {
          erkennen: async () => {
            gelesen++
            return { zeilen: [{ text: 'Muster GmbH', oben: 0, unten: 10, links: 0 }] }
          }
        }
      }
    }
    try {
      const leser = await leserAnlegen()
      const r = await leser.lesen(new Blob(), () => {})
      expect(gelesen).toBe(1)
      expect(r.text).toBe('Muster GmbH')
      await leser.beenden()
      await expect(leser.lesen(new Blob(), () => {})).rejects.toThrow()
    } finally {
      ;(globalThis as { window?: unknown }).window = vorher
    }
  })
})

/**
 * Karten, wie die Erkennung des Telefons sie zurueckgibt (Sven, 22.10.2026:
 * „erkennt die Strasse, traegt sie aber nicht ein"). Vision und ML Kit
 * liefern Zeilen ohne die Trennzeichen, die ein Mensch sieht: ein senkrechter
 * Strich wird zum grossen I, ein Punkt in der Mitte faellt weg, und bei zwei
 * Spalten liegt zwischen Strasse und Ort eine Zeile der anderen Spalte.
 */
describe('Anschrift aus der Erkennung des Telefons', () => {
  const ziel = { addressLine1: 'Hafenstraße 12a', postalCode: '27472', city: 'Cuxhaven' }

  it('trennt Strasse und Ort ohne Trennzeichen in einer Zeile', () => {
    expect(anschriftAusKarte(zeilen('Nordsee Logistik GmbH', 'Hafenstraße 12a 27472 Cuxhaven')))
      .toMatchObject(ziel)
  })

  it('liest einen senkrechten Strich, den die Erkennung als I oder l liest', () => {
    for (const strich of ['I', 'l', '|', '/', '–', '-']) {
      expect(anschriftAusKarte(zeilen('Nordsee Logistik GmbH',
                                      `Hafenstraße 12a ${strich} 27472 Cuxhaven`)))
        .toMatchObject(ziel)
    }
  })

  it('findet die Strasse auch zwei Zeilen ueber dem Ort', () => {
    // Zwei Spalten, nach Hoehe sortiert: links Kontakt, rechts Anschrift.
    expect(anschriftAusKarte(zeilen(
      ['Nordsee Logistik GmbH', 1.6],
      'Tel. 04721 123456', 'Hafenstraße 12a',
      'Fax 04721 123457', '27472 Cuxhaven'))).toMatchObject(ziel)
  })

  it('nimmt die Strasse mit Satzzeichen am Ende, Abkuerzung oder Beschriftung', () => {
    for (const s of ['Hafenstraße 12a,', 'Anschrift: Hafenstraße 12a', 'Adresse Hafenstraße 12a']) {
      expect(anschriftAusKarte(zeilen('Muster GmbH', s, '27472 Cuxhaven')).addressLine1)
        .toBe('Hafenstraße 12a')
    }
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'Hafenstr 12', '27472 Cuxhaven')).addressLine1)
      .toBe('Hafenstr 12')
    // "ß" als "B" gelesen: so steht es da, die Rezeption korrigiert den Buchstaben.
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'HafenstraBe 12', '27472 Cuxhaven')).addressLine1)
      .toBe('HafenstraBe 12')
  })

  it('nimmt Strassen ohne Strassenwort, wenn die Hausnummer folgt', () => {
    for (const s of ['Neuer Wall 10', 'An der Alster 1', 'Bei den Mühren 70', 'Straße des 17. Juni 112']) {
      expect(anschriftAusKarte(zeilen('Muster GmbH', s, '20095 Hamburg')).addressLine1).toBe(s)
    }
  })

  it('schneidet am Ort ab, was danach in der Zeile steht', () => {
    for (const z of ['27472 Cuxhaven Tel. 04721 1234', '27472 Cuxhaven · www.muster.de',
                     '27472 Cuxhaven Germany', 'D-27472 Cuxhaven, Deutschland']) {
      const v = anschriftAusKarte(zeilen('Muster GmbH', 'Hafenstraße 12a', z))
      expect(v.city, z).toBe('Cuxhaven')
      expect(v.postalCode, z).toBe('27472')
    }
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'Am Hafen 1', '60311 Frankfurt am Main')).city)
      .toBe('Frankfurt am Main')
    expect(anschriftAusKarte(zeilen('Muster GmbH', 'Am Hafen 1', '27476 Cuxhaven-Döse')).city)
      .toBe('Cuxhaven-Döse')
  })

  it('haelt eine Telefonnummer nie fuer Postleitzahl und Ort', () => {
    const v = anschriftAusKarte(zeilen('Muster GmbH', '+49 4721 12345 Zentrale', '0170 12345 Mobil',
                                       'Hafenstraße 12a', '27472 Cuxhaven'))
    expect(v).toMatchObject(ziel)
  })

  it('nimmt als Namen die Firma und nicht die Person darueber', () => {
    // Person gross, Firma klein, ohne Rechtsform: die Mailadresse verraet sie.
    const v = anschriftAusKarte(zeilen(
      ['Anna Schröder', 2], 'Geschäftsführerin', ['Küstenbau', 1.2],
      'Deichstraße 40', '27472 Cuxhaven', 'a.schroeder@kuestenbau.de'))
    expect(v.name).toBe('Küstenbau')
  })

  it('nimmt ohne andere Hinweise nicht die Zeile ueber der Berufsbezeichnung', () => {
    const v = anschriftAusKarte(zeilen(
      ['Anna Schröder', 2], 'Projektleitung', ['Hotelbedarf Nord', 1.3],
      'Deichstraße 40', '27472 Cuxhaven'))
    expect(v.name).toBe('Hotelbedarf Nord')
  })
})

describe('Ansprechpartner', () => {
  it('nimmt den Namen ueber der Berufsbezeichnung, auch wenn die Firma groesser ist', () => {
    const v = anschriftAusKarte(zeilen(
      ['Küstenbau GmbH & Co. KG', 1.8], ['Anja Schröder', 1.3], 'Projektleitung',
      'Deichstraße 40 | 27472 Cuxhaven'))
    expect(v).toMatchObject({ name: 'Küstenbau GmbH & Co. KG', contactName: 'Anja Schröder' })
  })

  it('nimmt den Namen neben der Berufsbezeichnung in derselben Zeile', () => {
    const v = anschriftAusKarte(zeilen(
      ['Nordsee Logistik GmbH', 1.5], 'Dr. Max Mustermann | Geschäftsführer', '27472 Cuxhaven'))
    expect(v.contactName).toBe('Dr. Max Mustermann')
  })

  it('erkennt den Menschen an seiner Mailadresse und haelt ihn aus dem Firmennamen', () => {
    // Groesser als die Firma und ohne Berufsbezeichnung: nur die Mail verraet ihn.
    const v = anschriftAusKarte(zeilen(
      ['Jan de Vries', 1.6], ['Elbe Consult', 1.2], 'Bei den Mühren 70', '20457 Hamburg',
      'jan.devries@elbe-consult.de'))
    expect(v).toMatchObject({ name: 'Elbe Consult', contactName: 'Jan de Vries' })
  })

  it('laesst das Feld leer, wenn nichts auf einen Menschen hinweist', () => {
    const v = anschriftAusKarte(zeilen(
      ['Elbe Consult', 1.6], 'Hafenstraße 12', '27472 Cuxhaven', 'info@elbe-consult.de'))
    expect(v).toMatchObject({ name: 'Elbe Consult', contactName: '' })
  })

  it('uebernimmt die Mailadresse nie von selbst', () => {
    const v = anschriftAusKarte(zeilen('Nordsee GmbH', 'rechnung@nordsee.de'))
    expect(v.invoiceEmail).toBe('')
  })
})

describe('Erkannten Text von Hand zuordnen', () => {
  const leer: AnschriftVorschlag = { name: '', contactName: '', addressLine1: '', postalCode: '',
    city: '', country: '', vatId: '', invoiceEmail: '' }

  it('teilt PLZ und Ort auf zwei Felder und erkennt das Land an der Kennung', () => {
    expect(zuweisen(leer, 'ort', '27472 Cuxhaven')).toMatchObject(
      { postalCode: '27472', city: 'Cuxhaven', country: 'DE' })
    expect(zuweisen(leer, 'ort', 'A-1010 Wien')).toMatchObject(
      { postalCode: '1010', city: 'Wien', country: 'AT' })
    expect(zuweisen(leer, 'ort', 'Cuxhaven')).toMatchObject({ postalCode: '', city: 'Cuxhaven' })
  })

  it('nimmt Beschriftung und Satzzeichen von der Strasse', () => {
    expect(zuweisen(leer, 'addressLine1', 'Anschrift: Hafenstr. 12,').addressLine1)
      .toBe('Hafenstr. 12')
  })

  it('setzt einen Firmennamen ueber zwei Zeilen fort', () => {
    const v = zuweisen(zuweisen(leer, 'name', 'Küstenbau'), 'nameAnhaengen', 'GmbH & Co. KG')
    expect(v.name).toBe('Küstenbau GmbH & Co. KG')
  })

  it('liest USt-IdNr., Mail und Land aus der beschrifteten Zeile', () => {
    expect(zuweisen(leer, 'vatId', 'USt-IdNr.: DE 123 456 789').vatId).toBe('DE123456789')
    expect(zuweisen(leer, 'invoiceEmail', 'E-Mail: buchhaltung@nordsee.de').invoiceEmail)
      .toBe('buchhaltung@nordsee.de')
    expect(zuweisen(leer, 'country', 'Germany').country).toBe('DE')
    // Was kein Land ist, laesst das Feld stehen.
    expect(zuweisen({ ...leer, country: 'DE' }, 'country', 'Hamburg').country).toBe('DE')
  })

  it('zeigt, in welchem Feld ein Stueck steht', () => {
    const v = { ...leer, name: 'Küstenbau GmbH & Co. KG', addressLine1: 'Deichstraße 40',
                postalCode: '27472', city: 'Cuxhaven' }
    expect(zugeordnet(v, 'KÜSTENBAU')).toEqual(['name'])
    expect(zugeordnet(v, 'Deichstraße 40,')).toEqual(['addressLine1'])
    expect(zugeordnet(v, '27472 Cuxhaven')).toEqual(['ort'])
    expect(zugeordnet(v, 'Tel. 04721 123456')).toEqual([])
    // Der Name in der Mailadresse macht die Zeile nicht zum Ansprechpartner.
    expect(zugeordnet({ ...v, contactName: 'Max Mustermann' },
                      'Tel. 04721 123456 + max.mustermann@nordsee.de')).toEqual([])
  })
})
