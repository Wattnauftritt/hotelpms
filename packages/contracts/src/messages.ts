/**
 * Meldungen der Schnittstelle in beiden Sprachen.
 *
 * **Warum das hier liegt und nicht in der API.** Ein Fehler der Schnittstelle
 * wird an zwei Orten gelesen: von einer Maschine, die auf ihn reagiert, und
 * von einem Menschen an der Rezeption, der ihn verstehen soll. Die Maschine
 * braucht einen stabilen Schluessel, der Mensch einen Satz in seiner Sprache.
 * Der Schluessel gehoert damit zum Vertrag, genau wie ein Feldname -- und
 * deshalb steht er hier neben den Schemata und nicht in `apps/api`.
 *
 * **Deutsch und Englisch stehen nebeneinander, nicht in zwei Listen.** Zwei
 * getrennte Bloecke laufen auseinander, sobald jemand einen Satz aendert und
 * den anderen vergisst; nebeneinander faellt die Luecke beim Hinsehen auf,
 * und ein Test faengt sie ohnehin ab.
 *
 * **Platzhalter** stehen in geschweiften Klammern: `{max}`. Eine Meldung mit
 * Platzhaltern ohne Werte bleibt lesbar -- der Platzhalter bleibt stehen,
 * statt dass die Meldung verschwindet.
 *
 * Die Sprache der Oberflaeche ist die des Personals; die der Gastpost steht
 * am Gastprofil und wird nicht hier entschieden (Dokument 19).
 */

/**
 * Die Sprachen, in denen Oberflaeche und Meldungen **vollstaendig**
 * vorliegen.
 *
 * Bewusst hier und nicht in `apps/web`: die Liste ist eine Zusage des
 * Produkts, kein Merkmal eines Bildschirms, und der Test ueber den Katalog
 * braucht sie genauso wie die Oberflaeche. Eine Sprache steht hier erst,
 * wenn jeder Schluessel sie hat -- halb uebersetzt anzubieten heisst, dem
 * Benutzer die Haelfte in einer Sprache zu zeigen, die er nicht gewaehlt
 * hat.
 */
export const LOCALES = ['de', 'en'] as const
export type MessageLocale = (typeof LOCALES)[number]

/**
 * Ein Eintrag: ein Satz je Sprache.
 *
 * Bewusst benannte Felder und keine Liste. Bei zwei Sprachen waere eine
 * Liste knapper; ab der dritten liest niemand mehr ab, welcher Satz zu
 * welcher Sprache gehoert, und eine vertauschte Reihenfolge faellt keinem
 * Typ auf. Ein fehlendes Feld dagegen bricht den Build.
 */
type Eintrag = { readonly [L in MessageLocale]: string }

const M = {
  // ------------------------------------------------------------ Fehlertitel

  'error.unauthorized': {
    de: 'Nicht angemeldet',
    en: 'Not signed in' },
  'error.forbidden': {
    de: 'Keine Berechtigung',
    en: 'Not permitted' },
  'error.notFound': {
    de: '{what} nicht gefunden',
    en: '{what} not found' },
  'error.conflict': {
    de: 'Konflikt',
    en: 'Conflict' },
  'error.validation': {
    de: 'Eingabe ungueltig',
    en: 'Invalid input' },
  'error.unprocessable': {
    de: 'Nicht verarbeitbar',
    en: 'Cannot be processed' },
  'error.soldOut': {
    de: 'Kein Kontingent verfuegbar',
    en: 'No availability left' },
  'error.soldOut.detail': {
    de: 'Fuer mindestens eine Nacht des Zeitraums ist die Kapazitaet erschoepft.',
    en: 'For at least one night of the period there is no capacity left.' },
  'error.notMaterialized': {
    de: 'Zeitraum nicht verfuegbar',
    en: 'Period not available' },
  'error.notMaterialized.detail': {
    de: 'Der Zeitraum liegt ausserhalb des vorbereiteten Horizonts. '
      + 'Der Betrieb wurde benachrichtigt.',
    en: 'The period lies beyond the prepared horizon. Operations have been notified.' },
  'error.rangeTooLarge': {
    de: 'Zeitraum zu gross',
    en: 'Period too large' },
  'error.rangeTooLarge.detail': {
    de: 'Hoechstens {max} Tage je Anfrage.',
    en: 'At most {max} days per request.' },
  'error.idempotencyMismatch': {
    de: 'Idempotenzschluessel wiederverwendet',
    en: 'Idempotency key reused' },
  'error.idempotencyMismatch.detail': {
    de: 'Derselbe Schluessel wurde bereits mit einem anderen Rumpf benutzt.',
    en: 'The same key has already been used with a different body.' },
  'error.idempotencyInFlight': {
    de: 'Anfrage laeuft bereits',
    en: 'Request already in flight' },
  'error.idempotencyInFlight.detail': {
    de: 'Eine Anfrage mit diesem Schluessel wird gerade verarbeitet. Bitte wiederholen.',
    en: 'A request with this key is being processed. Please try again.' },
  'error.notConfigured': {
    de: 'Nicht eingerichtet',
    en: 'Not configured' },
  'error.invalidSignature': {
    de: 'Signatur ungueltig',
    en: 'Invalid signature' },
  'error.documentPending': {
    de: 'Beleg noch nicht erzeugt',
    en: 'Document not generated yet' },
  'error.documentPending.detail': {
    de: 'Die Rechnung ist festgeschrieben, der Beleg wird gerade erzeugt. '
      + 'Bitte in Kuerze erneut abrufen.',
    en: 'The invoice is final; the document is being generated. Please retry shortly.' },
  'error.unknown': {
    de: 'Unbekannter Fehler',
    en: 'Unknown error' },
  'error.internal': {
    de: 'Interner Fehler',
    en: 'Internal error' },
  'error.rateLimited': {
    de: 'Zu viele Anfragen',
    en: 'Too many requests' },
  'error.rateLimited.detail': {
    de: 'Bitte in {seconds} Sekunden erneut versuchen.',
    en: 'Please try again in {seconds} seconds.' },

  // -------------------------------------------------------------- Ressourcen
  //
  // Der Name, der in "X nicht gefunden" eingesetzt wird. Eine kleine, feste
  // Liste: was es nicht gibt, ist immer eines dieser Dinge.

  'res.resource': {
    de: 'Ressource',
    en: 'Resource' },
  'res.property': {
    de: 'Property',
    en: 'Property' },
  'res.reservation': {
    de: 'Reservierung',
    en: 'Reservation' },
  'res.folio': {
    de: 'Folio',
    en: 'Folio' },
  'res.guest': {
    de: 'Gast',
    en: 'Guest' },
  'res.company': {
    de: 'Firma',
    en: 'Company' },
  'res.category': {
    de: 'Zimmergruppe',
    en: 'Room type' },
  'res.room': {
    de: 'Zimmer',
    en: 'Room' },
  'res.invoice': {
    de: 'Rechnung',
    en: 'Invoice' },
  'res.block': {
    de: 'Kontingent',
    en: 'Block' },
  'res.subscription': {
    de: 'Abonnement',
    en: 'Subscription' },
  'res.settlement': {
    de: 'Zahlungsvermerk',
    en: 'Settlement' },
  'res.paymentMethod': {
    de: 'Zahlungsart',
    en: 'Payment method' },
  'res.maintenanceTicket': {
    de: 'Wartungsmeldung',
    en: 'Maintenance ticket' },
  'res.connection': {
    de: 'Verbindung',
    en: 'Connection' },
  'res.ratePlan': {
    de: 'Ratenplan',
    en: 'Rate plan' },
  'res.registration': {
    de: 'Meldeschein',
    en: 'Registration form' },
  'res.oauthClient': {
    de: 'Maschinenzugang',
    en: 'Machine access' },
  'res.user': {
    de: 'Benutzer',
    en: 'User' },
  'res.task': {
    de: 'Aufgabe',
    en: 'Task' },
  'res.message': {
    de: 'Nachricht',
    en: 'Message' },
  'res.product': {
    de: 'Artikel',
    en: 'Product' },
  'res.posChargeByReference': {
    de: 'Kassenumsatz mit der Belegnummer {reference}',
    en: 'POS charge with document number {reference}' },

  // ------------------------------------------------------------- Feldfehler
  //
  // Die Meldung, die an einem einzelnen Feld haengt. Bewusst knapp: sie steht
  // neben dem Feld, nicht allein auf einer Seite.

  'field.required': {
    de: 'Pflichtfeld',
    en: 'Required' },
  'field.requiredWithManyAccounts': {
    de: 'Pflichtfeld bei mehreren Accounts',
    en: 'Required when there are several accounts' },
  'field.requiredForDerived': {
    de: 'Bei abgeleiteter Rate erforderlich',
    en: 'Required for a derived rate' },
  'field.headerRequired': {
    de: 'Kopfzeile erforderlich',
    en: 'Header required' },
  'field.bodyMissing': {
    de: 'Rumpf fehlt',
    en: 'Body missing' },
  'field.invalid': {
    de: 'ungueltig',
    en: 'invalid' },
  'field.isoDate': {
    de: 'Datum im Format YYYY-MM-DD erwartet',
    en: 'Date in the format YYYY-MM-DD expected' },
  'field.isoMonth': {
    de: 'Format YYYY-MM erwartet',
    en: 'Format YYYY-MM expected' },
  'field.isoTimestamp': {
    de: 'Zeitstempel nach ISO 8601 erwartet',
    en: 'Timestamp in ISO 8601 expected' },
  'field.email': {
    de: 'Keine brauchbare Adresse',
    en: 'Not a usable address' },
  'field.httpsOnly': {
    de: 'Muss mit https:// beginnen',
    en: 'Must start with https://' },
  'field.integer': {
    de: 'Ganze Zahl erwartet',
    en: 'Whole number expected' },
  'field.positiveInteger': {
    de: 'Ganze Zahl groesser als null erwartet',
    en: 'Whole number greater than zero expected' },
  'field.centAmount': {
    de: 'Ganze Cent-Betraege, nicht negativ',
    en: 'Whole amounts in cents, not negative' },
  'field.positiveCent': {
    de: 'Muss eine positive Centzahl sein',
    en: 'Must be a positive amount in cents' },
  'field.minTwoChars': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters' },
  'field.maxLength': {
    de: 'Hoechstens {max} Zeichen',
    en: 'At most {max} characters' },
  'field.afterArrival': {
    de: 'Muss nach arrival liegen',
    en: 'Must be after arrival' },
  'field.afterFrom': {
    de: 'Muss nach from liegen',
    en: 'Must be after from' },
  'field.afterFromDate': {
    de: 'Muss nach fromDate liegen',
    en: 'Must be after fromDate' },
  'field.onOrAfterFrom': {
    de: 'Muss auf oder nach from liegen',
    en: 'Must be on or after from' },
  'field.notBeforeFrom': {
    de: 'Darf nicht kleiner als from sein',
    en: 'Must not be smaller than from' },
  'field.notAboveMaxLos': {
    de: 'Darf nicht groesser als maxLos sein',
    en: 'Must not be greater than maxLos' },
  'field.weekday': {
    de: 'Werte von 0 (Montag) bis 6 (Sonntag)',
    en: 'Values from 0 (Monday) to 6 (Sunday)' },
  'field.weekdayRange': {
    de: 'Zwischen 0 und 6',
    en: 'Between 0 and 6' },
  'field.atLeastOneRoom': {
    de: 'Mindestens ein Zimmer',
    en: 'At least one room' },
  'field.tooManyRooms': {
    de: 'Hoechstens {max} Zimmer je Buchung. Groessere Gruppen laufen ueber ein '
      + 'Kontingent.',
    en: 'At most {max} rooms per booking. Larger groups go through a block.' },
  'field.pinDigits': {
    de: 'Zwischen {min} und {max} Ziffern, nur Ziffern',
    en: 'Between {min} and {max} digits, digits only' },
  'field.duplicateRoom': {
    de: 'Dasselbe Zimmer steht zweimal in der Auswahl',
    en: 'The same room appears twice in the selection' },
  'field.eitherCategoryOrRooms': {
    de: 'Entweder eine Zimmergruppe oder eine Zimmerliste',
    en: 'Either a room category or a list of rooms' },
  'field.atLeastOneScope': {
    de: 'Mindestens ein Zugriffsbereich',
    en: 'At least one scope' },
  'field.roleKeyList': {
    de: 'Liste der Rollenschluessel erwartet',
    en: 'A list of role keys is expected' },
  'field.allowedValues': {
    de: 'Erlaubt: {values}',
    en: 'Allowed: {values}' },
  'field.unknownValues': {
    de: 'Unbekannt: {values}',
    en: 'Unknown: {values}' },
  'field.seriesEmpty': {
    de: 'Die Serie ist nach den Auslassungen leer',
    en: 'After the exclusions the series is empty' },
  'field.occupancyPrices': {
    de: 'Preis je Belegung erwartet, Index 0 = 1 Person',
    en: 'A price per occupancy is expected, index 0 = 1 person' },
  'field.unknownCategory': {
    de: 'Unbekannte Kategorie',
    en: 'Unknown room type' },
  'field.unknownRatePlan': {
    de: 'Unbekannter Ratenplan',
    en: 'Unknown rate plan' },
  'field.unknownPaymentMethod': {
    de: 'Unbekannte Zahlart',
    en: 'Unknown payment method' },
  'field.unknownEventType': {
    de: 'Unbekannte Ereignisart: {values}',
    en: 'Unknown event type: {values}' },
  'field.unknownRole': {
    de: 'Unbekannte Rolle: {values}',
    en: 'Unknown role: {values}' },
  'field.mustMatchBlockCategory': {
    de: 'Muss der Zimmergruppe des Kontingents entsprechen',
    en: 'Must match the room type of the block' },
  'field.blockNeedsRoom': {
    de: 'Eine Sperrung braucht ein Zimmer',
    en: 'A block needs a room' },
  'field.onlyRoomcloud': {
    de: 'Nur roomcloud ist bisher angebunden',
    en: 'Only roomcloud is connected so far' },
  'field.onlyPreviousYear': {
    de: 'Erlaubt ist nur previous-year',
    en: 'Only previous-year is allowed' },
  'field.notAnIncomingPayment': {
    de: 'Der Zahlungsvermerk ist kein Zahlungseingang.',
    en: 'That settlement is not an incoming payment.' },
  'field.originalDocumentNumber': {
    de: 'Belegnummer des Originals',
    en: 'Document number of the original' },
  'field.reversalDocumentNumber': {
    de: 'Belegnummer des Stornos',
    en: 'Document number of the reversal' },
  'field.noPlatformScopes': {
    de: 'Plattformrechte sind keine Zugriffsbereiche: {values}',
    en: 'Platform permissions are not scopes: {values}' },
  // ------------------------------------------------- Zugriff und Anmeldung

  'access.accountOutOfScope': {
    de: 'Account liegt nicht im Zugriffsbereich.',
    en: 'That account is outside your scope.' },
  'access.propertyOutOfScope': {
    de: 'Property liegt nicht im Zugriffsbereich.',
    en: 'That property is outside your scope.' },
  'access.missingPermission': {
    de: 'Fehlende Berechtigung: {permission}',
    en: 'Missing permission: {permission}' },
  'auth.tooManyAttempts': {
    de: 'Zu viele Fehlversuche. Bitte später erneut versuchen.',
    en: 'Too many failed attempts. Please try again later.' },
  // Bewusst dieselbe Antwort fuer "Adresse unbekannt" und "Kennwort falsch":
  // eine hilfreichere Meldung waere eine Auskunft darueber, welche Adressen
  // es gibt.
  'auth.badCredentials': {
    de: 'E-Mail oder Kennwort stimmt nicht.',
    en: 'Email or password is not correct.' },
  'auth.badPin': {
    de: 'E-Mail oder PIN stimmt nicht.',
    en: 'Email or PIN is not correct.' },
  // Wer wechselt, muss auch zurueckwechseln koennen -- und das verlangt
  // denselben Nachweis. Ohne eigenen PIN waere der Angemeldete nach dem
  // ersten Wechsel aus seiner eigenen Sitzung ausgesperrt.
  'auth.ownerNeedsPin': {
    de: 'Die angemeldete Person braucht selbst einen Arbeitsplatz-PIN, bevor '
      + 'gewechselt werden kann. Sonst ist der Weg zurueck versperrt.',
    en: 'The signed-in person needs a workstation PIN of their own before '
      + 'switching. Otherwise there is no way back.' },
  // Bewusst ohne Unterscheidung zwischen unbekannt, abgelaufen und schon
  // benutzt: jede davon waere eine Auskunft ueber ein Token, das der
  // Aufrufer nicht hat.
  'auth.tokenInvalid': {
    de: 'Der Link ist ungueltig oder abgelaufen. Fordern Sie einen neuen an.',
    en: 'The link is invalid or has expired. Please request a new one.' },
  'auth.passwordTooShort': {
    de: 'Das Kennwort muss mindestens {min} Zeichen haben.',
    en: 'The password must be at least {min} characters long.' },

  // ------------------------------------------------------------ Onboarding

  'onboarding.emailTaken': {
    de: 'Diese E-Mail-Adresse gehoert bereits zu einem Zugang.',
    en: 'This email address already belongs to an account.' },
  // Nicht "Feld fehlt": der Grund gehoert dazu, sonst traegt jemand einen
  // Punkt ein und das Haus stellt Rechnungen aus, die nicht gelten.
  'onboarding.invoiceDataRequired': {
    de: 'Anschrift und Steuernummer sind Pflicht: ohne sie darf das Haus nach '
        + '§ 14 UStG keine Rechnung ausstellen.',
    en: 'Address and tax number are required: without them the property may not '
        + 'issue invoices under § 14 UStG.' },

  // ----------------------------------------------------------- Ausrollen

  // Der Teilindex laesst nur eine offene Anforderung zu. Das ist kein
  // Gedraenge, sondern der Schutz davor, dass sich zwei Laeufe im selben
  // Verzeichnis die Dateien wegziehen.
  'deploy.alreadyRunning': {
    de: 'Es laeuft bereits ein Ausrollvorgang. Warten Sie, bis er durch ist.',
    en: 'A deployment is already in progress. Please wait until it finishes.' },

  'deploy.unknownRelease': {
    de: 'Dieser Stand ist nicht mehr auf der Maschine. Zurueckgerollt werden kann '
        + 'nur auf einen Stand, der noch dort liegt.',
    en: 'That release is no longer on the machine. You can only roll back to a '
        + 'release that is still there.' },
  'deploy.alreadyCurrent': {
    de: 'Dieser Stand laeuft bereits.',
    en: 'That release is already running.' },

  // -------------------------------------------------------- Support-Sitzung

  'support.unknownSession': {
    de: 'Diese Support-Sitzung gibt es nicht.',
    en: 'This support session does not exist.' },
  'support.alreadyGranted': {
    de: 'Diese Sitzung ist bereits freigegeben.',
    en: 'This session has already been approved.' },
  'support.notPending': {
    de: 'Diese Sitzung laesst sich nicht mehr freigeben: sie ist abgelaufen oder '
        + 'widerrufen.',
    en: 'This session can no longer be approved: it has expired or been revoked.' },
  'support.badLevel': {
    de: 'Unbekannte Stufe. Erlaubt sind lesen und schreiben.',
    en: 'Unknown level. Allowed are read and write.' },
  'support.badHours': {
    de: 'Die Laufzeit muss zwischen 1 und {max} Stunden liegen.',
    en: 'The duration must be between 1 and {max} hours.' },
  'support.reasonRequired': {
    de: 'Ohne Anlass keine Anfrage: der Kunde entscheidet danach.',
    en: 'No request without a reason: the customer decides based on it.' },
  // Es gibt niemanden, der die Anfrage sehen und freigeben koennte -- eine
  // Anfrage ins Leere zu stellen waere schlimmer als sie abzuweisen.
  'support.noApprover': {
    de: 'Dieser Account hat niemanden, der eine Support-Sitzung freigeben kann.',
    en: 'This account has nobody who could approve a support session.' },

  // ----------------------------------------------------------- Uebungshaus

  'training.notPossible': {
    de: '{was} ist fuer ein Schulungshaus nicht moeglich. Uebungsdaten duerfen '
      + 'nicht in die Buchhaltung oder an eine Behoerde gelangen.',
    en: '{was} is not possible for a training property. Practice data must not '
      + 'reach the books or an authority.' },
  // Was ein Uebungshaus nicht darf. Wird in `training.notPossible` eingesetzt.
  'training.what.statistics': {
    de: 'Die Beherbergungsstatistik',
    en: 'The accommodation statistics' },
  'training.what.datev': {
    de: 'Der DATEV-Export',
    en: 'The DATEV export' },
  'training.what.gobd': {
    de: 'Der GoBD-Export',
    en: 'The GoBD export' },
  'training.noEmail': {
    de: 'Ein Uebungshaus verschickt keine E-Mail. Der Versand bleibt ausgeschaltet.',
    en: 'A training property sends no email. Sending stays switched off.' },

  // ------------------------------------------------- Folio, Rechnung, Geld

  'folio.closed': {
    de: 'Folio ist geschlossen.',
    en: 'The folio is closed.' },
  'folio.closedNoPosting': {
    de: 'Das Folio ist geschlossen und nimmt nichts mehr auf.',
    en: 'The folio is closed and takes no further postings.' },
  'folio.nothingOpen': {
    de: 'Keine offenen Positionen.',
    en: 'No open items.' },
  'paymentMethod.duplicateCode': {
    de: 'Die Zahlungsart {code} gibt es in diesem Haus schon.',
    en: 'A payment method {code} already exists in this property.' },
  'deposit.needsReservation': {
    de: 'Eine Anzahlungsrechnung braucht die Reservierung des Folios '
      + 'fuer den Leistungszeitraum.',
    en: 'A deposit invoice needs the folio reservation for the service period.' },
  'deposit.alreadyInvoiced': {
    de: 'Zu diesem Zahlungsvermerk gibt es bereits eine Anzahlungsrechnung.',
    en: 'There is already a deposit invoice for this settlement.' },
  'deposit.noRatesForSplit': {
    de: 'Zu diesem Aufenthalt sind keine Preise hinterlegt, aus denen sich die '
      + 'Steuersaetze ableiten liessen. Bitte taxRateBp oder lines mitgeben.',
    en: 'This stay has no rates from which tax rates could be derived. Please '
      + 'send taxRateBp or lines.' },
  'deposit.settlementOnInvoice': {
    de: 'Dieser Zahlungsvermerk steht schon als Zahlung auf Rechnung {number}. '
      + 'Aus ihm laesst sich keine Anzahlungsrechnung mehr machen, sonst waere '
      + 'derselbe Betrag zweimal abgerechnet.',
    en: 'This settlement is already recorded as a payment on invoice {number}. '
      + 'It cannot also become a deposit invoice; the same amount would be '
      + 'billed twice.' },
  'deposit.exceedsServices': {
    de: 'Die angerechnete Anzahlung uebersteigt die abzurechnenden Leistungen um '
      + '{cent} Cent. Das ist eine Rueckzahlung und keine Rechnung; sie ist in '
      + 'diesem System noch nicht vorgesehen.',
    en: 'The applied deposit exceeds the services to be billed by {cent} cents. '
      + 'That is a refund and not an invoice; this system does not provide for '
      + 'it yet.' },
  'invoice.requirementsUnmet': {
    de: 'Die Rechnung erfüllt die Pflichtangaben nicht: {maengel}',
    en: 'The invoice does not meet the mandatory particulars: {maengel}' },
  'deposit.requirementsUnmet': {
    de: 'Die Anzahlungsrechnung erfüllt die Pflichtangaben nicht: {maengel}',
    en: 'The deposit invoice does not meet the mandatory particulars: {maengel}' },

  // ------------------------------------------------------------ Kontingent

  'block.alreadyStatus': {
    de: 'Kontingent ist bereits {status}.',
    en: 'The block is already {status}.' },
  'block.notPickable': {
    de: 'Kontingent ist {status} und nicht mehr abrufbar.',
    en: 'The block is {status} and can no longer be picked up.' },
  'block.fullyPickedUp': {
    de: 'Kontingent ist vollstaendig abgerufen.',
    en: 'The block is fully picked up.' },
  'block.notEnoughLeft': {
    de: 'Das Kontingent hat nur noch {left} von {quantity} Zimmern frei.',
    en: 'The block has only {left} of {quantity} rooms left.' },
  'block.pickupWholePeriod': {
    de: 'Ein Abruf laeuft ueber den ganzen Zeitraum des Kontingents ({from} bis '
      + '{to}). Fuer abweichende Naechte eine eigene Reservierung anlegen.',
    en: 'A pickup runs for the whole period of the block ({from} to {to}). For '
      + 'different nights, create a separate reservation.' },

  // --------------------------------------------------- Zimmer und Aufenthalt

  'room.inactive': {
    de: 'Zimmer ist stillgelegt.',
    en: 'The room is deactivated.' },
  'room.outOfOrder': {
    de: 'Zimmer ist im Zeitraum ausser Betrieb.',
    en: 'The room is out of order during that period.' },
  'room.occupied': {
    de: 'Zimmer ist im Zeitraum bereits belegt.',
    en: 'The room is already occupied during that period.' },
  'inventory.unknownError': {
    de: 'Unbekannter Inventarfehler: {code}',
    en: 'Unknown inventory error: {code}' },
  'stay.pickupNotMovable': {
    de: 'Ein Abruf aus einem Kontingent laesst sich nicht verschieben. '
      + 'Abruf stornieren und frei neu buchen.',
    en: 'A pickup from a block cannot be moved. Cancel the pickup and book again.' },
  'stay.statusHoldsNoInventory': {
    de: 'Eine Reservierung im Zustand {status} bindet kein Kontingent und '
      + 'laesst sich nicht aendern.',
    en: 'A reservation in state {status} holds no inventory and cannot be changed.' },
  'stay.inHouseArrivalFixed': {
    de: 'Die Anreise eines Gastes im Haus laesst sich nicht verlegen.',
    en: 'The arrival of a guest in house cannot be moved.' },
  'stay.checkinNeedsRoom': {
    de: 'Check-in erfordert ein zugewiesenes Zimmer.',
    en: 'Check-in requires an assigned room.' },

  // ---------------------------------------------------------------- Gastpost

  'mail.alreadySent': {
    de: 'Diese Rechnung ist bereits verschickt oder eingereiht. '
      + 'Zum erneuten Versand resend=true angeben.',
    en: 'This invoice has already been sent or queued. To send it again, pass '
      + 'resend=true.' },
  'mail.guestAnonymized': {
    de: 'Der Gast ist anonymisiert. An eine geloeschte Adresse wird nicht versandt.',
    en: 'The guest is anonymized. Nothing is sent to a deleted address.' },
  'mail.noInvoiceAddress': {
    de: 'Zu dieser Rechnung ist keine brauchbare Empfaengeradresse hinterlegt. '
      + 'Adresse am Gast- oder Firmenprofil ergaenzen oder mit to angeben.',
    en: 'This invoice has no usable recipient address. Add one to the guest or '
      + 'company profile, or pass it as to.' },
  'mail.noReservationAddress': {
    de: 'Zu dieser Reservierung ist keine brauchbare Empfaengeradresse hinterlegt.',
    en: 'This reservation has no usable recipient address.' },
  'mail.onlyUnsentCancellable': {
    de: 'Nur eine noch nicht abgeschickte Nachricht laesst sich zurueckziehen.',
    en: 'Only a message that has not gone out yet can be withdrawn.' },

  // -------------------------------------------------------------------- Gast

  'guest.anonymizedNotRevived': {
    de: 'Ein anonymisiertes Profil wird nicht wiederbelebt.',
    en: 'An anonymized profile is not revived.' },
  'guest.hasOpenReservations': {
    de: 'Es gibt noch offene oder laufende Reservierungen fuer diesen Gast.',
    en: 'There are still open or current reservations for this guest.' },

  // -------------------------------------------------------------- Meldeschein

  'registration.noPrimaryGuest': {
    de: 'Die Reservierung hat keinen Hauptgast. Meldeschein nicht moeglich.',
    en: 'The reservation has no primary guest. No registration form is possible.' },
  'registration.alreadyExists': {
    de: 'Fuer diese Reservierung liegt bereits ein Meldeschein vor.',
    en: 'A registration form already exists for this reservation.' },
  // Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste.
  'registration.signatureRequired': {
    de: 'Fuer auslaendische Gaeste ist die Unterschrift nach § 30 BMG erforderlich.',
    en: 'For foreign guests the signature is required under § 30 BMG.' },
  'registration.signatureNotForeseen': {
    de: 'Fuer inlaendische Gaeste ist seit dem 1.1.2025 keine Unterschrift vorgesehen.',
    en: 'For domestic guests no signature has been foreseen since 1 January 2025.' },
  'registration.alreadySigned': {
    de: 'Der Meldeschein ist bereits unterschrieben.',
    en: 'The registration form is already signed.' },

  // -------------------------------------------------------- Kasse und Kanal

  'pos.roomUnknown': {
    de: 'Zimmer {room} gibt es in diesem Haus nicht.',
    en: 'There is no room {room} in this property.' },
  'pos.nobodyCheckedIn': {
    de: 'Auf Zimmer {room} ist niemand angereist. Fehlt der Check-in?',
    en: 'Nobody has checked in to room {room}. Is the check-in missing?' },
  'pos.productUnknown': {
    de: 'Artikel {product} ist in diesem Haus nicht eingerichtet. Er braucht ein '
      + 'Erloeskonto und einen Steuersatz, bevor die Kasse darauf buchen kann.',
    en: 'Product {product} is not set up in this property. It needs a revenue '
      + 'account and a tax rate before the POS can post to it.' },
  'pos.productNoTaxRate': {
    de: 'Fuer {product} ist kein Steuersatz hinterlegt. Entweder am Artikel '
      + 'einrichten oder als taxRateBp mitschicken.',
    en: 'No tax rate is stored for {product}. Either set it up on the product or '
      + 'pass it as taxRateBp.' },
  'pos.severalGuestsInRoom': {
    de: 'Auf Zimmer {room} sind mehrere Gaeste angereist. Bitte folioRef '
      + 'mitschicken: {folios}',
    en: 'Several guests have checked in to room {room}. Please pass folioRef: '
      + '{folios}' },
  'channel.referenceInFlight': {
    de: 'Externe Nummer ist bereits in Bearbeitung. Bitte spaeter erneut zustellen.',
    en: 'That external reference is being processed. Please deliver again later.' },

  // ---------------------------------------------- Raten, Einrichtung, Rollen

  'rate.derivationCycle': {
    de: 'Die Ableitungskette enthaelt einen Zyklus.',
    en: 'The derivation chain contains a cycle.' },
  'setup.onlyNightUnit': {
    de: 'Andere Zeiteinheiten als die Nacht sind noch nicht freigeschaltet.',
    en: 'Time units other than the night are not enabled yet.' },
  'setup.duplicateCategoryCode': {
    de: 'Eine Zimmergruppe mit dem Kürzel {code} gibt es schon.',
    en: 'A room type with the code {code} already exists.' },
  'setup.duplicateRoomCode': {
    de: 'Die Nummer {code} ist im Haus schon vergeben.',
    en: 'The number {code} is already taken in this property.' },
  'setup.categoryHasFutureReservations': {
    de: 'Die Gruppe hat noch {count} künftige Reservierungen. '
      + 'Erst umbuchen, dann stilllegen.',
    en: 'The room type still has {count} future reservations. Move them first, '
      + 'then deactivate.' },
  'setup.roomHasFutureReservations': {
    de: 'Auf dem Zimmer liegen noch künftige Reservierungen: {reservations}. '
      + 'Erst umbuchen, dann stilllegen.',
    en: 'The room still carries future reservations: {reservations}. Move them '
      + 'first, then deactivate.' },
  'report.noOpenBusinessDay': {
    de: 'Fuer die Property ist kein Tag geoeffnet.',
    en: 'No business day is open for this property.' },
  'user.wouldLockYourselfOut': {
    de: 'Damit naehmen Sie sich selbst das Recht, Rollen zu vergeben. '
      + 'Lassen Sie das jemand anderen tun.',
    en: 'That would take away your own right to assign roles. Let somebody else '
      + 'do it.' },
  'payments.stripeKeyMissing': {
    de: 'STRIPE_SECRET_KEY ist nicht gesetzt.',
    en: 'STRIPE_SECRET_KEY is not set.' },
  'payments.stripeWebhookSecretMissing': {
    de: 'STRIPE_WEBHOOK_SECRET ist nicht gesetzt.',
    en: 'STRIPE_WEBHOOK_SECRET is not set.' },

  // ------------------------------------------------ Hinweise in Antworten
  //
  // Saetze, die neben einer Antwort stehen und eine Erwartung geraderuecken.
  // Sie gehen denselben Weg wie eine Fehlermeldung: die Antwort traegt den
  // deutschen Satz **und** den Schluessel.

  'hint.settlementIsNotPayment': {
    de: 'Ein Zahlungsvermerk ordnet zu, er wickelt nicht ab. Die Zahlung selbst '
      + 'laeuft ueber Kasse, Portal oder Bank des Betriebs.',
    en: 'A settlement records where money was taken; it does not process it. The '
      + 'payment itself runs through the till, the portal or the bank.' },
  'hint.invoiceRetention': {
    de: 'Rechnungen unterliegen der steuerlichen Aufbewahrungsfrist und werden '
      + 'bei einer Loeschung nicht entfernt.',
    en: 'Invoices are subject to the statutory retention period and are not '
      + 'removed when a profile is deleted.' },
  'hint.statisticsSubmission': {
    de: 'Uebermittlung an das Statistische Landesamt ueber eSTATISTIK.core. '
      + 'Land XX bedeutet: kein Wohnsitzland erfasst.',
    en: 'Submission to the statistical office via eSTATISTIK.core. Country XX '
      + 'means no country of residence was recorded.' },
  'hint.webhookSecretOnce': {
    de: 'Der Schluessel wird nur hier einmal ausgegeben. Signatur: HMAC-SHA256 '
      + 'ueber "Zeitstempel.Rumpf".',
    en: 'The key is handed out here once and never again. Signature: HMAC-SHA256 '
      + 'over "timestamp.body".' },
  'hint.oauthSecretOnce': {
    de: 'Das Geheimnis wird nur hier einmal ausgegeben. Token holen: POST '
      + '/oauth/token mit grant_type=client_credentials.',
    en: 'The secret is handed out here once and never again. Get a token: POST '
      + '/oauth/token with grant_type=client_credentials.' },
  'hint.occupancyNotCapacity': {
    de: 'Die Belegungszahl wirkt auf Preise und Meldeschein, nicht auf die Kapazität.',
    en: 'Occupancy affects prices and the registration form, not capacity.' },
  'hint.legacyFormatsUnverified': {
    de: 'Keines dieser drei Formate ist eine veroeffentlichte Spezifikation '
      + '(Dokument 05, Abschnitt 6). Vor dem ersten echten Kunden gegen eine '
      + 'tatsaechliche Exportdatei pruefen.',
    en: 'None of these three formats is a published specification (document 05, '
      + 'section 6). Check against a real export file before the first real '
      + 'customer.' },

  // ------------------------------------------------------- Einrichtungsstand

  'setup.step.categories': {
    de: 'Zimmergruppen angelegt',
    en: 'Room types created' },
  'setup.step.categories.hint': {
    de: 'Mindestens eine Gruppe, etwa Doppelzimmer oder Ferienwohnung.',
    en: 'At least one type, such as a double room or a holiday flat.' },
  'setup.step.rooms': {
    de: 'Zimmer angelegt',
    en: 'Rooms created' },
  'setup.step.rooms.hint': {
    de: 'Am schnellsten als Serie: Nummernbereich und Etage angeben.',
    en: 'Fastest as a series: give a number range and a floor.' },
  'setup.step.inventory': {
    de: 'Inventar materialisiert',
    en: 'Inventory materialized' },
  'setup.step.inventory.hint.missing': {
    de: 'Ohne materialisierten Zeitraum weist jede Buchung ab. Der Worker legt '
      + 'ihn an, oder einmal von Hand anstoßen.',
    en: 'Without a materialized period every booking is refused. The worker '
      + 'creates it, or trigger it once by hand.' },
  'setup.step.inventory.hint.until': {
    de: 'Belegbar bis {date}.',
    en: 'Bookable until {date}.' },
  'setup.step.tax_rules': {
    de: 'Steuersätze hinterlegt',
    en: 'Tax rates stored' },
  'setup.step.tax_rules.hint': {
    de: 'Ohne Regel bucht der Nachtlauf Logis mit 7 Prozent.',
    en: 'Without a rule the night audit posts accommodation at 7 percent.' },
  'setup.step.rate_plans': {
    de: 'Ratenpläne angelegt',
    en: 'Rate plans created' },
  'setup.step.rate_plans.hint': {
    de: 'Je Gruppe mindestens eine Basisrate.',
    en: 'At least one base rate per type.' },
  'setup.step.prices': {
    de: 'Preise gepflegt',
    en: 'Prices maintained' },
  'setup.step.prices.hint': {
    de: 'Ohne Preise werden Reservierungen mit 0 Cent gebucht.',
    en: 'Without prices, reservations are booked at 0 cents.' },
  'setup.step.payment_methods': {
    de: 'Zahlungsarten angelegt',
    en: 'Payment methods created' },
  'setup.step.payment_methods.hint': {
    de: 'Nur zur Zuordnung. Die Zahlung selbst läuft außerhalb dieses Systems.',
    en: 'For assignment only. The payment itself runs outside this system.' },
  'setup.step.business_day': {
    de: 'Geschäftstag geöffnet',
    en: 'Business day open' },
  'setup.step.business_day.hint.missing': {
    de: 'Ohne offenen Tag läuft kein Nachtlauf.',
    en: 'Without an open day no night audit runs.' },
  'setup.step.business_day.hint.since': {
    de: 'Offen seit {date}.',
    en: 'Open since {date}.' },

  'field.depositPartsMismatch': {
    de: 'Die Teile ergeben {sum} Cent, vereinnahmt sind {received} Cent.',
    en: 'The parts add up to {sum} cents, {received} cents were received.' }
} as const satisfies Record<string, Eintrag>

export type MessageKey = keyof typeof M
export type MessageParams = Record<string, string | number>

/** Alle Schluessel. Ein Test prueft damit, dass die Quelle keine erfindet. */
export const MESSAGE_KEYS = Object.keys(M) as MessageKey[]

export function isMessageKey(v: string): v is MessageKey {
  return Object.prototype.hasOwnProperty.call(M, v)
}

/**
 * Eine Meldung in einer Sprache, mit eingesetzten Werten.
 *
 * Ein unbekannter Schluessel kommt unveraendert zurueck. Das ist Absicht:
 * waehrend der Umstellung stehen an manchen Stellen noch deutsche Saetze
 * statt Schluesseln, und eine leere Fehlermeldung waere schlimmer als eine
 * einsprachige.
 */
export function renderMessage(
  key: string, locale: MessageLocale, params?: MessageParams
): string {
  const eintrag = isMessageKey(key) ? M[key] : null
  const text = eintrag === null ? key : eintrag[locale]
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    // Ein Platzhalter ohne Wert bleibt stehen. Ihn durch nichts zu ersetzen
    // ergaebe einen Satz mit einem Loch, den niemand als Fehler erkennt.
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
}
