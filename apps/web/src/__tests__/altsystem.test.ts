import { describe, it, expect } from 'vitest'
import { auszugAusAbzug, KWHOTEL_TABELLEN, namenAus, zahlenAus } from '../lib/altsystem.js'

/**
 * Was vom KWHotel-Abzug den Rechner verlaesst: nur die Tabellen, die der
 * Import liest. Kasse, Rechnungen und Protokolle bleiben im Browser.
 */
const ABZUG = [
  '-- MariaDB dump 10.19',
  'CREATE TABLE `dok_dokument` (',
  '  `id` int(11) NOT NULL,',
  ') ENGINE=InnoDB;',
  "INSERT INTO `dok_dokument` VALUES (1,'Rechnung Erika Beispiel');",
  'CREATE TABLE `Rezerwacje` (',
  '  `RezerwacjaID` int(11) NOT NULL,',
  ') ENGINE=InnoDB;',
  "INSERT INTO `Rezerwacje` VALUES (1),(2);",
  "INSERT INTO `log` VALUES (1,'Anmeldung');",
  'CREATE TABLE `Klienci` (',
  '  `KlientID` int(11) NOT NULL,',
  ') ENGINE=InnoDB;',
  "INSERT INTO `Klienci` VALUES (7);"
].join('\n')

describe('Auszug aus dem KWHotel-Abzug', () => {
  it('behaelt nur die Tabellen, die der Import liest', () => {
    const a = auszugAusAbzug(ABZUG, KWHOTEL_TABELLEN)
    expect(a).toContain('INSERT INTO `Rezerwacje` VALUES (1),(2);')
    expect(a).toContain('CREATE TABLE `Klienci` (')
    expect(a).toContain(') ENGINE=InnoDB;')
    expect(a).not.toContain('Erika')
    expect(a).not.toContain('Anmeldung')
    expect(a).not.toContain('dok_dokument')
  })

  it('liest Statuscodes und Platzhalter aus freier Eingabe', () => {
    expect(zahlenAus('0, 1;2  4,x')).toEqual([0, 1, 2, 4])
    expect(namenAus('ungereinigt, nicht gereinigt,,')).toEqual(['ungereinigt', 'nicht gereinigt'])
  })
})
