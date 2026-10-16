# Beigaben für die Rechnungserzeugung

Beides liegt hier als Datei und nicht als Abhängigkeit, weil ein erzeugter
Beleg über Jahre reproduzierbar sein muss: eine Schrift, die sich mit dem
nächsten `pnpm install` ändert, ändert das Schriftbild jeder künftigen
Rechnung, und ein Farbprofil, das fehlt, macht aus PDF/A-3 gewöhnliches PDF.

## `LiberationSans-Regular.ttf`, `LiberationSans-Bold.ttf`

Liberation Fonts 2.1.5, SIL Open Font License 1.1
(`LiberationSans-LICENSE.txt`), Quelle <https://github.com/liberationfonts>.

**Warum überhaupt eine mitgelieferte Schrift.** PDF/A verlangt, dass jede
verwendete Schrift **eingebettet** ist. Die vierzehn Standardschriften von
PDF sind es gerade nicht: sie verlassen sich auf den Betrachter. Ein PDF mit
Helvetica ist deshalb kein PDF/A, egal wie es aussieht.

**Warum diese.** Sie deckt Latein einschließlich der osteuropäischen
Zeichen, Kyrillisch, Griechisch und Hebräisch ab. Das ist keine Zierde: auf
einer Hotelrechnung steht der Name des Gastes, und der kommt aus Warschau,
Istanbul oder Prag. Eine Schrift ohne diese Zeichen ersetzt sie durch
Kästchen — auf dem Beleg, den der Gast mitnimmt.

In das PDF wandert nur der tatsächlich benutzte Ausschnitt (Subsetting),
nicht die ganze Datei.

## `sRGB2014.icc`

sRGB IEC 61966-2-1, herausgegeben vom International Color Consortium
(© ICC 2015), 3024 Byte. Das ICC gibt dieses Profil ausdrücklich zum
Kopieren, Verteilen und Einbetten frei.

PDF/A verlangt für jede geräteabhängige Farbe ein Ausgabeziel
(`OutputIntent`) mit hinterlegtem Profil. Ohne dieses Profil ist selbst ein
schwarz-weißer Beleg kein gültiges PDF/A.
