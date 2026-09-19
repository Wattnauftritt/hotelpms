import { describe, it, expect } from 'vitest'
import { checkWebhookTargetUrl, checkResolvedAddress, parseCidrList,
         parseIpAddress, embeddedForms } from '../webhookTarget.js'

/**
 * Befund B1: ein Webhook-Ziel ist eine Adresse, die **wir** von innen
 * ansprechen. Geprueft wird deshalb nicht, ob ein URL huebsch aussieht,
 * sondern wohin er zeigt.
 */

const KEINE = parseCidrList('')

function abgelehnt(url: string, freigabe = KEINE): string | null {
  const r = checkWebhookTargetUrl(url, freigabe)
  return 'problem' in r ? r.problem : null
}

describe('Ziele ausgehender Ereignisse', () => {
  it('laesst ein oeffentliches https-Ziel durch', () => {
    expect(abgelehnt('https://portal.example.de/hook')).toBeNull()
    expect(abgelehnt('https://203.0.114.9:8443/hook')).toBeNull()
  })

  it('weist die Adressen ab, die der Praefix https:// durchliess', () => {
    for (const url of [
      'https://127.0.0.1:6379/',
      'https://localhost.localdomain@127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data/',   // Metadaten des Hosters
      'https://10.0.0.5/hook',
      'https://172.16.3.4/hook',
      'https://192.168.1.1/hook',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',                      // eindeutig lokal
      'https://[fe80::1]/hook',                      // Link-Local
      'https://0.0.0.0/hook',
      'https://100.64.0.1/hook'                      // Carrier-Grade NAT
    ]) {
      expect(abgelehnt(url), url).not.toBeNull()
    }
  })

  it('durchschaut eine in IPv6 eingewickelte innere Adresse', () => {
    // Dieselbe Adresse in vier Schreibweisen. Wer nur auf `127.` prueft,
    // faengt genau eine davon.
    expect(abgelehnt('https://[::ffff:127.0.0.1]/hook')).toBe('blockedAddress')
    expect(abgelehnt('https://[::ffff:7f00:1]/hook')).toBe('blockedAddress')
    expect(abgelehnt('https://[64:ff9b::169.254.169.254]/hook')).toBe('blockedAddress')
    expect(abgelehnt('https://[2002:a00:5::]/hook')).toBe('blockedAddress')  // 6to4 auf 10.0.0.5
  })

  it('weist Zugangsdaten im URL ab', () => {
    // Sie landen im Protokoll und in jeder Fehlermeldung, und gegenueber dem
    // Empfaenger sind sie ohnehin kein Geheimnis.
    expect(abgelehnt('https://nutzer:geheim@portal.example.de/hook')).toBe('credentials')
  })

  it('weist alles ab, was kein http oder https ist', () => {
    expect(abgelehnt('file:///etc/passwd')).toBe('scheme')
    expect(abgelehnt('gopher://portal.example.de/')).toBe('scheme')
    expect(abgelehnt('portal.example.de/hook')).toBe('malformed')
    expect(abgelehnt('')).toBe('malformed')
  })

  it('oeffnet genau das freigegebene Netz, nicht mehr', () => {
    const frei = parseCidrList('10.0.1.0/24')
    expect(abgelehnt('https://10.0.1.20/hook', frei)).toBeNull()
    // Das Nachbarnetz bleibt zu, und der Rest der Sperrliste auch.
    expect(abgelehnt('https://10.0.2.20/hook', frei)).toBe('blockedAddress')
    expect(abgelehnt('https://127.0.0.1/hook', frei)).toBe('blockedAddress')
  })

  it('erlaubt http nur in ein freigegebenes Netz und nur als Adresse', () => {
    const frei = parseCidrList('10.0.1.0/24')
    expect(abgelehnt('http://10.0.1.20/hook', frei)).toBeNull()
    // Ins offene Netz geht nichts ohne TLS ...
    expect(abgelehnt('http://portal.example.de/hook', frei)).toBe('scheme')
    // ... und ein Name laesst sich ohne Aufloesung nicht gegen die Freigabe
    // halten, deshalb bleibt auch er zu.
    expect(abgelehnt('http://kasse.intern/hook', frei)).toBe('scheme')
  })

  it('prueft die aufgeloeste Adresse mit derselben Liste', () => {
    // Was der Worker nach dem Aufloesen fragt -- ein Name, der beim Anlegen
    // nach draussen zeigte, kann jetzt nach innen zeigen (DNS-Rebinding).
    expect(checkResolvedAddress('https:', '93.184.216.34', KEINE)).toBeNull()
    expect(checkResolvedAddress('https:', '127.0.0.1', KEINE)).toBe('blockedAddress')
    expect(checkResolvedAddress('https:', 'kein-adresse', KEINE)).toBe('blockedAddress')
    expect(checkResolvedAddress('http:', '93.184.216.34', KEINE)).toBe('scheme')
  })

  it('liest Adressen und Netzmasken, und wirft bei einem Tippfehler', () => {
    expect(parseIpAddress('10.0.0.5')).toEqual(Uint8Array.of(10, 0, 0, 5))
    expect(parseIpAddress('nicht.eine.adresse')).toBeNull()
    expect(parseCidrList('10.0.1.0/24')).toHaveLength(1)
    expect(parseCidrList(' 10.0.1.0/24 , fd00::/8 ')).toHaveLength(2)
    // Ohne Maske gilt genau die eine Adresse.
    expect(parseCidrList('10.0.1.7')[0]!.bits).toBe(32)
    // Stillschweigend zu ueberspringen hiesse, dass eine ausbleibende
    // Zustellung erst Wochen spaeter jemanden an die Umgebung denken laesst.
    expect(() => parseCidrList('10.0.1.0/99')).toThrow()
    expect(() => parseCidrList('keinnetz/24')).toThrow()
  })

  it('findet die eingewickelte IPv4 in jeder ihrer Formen', () => {
    const formen = (s: string): string[] =>
      embeddedForms(parseIpAddress(s)!).map(b => b.join('.'))
    expect(formen('::ffff:127.0.0.1')).toContain('127.0.0.1')
    expect(formen('2002:a00:5::')).toContain('10.0.0.5')
    expect(formen('93.184.216.34')).toEqual(['93.184.216.34'])
  })
})
