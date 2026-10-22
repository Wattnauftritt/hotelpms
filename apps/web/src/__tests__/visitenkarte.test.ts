import { describe, it, expect } from 'vitest'
import { anschriftAusKarte, vorschlagErgaenzen, zeilenAusBoxen, type KartenZeile }
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
      name: 'Nordsee Logistik GmbH', addressLine1: 'Hafenstraße 12a',
      postalCode: '27472', city: 'Cuxhaven', country: 'DE', vatId: ''
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
      name: '', addressLine1: '', postalCode: '', city: '', country: '', vatId: ''
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
    const korrigiert = { name: 'Küstenbau GmbH', addressLine1: '', postalCode: '',
                         city: '', country: 'DE', vatId: '' }
    const neu = { name: 'Kustenbau GmbH', addressLine1: 'Deichstraße 40', postalCode: '27472',
                  city: 'Cuxhaven', country: 'DE', vatId: 'DE123456789' }
    expect(vorschlagErgaenzen(korrigiert, neu)).toEqual({
      name: 'Küstenbau GmbH', addressLine1: 'Deichstraße 40', postalCode: '27472',
      city: 'Cuxhaven', country: 'DE', vatId: 'DE123456789'
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
