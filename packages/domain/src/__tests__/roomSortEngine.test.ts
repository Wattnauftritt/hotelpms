import { describe, it, expect } from 'vitest'
import { sortRooms, wishesFromText, type SortRoom, type SortStay } from '../roomSortEngine.js'
import { resolveRoomSortWeights } from '../roomSort.js'

/**
 * Der Sortierer gegen die Regeln, die das Adminpanel ueber Monate am
 * echten Haus gelernt hat (Antwort vom 07.10.2026). Jeder Fall hier ist
 * einer, der dort einmal schiefging oder ausdruecklich gewollt war.
 */

const W = resolveRoomSortWeights({})
const GAESTEHAUS = resolveRoomSortWeights({ pricePercent: 0 })

let nr = 0
function zimmer(code: string, quality: number, over: Partial<SortRoom> = {}): SortRoom {
  return { id: Number(code), categoryId: 1, code, quality, floor: null, building: null,
           attributes: [], blocked: [], ...over }
}
function gast(arrival: string, departure: string, over: Partial<SortStay> = {}): SortStay {
  nr++
  return { id: nr, bookingId: nr, categoryId: 1, arrival, departure, resourceId: null,
           fixed: false, pricePerNightCent: null, text: '', ...over }
}

/** Wo jeder nach dem Sortieren liegt. */
function nachher(stays: SortStay[], r: ReturnType<typeof sortRooms>): Map<number, number | null> {
  const m = new Map(stays.map(s => [s.id, s.resourceId]))
  for (const z of r.moves) m.set(z.stayId, z.toRoomId)
  return m
}

/** Keine zwei ueberlappenden Aufenthalte im selben Zimmer. */
function ohneDoppelbelegung(stays: SortStay[], lage: Map<number, number | null>): boolean {
  for (const a of stays) {
    for (const b of stays) {
      if (a.id >= b.id) continue
      const ra = lage.get(a.id)
      if (ra === null || ra !== lage.get(b.id)) continue
      if (a.arrival < b.departure && b.arrival < a.departure) return false
    }
  }
  return true
}

describe('Gaestehaus: laengster Aufenthalt ins schoenste Zimmer', () => {
  const raeume = [zimmer('601', 70), zimmer('602', 80), zimmer('603', 50),
                  zimmer('604', 90), zimmer('605', 60)]

  it('legt den laengsten Gast nach 604 und den kuerzesten nach hinten', () => {
    const lang = gast('2026-10-10', '2026-10-17', { resourceId: 603 })
    const mittel = gast('2026-10-10', '2026-10-13', { resourceId: 604 })
    const kurz = gast('2026-10-10', '2026-10-11', { resourceId: 602 })
    const stays = [lang, mittel, kurz]
    const r = sortRooms(raeume, stays, GAESTEHAUS)
    const lage = nachher(stays, r)
    expect(lage.get(lang.id)).toBe(604)
    expect(lage.get(mittel.id)).toBe(602)
    expect(lage.get(kurz.id)).toBe(601)
    expect(r.costAfter).toBeLessThan(r.costBefore)
  })

  it('bringt alle unter, wenn an keinem Tag mehr als fuenf da sind', () => {
    // Fuenf Gaeste ueber Kreuz, wie sie aus RoomCloud kommen.
    const stays = [
      gast('2026-10-10', '2026-10-12'), gast('2026-10-11', '2026-10-15'),
      gast('2026-10-10', '2026-10-11'), gast('2026-10-11', '2026-10-13'),
      gast('2026-10-12', '2026-10-16'), gast('2026-10-13', '2026-10-14'),
      gast('2026-10-10', '2026-10-16'), gast('2026-10-14', '2026-10-16')
    ]
    const r = sortRooms(raeume, stays, GAESTEHAUS)
    expect(r.unplaced).toEqual([])
    expect(ohneDoppelbelegung(stays, nachher(stays, r))).toBe(true)
  })
})

describe('Was liegen bleibt', () => {
  const raeume = [zimmer('10', 90), zimmer('11', 50)]

  it('bewegt einen festen Gast nicht und legt niemanden in sein Zimmer', () => {
    const fest = gast('2026-10-10', '2026-10-12', { resourceId: 11, fixed: true })
    const lang = gast('2026-10-10', '2026-10-15', { resourceId: 10 })
    const stays = [fest, lang]
    const r = sortRooms(raeume, stays, W)
    expect(r.moves).toEqual([])
  })

  it('laesst einen laufenden Aufenthalt als Block stehen (Doppelbelegung im Adminpanel)', () => {
    const imHaus = gast('2026-10-08', '2026-10-14', { resourceId: 10, fixed: true })
    const neu = gast('2026-10-10', '2026-10-20', { resourceId: 11 })
    const stays = [imHaus, neu]
    const r = sortRooms(raeume, stays, W)
    expect(r.moves).toEqual([])
    expect(ohneDoppelbelegung(stays, nachher(stays, r))).toBe(true)
  })

  it('legt niemanden in ein gesperrtes Zimmer', () => {
    const raeumeGesperrt = [zimmer('10', 90, { blocked: [{ from: '2026-10-09', to: '2026-10-11' }] }),
                            zimmer('11', 50)]
    const g = gast('2026-10-10', '2026-10-12', { resourceId: 11 })
    const r = sortRooms(raeumeGesperrt, [g], W)
    expect(r.moves).toEqual([])
  })

  it('aendert eine Gruppe mit Doppelbelegung gar nicht, statt still einen Gast zu verschieben', () => {
    const a = gast('2026-10-10', '2026-10-12', { resourceId: 11 })
    const b = gast('2026-10-11', '2026-10-13', { resourceId: 11 })
    const r = sortRooms(raeume, [a, b], W)
    expect(r.moves).toEqual([])
  })

  it('laesst ein Upgrade in einem Zimmer einer anderen Gruppe stehen', () => {
    const suite = zimmer('31', 100, { categoryId: 2 })
    const upgrade = gast('2026-10-10', '2026-10-12', { resourceId: 31 })
    const r = sortRooms([...raeume, suite], [upgrade], W)
    expect(r.moves).toEqual([])
  })
})

describe('Ablage', () => {
  it('gibt einem Gast ohne Zimmer eines, wenn eines frei ist', () => {
    const g = gast('2026-10-10', '2026-10-12')
    const r = sortRooms([zimmer('10', 90)], [g], W)
    expect(r.moves).toEqual([{ stayId: g.id, fromRoomId: null, toRoomId: 10 }])
    expect(r.unplaced).toEqual([])
  })

  it('laesst ihn in der Ablage, wenn nichts frei ist', () => {
    const da = gast('2026-10-10', '2026-10-12', { resourceId: 10, fixed: true })
    const g = gast('2026-10-11', '2026-10-12')
    const r = sortRooms([zimmer('10', 90)], [da, g], W)
    expect(r.unplaced).toEqual([g.id])
  })
})

describe('Hotel: Gewichtung', () => {
  it('gibt das Spitzenzimmer dem, der zahlt, nicht dem Schnaeppchen', () => {
    const raeume = [zimmer('31', 100), zimmer('16', 20)]
    const teuer = gast('2026-10-10', '2026-10-12', { pricePerNightCent: 15000, resourceId: 16 })
    const billig = gast('2026-10-10', '2026-10-12', { pricePerNightCent: 8000, resourceId: 31 })
    const stays = [teuer, billig]
    const lage = nachher(stays, sortRooms(raeume, stays, W))
    expect(lage.get(teuer.id)).toBe(31)
    expect(lage.get(billig.id)).toBe(16)
  })

  it('erfuellt den Balkonwunsch aus der Notiz', () => {
    const raeume = [zimmer('19', 90), zimmer('20', 60, { attributes: ['balkon'] })]
    const g = gast('2026-10-10', '2026-10-12', { text: 'Gast wuenscht Balkon', resourceId: 19 })
    const lage = nachher([g], sortRooms(raeume, [g], W))
    expect(lage.get(g.id)).toBe(20)
  })

  it('"kein Balkon" ist kein Wunsch', () => {
    expect(wishesFromText('bitte kein Balkon, Terrasse gern', W)).toEqual(['dachterrasse'])
    expect(wishesFromText('großes Zimmer', W)).toEqual([])
    expect(wishesFromText('groß', W)).toEqual(['gross'])
  })

  it('legt einen langen Aufenthalt nicht ins kleine Zimmer', () => {
    const raeume = [zimmer('16', 50, { attributes: ['klein'] }), zimmer('22', 40)]
    const lang = gast('2026-10-10', '2026-10-20', { resourceId: 16 })
    const lage = nachher([lang], sortRooms(raeume, [lang], W))
    expect(lage.get(lang.id)).toBe(22)
  })

  it('haelt eine Gruppe im selben Gebaeude', () => {
    const raeume = [zimmer('5', 50, { building: 'Nebenhaus' }), zimmer('6', 50, { building: 'Nebenhaus' }),
                    zimmer('20', 50, { building: 'Haupthaus' })]
    const a = gast('2026-10-10', '2026-10-12', { bookingId: 900, resourceId: 5 })
    const b = gast('2026-10-10', '2026-10-12', { bookingId: 900, resourceId: 20 })
    const stays = [a, b]
    const lage = nachher(stays, sortRooms(raeume, stays, W))
    const ga = raeume.find(z => z.id === lage.get(a.id))!.building
    const gb = raeume.find(z => z.id === lage.get(b.id))!.building
    expect(ga).toBe(gb)
  })

  it('bewegt nichts, wenn schon alles gut liegt', () => {
    const raeume = [zimmer('31', 100), zimmer('16', 20)]
    const teuer = gast('2026-10-10', '2026-10-12', { pricePerNightCent: 15000, resourceId: 31 })
    const billig = gast('2026-10-10', '2026-10-12', { pricePerNightCent: 8000, resourceId: 16 })
    expect(sortRooms(raeume, [teuer, billig], W).moves).toEqual([])
  })

  it('ist bei gleicher Eingabe gleich', () => {
    const raeume = [zimmer('1', 50), zimmer('2', 60), zimmer('3', 70)]
    const stays = [gast('2026-10-10', '2026-10-12'), gast('2026-10-11', '2026-10-14'),
                   gast('2026-10-10', '2026-10-11')]
    expect(sortRooms(raeume, stays, W)).toEqual(sortRooms(raeume, stays, W))
  })
})
