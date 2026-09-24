import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Das Haus wechseln.
 *
 * Wer drei Haeuser betreut, wechselt am Tag ein Dutzend Mal, und jede
 * Handlung landet in dem Haus, das gerade gewaehlt ist. Im falschen Haus zu
 * buchen faellt niemandem auf, bis der Gast vor einem anderen Tresen steht.
 * Geprueft wird deshalb, was daran schiefgehen kann -- nicht, wie das Menue
 * aussieht.
 */

const wahl = readFileSync(
  new URL('../components/Hauswahl.tsx', import.meta.url), 'utf8')
const shell = readFileSync(
  new URL('../components/Shell.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

describe('Das Haus steht in der Kopfleiste', () => {
  it('nennt es auch dann, wenn es nur eines gibt', () => {
    /*
     * Vorher zeigte sich die Auswahl erst ab zwei Haeusern. Eine
     * Bedienung, die es die meiste Zeit gar nicht gibt, lernt niemand
     * kennen -- und wer das zweite Haus bekommt, sucht sie. Zu wissen, in
     * welchem Haus man arbeitet, ist ausserdem fuer sich genommen wichtig.
     */
    expect(wahl).toContain('if (haeuser.length < 2)')
    // Der Zweig gibt die Beschriftung zurueck, nicht `null`.
    const einHaus = wahl.slice(wahl.indexOf('if (haeuser.length < 2)'),
                               wahl.indexOf('const suchen ='))
    expect(einHaus).toContain('{haus.name}')
    expect(einHaus).not.toContain('return null')
  })

  it('benennt das Uebungshaus schon in der Liste', () => {
    // Danach steht der violette Streifen da -- aber dann ist man schon
    // drin (Dokument 13, C11).
    expect(wahl).toContain("t('haus.training')")
  })

  it('bietet ein Suchfeld erst, wenn die Liste lang wird', () => {
    // Bei drei Haeusern ist es ein Feld, das man wegklicken muss; bei
    // dreissig ist eine Liste ohne Suche eine Rolle.
    expect(wahl).toContain('const AB_HIER_SUCHEN = 8')
    expect(wahl).toContain('haeuser.length >= AB_HIER_SUCHEN')
  })
})

describe('Beim Wechsel faellt weg, was zum alten Haus gehoert', () => {
  it('schliesst einen offenen Beleg und Check-in', () => {
    /*
     * Beide haengen an einer Kennung aus dem vorigen Haus. Bleiben sie
     * stehen, sieht die Rezeption einen Vorgang, den es hier nicht gibt,
     * und die Schnittstelle antwortet 404 auf einen Bildschirm, den
     * niemand mehr zuordnen kann.
     */
    // Ab dem Umschalter bis zum naechsten Block **dahinter**: das
    // Adminpanel weiter oben hat einen eigenen `{arbeitsplatz && (`.
    const ab = app.indexOf('onHaus={id => {')
    const umschalter = app.slice(ab, app.indexOf('{arbeitsplatz && (', ab))
    expect(umschalter).toContain('setFolioRef(null)')
    expect(umschalter).toContain('setCheckInRef(null)')
    expect(umschalter).toContain('setAdresse({ property: id, screen: null })')
  })

  it('haengt den Bildschirm neu ein, statt ihn weiterlaufen zu lassen', () => {
    /*
     * Haben beide Haeuser denselben Startbildschirm, bleibt die Komponente
     * eingehaengt und behaelt ihren Zustand -- im Zimmerplan die markierte
     * Reservierung des alten Hauses, nach der das Seitenfenster dann im
     * neuen fragt.
     */
    expect(app).toContain('<Fragment key={haus.id}>')
  })
})

describe('Die Kopfleiste spricht die Sprache der Oberflaeche', () => {
  it('haelt keinen deutschen Satz mehr im Code', () => {
    /*
     * Jeder Satz, den ein Mensch zu sehen bekommt, ist ein Schluessel
     * (CLAUDE.md). Hier standen drei: die Beschriftungen der beiden
     * Auswahlfelder und der ganze Uebungshinweis -- wer die Oberflaeche
     * auf Englisch stellte, bekam sie trotzdem auf Deutsch.
     */
    for (const quelle of [shell, wahl]) {
      expect(quelle).not.toContain('aria-label="Haus"')
      expect(quelle).not.toContain('aria-label="Sprache"')
      expect(quelle).not.toContain('Uebungsbetrieb')
    }
    expect(shell).toContain("t('app.training', { haus: haus.name })")
    expect(shell).toContain("t('common.language')")
    expect(wahl).toContain("t('haus.label')")
  })
})
