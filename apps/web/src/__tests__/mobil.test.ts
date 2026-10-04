import { describe, it, expect } from 'vitest'
import type { TapeChart } from '@hotelpms/contracts'
import { balkenSpanne, zimmerAmTag, zimmerGruppen, istFrei, mobilFenster, WOCHE_TAGE }
  from '../lib/mobil.js'
import { vorrang } from '../components/mobil/MobilZimmer.tsx'
import { resolveScreen } from '../screens.js'

/**
 * Die Rechnung der Mobilansicht. Geprueft wird, wo ein Balken steht und was
 * ein Zimmer an einem Tag ist -- ein Fehler dort sieht plausibel aus und
 * schickt die Rezeption in ein belegtes Zimmer.
 */

type Res = TapeChart['reservations'][number]
type Einheit = TapeChart['units'][number]

function res(over: Partial<Res>): Res {
  return {
    id: 1, public_ref: 'R1', resource_id: 10, category_id: 1,
    arrival: '2026-10-04', departure: '2026-10-07', status: 'Confirmed',
    last_name: 'Kuehl', first_name: null, booking_ref: 'B1', booking_rooms: 1,
    source: 'direct', external_reference: null, rate_code: null, occupants: 2,
    guest_count: null, adults: null, children: null, category_max_occupancy: 2,
    short_note: null, notes: null, ...over
  }
}

function einheit(id: number, floor: string | null, kategorie = 'Doppelzimmer'): Einheit {
  return { id, code: String(id), name: null, floor, category_id: 1,
           category_name: kategorie, category_code: 'DZ', max_occupancy: 2, sort_order: id }
}

describe('Balken in der Wochenansicht', () => {
  it('laeuft von der Mitte des Anreisetags bis zur Mitte des Abreisetags', () => {
    // 4. bis 7.: drei Naechte, Beginn in der Mitte von Tag 0, Ende in der von Tag 3.
    const s = balkenSpanne('2026-10-04', 7, '2026-10-04', '2026-10-07')!
    expect(s.start).toBeCloseTo(0.5 / 7)
    expect(s.ende).toBeCloseTo(3.5 / 7)
    expect(s.offenLinks).toBe(false)
    expect(s.offenRechts).toBe(false)
  })

  it('schneidet am Rand ab und sagt, dass es weitergeht', () => {
    const s = balkenSpanne('2026-10-04', 7, '2026-09-30', '2026-10-20')!
    expect(s.start).toBe(0)
    expect(s.ende).toBe(1)
    expect(s.offenLinks).toBe(true)
    expect(s.offenRechts).toBe(true)
  })

  it('zeigt die Abreise am ersten Tag als halben Tag, eine fruehere gar nicht', () => {
    const s = balkenSpanne('2026-10-04', 7, '2026-10-01', '2026-10-04')!
    expect(s.start).toBe(0)
    expect(s.ende).toBeCloseTo(0.5 / 7)
    expect(balkenSpanne('2026-10-04', 7, '2026-10-01', '2026-10-03')).toBeNull()
  })

  it('zeigt eine Anreise am letzten Tag, eine spaetere nicht', () => {
    expect(balkenSpanne('2026-10-04', 7, '2026-10-10', '2026-10-12')).not.toBeNull()
    expect(balkenSpanne('2026-10-04', 7, '2026-10-11', '2026-10-12')).toBeNull()
  })

  it('rechnet ueber die Zeitumstellung mit Kalendertagen', () => {
    // 25.10.2026 ist die Umstellung auf Winterzeit; ein Tag bleibt ein Tag.
    const s = balkenSpanne('2026-10-24', 7, '2026-10-25', '2026-10-26')!
    expect(s.start).toBeCloseTo(1.5 / 7)
    expect(s.ende).toBeCloseTo(2.5 / 7)
  })
})

describe('Ein Zimmer an einem Tag', () => {
  const tag = '2026-10-04'

  it('ist frei ohne Buchung', () => {
    expect(zimmerAmTag(10, tag, [], []).lage).toBe('frei')
  })

  it('erkennt Bleiben, Anreise, Abreise und den Wechsel', () => {
    expect(zimmerAmTag(10, tag, [res({ arrival: '2026-10-01', departure: '2026-10-08' })], []).lage)
      .toBe('belegt')
    expect(zimmerAmTag(10, tag, [res({})], []).lage).toBe('anreise')
    expect(zimmerAmTag(10, tag, [res({ arrival: '2026-10-01', departure: tag })], []).lage)
      .toBe('abreise')
    const wechsel = zimmerAmTag(10, tag, [
      res({ public_ref: 'GEHT', arrival: '2026-10-01', departure: tag, status: 'CheckedOut' }),
      res({ public_ref: 'KOMMT' })], [])
    expect(wechsel.lage).toBe('wechsel')
    // Antippen oeffnet, wer kommt -- um den geht es heute.
    expect(wechsel.reservierung?.public_ref).toBe('KOMMT')
  })

  it('zaehlt Storno und No-Show nicht als Belegung', () => {
    expect(zimmerAmTag(10, tag, [res({ status: 'Canceled' })], []).lage).toBe('frei')
    expect(zimmerAmTag(10, tag, [res({ status: 'NoShow' })], []).lage).toBe('frei')
  })

  it('sieht nur das eigene Zimmer', () => {
    expect(zimmerAmTag(11, tag, [res({})], []).lage).toBe('frei')
  })

  it('stellt eine Sperre vor alles andere', () => {
    const sperre = { resource_id: 10, from_date: '2026-10-03', to_date: '2026-10-05',
                     kind: 'out_of_order', reason: 'Wasserschaden' }
    expect(zimmerAmTag(10, tag, [], [sperre]).lage).toBe('gesperrt')
    // Das Ende einer Sperre ist ausschliesslich, wie die Abreise.
    expect(zimmerAmTag(10, '2026-10-05', [], [sperre]).lage).toBe('frei')
  })

  it('nennt ein Zimmer mit Abreise frei, eines mit Anreise nicht', () => {
    expect(istFrei('abreise')).toBe(true)
    expect(istFrei('anreise')).toBe(false)
    expect(istFrei('wechsel')).toBe(false)
    expect(istFrei('gesperrt')).toBe(false)
  })
})

describe('Zimmergruppen', () => {
  const etage = (n: string): string => `Etage ${n}`

  it('ordnet nach Etage, in der Reihenfolge des Plans', () => {
    const g = zimmerGruppen([einheit(101, '1. OG'), einheit(201, '2. OG'),
                             einheit(102, '1. OG')], 'Ohne Etage', etage)
    expect(g.map(x => [x.name, x.zimmer.map(z => z.id)]))
      .toEqual([['1. OG', [101, 102]], ['2. OG', [201]]])
  })

  it('nimmt ohne gepflegte Etagen die Zimmergruppe', () => {
    const g = zimmerGruppen([einheit(1, null, 'Einzel'), einheit(2, null, 'Doppel')], 'x', etage)
    expect(g.map(x => x.name)).toEqual(['Einzel', 'Doppel'])
  })

  it('sammelt Zimmer ohne Etage in einem Haus mit Etagen eigens', () => {
    const g = zimmerGruppen([einheit(1, '1. OG'), einheit(2, '')], 'Ohne Etage', etage)
    expect(g.map(x => x.name)).toEqual(['1. OG', 'Ohne Etage'])
  })

  it('setzt vor eine blosse Etagennummer das Wort', () => {
    const g = zimmerGruppen([einheit(1, '1'), einheit(2, '0'), einheit(3, 'Gaestehaus')],
                            'Ohne Etage', etage)
    expect(g.map(x => x.name)).toEqual(['Etage 1', 'Etage 0', 'Gaestehaus'])
  })
})

describe('Fenster der Mobilansicht', () => {
  it('holt den Vortag mit, damit die Abreise am ersten Tag dabei ist', () => {
    expect(mobilFenster('2026-10-04'))
      .toEqual({ von: '2026-10-03', bis: '2026-10-11' })
    expect(WOCHE_TAGE).toBe(7)
  })
})

describe('Zimmerstatus am Telefon', () => {
  it('gibt einem schmutzigen Zimmer mit Anreise heute Vorrang', () => {
    expect(vorrang({ status: 'dirty', arrivalRef: 'R1' })).toBe(true)
    expect(vorrang({ status: 'dirty', arrivalRef: null })).toBe(false)
    expect(vorrang({ status: 'clean', arrivalRef: 'R1' })).toBe(false)
  })
})

describe('Startbildschirm', () => {
  const rechte = ['reservation:read', 'housekeeping:read']

  it('beginnt am Telefon mit Heute, am Desktop mit dem Plan', () => {
    expect(resolveScreen(null, rechte, false, 'today')?.key).toBe('today')
    expect(resolveScreen(null, rechte)?.key).toBe('tape')
  })

  it('laesst die Adresse vorgehen', () => {
    expect(resolveScreen('housekeeping', rechte, false, 'today')?.key).toBe('housekeeping')
  })

  it('faellt ohne Recht auf Heute auf den ersten erlaubten zurueck', () => {
    expect(resolveScreen(null, ['housekeeping:read'], false, 'today')?.key).toBe('housekeeping')
  })
})
