/**
 * Schreibt Beispielbelege als CII-XML in ein Verzeichnis, damit
 * `check-erechnung.sh` sie gegen die Schematron-Regeln von EN 16931 prueft
 * (Pruefung des Rechnungssystems vom 13.10.2026: "In den Tests oder in CI
 * laeuft kein Validator").
 *
 * Die Faelle sind die, an denen es schon einmal gescheitert ist oder die
 * selten genug sind, dass niemand sie von Hand anschaut: offener Betrag mit
 * und ohne Ziel, Anzahlungsrechnung, Stornorechnung, Rundungsbetrag,
 * Handelsregister statt USt-IdNr., Leitweg-ID.
 *
 * Aufruf: pnpm tsx scripts/erechnung-beispiele.ts <verzeichnis>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInvoiceCii, ciiFindings, type CiiInvoice } from '../packages/domain/src/invoiceCii.js'

const ziel = process.argv[2]
if (!ziel) {
  console.error('Aufruf: erechnung-beispiele.ts <verzeichnis>')
  process.exit(2)
}

const haus = {
  name: 'Seehotel Wattenblick', addressLine1: 'Hafenstr. 1', postalCode: '25813',
  city: 'Husum', country: 'DE', taxNumber: '21/815/00123', vatId: 'DE123456789',
  contactName: 'Rezeption', phone: '+49 4841 1234', email: 'rechnung@wattenblick.test',
  electronicAddress: 'rechnung@wattenblick.test'
}
const firma = {
  name: 'Nordwind GmbH', addressLine1: 'Deichweg 4', postalCode: '24937',
  city: 'Flensburg', country: 'DE', vatId: 'DE987654321',
  electronicAddress: 'buchhaltung@nordwind.test'
}
const bank = { iban: 'DE02120300000000202051', bic: 'BYLADEM1001', accountName: haus.name }

const basis: CiiInvoice = {
  number: '2026-00042', issuedOn: '2026-10-04', kind: 'final', currency: 'EUR',
  seller: haus, buyer: firma,
  lines: [
    { name: 'Uebernachtung', quantity: 3, unitCode: 'DAY', netCent: 30_000, rateBp: 700 },
    { name: 'Fruehstueck Getraenke', quantity: 3, netCent: 1_134, rateBp: 1900 }
  ],
  serviceFrom: '2026-10-01', serviceTo: '2026-10-03'
}

const faelle: Record<string, CiiInvoice> = {
  bezahlt: { ...basis, prepaidCent: 33_449 },
  offen_mit_ziel: { ...basis, dueOn: '2026-10-18', payee: bank },
  offen_sofort: { ...basis, payee: bank },
  rundung: {
    ...basis,
    lines: [{ name: 'Uebernachtung', quantity: 2, unitCode: 'DAY', netCent: 23_364, rateBp: 700 }],
    roundingCent: 1, dueOn: '2026-10-18', payee: bank
  },
  anzahlung: {
    ...basis, kind: 'deposit',
    lines: [{ name: 'Anzahlung auf den Aufenthalt', quantity: 1, netCent: 18_692, rateBp: 700 }],
    prepaidCent: 20_000
  },
  anzahlung_verrechnet: {
    ...basis,
    lines: [...basis.lines,
      { name: 'Anzahlung verrechnet (Rechnung 2026-00040 vom 01.09.2026)', quantity: -1,
        netCent: -18_692, rateBp: 700 }],
    dueOn: '2026-10-18', payee: bank
  },
  storno: {
    ...basis, number: '2026-00043', kind: 'credit_note',
    lines: basis.lines.map(l => ({ ...l, netCent: -l.netCent })),
    precedingInvoice: { number: '2026-00042', issuedOn: '2026-10-04' }
  },
  handelsregister: {
    ...basis, seller: { ...haus, vatId: null, registrationId: 'HRB 1234 Amtsgericht Flensburg' },
    dueOn: '2026-10-18', payee: bank
  },
  leitweg: {
    ...basis, buyerReference: '04011000-12345-34', dueOn: '2026-10-18', payee: bank
  }
}

mkdirSync(ziel, { recursive: true })
let fehler = 0
for (const [name, inv] of Object.entries(faelle)) {
  const f = ciiFindings(inv)
  if (f.length > 0) {
    // Ein Beispiel, das die eigene Pruefung abweist, prueft den Validator
    // nicht, sondern das Beispiel.
    console.error(`${name}: ${f.map(x => x.de).join(' ')}`)
    fehler++
    continue
  }
  writeFileSync(join(ziel, `${name}.xml`), buildInvoiceCii(inv))
}
process.exit(fehler === 0 ? 0 : 1)
