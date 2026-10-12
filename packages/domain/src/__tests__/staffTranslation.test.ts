import { describe, it, expect } from 'vitest'
import { deeplEndpoint, deeplTargetCode, staffLangFromDeepl,
         translationRetryDelaySeconds } from '../staffTranslation.js'

describe('Uebersetzung der Personaltexte', () => {
  it('nennt die Ziele so, wie DeepL sie annimmt', () => {
    expect(['de', 'en', 'ru', 'uk', 'nb', 'cs', 'pt', 'zh', 'ar'].map(l => deeplTargetCode(l))).toEqual(
      ['DE', 'EN-GB', 'RU', 'UK', 'NB', 'CS', 'PT-PT', 'ZH-HANS', 'AR'])
  })
  it('bildet die erkannte Sprache auf unsere ab', () => {
    expect(staffLangFromDeepl('RU')).toBe('ru')
    expect(staffLangFromDeepl('EN-US')).toBe('en')
    expect(staffLangFromDeepl('PL')).toBe('pl')
    expect(staffLangFromDeepl('NB')).toBe('nb')
    expect(staffLangFromDeepl('AR')).toBe('ar')
    expect(staffLangFromDeepl('JA')).toBeNull()
    expect(staffLangFromDeepl(null)).toBeNull()
  })
  it('schickt einen kostenlosen Schluessel an den kostenlosen Rechner', () => {
    expect(deeplEndpoint('abc:fx')).toContain('api-free.deepl.com')
    expect(deeplEndpoint('abc')).toContain('//api.deepl.com')
  })
  it('verdoppelt den Abstand', () => {
    expect([1, 2, 3].map(a => translationRetryDelaySeconds(a))).toEqual([60, 120, 240])
  })
})
