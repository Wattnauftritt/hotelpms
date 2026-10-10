import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Bildschirm „Meldescheine" (04.10.2026). `Meldeschein` bleibt in jeder
 * Sprache stehen: es ist der Name des Papiers, das vor der Rezeption liegt.
 */
export const meldescheine = {
  'nav.registrations': {
    de: 'Meldescheine',
    en: 'Meldescheine',
    tr: 'Meldescheine' },
  'reg.title': {
    de: 'Meldescheine',
    en: 'Registration forms (Meldescheine)',
    tr: 'Kayıt formları (Meldescheine)' },
  'reg.arrivalFrom': {
    de: 'Anreise ab',
    en: 'Arrival from',
    tr: 'Varış tarihinden' },
  'reg.search': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'reg.rangeInvalid': {
    de: 'Der Zeitraum muss vorwärts laufen und darf höchstens {max} Tage lang sein.',
    en: 'The period must run forwards and may be at most {max} days long.',
    tr: 'Dönem ileriye doğru olmalı ve en fazla {max} gün sürmelidir.' },
  'reg.none': {
    de: 'Keine Meldescheine mit Anreise in diesem Zeitraum.',
    en: 'No Meldescheine with arrival in this period.',
    tr: 'Bu dönemde varışlı Meldeschein yok.' },
  'reg.count': {
    de: '{n} Meldescheine',
    en: '{n} Meldescheine',
    tr: '{n} Meldeschein' },
  'reg.persons': {
    de: '{n} Pers.',
    en: '{n} pers.',
    tr: '{n} kişi' },
  'reg.signature.notNeeded': {
    de: 'ohne Unterschrift (Inland)',
    en: 'no signature needed (domestic)',
    tr: 'imza gerekmez (yurt içi)' },
  'reg.signature.done': {
    de: 'unterschrieben',
    en: 'signed',
    tr: 'imzalandı' },
  'reg.signature.pending': {
    de: 'Unterschrift steht aus',
    en: 'signature outstanding',
    tr: 'imza bekleniyor' },
  'reg.openReservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'reg.source.desk': {
    de: 'An der Rezeption erfasst',
    en: 'Recorded at the front desk',
    tr: 'Resepsiyonda kaydedildi' },
  'reg.source.online': {
    de: 'Online ausgefüllt',
    en: 'Filled in online',
    tr: 'Çevrimiçi dolduruldu' },
  'reg.source.terminal': {
    de: 'Am Terminal ausgefüllt',
    en: 'Filled in at the terminal',
    tr: 'Terminalde dolduruldu' },
  'reg.source.import': {
    de: 'Übernommen aus {system}',
    en: 'Taken over from {system}',
    tr: '{system} sisteminden aktarıldı' },
  'reg.avsReported': {
    de: 'an AVS gemeldet am {datum}',
    en: 'reported to AVS on {datum}',
    tr: '{datum} tarihinde AVS\'ye bildirildi' },
  'reg.destroyAfter': {
    de: 'wird vernichtet ab {datum} (§ 30 BMG)',
    en: 'destroyed from {datum} (§ 30 BMG)',
    tr: '{datum} tarihinden itibaren imha edilir (§ 30 BMG)' },
  'reg.taxExemption': {
    de: 'Kurtaxe befreit: {grund}',
    en: 'Exempt from tourist tax: {grund}',
    tr: 'Turist vergisinden muaf: {grund}' },
  'reg.companions': {
    de: 'Mitreisende',
    en: 'Companions',
    tr: 'Birlikte seyahat edenler' },
  /* Der Schein mit Inhalt (10.10.2026): Sven konnte ihn in der Liste nicht
     oeffnen, gesehen hat man bis dahin nur, dass es ihn gibt. */
  'reg.open': {
    de: 'Ansehen',
    en: 'View',
    tr: 'Görüntüle' },
  'reg.sheet': {
    de: 'Meldeschein',
    en: 'Meldeschein',
    tr: 'Meldeschein' },
  'reg.stay': {
    de: 'Aufenthalt',
    en: 'Stay',
    tr: 'Konaklama' },
  'reg.occupants': {
    de: 'Personen',
    en: 'Persons',
    tr: 'Kişiler' },
  'reg.stayPhone': {
    de: 'Telefon im Aufenthalt',
    en: 'Phone during stay',
    tr: 'Konaklama sırasında telefon' },
  'reg.mainGuest': {
    de: 'Hauptgast',
    en: 'Main guest',
    tr: 'Ana misafir' },
  'reg.expectedArrival': {
    de: 'Ankunftszeit',
    en: 'Arrival time',
    tr: 'Varış saati' },
  'reg.digitalGuestCard': {
    de: 'Digitale Gästekarte gewünscht',
    en: 'Digital guest card requested',
    tr: 'Dijital misafir kartı istendi' },
  'reg.exemptionProof': {
    de: 'Nachweis: {nachweis}',
    en: 'Proof: {nachweis}',
    tr: 'Belge: {nachweis}' },
  'reg.signature': {
    de: 'Unterschrift',
    en: 'Signature',
    tr: 'İmza' },
  'reg.signedAt': {
    de: 'unterschrieben am {datum}',
    en: 'signed on {datum}',
    tr: '{datum} tarihinde imzalandı' },
  'reg.signatureNoImage': {
    de: 'Die Unterschrift liegt vor, ihr Bild lässt sich hier nicht anzeigen.',
    en: 'The signature is on file, but its image cannot be shown here.',
    tr: 'İmza kayıtlı, ancak görüntüsü burada gösterilemiyor.' },
  'reg.noAccess': {
    de: 'Den Inhalt eines Meldescheins sieht nur, wer Gastprofile sehen darf.',
    en: 'Only users allowed to see guest profiles can view a Meldeschein.',
    tr: 'Meldeschein içeriğini yalnızca misafir profillerini görebilenler görür.' }
} satisfies Record<string, LocalizedText>
