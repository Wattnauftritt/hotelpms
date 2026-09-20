import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { auswahlZeitraum, gruppenAuswahl, zimmerPassung, platzbedarf }
  from '../lib/tapeSelection.js'

/**
 * Was eine aufgezogene Auswahl im Belegungsplan bedeutet.
 *
 * Der Plan ist das Werkzeug, an dem die Rezeption den ganzen Tag sitzt, und
 * die Rechnerei dahinter ist die einzige Stelle, an der ein Fehler still
 * Geld kostet: aus Rasterindizes werden Kalenderdaten. Ein Tag daneben ist
 * eine Nacht zu viel auf der Rechnung und sieht im Plan genauso richtig aus
 * wie vorher.
 */

const TAGE = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
const ZIMMER = [
  { id: 11, category_id: 1 },
  { id: 12, category_id: 1 },
  { id: 13, category_id: 2 },
  { id: 14, category_id: 2 }
]

describe('Zeitraum einer aufgezogenen Auswahl', () => {
  it('macht aus einem markierten Tag eine Nacht', () => {
    // Markiert ist der 1., also die Nacht vom 1. auf den 2.
    expect(auswahlZeitraum(TAGE, 0, 0))
      .toEqual({ arrival: '2026-10-01', departure: '2026-10-02' })
  })

  it('zaehlt die Abreise einen Tag hinter den letzten markierten', () => {
    // Am Abreisetag ist das Zimmer ab mittags wieder frei; ein Balken, der
    // bis in ihn hineinreicht, laesst ein verkaeufliches Zimmer belegt
    // aussehen.
    expect(auswahlZeitraum(TAGE, 0, 2))
      .toEqual({ arrival: '2026-10-01', departure: '2026-10-04' })
  })

  it('versteht Aufziehen von rechts nach links', () => {
    expect(auswahlZeitraum(TAGE, 2, 0)).toEqual(auswahlZeitraum(TAGE, 0, 2))
  })

  /**
   * Der Fehler, den diese Zeile verhindert: am rechten Rand gibt es den
   * Abreisetag im Raster nicht mehr. Wer ihn nachschlaegt statt ihn zu
   * rechnen, bekommt `undefined` -- oder, schlimmer, den letzten
   * sichtbaren Tag, und die Buchung endet eine Nacht zu frueh.
   */
  it('rechnet die Abreise am rechten Rand, statt sie nachzuschlagen', () => {
    expect(auswahlZeitraum(TAGE, 3, 3))
      .toEqual({ arrival: '2026-10-04', departure: '2026-10-05' })
  })
})

describe('Mehrfachauswahl wird eine Gruppe', () => {
  it('nimmt alle Zeilen zwischen Anfang und Ende', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 0, index: 2, startDay: 0, day: 1 })
    expect(a.rooms).toEqual([
      { resourceId: 11, categoryId: 1 },
      { resourceId: 12, categoryId: 1 },
      { resourceId: 13, categoryId: 2 }
    ])
    expect(a).toMatchObject({ arrival: '2026-10-01', departure: '2026-10-03' })
  })

  it('versteht Aufziehen von unten nach oben', () => {
    const rauf = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 3, index: 1, startDay: 1, day: 0 })
    const runter = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 1, index: 3, startDay: 0, day: 1 })
    expect(rauf).toEqual(runter)
  })

  /**
   * Eine Gruppe liegt selten in einer Zimmergruppe: zwei Suiten, sechs
   * Doppelzimmer. Die Kategorie gehoert deshalb an jedes Zimmer, nicht
   * einmal an die Buchung.
   */
  it('behaelt die Zimmergruppe je Zimmer', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 1, index: 2, startDay: 0, day: 0 })
    expect(a.rooms.map(r => r.categoryId)).toEqual([1, 2])
  })

  it('bleibt bei einer Zeile eine Auswahl aus einem Zimmer', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 2, index: 2, startDay: 0, day: 0 })
    expect(a.rooms).toEqual([{ resourceId: 13, categoryId: 2 }])
  })
})

/**
 * Das Verschieben gab es lange und wurde nicht benutzt: der Zeiger blieb
 * ein Pfeil, und nichts am Balken sagte, dass er anfassbar ist. Eine
 * Funktion, die niemand findet, ist keine -- deshalb steht der Hinweis
 * hier als Test und nicht nur als Kommentar.
 */
describe('Die Gesten sind zu sehen', () => {
  const quelle = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('zeigt am Balken, dass er sich ziehen laesst', () => {
    expect(quelle).toContain('cursor-move')
  })

  it('zeigt auf freier Flaeche, dass sich dort aufziehen laesst', () => {
    expect(quelle).toContain('cursor-crosshair')
  })

  it('wertet die Modifikatortaste fuer die Mehrfachauswahl aus', () => {
    // Umschalt steht daneben, weil es auf jeder Tastatur dieselbe Taste
    // ist -- Strg und ⌘ sind es nicht.
    expect(quelle).toMatch(/e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey/)
  })
})

/**
 * Die Gastauswahl darf in keinem <label> stehen.
 *
 * Der Fehler, den das festhaelt, war zwei Bildschirme lang unsichtbar: ein
 * Klick auf einen Treffer der Gastsuche waehlte den Gast aus und nahm die
 * Auswahl im selben Wimpernschlag zurueck. Ein <label> leitet einen Klick an
 * sein erstes bedienbares Kind weiter; vor der Auswahl ist das das Suchfeld,
 * danach steht dort der Knopf "Aendern" -- und der raeumt die Auswahl wieder
 * ab. Die Buchungsmaske ging deshalb ohne `guestRef` hinaus, und niemandem
 * fiel es auf, weil die Buchung ja gelang.
 *
 * Geprueft wird an der Quelle, nicht im Browser: die Oberflaeche hat hier
 * keine DOM-Umgebung, und die Regel ist ohnehin eine ueber den Aufbau.
 */
describe('Gastauswahl', () => {
  const dateien = [
    'BookingDialog.tsx', 'GroupBookingDialog.tsx', 'Rechnungsempfaenger.tsx'
  ]

  /** Kommentare zaehlen nicht mit -- in ihnen steht das Wort ja gerade. */
  const ohneKommentare = (q: string): string =>
    q.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  for (const datei of dateien) {
    it(`steht in ${datei} nicht in einem <label>`, () => {
      const quelle = ohneKommentare(readFileSync(
        new URL(`../components/${datei}`, import.meta.url), 'utf8'))
      const bis = quelle.indexOf('<GuestPicker')
      expect(bis, `${datei} benutzt GuestPicker nicht mehr`).toBeGreaterThan(-1)

      const davor = quelle.slice(0, bis)
      const offen = (davor.match(/<label[\s>]/g) ?? []).length
      const geschlossen = (davor.match(/<\/label>/g) ?? []).length
      expect(offen - geschlossen,
        `${datei}: <GuestPicker> steht in einem <label>`).toBe(0)
    })
  }
})

describe('Der eingetippte Name geht nicht verloren', () => {
  /*
   * Der Befund aus dem Betrieb: "das System generiert Namen wie
   * HQNQHPXMDTFA". Es generierte keine. Die Reservierung hatte gar keinen
   * Gast, und der Plan zeigte an der Stelle des Namens ihre eigene Kennung
   * -- zwoelf Zeichen aus generate_public_ref, die wie ein erfundener Name
   * aussehen.
   *
   * Zwei Ursachen, beide hier festgehalten: das Suchfeld gab den
   * eingetippten Namen nicht weiter, und der Dialog liess sich ohne Gast
   * abschicken.
   */
  const picker = readFileSync(
    new URL('../components/GuestPicker.tsx', import.meta.url), 'utf8')
  const dialog = readFileSync(
    new URL('../components/BookingDialog.tsx', import.meta.url), 'utf8')
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('bietet den eingetippten Namen an, statt auf ein leeres Formular zu verweisen', () => {
    expect(picker).toContain('guestPicker.createNamed')
  })

  it('fuellt das Formular mit dem Suchbegriff vor', () => {
    // Sonst muss der Name ein zweites Mal getippt werden, und genau das
    // tut niemand.
    expect(picker).toContain('vorgabe={begriff.trim()}')
    expect(picker).toContain('useState(vorgabe)')
  })

  it('laesst den Dialog ohne Gast nicht abschicken', () => {
    expect(dialog).toContain('guest !== null')
  })

  it('zeigt im Plan keine Kennung an der Stelle eines Namens', () => {
    /*
     * Die Kennung bleibt im Titel des Balkens stehen, wo sie hingehoert --
     * nur nicht als Beschriftung. Eine Reservierung ohne Gast gibt es
     * weiterhin, sie kommt so aus einem Kanal; sie soll nur sagen, dass
     * ihr einer fehlt.
     */
    expect(plan).not.toMatch(/\{r\.last_name \?\? r\.public_ref\}/)
    expect(plan).toContain("t('tape.noGuest')")
  })
})

describe('Die Maske fuer eine neue Reservierung', () => {
  const dialog = readFileSync(
    new URL('../components/BookingDialog.tsx', import.meta.url), 'utf8')
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')
  const texte = readFileSync(
    new URL('../lib/i18n/plan.ts', import.meta.url), 'utf8')

  it('heisst Reservierung, nicht Buchung', () => {
    /*
     * Das Datenmodell trennt beides: eine `booking` haelt mehrere
     * `reservation`, und dieser Dialog legt einen Aufenthalt in einem
     * Zimmer an. Die Rezeption traegt eine Buchung ein, sie erstellt keine.
     */
    const block = texte.slice(texte.indexOf("'booking.title'"),
                              texte.indexOf("'booking.room'"))
    expect(block).toContain('Neue Reservierung')
  })

  it('rechnet Euro in ganze Cent um, ohne ueber Fliesskomma zu gehen', () => {
    /*
     * Geld ist immer eine ganze Zahl in Cent (CLAUDE.md).
     *
     * Hier stand `Math.round(Number(text.replace(',', '.')) * 100)`. Das
     * fing die Fliesskommaungenauigkeit ab, die aus "19,90" sonst 1989
     * macht -- und scheiterte an "1.234,50", weil `Number('1.234.50')`
     * `NaN` ist. An einer deutschen Rezeption wird der Tausenderpunkt
     * getippt. `centAusEingabe` rechnet auf den Ziffern und kennt beide
     * Trennzeichen.
     */
    expect(dialog).toContain('preisFelder(preis)')
    expect(dialog).not.toContain('Math.round')
    expect(dialog).not.toContain("replace(',', '.')")
  })

  it('verlangt bei einer Option eine Frist', () => {
    // Ohne Frist verfaellt sie nie und haelt das Zimmer dauerhaft besetzt.
    expect(dialog).toContain("!unverbindlich || optionBis !== ''")
  })

  it('schlaegt als Frist den Vortag der Anreise vor', () => {
    /*
     * Kein fester Abstand in Tagen: bei einer Anreise uebermorgen waeren
     * sieben Tage eine Frist **nach** der Anreise, und die Option verfiele
     * nie -- genau der Fall, den die Pflichtangabe verhindern soll.
     */
    expect(dialog).toContain('vortag(anfangsAnreise)')
  })

  it('rechnet den Vortag ohne new Date(iso)', () => {
    // Das verschiebt je nach Zeitzone um einen Tag (CLAUDE.md).
    const fn = dialog.slice(dialog.indexOf('function vortag'),
                            dialog.indexOf('export function BookingDialog'))
    expect(fn).toContain('Date.UTC')
    expect(fn).not.toMatch(/new Date\(iso\)/)
  })

  it('fragt bei Ueberbelegung, statt sie zu verbieten', () => {
    // Ein Kleinkind im Doppelzimmer ist der Normalfall. Ein Verbot zwaenge
    // die Rezeption zu einer falschen Zahl, und dann stimmt die Kurtaxe nicht.
    expect(dialog).toContain('booking.overCapacity')
    expect(dialog).toContain('zuViele')
  })

  it('zeigt die Notiz im Plan als Text, nicht als Merkmal', () => {
    // Eine Stecknadel sagt, dass es eine Notiz gibt, und verschweigt
    // welche -- also genau das, was man wissen will. Seit der Aufteilung
    // steht dort die Kurznotiz; die lange bleibt im Titel.
    expect(plan).toContain('· {r.short_note}')
    expect(plan).not.toContain('📌')
  })
})

describe('Kurznotiz und lange Notiz', () => {
  const dialog = readFileSync(
    new URL('../components/BookingDialog.tsx', import.meta.url), 'utf8')
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('zeigt auf dem Balken die Kurznotiz, nicht die lange', () => {
    /*
     * Der Balken ist bei einer Nacht 44 Pixel breit. Die ersten Zeichen
     * eines Absatzes sind "Gast hat angerufen weg...", also nichts.
     */
    expect(plan).toContain('· {r.short_note}')
    expect(plan).not.toContain('· {r.notes}')
  })

  it('haelt die lange Notiz im Titel bereit', () => {
    expect(plan).toContain('r.notes ?')
  })

  it('bietet in der Maske beide Felder an', () => {
    expect(dialog).toContain('booking.shortNote')
    expect(dialog).toContain('booking.notes')
    // Vierzig Zeichen, dieselbe Zahl wie in der Bedingung der Tabelle.
    expect(dialog).toContain('maxLength={40}')
  })
})

describe('Personenzahl ist vorbelegt', () => {
  const dialog = readFileSync(
    new URL('../components/BookingDialog.tsx', import.meta.url), 'utf8')

  it('nimmt die Belegung der Zimmergruppe als Vorgabe', () => {
    /*
     * Ein Doppelzimmer wird als Doppelzimmer verkauft, und meist reisen
     * auch zwei an. Das Feld leer zu lassen hiesse, dieselbe Zahl bei jeder
     * Buchung eintippen zu lassen -- und dann tippt irgendwann niemand mehr.
     */
    expect(dialog).toContain("maxOccupancy === undefined ? '' : String(maxOccupancy)")
  })
})

describe('Der Kalender selbst', () => {
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')
  const bildschirm = readFileSync(
    new URL('../routes/Tape.tsx', import.meta.url), 'utf8')

  it('verschiebt einen Aufenthalt in der Zeit, nicht nur zwischen Zimmern', () => {
    /*
     * Vorher aenderte ein Zug nur die Zeile. Anreise und Abreise blieben
     * stehen, wo sie waren -- die Kanten liessen sich einzeln ziehen, der
     * ganze Aufenthalt nicht.
     */
    expect(plan).toContain('d.day - d.startDay')
    expect(plan).toContain('addDays(d.arrival, versatz)')
    expect(plan).toContain('addDays(d.departure, versatz)')
  })

  it('macht aus einer Geste nicht zwei Aenderungen', () => {
    /*
     * Zimmer **und** Zeit zugleich waeren zwei Aufrufe, und dazwischen
     * liegt ein Zustand, den niemand gewollt hat. Schlaegt der zweite
     * fehl, bleibt genau der stehen.
     */
    expect(plan).toContain('drag.overResourceId === drag.quelleResourceId')
    expect(plan).toContain("d.overResourceId !== d.quelleResourceId")
  })

  it('blaettert Monate und Jahre mit Pfeilen', () => {
    expect(bildschirm).toContain('addMonths(von, -12)')
    expect(bildschirm).toContain('addMonths(von, -1)')
    expect(bildschirm).toContain('addMonths(von, 1)')
    expect(bildschirm).toContain('addMonths(von, 12)')
  })

  it('laesst die Gruppierung abschalten', () => {
    // Nach Gruppe fuer den Verkauf, nach Zimmernummer fuer alles, was am
    // Gebaeude haengt.
    expect(bildschirm).toContain('plan.groupByCategory')
    // `numeric`, sonst steht 110 vor 2.
    expect(bildschirm).toContain('{ numeric: true }')
  })

  it('setzt die Warnungen in eine Zeile', () => {
    /*
     * Gestapelt schoben drei Hinweise den Plan um drei Zeilen nach unten --
     * und der Plan ist der Bildschirm, auf den die Rezeption den ganzen Tag
     * sieht.
     */
    expect(bildschirm).toContain("warnungen.join(' · ')")
    expect(bildschirm).not.toMatch(/warnungen\.map\(\(w, i\)/)
  })
})

/**
 * Wohin eine Buchung ohne Zimmer darf.
 *
 * Der Fall, für den das gebaut ist: ein Kanalmanager legt jede Buchung ohne
 * Zimmer an -- die Route kennt das Feld gar nicht --, und sie landet im Band
 * oben im Plan. Von dort zieht die Rezeption sie in eine Zeile, und in
 * diesem einen Moment entscheidet sich, ob zwei Personen in einem
 * Einzelzimmer schlafen.
 */
describe('Passung eines Zimmers zur Buchung', () => {
  const dz = { category_id: 1, max_occupancy: 2 }
  const ez = { category_id: 2, max_occupancy: 1 }
  const suite = { category_id: 3, max_occupancy: 4 }
  /** Gebucht als Doppelzimmer, nur der Bucher erfasst -- der Normalfall
      im Band. */
  const dzBuchung = { categoryId: 1, occupants: 1, categoryMaxOccupancy: 2 }

  it('nennt die gebuchte Zimmergruppe passend', () => {
    expect(zimmerPassung(dz, dzBuchung)).toBe('passt')
  })

  /**
   * Ein Upgrade ist Alltag: gebucht Doppelzimmer, bekommen Juniorsuite.
   * Abgerechnet wird, was gebucht wurde -- die API prueft die Gruppe
   * deshalb bewusst nicht.
   */
  it('nennt eine groessere Zimmergruppe anders, aber nicht falsch', () => {
    expect(zimmerPassung(suite, dzBuchung)).toBe('andere')
  })

  /**
   * Der Befund, der diese Regel gedreht hat. Gerechnet wurde zuerst mit der
   * Personenzahl, und die steht bei einer Buchung aus dem Channel Manager
   * auf 1: angelegt wird genau ein Belegter, der Bucher (`channel.ts`).
   * Ein Doppelzimmer aus dem Channel war damit im Einzelzimmer "gross
   * genug" -- die Warnung fehlte an der einzigen Stelle, an der sie
   * gebraucht wird.
   */
  it('warnt beim Doppelzimmer im Einzelzimmer, auch wenn nur der Bucher erfasst ist', () => {
    expect(zimmerPassung(ez, dzBuchung)).toBe('zuKlein')
  })

  it('warnt auch ohne jeden erfassten Belegten', () => {
    expect(zimmerPassung(ez, { categoryId: 1, occupants: 0, categoryMaxOccupancy: 2 }))
      .toBe('zuKlein')
  })

  /**
   * Andersherum bleibt es still: ein Einzelzimmer im Doppelzimmer ist ein
   * Upgrade, keine Enge. Eine Warnung, die auch dabei kaeme, liest niemand.
   */
  it('schweigt beim Einzelzimmer im Doppelzimmer', () => {
    expect(zimmerPassung(dz, { categoryId: 2, occupants: 1, categoryMaxOccupancy: 1 }))
      .toBe('andere')
  })

  /**
   * Sind mehr Personen erfasst, als die gebuchte Gruppe fasst -- vier in
   * einem Doppelzimmer mit Aufbettung --, zaehlt die groessere Zahl.
   */
  it('zaehlt die erfassten Personen, wenn sie ueber die Zimmergruppe hinausgehen', () => {
    expect(zimmerPassung(suite, { categoryId: 1, occupants: 5, categoryMaxOccupancy: 2 }))
      .toBe('zuKlein')
    expect(platzbedarf({ occupants: 5, categoryMaxOccupancy: 2 })).toBe(5)
  })

  it('bleibt bei gleicher Gruppe passend, auch wenn die Zahl nicht aufgeht', () => {
    // Ueberbelegung innerhalb der eigenen Gruppe ist eine Frage an die
    // Rezeption, nicht an den Plan: das Zusatzbett steht nicht im System.
    expect(zimmerPassung(dz, { categoryId: 1, occupants: 3, categoryMaxOccupancy: 2 }))
      .toBe('passt')
  })
})

/**
 * Das Band der Buchungen ohne Zimmer zeigte vier und zaehlte alle. Die
 * uebrigen waren im Plan unsichtbar und nicht erreichbar -- bei einem
 * Kanalmanager, der jede Buchung ohne Zimmer anlegt, der Normalfall.
 */
describe('Das Band scrollt, statt abzuschneiden', () => {
  const quelle = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('zeichnet alle Buchungen ohne Zimmer, nicht die ersten vier', () => {
    expect(quelle).not.toMatch(/nichtZugewiesen\.slice\(/)
  })

  it('scrollt im Band und nimmt die Seite nicht mit', () => {
    // `overscroll-contain`: sonst rutscht der ganze Plan weg, sobald das
    // Band unten ankommt.
    expect(quelle).toContain('overscroll-contain')
  })
})

/**
 * Die Mehrfachauswahl, umgebaut.
 *
 * Vorher war sie ein Gummiband ueber einen zusammenhaengenden Bereich:
 * Zimmer 1 bis 8 ging, Zimmer 1 und 20 nicht. Ein Haus, das eine Gruppe auf
 * verstreute Zimmer legt -- weil die dazwischen belegt sind, der Normalfall
 * bei einer Gruppe, die kurzfristig kommt --, konnte sie gar nicht als eine
 * Buchung anlegen.
 *
 * Geprueft wird die Mechanik an der Quelle, nicht das Aussehen: ob ein
 * Kasten blau ist, faengt keinen Fehler und bricht bei jeder Gestaltung.
 */
describe('Die Mehrfachauswahl sammelt und laesst sich aufheben', () => {
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('haelt die Auswahl ueber den einzelnen Zug hinaus', () => {
    expect(plan).toMatch(/const \[auswahl, setAuswahl\] = useState</)
  })

  it('legt jeder Zug dazu, statt zu ersetzen', () => {
    // Das `Set` ist der Punkt: dieselbe Zeile zweimal zu ziehen darf sie
    // nicht zweimal in die Buchung legen.
    expect(plan).toContain("...new Set([...(vorher?.resourceIds ?? [])")
  })

  it('bucht nicht schon beim Loslassen', () => {
    /*
     * Vorher oeffnete das Loslassen sofort den Gruppendialog. Damit war die
     * Auswahl genau einen Zug lang -- und ein Zug ist ein
     * zusammenhaengender Bereich. Gebucht wird jetzt ueber die Leiste.
     */
    expect(plan).not.toMatch(/onCreateGroup\?\.\(gruppenAuswahl\(/)
    expect(plan).toContain("t('plan.bookSelection')")
  })

  it('nimmt den zuletzt gezogenen Zeitraum fuer alle Zeilen', () => {
    // Eine Gruppenbuchung kennt genau eine Anreise und eine Abreise.
    // Zwoelf Zeilen mit zwoelf Zeitraeumen waeren zwoelf Buchungen.
    expect(plan).toContain('arrival: neu.arrival, departure: neu.departure')
  })

  it('zeigt waehrend des Zugs die ganze Auswahl, nicht nur den letzten Streifen', () => {
    expect(plan).toContain(
      "const ids = new Set([...(auswahl?.resourceIds ?? []), ...zeilen.map(u => u.id)])")
  })

  it('hebt die Auswahl mit Esc auf', () => {
    expect(plan).toContain("if (e.key === 'Escape') setAuswahl(null)")
    // Am Fenster und nicht am Plan: der Plan haelt keinen Fokus, nach einem
    // Zug liegt der auf dem zuletzt beruehrten Balken oder nirgends.
    expect(plan).toContain("window.addEventListener('keydown', aufTaste)")
    expect(plan).toContain("window.removeEventListener('keydown', aufTaste)")
  })

  it('hebt sie auch auf, wenn man ohne Modifikator woanders hinklickt', () => {
    // Der Weg zurueck, den man ohne Anleitung findet. Er steht **vor** dem
    // Beginn des naechsten Zugs, sonst loeschte er die Auswahl, die dieser
    // Zug gerade aufbaut.
    expect(plan).toMatch(
      /setAuswahl\(null\)\n\s*setDragState\(\{ kind: 'create'/)
  })

  it('leert die Auswahl, wenn daraus eine Buchung wird', () => {
    // Sonst liegt nach dem Anlegen ein Schatten ueber den frischen Balken,
    // der aussieht wie eine zweite, ungebuchte Gruppe.
    expect(plan).toMatch(/onCreateGroup\?\.\(\{[\s\S]*?\}\)\n\s*setAuswahl\(null\)/)
  })

  it('haelt die Leiste sichtbar, ohne die Kopfzeile zu verdecken', () => {
    // Oben klebt die Kopfzeile mit den Tagen, und die wird beim Auswaehlen
    // eines Zeitraums gebraucht. Beide Achsen, weil eine Auswahl ueber
    // Zimmer 3 und Zimmer 200 liegen kann.
    expect(plan).toContain('sticky bottom-0 left-0 z-30')
  })
})

/**
 * Die Gruppe als Vorgang, auch in der Oberflaeche.
 *
 * An der Rezeption ist eine Reisegruppe **eine** Sache: "die Gruppe
 * Petersen kommt einen Tag spaeter". Acht Balken einzeln zu ziehen sind
 * acht Gelegenheiten, einen zu vergessen -- und der vergessene faellt erst
 * am Anreisetag auf, wenn ein Zimmer belegt ist, das frei sein sollte.
 */
describe('Eine Gruppenbuchung wandert als Gruppe', () => {
  const plan = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')
  const bildschirm = readFileSync(
    new URL('../routes/Tape.tsx', import.meta.url), 'utf8')

  it('verschiebt beim seitlichen Ziehen die ganze Gruppe', () => {
    expect(plan).toContain('if (d.bookingRooms > 1 && !d.einzeln)')
    expect(plan).toContain('onShiftGroup?.(d.bookingRef, versatz)')
  })

  it('laesst mit Alt doch nur das eine Zimmer wandern', () => {
    // Beim **Greifen** abgelesen, nicht beim Loslassen: waehrend des Zugs
    // liest niemand mehr die Tastatur, und ein `altKey` am Ende waere eine
    // andere Frage als die, die der Mensch beim Aufsetzen beantwortet hat.
    expect(plan).toContain('einzeln: e.altKey')
  })

  it('schickt einen Versatz in Tagen, keinen neuen Zeitraum', () => {
    /*
     * Nach einzelnen Aenderungen liegen die Zimmer einer Gruppe nicht mehr
     * deckungsgleich. Ein gemeinsamer neuer Zeitraum machte daraus wieder
     * einen Block und loeschte genau die Abweichungen, die jemand von Hand
     * eingetragen hat.
     */
    expect(plan).toContain('onShiftGroup?: (bookingRef: string, shiftDays: number) => void')
    expect(bildschirm).toContain('gruppeVerschieben.mutate({ bookingRef, shiftDays })')
  })

  it('zeichnet keinen Schatten je Zimmer der Gruppe, sondern die Zahl', () => {
    /*
     * Die Zimmer einer Gruppe liegen nicht deckungsgleich, und ein Schatten
     * hat genau eine Breite. Acht gleich breite Rechtecke zeigten eine
     * Deckungsgleichheit, die nach dem Loslassen nicht eintritt -- eine
     * Vorschau, die luegt, ist schlechter als keine.
     */
    expect(plan).toContain('gruppenZahl: versatz !== 0 && drag.bookingRooms > 1')
  })
})

describe('Die Gruppenmaske', () => {
  const maske = readFileSync(
    new URL('../components/GroupPanel.tsx', import.meta.url), 'utf8')
  const seitenfenster = readFileSync(
    new URL('../components/ReservationPanel.tsx', import.meta.url), 'utf8')

  it('holt alle Zimmer in einem Aufruf', () => {
    // Eine Gruppe darf fuenfzig Zimmer haben, und fuenfzig Runden machen
    // aus dem Oeffnen einer Maske eine Wartezeit (CLAUDE.md, "Leistung").
    expect(maske).toContain('useBooking(bookingRef)')
  })

  it('trennt Verschieben der Gruppe vom Aendern eines Zimmers', () => {
    /*
     * Der Alltag gibt die Trennung vor: der Bus kommt einen Tag spaeter
     * (Gruppe), aber die Eltern des Brautpaars bleiben eine Nacht laenger
     * (ein Zimmer). Ein gemeinsamer Knopf machte einen der beiden Faelle
     * kaputt.
     */
    expect(maske).toContain('verschieben.mutate({ bookingRef, shiftDays: n })')
    expect(maske).toContain('umbuchen.mutate(')
  })

  it('nimmt ein Zimmer heraus, indem es storniert -- nicht loescht', () => {
    // Geloescht waere die Reservierung aus der Statistik verschwunden, und
    // der Abend haette einen Storno weniger als das Haus.
    expect(maske).toContain("aktion.mutate('cancel')")
    expect(maske).toContain("t('group.removeConfirm')")
  })

  it('fragt vor dem Herausnehmen', () => {
    expect(maske).toContain('confirm(')
  })

  it('bekommt die Zimmergruppen als Eigenschaft, nicht als zweite Abfrage', () => {
    // Die Maske wird aus dem Plan geoeffnet, und der hat sie laengst
    // geladen.
    expect(maske).toContain('categories: ReadonlyArray<')
    expect(maske).not.toContain('useCategories')
  })

  it('wird aus dem Seitenfenster geoeffnet, nicht vom Balken', () => {
    /*
     * Am Balken sieht man einer Reservierung nicht an, dass sie zu sieben
     * weiteren gehoert, und ein zusaetzlicher Klickbereich auf einem
     * 44 Pixel breiten Kasten waere ein Fehlklick in Serie.
     */
    expect(seitenfenster).toContain('onOpenGroup(r.bookingRef)')
  })
})
