import { describe, it, expect } from 'vitest'
import { trenneHausnummer, staatsangehoerigkeit, landName, alterAm, avsDateiname, avsXml }
  from '../avs.js'

/**
 * Die Datei fuer AVS (Migration 0091). AVS hat keine Updateschnittstelle:
 * was hier falsch herauskommt, korrigiert die Rezeption in AVS von Hand.
 */

describe('Strasse und Hausnummer', () => {
  it.each([
    ['Deichweg 4a', 'Deichweg', '4a'],
    ['Am Hafen 12-14', 'Am Hafen', '12-14'],
    ['Strandstr. 3 b', 'Strandstr.', '3b'],
    ['Straße des 17. Juni 5', 'Straße des 17. Juni', '5'],
    ['Musterweg 7/2', 'Musterweg', '7/2']
  ])('%s', (zeile, strasse, hausnummer) => {
    expect(trenneHausnummer(zeile)).toEqual({ strasse, hausnummer })
  })

  it('raet nicht, wo keine Nummer steht', () => {
    // Das Adminpanel machte aus "Am Deich" die Hausnummer "Deich".
    expect(trenneHausnummer('Am Deich')).toEqual({ strasse: 'Am Deich', hausnummer: '' })
    expect(trenneHausnummer(null)).toEqual({ strasse: '', hausnummer: '' })
  })
})

describe('Ausgeschriebene Werte', () => {
  it('schreibt die Staatsangehoerigkeit als Adjektiv, sonst den Landesnamen', () => {
    expect(staatsangehoerigkeit('DE')).toBe('deutsch')
    expect(staatsangehoerigkeit('nl')).toBe('niederländisch')
    expect(staatsangehoerigkeit('PE')).toBe(landName('PE'))
    expect(staatsangehoerigkeit(null)).toBe('')
  })

  it('rechnet das Alter in Kalenderdaten', () => {
    expect(alterAm('2010-10-05', '2026-10-04')).toBe(15)
    expect(alterAm('2010-10-05', '2026-10-05')).toBe(16)
  })

  it('benennt die Datei in Ortszeit des Hauses', () => {
    // 22:30 UTC im Sommer ist 00:30 in Berlin, am naechsten Tag.
    expect(avsDateiname('StayGrid', new Date('2026-07-01T22:30:00Z')))
      .toBe('StayGrid_2026-07-02_00-30.xml')
  })
})

describe('XML', () => {
  const einstellung = { hotelId: '4711', origin: 'StayGrid', userName: 'StayGrid' }
  const person = { lastName: 'Müller & Söhne', firstName: 'A<b>', birthDate: null,
                   nationality: 'DE', category: 1, email: null, idDocumentNumber: null }

  it('maskiert Sonderzeichen und laesst leere Felder weg, die Hausnummer nicht', () => {
    const x = avsXml(einstellung, [{ arrival: '2026-10-05', departure: '2026-10-08',
      main: { ...person, addressLine1: 'Hof\tSonnenschein', postalCode: null, city: 'Cuxhaven',
              country: 'DE', lodgingCent: 15000 }, companions: [] }])
    expect(x).toContain('<name>Müller &amp; Söhne</name>')
    expect(x).toContain('<vorname>A&lt;b&gt;</vorname>')
    expect(x).toContain('<hausnummer></hausnummer>')
    expect(x).not.toContain('<plz>')
    expect(x).not.toContain('<gebdatum>')
    expect(x).toContain('<ue-e-gelt>150.00</ue-e-gelt>')
    expect(x).toContain('<land>Deutschland</land>')
  })
})
