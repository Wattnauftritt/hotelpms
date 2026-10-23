/*
 * Die Verschluesselung liegt seit der Kanalanbindung (Migration 0198) in
 * `@hotelpms/domain`: der Worker entschluesselt die Zugangsdaten eines
 * Channel Managers selbst, und eine App darf nicht aus einer anderen
 * importieren. Die Pfade der API bleiben, damit kein Aufrufer wandern muss.
 */
export { CURRENT_KEY_VERSION, encryptIdDocument, decryptIdDocument, maskIdDocument,
         safeEqual, encryptSecret, decryptSecret } from '@hotelpms/domain'
