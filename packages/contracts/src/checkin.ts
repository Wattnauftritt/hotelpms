import { Type, type Static } from '@sinclair/typebox'
import { IsoDate, CleaningWaiverView } from './schemas.js'

/**
 * Online-Check-in: der Vertrag zwischen Gastseite, Terminal und Schnittstelle.
 *
 * **Warum im Vertrag.** Drei Enden muessen sich einig sein: die Gastseite in
 * der Oberflaeche, die Station im Haus, die dieselbe Seite im Terminalmodus
 * oeffnet, und die Schnittstelle. Wer "auslaendisch" an zwei Stellen
 * entscheidet, entscheidet es irgendwann zweimal verschieden -- und dann
 * fragt die Maske keine Unterschrift ab, die die Schnittstelle verlangt.
 * Begruendungen in Dokument 30.
 */

/**
 * Die Kopfzeile, in der das Token zur Schnittstelle reist.
 *
 * **Nicht im Pfad.** Der Serialisierer des Anfrageprotokolls ersetzt die
 * Werte der Abfragezeichenfolge, nicht den Pfad: ein Token als Pfadsegment
 * stuende im Protokoll, und wer das Protokoll liest, koennte den Meldeschein
 * eines Gastes oeffnen. Die Kopfzeile schreibt der Serialisierer gar nicht
 * mit, und die Redaktionsliste von pino nennt sie trotzdem -- falls jemand
 * ihn spaeter erweitert.
 */
export const CHECKIN_TOKEN_HEADER = 'x-staygrid-checkin-token'

/** Der Pfad der Gastseite in der Oberflaeche. */
export const CHECKIN_PATH = '/checkin'

/**
 * Der Link, der in der Mail steht.
 *
 * **Das Token steht im Fragment (`#`), nicht in der Abfragezeichenfolge.**
 * Ein Fragment verlaesst den Browser nie: es steht in keinem Zugriffsprotokoll
 * von Caddy oder eines Proxys dazwischen und in keinem Referer. Die Seite
 * liest es selbst und schickt es in der Kopfzeile oben weiter.
 */
export function checkinLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CHECKIN_PATH}#${token}`
}

/**
 * Das Token aus dem Fragment, oder null.
 *
 * Streng auf die Form, die `neuesToken()` erzeugt (32 Byte base64url, also
 * 43 Zeichen). Ein abgeschnittener Link aus einem Mailprogramm soll
 * "ungueltig" ergeben und nicht eine Anfrage, die das erst die Datenbank
 * fragen laesst.
 */
export function checkinTokenAusFragment(hash: string): string | null {
  const t = hash.replace(/^#/, '').trim()
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null
}

/**
 * Ist diese Person im Sinne von § 29 Abs. 2 BMG auslaendisch?
 *
 * **Nach der Staatsangehoerigkeit, nicht nach dem Wohnsitz.** Das Gesetz
 * spricht von "auslaendischen Personen", also von Menschen ohne deutsche
 * Staatsangehoerigkeit. Bis hierher entschied der Meldeschein nach dem Land
 * der Anschrift -- eine Deutsche mit Wohnsitz in Wien haette unterschreiben
 * muessen, ein tuerkischer Staatsangehoeriger aus Bremen nicht. Wer
 * mehrere Staatsangehoerigkeiten hat und eine davon die deutsche ist, ist
 * nicht auslaendisch; die Maske sagt das dazu.
 *
 * Ist keine Staatsangehoerigkeit erfasst, gilt hilfsweise das Land der
 * Anschrift: so entschied der Tresen bisher, und Profile aus der Zeit davor
 * tragen oft nur das eine. Fehlt beides, ist die Person nicht auslaendisch --
 * eine Unterschrift ohne Rechtsgrund waere eine Erhebung ohne Rechtsgrund.
 */
export function istAuslaendisch(p: {
  nationality?: string | null; country?: string | null
}): boolean {
  const nat = (p.nationality ?? '').trim().toUpperCase()
  if (nat !== '') return nat !== 'DE'
  const land = (p.country ?? '').trim().toUpperCase()
  return land !== '' && land !== 'DE'
}

/**
 * Hoechstzahl der Mitreisenden je Meldeschein ueber den Link.
 *
 * Bei Reisegesellschaften von mehr als zehn Personen gilt nach § 29 Abs. 2
 * Satz 3 BMG eine andere Regel (die Reiseleitung meldet Anzahl und
 * Staatsangehoerigkeit). Das ist ein Vorgang am Tresen, kein Formular fuer
 * eine Familie.
 */
export const MAX_MITREISENDE = 9

/** Obergrenze fuer das Bild einer Unterschrift. Die Maske erzeugt ~20 KB. */
export const UNTERSCHRIFT_MAX_ZEICHEN = 300_000

/**
 * Ist das die Unterschrift, die unsere Maske zeichnet -- und nichts sonst?
 *
 * Auf der oeffentlichen Seite schickt ein Fremder, was er will. Ein SVG kann
 * Skript, Verweise nach aussen und eingebettete Fremdinhalte tragen, und
 * es wird spaeter einem Menschen gezeigt, wenn die Meldebehoerde Einsicht
 * nimmt. Angenommen wird deshalb genau die eine Form, die das Zeichenfeld
 * erzeugt: ein SVG mit einem PNG als data-URL darin.
 */
export function istUnterschriftSvg(svg: string): boolean {
  if (svg.length > UNTERSCHRIFT_MAX_ZEICHEN) return false
  return /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d{1,4}" height="\d{1,4}"><image href="data:image\/png;base64,[A-Za-z0-9+/=]+" width="\d{1,4}" height="\d{1,4}"\/><\/svg>$/
    .test(svg)
}

/**
 * Die Laender nach ISO 3166-1 alpha-2.
 *
 * Fuer die Auswahl der Staatsangehoerigkeit und der Anschrift, und als
 * Pruefung auf der Schnittstelle: `nationality` ist `char(2)`, und "XX"
 * passte dort hinein. Die Namen kommen in der Oberflaeche aus
 * `Intl.DisplayNames` in der Sprache des Gastes -- eine eigene Liste mit
 * 249 Namen in fuenf Sprachen waere eine, die niemand pflegt.
 */
export const LAENDER: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ '
  + 'BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO '
  + 'CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM '
  + 'FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN '
  + 'HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP '
  + 'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML '
  + 'MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR '
  + 'NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA '
  + 'SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG '
  + 'TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN '
  + 'VU WF WS XK YE YT ZA ZM ZW').split(' ')

export function istLand(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && LAENDER.includes(code)
}

// ---------------------------------------------------------------- Schemata

/**
 * Was die Gastseite ueber die Reservierung erfaehrt -- und mehr nicht.
 *
 * Name, Zeitraum, Haus. Keine Anschrift, kein Geburtsdatum, kein Preis,
 * keine anderen Gaeste: wer den Link aus einem weitergeleiteten Postfach
 * oeffnet, soll nicht mehr erfahren, als ohnehin im Betreff der Mail stand.
 * Darum wird auch nichts vorbefuellt ausser dem Namen.
 */
export const CheckinFormView = Type.Object({
  propertyName: Type.String(),
  arrival: IsoDate,
  departure: IsoDate,
  firstName: Type.Union([Type.String(), Type.Null()]),
  lastName: Type.String(),
  channel: Type.Union([Type.Literal('mail'), Type.Literal('terminal')]),
  /**
   * open           Meldeschein steht noch aus.
   * signatureOnly  Vorab erfasst, es fehlt nur die Unterschrift.
   * done           Nichts mehr zu tun.
   */
  state: Type.Union([Type.Literal('open'), Type.Literal('signatureOnly'),
                     Type.Literal('done')]),
  /**
   * Darf hier unterschrieben werden? Nur am Terminal und erst am Anreisetag
   * (§ 29 Abs. 2 BMG: "am Tag der Ankunft").
   */
  signatureAllowed: Type.Boolean(),
  /** Sprache am Gastprofil, als Vorschlag fuer die Seite. */
  language: Type.String(),
  maxCompanions: Type.Integer(),
  /**
   * Die Hausbedingungen, denen dieser Aufenthalt noch nicht zugestimmt hat,
   * in der Fassung des Anreisetags. Vollstaendig, nicht als Verweis: was
   * der Gast unterschreibt, soll er auf derselben Seite lesen.
   */
  terms: Type.Array(Type.Object({
    termsRef: Type.String(),
    title: Type.String(),
    body: Type.String(),
    requiresSignature: Type.Boolean()
  })),
  /**
   * Bietet das Haus die digitale Gaestekarte an? Nur wenn es an AVS meldet
   * (Migration 0090); sonst waere das Haekchen eine Zusage ohne Weg.
   */
  digitalGuestCardOffered: Type.Boolean(),
  /** Die Befreiungsgruende fuer die Kurtaxe, die das Haus anbietet. */
  exemptionReasons: Type.Array(Type.Object({
    code: Type.String(),
    label: Type.String(),
    needsProof: Type.Boolean()
  })),
  /**
   * Reinigungsverzicht (0115): die Bleibetage ab heute. `null`, wenn das
   * Haus ihn nicht anbietet oder kein Bleibetag mehr kommt.
   */
  cleaningWaiver: Type.Union([CleaningWaiverView, Type.Null()])
})
export type CheckinFormView = Static<typeof CheckinFormView>

export const CheckinAddress = Type.Object({
  line1: Type.String({ minLength: 1, maxLength: 200 }),
  postalCode: Type.String({ minLength: 1, maxLength: 20 }),
  city: Type.String({ minLength: 1, maxLength: 100 }),
  country: Type.String({ minLength: 2, maxLength: 2 })
}, { additionalProperties: false })

/**
 * Befreiung von der Kurtaxe, je Person. `reason` ist das Kuerzel eines
 * Grundes des Hauses; `proof` die Ausweis- oder Kartennummer, freiwillig und
 * nur, wo der Grund danach fragt -- sonst verworfen.
 */
export const CheckinTaxExemption = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 40 }),
  proof: Type.Optional(Type.String({ maxLength: 100 }))
}, { additionalProperties: false })
export type CheckinTaxExemption = Static<typeof CheckinTaxExemption>

export const CheckinPerson = Type.Object({
  lastName: Type.String({ minLength: 1, maxLength: 100 }),
  firstName: Type.String({ minLength: 1, maxLength: 100 }),
  birthDate: IsoDate,
  nationality: Type.String({ minLength: 2, maxLength: 2 }),
  taxExemption: Type.Optional(CheckinTaxExemption)
}, { additionalProperties: false })
export type CheckinPerson = Static<typeof CheckinPerson>

/**
 * Was die Gastseite einreicht.
 *
 * `additionalProperties: false` ueberall, und das ist hier keine Pedanterie:
 * es gibt kein Feld fuer eine Ausweiskopie (§ 30 BMG erlaubt die Nummer und
 * verbietet die Kopie), und ein Feld, das jemand trotzdem mitschickt, wird
 * abgewiesen statt still verworfen -- wer eine Kopie hochladen will, soll
 * erfahren, dass es das hier nicht gibt.
 */
export const CheckinSubmit = Type.Object({
  guest: Type.Object({
    lastName: Type.String({ minLength: 1, maxLength: 100 }),
    firstName: Type.String({ minLength: 1, maxLength: 100 }),
    birthDate: IsoDate,
    nationality: Type.String({ minLength: 2, maxLength: 2 }),
    address: CheckinAddress,
    /** Nur bei auslaendischen Gaesten; bei inlaendischen verworfen. */
    idDocumentType: Type.Optional(Type.Union([
      Type.Literal('passport'), Type.Literal('id_card'), Type.Literal('other')])),
    idDocumentNumber: Type.Optional(Type.String({ maxLength: 40 })),
    taxExemption: Type.Optional(CheckinTaxExemption)
  }, { additionalProperties: false }),
  companions: Type.Optional(Type.Array(CheckinPerson, { maxItems: MAX_MITREISENDE })),
  /** Nur am Terminal am Anreisetag angenommen, sonst verworfen. */
  signatureSvg: Type.Optional(Type.String({ maxLength: UNTERSCHRIFT_MAX_ZEICHEN })),
  /**
   * Die Hausbedingungen, denen der Gast zustimmt -- genau die Fassungen, die
   * ihm `terms` gezeigt hat. Jede offene muss dabei sein.
   */
  termsAccepted: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  /**
   * Die Unterschrift unter die Hausbedingungen. Anders als beim Meldeschein
   * auch von zu Hause und von jedem Gast: die Hausbedingung ist
   * privatrechtlich, § 29 Abs. 2 BMG gilt fuer sie nicht.
   */
  termsSignatureSvg: Type.Optional(Type.String({ maxLength: UNTERSCHRIFT_MAX_ZEICHEN })),
  /**
   * Einwilligung, dass AVS die Gaestekarte an die Mailadresse schickt
   * (`digit_gastkart`). Freiwillig; ohne sie geht die Adresse nicht mit.
   */
  digitalGuestCard: Type.Optional(Type.Boolean()),
  /**
   * Voraussichtliche Ankunftszeit, Freitext ("zwischen 16 und 17 Uhr").
   * Ueber den Mail-Link verlangt, am Terminal weder gefragt noch gespeichert:
   * dort ist der Gast schon da.
   */
  expectedArrival: Type.Optional(Type.String({ maxLength: 50 })),
  /**
   * Telefonnummer fuer den Aufenthalt (0123), meist das Handy. Verlangt,
   * ueber den Mail-Link wie am Terminal. Geht an den Meldeschein,
   * ins Gastprofil nur, wo dort noch keine Nummer steht.
   */
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  /** "Meine Angaben sind richtig und vollstaendig." */
  confirmed: Type.Literal(true)
}, { additionalProperties: false })
export type CheckinSubmit = Static<typeof CheckinSubmit>

export const CheckinSubmitted = Type.Object({
  state: Type.Union([Type.Literal('signatureOnly'), Type.Literal('done')])
})
export type CheckinSubmitted = Static<typeof CheckinSubmitted>

export const CheckinSignature = Type.Object({
  signatureSvg: Type.String({ minLength: 1, maxLength: UNTERSCHRIFT_MAX_ZEICHEN })
}, { additionalProperties: false })

export const CheckinSettings = Type.Object({
  enabled: Type.Boolean(),
  daysBefore: Type.Integer({ minimum: 1, maximum: 14 })
}, { additionalProperties: false })
export type CheckinSettings = Static<typeof CheckinSettings>

/**
 * Vorschau der Einladung, mit Beispieldaten, und ob sie hinausginge.
 *
 * `ready` beantwortet die Frage, die sonst als "warum kommt nichts an"
 * zurueckkommt: jede Bedingung einzeln, nicht ein Sammelschalter. Ein Haus
 * mit ausgeschaltetem Vorabversand ist bereit fuer die Testmail, und genau
 * so soll es aussehen, solange niemand ihn einschaltet.
 */
export const CheckinMailPreview = Type.Object({
  language: Type.String(),
  subject: Type.String(),
  text: Type.String(),
  html: Type.String(),
  ready: Type.Object({
    training: Type.Boolean(),
    mailEnabled: Type.Boolean(),
    senderAllowed: Type.Boolean(),
    autoEnabled: Type.Boolean()
  })
})
export type CheckinMailPreview = Static<typeof CheckinMailPreview>

export const CheckinTestMail = Type.Object({
  to: Type.String({ maxLength: 320 }),
  language: Type.Optional(Type.String())
}, { additionalProperties: false })
export type CheckinTestMail = Static<typeof CheckinTestMail>

export const CheckinLink = Type.Object({
  link: Type.String(),
  expiresOn: IsoDate
})
export type CheckinLink = Static<typeof CheckinLink>
