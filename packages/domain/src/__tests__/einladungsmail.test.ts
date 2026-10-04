import { describe, it, expect } from 'vitest'
import { renderInviteEmail } from '../email.js'

const basis = {
  userName: 'zurseerobbe', link: 'https://app.example/einladung?token=abc&x=1',
  gueltigStunden: 48, email: 'info@cuxhaven-hotel.com'
}

describe('Einladungsmail', () => {
  it('redet den Kunden an, nicht den Benutzernamen', () => {
    const m = renderInviteEmail({ ...basis, accountName: 'Hotel Zur Seerobbe' })
    expect(m.subject).toBe('Willkommen bei StayGrid – Ihr Zugang für Hotel Zur Seerobbe')
    expect(m.text).toMatch(/^Guten Tag Hotel Zur Seerobbe,/)
    expect(m.text).not.toContain('zurseerobbe,')
    expect(m.text).toContain('48 Stunden')
    expect(m.text).toContain('info@cuxhaven-hotel.com')
  })

  it('faellt ohne Kunden auf den Anzeigenamen zurueck', () => {
    // Plattformpersonal gehoert zu keinem Kunden.
    const m = renderInviteEmail({ ...basis, userName: 'Anna Petersen', accountName: null })
    expect(m.subject).toBe('Willkommen bei StayGrid – Ihr Zugang ist bereit')
    expect(m.text).toMatch(/^Guten Tag Anna Petersen,/)
  })

  it('macht den Link im HTML-Teil anklickbar, ohne ihn als Markup zu lesen', () => {
    const m = renderInviteEmail({ ...basis, accountName: 'A & B <GmbH>' })
    expect(m.html).toContain('<a href="https://app.example/einladung?token=abc&amp;x=1">')
    expect(m.html).toContain('A &amp; B &lt;GmbH&gt;')
    expect(m.html).not.toContain('<GmbH>')
  })

  it('gibt es auch englisch', () => {
    const m = renderInviteEmail({ ...basis, accountName: 'Hotel Zur Seerobbe' }, 'en')
    expect(m.subject).toBe('Welcome to StayGrid – your access for Hotel Zur Seerobbe')
    expect(m.text).toMatch(/^Dear Hotel Zur Seerobbe,/)
  })
})
