import { describe, it, expect } from 'vitest'
import {
  sumInvoice, taxFromGross, taxFromNet, splitPackage,
  VAT_ACCOMMODATION, VAT_STANDARD,
  applyAction, nextState, InvalidTransitionError, occupiesInventory,
  cancellationFee, derivePrice, checkRestrictions,
  nightsBetween, eachNight, addDays, businessDateFor
} from '@hotelpms/domain'

describe('Geld und Steuern', () => {
  it('rechnet Steuer aus dem Bruttobetrag heraus', () => {
    expect(taxFromGross(11900, VAT_STANDARD)).toBe(1900)
    expect(taxFromGross(10700, VAT_ACCOMMODATION)).toBe(700)
  })

  it('rundet die Steuer je Satzgruppe aus der Nettosumme, nicht je Zeile', () => {
    // Zwanzig Fruehstuecke zu 8,40 Euro netto.
    const zeilen = Array.from({ length: 20 }, () => ({ netCent: 840, rateBp: VAT_STANDARD }))
    const summe = sumInvoice(zeilen)

    const jeZeileGerundet = zeilen.reduce((s, z) => s + taxFromNet(z.netCent, z.rateBp), 0)
    const ausNettosumme = taxFromNet(20 * 840, VAT_STANDARD)

    expect(summe.groups).toHaveLength(1)
    expect(summe.groups[0]!.netCent).toBe(16800)
    expect(summe.groups[0]!.taxCent).toBe(ausNettosumme)
    expect(summe.taxCent).toBe(3192)
    // Genau der Unterschied, den ein Pruefer findet: 20 x 160 = 3200 statt 3192.
    expect(jeZeileGerundet).toBe(3200)
    expect(summe.taxCent).not.toBe(jeZeileGerundet)
  })

  it('fuehrt mehrere Steuersaetze getrennt', () => {
    const s = sumInvoice([
      { netCent: 10000, rateBp: VAT_ACCOMMODATION },
      { netCent: 10000, rateBp: VAT_ACCOMMODATION },
      { netCent: 2000,  rateBp: VAT_STANDARD }
    ])
    expect(s.groups).toHaveLength(2)
    expect(s.groups[0]).toEqual({ rateBp: 700, netCent: 20000, taxCent: 1400, grossCent: 21400 })
    expect(s.groups[1]).toEqual({ rateBp: 1900, netCent: 2000, taxCent: 380, grossCent: 2380 })
    expect(s.grossCent).toBe(23780)
  })

  it('teilt einen Paketpreis in Logis und Fruehstueck', () => {
    const teile = splitPackage(12000, [{ code: 'breakfast', grossCent: 1800, rateBp: VAT_STANDARD }])
    expect(teile[0]).toEqual({ code: 'accommodation', grossCent: 10200, rateBp: 700 })
    expect(teile[1]!.grossCent).toBe(1800)
    expect(teile.reduce((s, t) => s + t.grossCent, 0)).toBe(12000)
  })

  it('weist Zusatzleistungen ueber dem Paketpreis ab', () => {
    expect(() => splitPackage(1000, [{ code: 'x', grossCent: 2000, rateBp: 1900 }])).toThrow()
  })
})

describe('Zustandsautomat', () => {
  it('erlaubt den normalen Verlauf', () => {
    let s = applyAction('Confirmed', 'check_in')
    expect(s).toBe('InHouse')
    s = applyAction(s, 'check_out')
    expect(s).toBe('CheckedOut')
  })

  it('weist jeden unerlaubten Uebergang ab', () => {
    expect(() => applyAction('CheckedOut', 'check_in')).toThrow(InvalidTransitionError)
    expect(() => applyAction('Confirmed', 'check_out')).toThrow(InvalidTransitionError)
    expect(() => applyAction('Canceled', 'check_in')).toThrow(InvalidTransitionError)
    expect(() => applyAction('InHouse', 'cancel')).toThrow(InvalidTransitionError)
    expect(nextState('CheckedOut', 'cancel')).toBeNull()
  })

  it('bindet Kontingent nur in den aktiven Zustaenden', () => {
    expect(occupiesInventory('Confirmed')).toBe(true)
    expect(occupiesInventory('Optional')).toBe(true)
    expect(occupiesInventory('InHouse')).toBe(true)
    expect(occupiesInventory('Canceled')).toBe(false)
    expect(occupiesInventory('NoShow')).toBe(false)
    expect(occupiesInventory('CheckedOut')).toBe(false)
  })
})

describe('Stornogebuehr', () => {
  const stay = { arrival: new Date('2026-10-10T00:00:00Z'), nightPricesCent: [10000, 12000] }

  it('ist innerhalb der Frist kostenlos', () => {
    const fee = cancellationFee({ freeUntilHours: 24, feeKind: 'first_night', feeValue: 0 },
      stay, new Date('2026-10-08T00:00:00Z'))
    expect(fee).toBe(0)
  })

  it('berechnet die erste Nacht nach Fristablauf', () => {
    const fee = cancellationFee({ freeUntilHours: 24, feeKind: 'first_night', feeValue: 0 },
      stay, new Date('2026-10-09T18:00:00Z'))
    expect(fee).toBe(10000)
  })

  it('berechnet einen Prozentsatz des Gesamtpreises', () => {
    const fee = cancellationFee({ freeUntilHours: 24, feeKind: 'percent', feeValue: 80 },
      stay, new Date('2026-10-09T18:00:00Z'))
    expect(fee).toBe(17600)
  })
})

describe('Raten und Restriktionen', () => {
  it('leitet Preise per Betrag und Prozent ab', () => {
    expect(derivePrice(10000, { kind: 'amount', value: -1500 })).toBe(8500)
    expect(derivePrice(10000, { kind: 'percent', value: -10 })).toBe(9000)
    expect(derivePrice(1000, { kind: 'amount', value: -5000 })).toBe(0)
  })

  it('findet Verstoesse gegen Mindestaufenthalt und Anreisesperre', () => {
    const naechte = [
      { date: '2026-12-24', restriction: { minLos: 3, closedToArrival: true } },
      { date: '2026-12-25', restriction: {} }
    ]
    const v = checkRestrictions(naechte, undefined, 2)
    expect(v).toContain('closed_to_arrival')
    expect(v).toContain('min_los')
  })

  it('laesst einen zulaessigen Aufenthalt durch', () => {
    const naechte = [{ date: '2026-12-24', restriction: { minLos: 2 } },
                     { date: '2026-12-25', restriction: {} }]
    expect(checkRestrictions(naechte, undefined, 2)).toHaveLength(0)
  })
})

describe('Kalenderrechnung', () => {
  it('zaehlt Naechte und listet sie auf', () => {
    expect(nightsBetween('2026-10-01', '2026-10-04')).toBe(3)
    expect(eachNight('2026-10-01', '2026-10-04'))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('ordnet die Zeit vor dem Tageswechsel dem Vortag zu', () => {
    // 02:30 Ortszeit gehoert noch zum 9. Oktober, wenn um 04:00 gewechselt wird.
    expect(businessDateFor(new Date('2026-10-10T00:30:00Z'), 'Europe/Berlin', '04:00'))
      .toBe('2026-10-09')
    expect(businessDateFor(new Date('2026-10-10T06:00:00Z'), 'Europe/Berlin', '04:00'))
      .toBe('2026-10-10')
  })
})
