import { describe, it, expect } from 'vitest'
import { zusammenfassen } from '../components/KalenderSenden.js'
import type { OffenerTag } from '../lib/queries/rates.js'

/** Die Liste offener Tage fasst Folgetage desselben Plans zusammen. */
const tag = (ratePlanCode: string, date: string, extra: Partial<OffenerTag> = {}): OffenerTag => ({
  ratePlanCode, ratePlanName: ratePlanCode, date, price: false, restriction: false,
  neverSent: true, priceCent: null, sentPriceCent: null, ...extra })

describe('offene Aenderungen zusammenfassen', () => {
  it('fasst Folgetage je Plan zusammen und trennt bei Luecke oder anderer Abweichung', () => {
    const g = zusammenfassen([
      tag('DZ-STD', '2027-11-23'), tag('EZ-STD', '2027-11-23'),
      tag('DZ-STD', '2027-11-24'), tag('DZ-STD', '2027-11-25'),
      tag('DZ-STD', '2027-11-27'),
      tag('DZ-STD', '2027-11-28', { neverSent: false, price: true,
                                   priceCent: [9000], sentPriceCent: [8000] })
    ])
    expect(g.map(x => [x.ratePlanCode, x.von, x.bis])).toEqual([
      ['DZ-STD', '2027-11-23', '2027-11-25'],
      ['EZ-STD', '2027-11-23', '2027-11-23'],
      ['DZ-STD', '2027-11-27', '2027-11-27'],
      ['DZ-STD', '2027-11-28', '2027-11-28']
    ])
  })
})
