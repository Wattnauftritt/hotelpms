# Symbole und Startbild der App aus der Zeichnung von apps/web/public/icons/icon.svg.
#
# Die Zeichnung sind fuenf Rechtecke; sie hier nachzuzeichnen ist kuerzer als
# ein SVG-Renderer als Abhaengigkeit. Wer icon.svg aendert, aendert die
# Zahlen hier mit und laesst das Skript neu laufen:
#
#     python3 scripts/symbole.py
#
# iOS bekommt ein volles Quadrat (das System rundet selbst), Android ein
# adaptives Symbol: Hintergrundfarbe plus Vordergrund, dessen Inhalt in der
# sicheren Mitte bleibt, weil jeder Hersteller anders zuschneidet.
from pathlib import Path
from PIL import Image, ImageDraw

HIER = Path(__file__).resolve().parent.parent
GRUND = (23, 23, 23, 255)  # #171717
BALKEN = [((112, 136, 320, 192), '#60a5fa'), ((192, 228, 400, 284), '#34d399'),
          ((112, 320, 232, 376), '#fbbf24'), ((272, 320, 400, 376), '#a78bfa')]
LINIEN = [176, 256, 336]
# Weiss zu 14 Prozent ueber dem Grund, als volle Farbe: ImageDraw mischt
# nicht, eine halbdurchsichtige Linie waere ein Loch im Symbol.
LINIE = (56, 56, 56, 255)


def zeichnung(groesse, mit_grund, rund=0, anteil=1.0):
    """Die Zeichnung auf `groesse` Pixel; `anteil` verkleinert sie zur Mitte hin."""
    gross = groesse * 4  # vierfach zeichnen und verkleinern: glatte Kanten
    bild = Image.new('RGBA', (gross, gross), (0, 0, 0, 0))
    d = ImageDraw.Draw(bild)
    if mit_grund:
        d.rounded_rectangle((0, 0, gross - 1, gross - 1), radius=rund * gross / 512, fill=GRUND)
    s = gross * anteil / 512
    o = gross * (1 - anteil) / 2
    for x in LINIEN:
        d.line((o + x * s, o + 112 * s, o + x * s, o + 400 * s),
               fill=LINIE, width=max(1, round(6 * s)))
    for (x0, y0, x1, y1), farbe in BALKEN:
        d.rounded_rectangle((o + x0 * s, o + y0 * s, o + x1 * s, o + y1 * s),
                            radius=14 * s, fill=farbe)
    return bild.resize((groesse, groesse), Image.LANCZOS)


def startbild(breite, hoehe):
    bild = Image.new('RGBA', (breite, hoehe), GRUND)
    k = min(breite, hoehe) // 4
    bild.alpha_composite(zeichnung(k, False), ((breite - k) // 2, (hoehe - k) // 2))
    return bild


# iOS: ein Symbol in 1024 Punkten, ohne Transparenz.
ios = HIER / 'ios/App/App/Assets.xcassets'
zeichnung(1024, True).convert('RGB').save(ios / 'AppIcon.appiconset/AppIcon-512@2x.png')
for name in ('splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'):
    startbild(2732, 2732).convert('RGB').save(ios / 'Splash.imageset' / name)

# Android: Symbol klassisch und rund, adaptiver Vordergrund, Startbilder.
res = HIER / 'android/app/src/main/res'
for dichte, mal in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    seite = round(48 * mal)
    zeichnung(seite, True, rund=112).save(res / f'mipmap-{dichte}/ic_launcher.png')
    zeichnung(seite, True, rund=256).save(res / f'mipmap-{dichte}/ic_launcher_round.png')
    # 108 dp Flaeche, 66 dp sichere Mitte: die Zeichnung auf 83 dp.
    zeichnung(round(108 * mal), False, anteil=83 / 108).save(
        res / f'mipmap-{dichte}/ic_launcher_foreground.png')
for datei in res.glob('drawable*/splash.png'):
    with Image.open(datei) as alt:
        groesse = alt.size
    startbild(*groesse).convert('RGB').save(datei)
print('Symbole und Startbilder geschrieben')
