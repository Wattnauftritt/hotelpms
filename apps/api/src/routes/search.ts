import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, type Principal } from '../platform/context.js'
import type { SearchReservationHit, SearchResult } from '@hotelpms/contracts'

/**
 * Die Suche der Rezeption: Schnellsuche im Belegungsplan und Detailsuche
 * hinter Strg+K -- beide ueber diesen einen Endpunkt.
 *
 * **Ein Aufruf je Tastendruck, nicht je Treffer.** Die Oberflaeche fragt
 * entprellt, und die Antwort traegt alles, was eine Trefferzeile zeigt:
 * Zimmer, Zeitraum, Zustand, Begleitpersonen, Zahl der Aufenthalte, ob der
 * Gast gerade im Haus ist. Wer das je Zeile nachlaedt, macht aus einer
 * Runde zwanzig -- und das bei jedem Buchstaben.
 *
 * **Hausbezogen, obwohl Gaeste es nicht sind.** Gast und Firma gehoeren dem
 * Account (Entscheidung 13, Migration 0008), Reservierungen dem Haus. Die
 * Zeilenrichtlinie filtert nach Mandant, nicht nach Haus: wer zwei Haeuser
 * sieht, saehe ohne die ausdrueckliche Bedingung die Reservierungen beider.
 * Deshalb steht `property_id = $1` an jeder Reservierungstabelle, und die
 * Gaeste werden auf den Account **dieses** Hauses begrenzt -- auch wer
 * zugleich in einem zweiten Account arbeitet, sieht hier nur Gaeste des
 * Hauses, in dem er gerade sucht.
 *
 * **Was ein Gast aus dem Account zeigen darf.** Das Profil selbst: dieselben
 * Felder wie die Gastsuche (`GET /v1/guests`), die jeder mit `guest:read`
 * accountweit sieht. Die Zahl der Reservierungen und "im Haus" stammen
 * dagegen nur aus **diesem** Haus. Ein Rezeptionist mit einer Rolle in
 * Haus A erfuehre sonst ueber die Suche, dass Frau X gerade in Haus B
 * wohnt -- ein Aufenthalt, den er auf keinem anderen Weg sehen kann.
 *
 * **Anonymisierte Gaeste werden nicht gefunden.** Ihr Name lautet
 * "Anonymisiert", und ein Treffer darauf sagt, dass es einmal jemanden gab.
 * Ihre Reservierungen bleiben ueber die Nummer auffindbar: die
 * Buchungsbelege unterliegen der Aufbewahrung, und wer eine Nummer von einer
 * Rechnung abliest, muss sie finden.
 *
 * **Der Suchbegriff ist ein Gastname.** Er steht in der Abfragezeichenfolge
 * und damit in der Adresse, die Fastify protokolliert; der
 * `req`-Serialisierer in `platform/app.ts` ersetzt jeden Wert dort, und ein
 * Test haelt das fuer diese Route fest (`suche.test.ts`). Hier wird der
 * Begriff deshalb auch nirgends sonst ausgegeben -- nicht in einer
 * Fehlermeldung, nicht in einem Hinweis.
 *
 * **Warum jede Namenssuche ein `LIMIT` im Inneren hat** -- der Befund beim
 * Messen gegen das Saatlaufhaus. `guest` steht unter einer erzwungenen
 * Zeilenrichtlinie, und eine Bedingung des Aufrufers darf nur dann als
 * Indexbedingung **vor** der Richtlinie laufen, wenn ihr Operator
 * `LEAKPROOF` ist. `%` (pg_trgm) ist es nicht, `LIKE` auch nicht, `lower()`
 * ebenso wenig. Der GiST-Index liefert dann zwar die naechsten Nachbarn der
 * Reihe nach (`ORDER BY last_name <-> $2` ist keine Bedingung, sondern eine
 * Sortierung), aber `last_name % $2` wird erst danach geprueft. Gibt es
 * keinen Treffer -- ein Tippfehler, eine Nummer im Namensfeld --, laeuft der
 * Scan ueber alle 60 000 Gaeste, ohne dass das `LIMIT` je greift: 240 ms je
 * Tastendruck. Deshalb hier: erst die hundert naechsten nehmen, **dann**
 * nach Aehnlichkeit filtern. Der Scan endet nach hundert Zeilen, ob etwas
 * passt oder nicht. Dieselbe Falle steckt in `GET /v1/guests`
 * (Dokument 16, Fallstricke).
 */

const SCOPES = ['all', 'reservation', 'customer'] as const
type Scope = (typeof SCOPES)[number]

/** Treffer je Gruppe, wenn nichts verlangt ist: so viele passen ins Fenster. */
const LIMIT_STANDARD = 8
/**
 * Obergrenze je Gruppe. Eine Suche ist keine Liste; wer mehr als
 * fuenfundzwanzig Treffer durchblaettern muss, tippt einen Buchstaben mehr.
 */
const LIMIT_MAX = 25
/** Ein Name ist kuerzer. Was laenger ist, ist ein eingefuegter Absatz. */
const BEGRIFF_MAX = 100
/**
 * Wie viele naechste Nachbarn je Namenszweig gelesen werden.
 *
 * Bei "Mueller" sind es Hunderte Gaeste, je Gast kommen mehrere Aufenthalte
 * dazu. Hundert liegt weit ueber dem, was am Ende gezeigt wird -- sonst
 * fielen die aktuellen Aufenthalte eines haeufigen Namens weg, bevor nach
 * Datum sortiert ist -- und begrenzt zugleich, was ein Begriff ohne Treffer
 * kostet (siehe Dateikopf).
 */
const NACHBARN = 100

/**
 * Sieht der Begriff aus wie eine Nummer?
 *
 * Reservierungs- und Buchungsnummern sind zwoelf Zeichen aus Ziffern und
 * Grossbuchstaben (`generate_public_ref`), Nummern aus einem Kanal
 * (Booking.com, Expedia) meist Ziffern, gelegentlich mit Bindestrich. Ab
 * drei Zeichen, weil zwei bei dreissig Zeichen im Alphabet ein Dreissigstel
 * aller Buchungen treffen -- das ist keine Suche, das ist eine Liste.
 */
const NUMMER = /^[0-9A-Za-z._-]{3,40}$/

interface ReservierungZeile {
  reservationRef: string; bookingRef: string; externalReference: string | null
  status: SearchReservationHit['status']; arrival: string; departure: string
  past: boolean; matchedBy: SearchReservationHit['matchedBy']
  lastName: string | null; firstName: string | null
  roomCode: string | null; categoryCode: string; companions: string[]
}

interface KundeZeile {
  kind: 'guest' | 'company'; ref: string; name: string; firstName: string | null
  email: string | null; phone: string | null; city: string | null
  reservations: number; inHouse: boolean
}

/*
 * Die Namenssuche, in beiden Anweisungen gleich.
 *
 * Zwei Zweige, beide ueber den GiST-Trigramm-Index (Migration 0015) und
 * beide mit innerem `LIMIT`:
 *
 * - `<->` ist die Aehnlichkeit des ganzen Namens. Sie traegt Tippfehler
 *   ("Petersn") und den vollen Namen ("Jan Petersen"). Schwelle 0,3 wie der
 *   Operator `%`.
 * - `<<->` ist die Wortaehnlichkeit: wie gut der Begriff in einem Teil des
 *   Namens steckt. Sie traegt das, was man tippt, **bevor** man fertig ist --
 *   "Mü" hat mit "Müller" eine Aehnlichkeit von 0,25 und faellt unter die
 *   Schwelle, eine Wortaehnlichkeit von 0,67 und nicht -- und den zweiten
 *   Teil eines Doppelnamens ("Hansen" in "Brodersen-Hansen"). Schwelle 0,6
 *   wie `<%`.
 *
 * `$2` ist NULL, wenn der Begriff eine Ziffer enthaelt: kein Nachname hat
 * eine, und eine Nummer im Namenszweig ist genau der Begriff ohne Treffer,
 * der den Index am teuersten ablaeuft.
 */
const GAESTE_NACH_NAMEN = `
  nach_name AS (
    SELECT k.id, k.abstand FROM (
      SELECT g.id, g.last_name <-> $2 AS abstand FROM guest g
       WHERE $2::text IS NOT NULL
         AND g.account_id = (SELECT account_id FROM haus)
         AND g.status <> 'anonymized'
       ORDER BY g.last_name <-> $2
       LIMIT ${NACHBARN}) k
     WHERE k.abstand <= 0.7
    UNION ALL
    SELECT k.id, k.abstand FROM (
      SELECT g.id, $2 <<-> g.last_name AS abstand FROM guest g
       WHERE $2::text IS NOT NULL
         AND g.account_id = (SELECT account_id FROM haus)
         AND g.status <> 'anonymized'
       ORDER BY $2 <<-> g.last_name
       LIMIT ${NACHBARN}) k
     WHERE k.abstand <= 0.4
  )`

/*
 * Wie gut ein Name passt, in drei Stufen: gleich (auch als "Vorname
 * Nachname" oder "Nachname, Vorname"), am Anfang, irgendwo. Gerechnet nur
 * fuer die wenigen Kandidaten, nie ueber die Tabelle.
 */
const GUETE = `
  CASE WHEN lower($2) IN (lower(g.last_name),
                          lower(concat_ws(' ', g.first_name, g.last_name)),
                          lower(concat_ws(' ', g.last_name, g.first_name)),
                          lower(concat_ws(', ', g.last_name, g.first_name))) THEN 0
       WHEN starts_with(lower(g.last_name), lower($2)) THEN 1
       ELSE 2 END`

export function searchRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/search',
    /*
     * `reservation:read` und nicht `guest:read`: die Suche lebt am
     * Belegungsplan, und wer ihn sieht, sieht dort ohnehin Namen und
     * Nummern. Die Kunden -- mit Mail und Telefon -- verlangen zusaetzlich
     * `guest:read` und werden im Handler geprueft. Die Rolle `revenue` hat
     * das erste ohne das zweite: sie findet Reservierungen, aber keine
     * Kontaktdaten.
     */
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Reservierungen, Gaeste und Firmen suchen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { q?: unknown; scope?: string; limit?: string }

      // Mehrfache Leerzeichen zaehlen nicht: "Jan  Petersen" aus einer
      // eingefuegten Zeile ist dieselbe Frage wie "Jan Petersen". Zweimal
      // `q=` in der Adresse kommt als Liste an und ist keine Suche, sondern
      // ein Fehler des Aufrufers -- als 422, nicht als 500.
      const begriff = (typeof q.q === 'string' ? q.q : '').trim().replace(/\s+/g, ' ')
      if (begriff.length < 2) throw Errors.validation({ q: ['field.minTwoChars'] })
      if (begriff.length > BEGRIFF_MAX) {
        throw Errors.validation({ q: ['field.maxLength'] }, { max: BEGRIFF_MAX })
      }
      const scope = (q.scope ?? 'all') as Scope
      if (!SCOPES.includes(scope)) {
        throw Errors.validation({ scope: ['field.allowedValues'] },
          { values: SCOPES.join(', ') })
      }
      // Begrenzt statt abgewiesen, wie bei der Gastsuche: eine zu grosse
      // Zahl ist kein Fehler des Benutzers, sondern einer der Oberflaeche,
      // und eine Suche, die deswegen gar nichts zeigt, hilft niemandem.
      const limit = Math.min(Math.max(Math.trunc(Number(q.limit ?? LIMIT_STANDARD))
                                      || LIMIT_STANDARD, 1), LIMIT_MAX)

      const principal = req.principal as Principal
      const darfKunden = can(principal, 'guest:read', propertyId)
      if (scope === 'customer' && !darfKunden) {
        throw Errors.forbidden('access.missingPermission', { permission: 'guest:read' })
      }

      const name = /[\d@]/.test(begriff) ? null : begriff
      // Die eigenen Nummern sind gross geschrieben; getippt werden sie, wie
      // sie gerade fallen. Die des Kanals bleiben, wie sie sind: dort
      // entscheidet der Kanal ueber die Schreibweise, nicht wir.
      const nummer = NUMMER.test(begriff) ? begriff.toUpperCase() : null
      const extern = NUMMER.test(begriff) ? begriff : null
      /*
       * Die Mail nur, wenn ein @ darin steht. Der Zweig ist ueber
       * `email_lower` ein Indexbereich (unten), aber bei jedem Buchstaben
       * eines Namens bliebe er eine zweite Abfrage fuer einen Treffer, den
       * die Namenssuche ohnehin liefert. Wer nach der Mail sucht, kennt den
       * Namen nicht und fuegt die Adresse ein -- mit @.
       */
      const mail = begriff.includes('@') ? begriff.toLowerCase() : null

      const mitReservierungen = scope !== 'customer' && (name !== null || nummer !== null)
      const mitKunden = scope !== 'reservation' && darfKunden
        && (name !== null || mail !== null)

      return tx(req.pool, req, async client => {
        const ergebnis: SearchResult = {
          reservations: [], moreReservations: false,
          customers: [], moreCustomers: false
        }

        if (mitReservierungen) {
          /*
           * Eine Anweisung fuer alle drei Wege -- Gast, Begleitperson,
           * Nummer -- und fuer alles, was die Zeile zeigt.
           *
           * **Die Nummer** ueber `^@` (`starts_with`): anders als `LIKE` ist
           * es LEAKPROOF und darf den Index vor der Zeilenrichtlinie
           * benutzen (Migration 0058). Es kennt ausserdem keine
           * Platzhalter -- ein `_` im Suchfeld meint das Zeichen.
           *
           * **Die Reihenfolge.** Erst eine getroffene Nummer -- wer eine
           * tippt, meint genau diese. Dann die Guete des Namens (gleich,
           * Anfang, irgendwo), damit "Möller" nicht vor "Müller" steht, nur
           * weil Herr Möller morgen anreist. Innerhalb davon: wer im Haus
           * ist, dann was kommt (nach Anreise), dann was war (das Juengste
           * zuerst). Die Frage an der Rezeption ist fast immer "der Gast,
           * der gerade da ist oder gleich kommt" -- und selten "der vor drei
           * Jahren".
           *
           * "Heute" ist der offene Geschaeftstag, nicht `current_date`:
           * zwischen Mitternacht und Tagesabschluss ist der Gast, der heute
           * abreist, noch nicht Vergangenheit.
           *
           * Die Begleitpersonen werden nur fuer die Zeilen der Seite
           * zusammengesetzt, in einem Verbund statt einer Unterabfrage je
           * Zeile.
           */
          const { rows } = await client.query<ReservierungZeile>(
            `WITH haus AS (
               SELECT p.account_id,
                      COALESCE((SELECT bd.date FROM business_day bd
                                 WHERE bd.property_id = p.id AND bd.status = 'open'
                                 ORDER BY bd.date DESC LIMIT 1), current_date) AS heute
                 FROM property p WHERE p.id = $1
             ), ${GAESTE_NACH_NAMEN},
             gaeste AS (
               SELECT g.id, min(n.abstand) AS abstand, ${GUETE} AS guete
                 FROM nach_name n JOIN guest g ON g.id = n.id
                GROUP BY g.id
             ), kandidaten AS (
               SELECT r.id, 1 AS rang, ga.guete, ga.abstand
                 FROM gaeste ga JOIN reservation r ON r.primary_guest_id = ga.id
                WHERE r.property_id = $1
               UNION ALL
               SELECT o.reservation_id, 2, ga.guete, ga.abstand
                 FROM gaeste ga JOIN reservation_occupant o ON o.guest_id = ga.id
                WHERE o.property_id = $1
               UNION ALL
               SELECT r.id, 0, 0, 0 FROM reservation r
                WHERE $3::text IS NOT NULL AND r.public_ref ^@ $3
                  AND r.property_id = $1
               UNION ALL
               SELECT r.id, 0, 0, 0
                 FROM booking b JOIN reservation r ON r.booking_id = b.id
                WHERE $3::text IS NOT NULL AND b.public_ref ^@ $3
                  AND b.property_id = $1
               UNION ALL
               SELECT r.id, 0, 0, 0
                 FROM booking b JOIN reservation r ON r.booking_id = b.id
                WHERE $4::text IS NOT NULL AND b.external_reference ^@ $4
                  AND b.property_id = $1
               UNION ALL
               -- Die Nummer aus dem Altsystem, genau getroffen: "359" soll
               -- nicht jede KWHotel-Nummer von 35900 bis 35999 liefern
               -- (Migration 0079).
               SELECT r.id, 0, 0, 0 FROM reservation r
                WHERE $4::text IS NOT NULL AND r.legacy_reference = $4
                  AND r.property_id = $1
             ), beste AS (
               SELECT id, min(rang) AS rang, min(guete) AS guete, min(abstand) AS abstand
                 FROM kandidaten GROUP BY id
             ), seite AS (
               SELECT * FROM (
                 SELECT r.id, r.status, r.arrival, r.departure, r.primary_guest_id,
                        r.resource_id, r.category_id, r.booking_id, r.public_ref,
                        be.rang, r.departure <= h.heute AS vergangen,
                        row_number() OVER (ORDER BY
                          be.rang = 0 DESC,
                          be.guete,
                          CASE WHEN r.status = 'InHouse' THEN 0
                               WHEN r.status IN ('Inquired','Optional','Confirmed')
                                    AND r.departure > h.heute THEN 1
                               ELSE 2 END,
                          CASE WHEN r.status IN ('Inquired','Optional','Confirmed','InHouse')
                                    AND r.departure > h.heute
                               THEN r.arrival - DATE '2000-01-01'
                               ELSE DATE '2000-01-01' - r.arrival END,
                          be.abstand, r.id) AS reihe
                   FROM beste be
                   JOIN reservation r ON r.id = be.id
                  CROSS JOIN haus h) k
                WHERE k.reihe <= $5 + 1
             ), begleiter AS (
               SELECT o.reservation_id,
                      array_agg(concat_ws(' ', og.first_name, og.last_name)
                                ORDER BY o.id) AS namen
                 FROM seite s
                 JOIN reservation_occupant o ON o.reservation_id = s.id
                 JOIN guest og ON og.id = o.guest_id
                WHERE og.status <> 'anonymized'
                  AND o.guest_id IS DISTINCT FROM s.primary_guest_id
                GROUP BY o.reservation_id
             )
             SELECT s.public_ref AS "reservationRef", b.public_ref AS "bookingRef",
                    b.external_reference AS "externalReference",
                    s.status, s.arrival::text AS arrival, s.departure::text AS departure,
                    s.vergangen AS past,
                    CASE s.rang WHEN 0 THEN 'number' WHEN 1 THEN 'guest'
                                ELSE 'companion' END AS "matchedBy",
                    g.last_name AS "lastName", g.first_name AS "firstName",
                    res.code AS "roomCode", c.code AS "categoryCode",
                    COALESCE(bg.namen, '{}') AS companions
               FROM seite s
               JOIN booking b ON b.id = s.booking_id
               JOIN resource_category c ON c.id = s.category_id
               LEFT JOIN resource res ON res.id = s.resource_id
               LEFT JOIN guest g ON g.id = s.primary_guest_id
               LEFT JOIN begleiter bg ON bg.reservation_id = s.id
              ORDER BY s.reihe`,
            [propertyId, name, nummer, extern, limit])
          ergebnis.moreReservations = rows.length > limit
          ergebnis.reservations = rows.slice(0, limit)
        }

        if (mitKunden) {
          /*
           * Gaeste und Firmen in einer Anweisung, nach derselben Guete
           * sortiert: wer "Hansen" tippt, sucht vielleicht Herrn Hansen,
           * vielleicht die Hansen GmbH, und welches von beiden gemeint ist,
           * weiss die Suche nicht besser als die Liste.
           *
           * Die Telefonnummer wird nicht gesucht: sie steht in jeder
           * Schreibweise anders da, und eine Suche, die "040 123" nicht
           * findet, weil "+4940123" gespeichert ist, ist schlechter als
           * keine.
           *
           * Die Zahl der Reservierungen und "im Haus" kommen aus diesem Haus
           * (siehe oben) und als Verbund ueber die Kandidaten, nicht je
           * Zeile. Bei der Firma zaehlt, was sie gebucht hat
           * (`booking.booker_company_id`, Migration 0058).
           *
           * Die Mail wird als Bereich ueber `email_lower` gesucht, nicht mit
           * `starts_with(lower(email), ...)`: `lower()` ueber der Spalte ist
           * nicht LEAKPROOF und laeuft deshalb erst hinter der
           * Zeilenrichtlinie, ein Begriff ohne Treffer las so jeden Gast des
           * Accounts. `starts_with(email_lower, ...)` allein genuegt auch
           * nicht: im generischen Plan leitet PostgreSQL daraus keinen
           * Indexbereich ab. Die beiden Vergleiche tun es in beiden Plaenen
           * (Migration 0069, wie `GET /v1/guests`). `$3` ist schon
           * kleingeschrieben; `email_lower` ist NULL, wo `email` es ist.
           */
          const { rows } = await client.query<KundeZeile>(
            `WITH haus AS (
               SELECT account_id FROM property WHERE id = $1
             ), ${GAESTE_NACH_NAMEN},
             nach_mail AS (
               SELECT g.id, 0::real AS abstand FROM guest g
                WHERE $3::text IS NOT NULL
                  AND g.account_id = (SELECT account_id FROM haus)
                  AND g.status <> 'anonymized'
                  AND g.email_lower ~>=~ $3
                  AND g.email_lower ~<~ text_prefix_end($3)
                LIMIT $4 + 1
             ), gaeste AS (
               SELECT g.id, g.public_ref, g.last_name, g.first_name, g.email, g.phone,
                      g.city, min(n.abstand) AS abstand,
                      CASE WHEN g.email_lower = $3 THEN 0
                           WHEN $2::text IS NULL THEN 1
                           ELSE ${GUETE} END AS guete
                 FROM (SELECT * FROM nach_name UNION ALL SELECT * FROM nach_mail) n
                 JOIN guest g ON g.id = n.id
                GROUP BY g.id
             ), gast_aufenthalte AS (
               SELECT k.guest_id, count(DISTINCT k.reservation_id) AS anzahl,
                      bool_or(k.status = 'InHouse') AS im_haus
                 FROM (SELECT r.primary_guest_id AS guest_id, r.id AS reservation_id,
                              r.status
                         FROM gaeste ga JOIN reservation r ON r.primary_guest_id = ga.id
                        WHERE r.property_id = $1
                       UNION ALL
                       SELECT o.guest_id, r.id, r.status
                         FROM gaeste ga
                         JOIN reservation_occupant o ON o.guest_id = ga.id
                         JOIN reservation r ON r.id = o.reservation_id
                        WHERE o.property_id = $1) k
                GROUP BY k.guest_id
             ), firmen AS (
               SELECT k.*,
                      CASE WHEN lower(k.name) = lower($2) THEN 0
                           WHEN starts_with(lower(k.name), lower($2)) THEN 1
                           ELSE 2 END AS guete
                 FROM (SELECT c.id, c.public_ref, c.name, c.invoice_email, c.city,
                              least(c.name <-> $2, $2 <<-> c.name) AS abstand
                         FROM company c
                        WHERE $2::text IS NOT NULL
                          AND c.account_id = (SELECT account_id FROM haus) AND c.active
                        ORDER BY $2 <<-> c.name
                        LIMIT ${NACHBARN}) k
                WHERE k.abstand <= 0.4 OR (k.name <-> $2) <= 0.7
             ), firma_aufenthalte AS (
               SELECT b.booker_company_id AS company_id, count(r.id) AS anzahl,
                      bool_or(r.status = 'InHouse') AS im_haus
                 FROM firmen f
                 JOIN booking b ON b.booker_company_id = f.id
                 JOIN reservation r ON r.booking_id = b.id
                WHERE b.property_id = $1
                GROUP BY b.booker_company_id
             )
             SELECT * FROM (
               SELECT 'guest' AS kind, g.public_ref AS ref, g.last_name AS name,
                      g.first_name AS "firstName", g.email, g.phone, g.city,
                      COALESCE(a.anzahl, 0)::int AS reservations,
                      COALESCE(a.im_haus, false) AS "inHouse", g.guete, g.abstand
                 FROM gaeste g LEFT JOIN gast_aufenthalte a ON a.guest_id = g.id
               UNION ALL
               SELECT 'company', f.public_ref, f.name, NULL, f.invoice_email, NULL,
                      f.city, COALESCE(fa.anzahl, 0)::int,
                      COALESCE(fa.im_haus, false), f.guete, f.abstand
                 FROM firmen f LEFT JOIN firma_aufenthalte fa ON fa.company_id = f.id
             ) k
             ORDER BY guete, "inHouse" DESC, abstand, name, ref
             LIMIT $4 + 1`,
            [propertyId, name, mail, limit])
          ergebnis.moreCustomers = rows.length > limit
          ergebnis.customers = rows.slice(0, limit).map(r => ({
            kind: r.kind, ref: r.ref, name: r.name, firstName: r.firstName,
            email: r.email, phone: r.phone, city: r.city,
            reservations: r.reservations, inHouse: r.inHouse
          }))
        }

        return ergebnis
      })
    }
  })
}
