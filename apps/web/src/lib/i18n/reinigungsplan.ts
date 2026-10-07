import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Reinigungsplan (Migration 0106, Baustein 2 des Personalsystems): Zimmer
 * des Tages den Reinigungskraeften zuteilen, Sollminuten pflegen.
 */
export const reinigungsplan = {
  'nav.cleaningPlan': {
    de: 'Reinigungsplan',
    en: 'Cleaning plan',
    tr: 'Temizlik planı' },
  'cleaningPlan.staff': {
    de: 'Wer arbeitet heute',
    en: 'Working today',
    tr: 'Bugün çalışanlar' },
  'cleaningPlan.noStaff': {
    de: 'Noch niemand hat die Rolle Reinigung. Unter Einstellungen › Benutzer einladen.',
    en: 'Nobody has the Cleaning role yet. Invite people under Settings › Users.',
    tr: 'Henüz kimsede Temizlik rolü yok. Ayarlar › Kullanıcılar altından davet edin.' },
  'cleaningPlan.load': {
    de: '{rooms} Zimmer · {minutes} Min.',
    en: '{rooms} rooms · {minutes} min',
    tr: '{rooms} oda · {minutes} dk' },
  'cleaningPlan.inactive': {
    de: 'ohne Rolle Reinigung',
    en: 'without Cleaning role',
    tr: 'Temizlik rolü yok' },
  'cleaningPlan.suggest': {
    de: 'Vorschlag',
    en: 'Suggest',
    tr: 'Öneri' },
  'cleaningPlan.suggestHint': {
    de: 'Verteilt die offenen Zimmer gleichmäßig nach Minuten auf die Angehakten, jede Kraft am Stück durchs Haus. Erledigte bleiben, wo sie sind. Gespeichert wird erst mit „Speichern“.',
    en: 'Spreads the open rooms evenly by minutes across the ticked people, each in one stretch through the building. Finished rooms stay put. Nothing is saved until you press “Save”.',
    tr: 'Açık odaları işaretlenen kişilere dakikaya göre eşit dağıtır; herkes binada tek bir bölümü alır. Tamamlananlar yerinde kalır. “Kaydet”e basılana kadar hiçbir şey kaydedilmez.' },
  'cleaningPlan.save': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'cleaningPlan.discard': {
    de: 'Verwerfen',
    en: 'Discard',
    tr: 'Vazgeç' },
  'cleaningPlan.unsaved': {
    de: 'Nicht gespeichert',
    en: 'Not saved',
    tr: 'Kaydedilmedi' },
  'cleaningPlan.unassigned': {
    de: '{rooms} Zimmer ohne Kraft',
    en: '{rooms} rooms unassigned',
    tr: '{rooms} oda atanmadı' },
  'cleaningPlan.nothingDue': {
    de: 'An diesem Tag ist kein Zimmer fällig.',
    en: 'No rooms are due on this day.',
    tr: 'Bu gün için temizlenecek oda yok.' },
  'cleaningPlan.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'cleaningPlan.due': {
    de: 'Fällig',
    en: 'Due',
    tr: 'Durum' },
  'cleaningPlan.minutes': {
    de: 'Minuten',
    en: 'Minutes',
    tr: 'Dakika' },
  'cleaningPlan.assignee': {
    de: 'Kraft',
    en: 'Assigned to',
    tr: 'Atanan' },
  'cleaningPlan.nobody': {
    de: '– niemand –',
    en: '– nobody –',
    tr: '– kimse –' },
  'cleaningPlan.departure': {
    de: 'Abreise',
    en: 'Departure',
    tr: 'Ayrılış' },
  'cleaningPlan.stayover': {
    de: 'Bleiber',
    en: 'Stayover',
    tr: 'Konaklama devam' },
  'cleaningPlan.checkedOut': {
    de: 'frei',
    en: 'vacated',
    tr: 'boşaldı' },
  'cleaningPlan.arrival': {
    de: 'Anreise heute',
    en: 'Arrival today',
    tr: 'Bugün giriş' },
  'cleaningPlan.done': {
    de: 'erledigt',
    en: 'done',
    tr: 'tamamlandı' },
  'cleaningPlan.legacy': {
    de: 'aus Alt-App',
    en: 'from old app',
    tr: 'eski uygulamadan' },

  'cleaningPlan.waived': {
    de: 'Gast verzichtet',
    en: 'Guest skips',
    tr: 'Misafir istemiyor' },
  'cleaningPlan.waiver': {
    de: 'Reinigungsverzicht',
    en: 'Cleaning opt-out',
    tr: 'Temizlikten vazgeçme' },
  'cleaningPlan.waiverHint': {
    de: 'Gäste verzichten über ihren Check-in-Link oder an der Rezeption auf die Zwischenreinigung eines Tages. Ohne Wasser fällt das Zimmer an dem Tag aus dem Plan; mit Wasser bleibt es drin, und die Kraft hakt die Flasche ab.',
    en: 'Guests skip a day’s stay-over cleaning via their check-in link or at reception. Without water the room drops out of the plan that day; with water it stays, and staff tick off the bottle.',
    tr: 'Misafirler check-in bağlantısı veya resepsiyon üzerinden bir günün ara temizliğinden vazgeçer. Su olmadan oda o gün plandan çıkar; su ile planda kalır ve personel şişeyi işaretler.' },
  'cleaningPlan.waiverEnabled': {
    de: 'Gäste dürfen verzichten',
    en: 'Guests may opt out',
    tr: 'Misafirler vazgeçebilir' },
  'cleaningPlan.waiverWater': {
    de: 'Als Dank eine Flasche Wasser',
    en: 'A bottle of water as a thank-you',
    tr: 'Teşekkür olarak bir şişe su' },
  'cleaningPlan.norms': {
    de: 'Sollminuten',
    en: 'Target minutes',
    tr: 'Hedef dakikalar' },
  'cleaningPlan.normsHint': {
    de: 'Nach diesen Minuten rechnet die Zeitarbeitsfirma ab. Ein Zimmer schlägt die Kategorie, die Kategorie das Haus. Ein leeres Feld nimmt die nächste Stufe. Geänderte Werte gelten für neu geplante Zimmer; schon gespeicherte Tage behalten ihre Minuten.',
    en: 'The staffing agency bills by these minutes. A room overrides its category, a category overrides the property. An empty field falls back to the next level. Changes apply to newly planned rooms; days already saved keep their minutes.',
    tr: 'Personel ajansı bu dakikalara göre faturalandırır. Oda kategoriyi, kategori tesisi geçersiz kılar. Boş alan bir üst seviyeyi kullanır. Değişiklikler yeni planlanan odalar için geçerlidir; kaydedilmiş günler dakikalarını korur.' },
  'cleaningPlan.normProperty': {
    de: 'Ganzes Haus',
    en: 'Whole property',
    tr: 'Tüm tesis' },
  'cleaningPlan.normDefault': {
    de: 'Vorgabe {minutes}',
    en: 'Default {minutes}',
    tr: 'Varsayılan {minutes}' },
  'cleaningPlan.normRooms': {
    de: 'Einzelne Zimmer',
    en: 'Individual rooms',
    tr: 'Tek tek odalar' },
  'cleaningPlan.normAddRoom': {
    de: 'Zimmer hinzufügen',
    en: 'Add room',
    tr: 'Oda ekle' },
  'cleaningPlan.normSave': {
    de: 'Sollminuten speichern',
    en: 'Save target minutes',
    tr: 'Hedef dakikaları kaydet' },

  'cleaningPlan.log': {
    de: 'Verlauf des Tages',
    en: 'Changes on this day',
    tr: 'Günün değişiklikleri' },
  'cleaningPlan.logEmpty': {
    de: 'Noch nichts geändert.',
    en: 'Nothing changed yet.',
    tr: 'Henüz bir değişiklik yok.' },
  'cleaningPlan.logCreated': {
    de: '{room}: geplant für {to}',
    en: '{room}: planned for {to}',
    tr: '{room}: {to} için planlandı' },
  'cleaningPlan.logMoved': {
    de: '{room}: von {from} zu {to}',
    en: '{room}: moved from {from} to {to}',
    tr: '{room}: {from} → {to}' },
  'cleaningPlan.logMinutes': {
    de: '{room}: {from} → {to} Min.',
    en: '{room}: {from} → {to} min',
    tr: '{room}: {from} → {to} dk' },
  'cleaningPlan.logStatus': {
    de: '{room}: Stand {from} → {to}',
    en: '{room}: status {from} → {to}',
    tr: '{room}: durum {from} → {to}' },
  'cleaningPlan.logDeleted': {
    de: '{room}: aus dem Plan genommen',
    en: '{room}: removed from the plan',
    tr: '{room}: plandan çıkarıldı' },
  'cleaningPlan.logBy': {
    de: '{zeit} · {wer}',
    en: '{zeit} · {wer}',
    tr: '{zeit} · {wer}' }
} as const satisfies Record<string, LocalizedText>
