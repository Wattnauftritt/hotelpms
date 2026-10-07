import { describe, it, expect } from 'vitest'
import { isPushEndpoint } from '../push.js'

describe('isPushEndpoint', () => {
  it('nimmt die Dienste der Browserhersteller', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGx8',
      'https://wns2-db5p.notify.windows.com/w/?token=x'
    ]) expect(isPushEndpoint(e), e).toBe(true)
  })
  it('weist alles andere ab', () => {
    for (const e of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.boese.de/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x',
      'https://evilnotify.windows.com.example/x',
      'kein url'
    ]) expect(isPushEndpoint(e), e).toBe(false)
  })
})
