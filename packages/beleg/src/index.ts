/**
 * Das Rechnungsblatt und sein PDF/A-3-Rahmen.
 *
 * Ein eigenes Paket, weil zwei Apps es zeichnen: der Worker den Beleg nach
 * dem Festschreiben, die API den Entwurf davor (Sven, 16.10.2026: "es waere
 * gut wenn es kuenftig eine rechnungsvorschau gaebe bevor ich diese
 * festschreibe"). Apps duerfen einander nicht importieren, und zwei
 * Fassungen des Blattes liefen auseinander -- die Vorschau saehe dann
 * anders aus als das Papier, und genau dafuer gibt es sie.
 */
export * from './invoiceLayout.js'
export * from './pdfa3.js'
export * from './rechnungsbeleg.js'
