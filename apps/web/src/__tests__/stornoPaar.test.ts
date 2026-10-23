import { describe, expect, it } from 'vitest'
import { offeneStornoPaare } from '../lib/stornoPaar.js'

const c = (id: number, reverses_id: number | null = null, invoice_id: number | null = null) =>
  ({ id, reverses_id, invoice_id })

describe('offeneStornoPaare', () => {
  it('nimmt die alte Position und ihre Gegenbuchung, nicht die neue', () => {
    // 1 alte Nacht, 2 ihre Gegenbuchung, 3 die korrigierte Nacht
    expect([...offeneStornoPaare([c(1), c(2, 1), c(3)])].sort()).toEqual([1, 2])
  })

  it('laesst ein Paar stehen, von dem eine Haelfte schon berechnet ist', () => {
    expect(offeneStornoPaare([c(1, null, 7), c(2, 1)]).size).toBe(0)
    expect(offeneStornoPaare([c(1), c(2, 1, 7)]).size).toBe(0)
  })

  it('erkennt eine Gegenbuchung ohne ihr Original am Folio nicht als Paar', () => {
    expect(offeneStornoPaare([c(2, 1)]).size).toBe(0)
  })
})
