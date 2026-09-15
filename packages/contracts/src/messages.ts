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

/** Ein Eintrag: deutsch, dann englisch. */
type Eintrag = readonly [de: string, en: string]

const M = {
  // ------------------------------------------------------------ Fehlertitel

  'error.unauthorized': ['Nicht angemeldet', 'Not signed in'],
  'error.forbidden': ['Keine Berechtigung', 'Not permitted'],
  'error.notFound': ['{what} nicht gefunden', '{what} not found'],
  'error.conflict': ['Konflikt', 'Conflict'],
  'error.validation': ['Eingabe ungueltig', 'Invalid input'],
  'error.unprocessable': ['Nicht verarbeitbar', 'Cannot be processed'],
  'error.soldOut': ['Kein Kontingent verfuegbar', 'No availability left'],
  'error.soldOut.detail': [
    'Fuer mindestens eine Nacht des Zeitraums ist die Kapazitaet erschoepft.',
    'For at least one night of the period there is no capacity left.'],
  'error.notMaterialized': ['Zeitraum nicht verfuegbar', 'Period not available'],
  'error.notMaterialized.detail': [
    'Der Zeitraum liegt ausserhalb des vorbereiteten Horizonts. '
    + 'Der Betrieb wurde benachrichtigt.',
    'The period lies beyond the prepared horizon. Operations have been notified.'],
  'error.rangeTooLarge': ['Zeitraum zu gross', 'Period too large'],
  'error.rangeTooLarge.detail': [
    'Hoechstens {max} Tage je Anfrage.', 'At most {max} days per request.'],
  'error.idempotencyMismatch': [
    'Idempotenzschluessel wiederverwendet', 'Idempotency key reused'],
  'error.idempotencyMismatch.detail': [
    'Derselbe Schluessel wurde bereits mit einem anderen Rumpf benutzt.',
    'The same key has already been used with a different body.'],
  'error.idempotencyInFlight': ['Anfrage laeuft bereits', 'Request already in flight'],
  'error.idempotencyInFlight.detail': [
    'Eine Anfrage mit diesem Schluessel wird gerade verarbeitet. Bitte wiederholen.',
    'A request with this key is being processed. Please try again.'],
  'error.notConfigured': ['Nicht eingerichtet', 'Not configured'],
  'error.invalidSignature': ['Signatur ungueltig', 'Invalid signature'],
  'error.documentPending': ['Beleg noch nicht erzeugt', 'Document not generated yet'],
  'error.documentPending.detail': [
    'Die Rechnung ist festgeschrieben, der Beleg wird gerade erzeugt. '
    + 'Bitte in Kuerze erneut abrufen.',
    'The invoice is final; the document is being generated. Please retry shortly.'],
  'error.unknown': ['Unbekannter Fehler', 'Unknown error'],
  'error.internal': ['Interner Fehler', 'Internal error'],
  'error.rateLimited': ['Zu viele Anfragen', 'Too many requests'],
  'error.rateLimited.detail': [
    'Bitte in {seconds} Sekunden erneut versuchen.',
    'Please try again in {seconds} seconds.'],

  // -------------------------------------------------------------- Ressourcen
  //
  // Der Name, der in "X nicht gefunden" eingesetzt wird. Eine kleine, feste
  // Liste: was es nicht gibt, ist immer eines dieser Dinge.

  'res.resource': ['Ressource', 'Resource'],
  'res.property': ['Property', 'Property'],
  'res.reservation': ['Reservierung', 'Reservation'],
  'res.folio': ['Folio', 'Folio'],
  'res.guest': ['Gast', 'Guest'],
  'res.company': ['Firma', 'Company'],
  'res.category': ['Zimmergruppe', 'Room type'],
  'res.room': ['Zimmer', 'Room'],
  'res.invoice': ['Rechnung', 'Invoice'],
  'res.block': ['Kontingent', 'Block'],
  'res.subscription': ['Abonnement', 'Subscription'],
  'res.settlement': ['Zahlungsvermerk', 'Settlement'],
  'res.paymentMethod': ['Zahlungsart', 'Payment method'],
  'res.maintenanceTicket': ['Wartungsmeldung', 'Maintenance ticket'],
  'res.connection': ['Verbindung', 'Connection'],
  'res.ratePlan': ['Ratenplan', 'Rate plan'],
  'res.registration': ['Meldeschein', 'Registration form'],
  'res.oauthClient': ['Maschinenzugang', 'Machine access'],
  'res.user': ['Benutzer', 'User'],
  'res.task': ['Aufgabe', 'Task'],
  'res.message': ['Nachricht', 'Message'],
  'res.product': ['Artikel', 'Product'],
  'res.posChargeByReference': [
    'Kassenumsatz mit der Belegnummer {reference}',
    'POS charge with document number {reference}'],

  // ------------------------------------------------------------- Feldfehler
  //
  // Die Meldung, die an einem einzelnen Feld haengt. Bewusst knapp: sie steht
  // neben dem Feld, nicht allein auf einer Seite.

  'field.required': ['Pflichtfeld', 'Required'],
  'field.requiredWithManyAccounts': [
    'Pflichtfeld bei mehreren Accounts', 'Required when there are several accounts'],
  'field.requiredForDerived': [
    'Bei abgeleiteter Rate erforderlich', 'Required for a derived rate'],
  'field.headerRequired': ['Kopfzeile erforderlich', 'Header required'],
  'field.bodyMissing': ['Rumpf fehlt', 'Body missing'],
  'field.invalid': ['ungueltig', 'invalid'],
  'field.isoDate': [
    'Datum im Format YYYY-MM-DD erwartet', 'Date in the format YYYY-MM-DD expected'],
  'field.isoMonth': ['Format YYYY-MM erwartet', 'Format YYYY-MM expected'],
  'field.isoTimestamp': [
    'Zeitstempel nach ISO 8601 erwartet', 'Timestamp in ISO 8601 expected'],
  'field.email': ['Keine brauchbare Adresse', 'Not a usable address'],
  'field.httpsOnly': ['Muss mit https:// beginnen', 'Must start with https://'],
  'field.integer': ['Ganze Zahl erwartet', 'Whole number expected'],
  'field.positiveInteger': [
    'Ganze Zahl groesser als null erwartet', 'Whole number greater than zero expected'],
  'field.centAmount': [
    'Ganze Cent-Betraege, nicht negativ', 'Whole amounts in cents, not negative'],
  'field.positiveCent': [
    'Muss eine positive Centzahl sein', 'Must be a positive amount in cents'],
  'field.minTwoChars': ['Mindestens zwei Zeichen', 'At least two characters'],
  'field.maxLength': ['Hoechstens {max} Zeichen', 'At most {max} characters'],
  'field.afterArrival': ['Muss nach arrival liegen', 'Must be after arrival'],
  'field.afterFrom': ['Muss nach from liegen', 'Must be after from'],
  'field.afterFromDate': ['Muss nach fromDate liegen', 'Must be after fromDate'],
  'field.onOrAfterFrom': [
    'Muss auf oder nach from liegen', 'Must be on or after from'],
  'field.notBeforeFrom': [
    'Darf nicht kleiner als from sein', 'Must not be smaller than from'],
  'field.notAboveMaxLos': [
    'Darf nicht groesser als maxLos sein', 'Must not be greater than maxLos'],
  'field.weekday': [
    'Werte von 0 (Montag) bis 6 (Sonntag)', 'Values from 0 (Monday) to 6 (Sunday)'],
  'field.weekdayRange': ['Zwischen 0 und 6', 'Between 0 and 6'],
  'field.atLeastOneRoom': ['Mindestens ein Zimmer', 'At least one room'],
  'field.atLeastOneScope': [
    'Mindestens ein Zugriffsbereich', 'At least one scope'],
  'field.roleKeyList': [
    'Liste der Rollenschluessel erwartet', 'A list of role keys is expected'],
  'field.allowedValues': ['Erlaubt: {values}', 'Allowed: {values}'],
  'field.unknownValues': ['Unbekannt: {values}', 'Unknown: {values}'],
  'field.seriesEmpty': [
    'Die Serie ist nach den Auslassungen leer',
    'After the exclusions the series is empty'],
  'field.occupancyPrices': [
    'Preis je Belegung erwartet, Index 0 = 1 Person',
    'A price per occupancy is expected, index 0 = 1 person'],
  'field.unknownCategory': ['Unbekannte Kategorie', 'Unknown room type'],
  'field.unknownRatePlan': ['Unbekannter Ratenplan', 'Unknown rate plan'],
  'field.unknownPaymentMethod': ['Unbekannte Zahlart', 'Unknown payment method'],
  'field.unknownEventType': [
    'Unbekannte Ereignisart: {values}', 'Unknown event type: {values}'],
  'field.unknownRole': ['Unbekannte Rolle: {values}', 'Unknown role: {values}'],
  'field.mustMatchBlockCategory': [
    'Muss der Zimmergruppe des Kontingents entsprechen',
    'Must match the room type of the block'],
  'field.blockNeedsRoom': [
    'Eine Sperrung braucht ein Zimmer', 'A block needs a room'],
  'field.onlyRoomcloud': [
    'Nur roomcloud ist bisher angebunden', 'Only roomcloud is connected so far'],
  'field.onlyPreviousYear': [
    'Erlaubt ist nur previous-year', 'Only previous-year is allowed'],
  'field.notAnIncomingPayment': [
    'Der Zahlungsvermerk ist kein Zahlungseingang.',
    'That settlement is not an incoming payment.'],
  'field.originalDocumentNumber': [
    'Belegnummer des Originals', 'Document number of the original'],
  'field.reversalDocumentNumber': [
    'Belegnummer des Stornos', 'Document number of the reversal'],
  'field.noPlatformScopes': [
    'Plattformrechte sind keine Zugriffsbereiche: {values}',
    'Platform permissions are not scopes: {values}'],
  // ------------------------------------------------- Zugriff und Anmeldung

  'access.accountOutOfScope': [
    'Account liegt nicht im Zugriffsbereich.',
    'That account is outside your scope.'],
  'access.propertyOutOfScope': [
    'Property liegt nicht im Zugriffsbereich.',
    'That property is outside your scope.'],
  'access.missingPermission': [
    'Fehlende Berechtigung: {permission}', 'Missing permission: {permission}'],
  'auth.tooManyAttempts': [
    'Zu viele Fehlversuche. Bitte später erneut versuchen.',
    'Too many failed attempts. Please try again later.'],
  // Bewusst dieselbe Antwort fuer "Adresse unbekannt" und "Kennwort falsch":
  // eine hilfreichere Meldung waere eine Auskunft darueber, welche Adressen
  // es gibt.
  'auth.badCredentials': [
    'E-Mail oder Kennwort stimmt nicht.', 'Email or password is not correct.'],
  'auth.badPin': ['E-Mail oder PIN stimmt nicht.', 'Email or PIN is not correct.'],
  // Bewusst ohne Unterscheidung zwischen unbekannt, abgelaufen und schon
  // benutzt: jede davon waere eine Auskunft ueber ein Token, das der
  // Aufrufer nicht hat.
  'auth.tokenInvalid': [
    'Der Link ist ungueltig oder abgelaufen. Fordern Sie einen neuen an.',
    'The link is invalid or has expired. Please request a new one.'],
  'auth.passwordTooShort': [
    'Das Kennwort muss mindestens {min} Zeichen haben.',
    'The password must be at least {min} characters long.'],

  // ------------------------------------------------------------ Onboarding

  'onboarding.emailTaken': [
    'Diese E-Mail-Adresse gehoert bereits zu einem Zugang.',
    'This email address already belongs to an account.'],
  // Nicht "Feld fehlt": der Grund gehoert dazu, sonst traegt jemand einen
  // Punkt ein und das Haus stellt Rechnungen aus, die nicht gelten.
  'onboarding.invoiceDataRequired': [
    'Anschrift und Steuernummer sind Pflicht: ohne sie darf das Haus nach '
      + '§ 14 UStG keine Rechnung ausstellen.',
    'Address and tax number are required: without them the property may not '
      + 'issue invoices under § 14 UStG.'],

  // ----------------------------------------------------------- Ausrollen

  // Der Teilindex laesst nur eine offene Anforderung zu. Das ist kein
  // Gedraenge, sondern der Schutz davor, dass sich zwei Laeufe im selben
  // Verzeichnis die Dateien wegziehen.
  'deploy.alreadyRunning': [
    'Es laeuft bereits ein Ausrollvorgang. Warten Sie, bis er durch ist.',
    'A deployment is already in progress. Please wait until it finishes.'],

  'deploy.unknownRelease': [
    'Dieser Stand ist nicht mehr auf der Maschine. Zurueckgerollt werden kann '
      + 'nur auf einen Stand, der noch dort liegt.',
    'That release is no longer on the machine. You can only roll back to a '
      + 'release that is still there.'],
  'deploy.alreadyCurrent': [
    'Dieser Stand laeuft bereits.', 'That release is already running.'],

  // -------------------------------------------------------- Support-Sitzung

  'support.unknownSession': [
    'Diese Support-Sitzung gibt es nicht.', 'This support session does not exist.'],
  'support.alreadyGranted': [
    'Diese Sitzung ist bereits freigegeben.', 'This session has already been approved.'],
  'support.notPending': [
    'Diese Sitzung laesst sich nicht mehr freigeben: sie ist abgelaufen oder '
      + 'widerrufen.',
    'This session can no longer be approved: it has expired or been revoked.'],
  'support.badLevel': [
    'Unbekannte Stufe. Erlaubt sind lesen und schreiben.',
    'Unknown level. Allowed are read and write.'],
  'support.badHours': [
    'Die Laufzeit muss zwischen 1 und {max} Stunden liegen.',
    'The duration must be between 1 and {max} hours.'],
  'support.reasonRequired': [
    'Ohne Anlass keine Anfrage: der Kunde entscheidet danach.',
    'No request without a reason: the customer decides based on it.'],
  // Es gibt niemanden, der die Anfrage sehen und freigeben koennte -- eine
  // Anfrage ins Leere zu stellen waere schlimmer als sie abzuweisen.
  'support.noApprover': [
    'Dieser Account hat niemanden, der eine Support-Sitzung freigeben kann.',
    'This account has nobody who could approve a support session.'],

  // ----------------------------------------------------------- Uebungshaus

  'training.notPossible': [
    '{was} ist fuer ein Schulungshaus nicht moeglich. Uebungsdaten duerfen '
    + 'nicht in die Buchhaltung oder an eine Behoerde gelangen.',
    '{was} is not possible for a training property. Practice data must not '
    + 'reach the books or an authority.'],
  // Was ein Uebungshaus nicht darf. Wird in `training.notPossible` eingesetzt.
  'training.what.statistics': [
    'Die Beherbergungsstatistik', 'The accommodation statistics'],
  'training.what.datev': ['Der DATEV-Export', 'The DATEV export'],
  'training.what.gobd': ['Der GoBD-Export', 'The GoBD export'],
  'training.noEmail': [
    'Ein Uebungshaus verschickt keine E-Mail. Der Versand bleibt ausgeschaltet.',
    'A training property sends no email. Sending stays switched off.'],

  // ------------------------------------------------- Folio, Rechnung, Geld

  'folio.closed': ['Folio ist geschlossen.', 'The folio is closed.'],
  'folio.closedNoPosting': [
    'Das Folio ist geschlossen und nimmt nichts mehr auf.',
    'The folio is closed and takes no further postings.'],
  'folio.nothingOpen': ['Keine offenen Positionen.', 'No open items.'],
  'paymentMethod.duplicateCode': [
    'Die Zahlungsart {code} gibt es in diesem Haus schon.',
    'A payment method {code} already exists in this property.'],
  'deposit.needsReservation': [
    'Eine Anzahlungsrechnung braucht die Reservierung des Folios '
    + 'fuer den Leistungszeitraum.',
    'A deposit invoice needs the folio reservation for the service period.'],
  'deposit.alreadyInvoiced': [
    'Zu diesem Zahlungsvermerk gibt es bereits eine Anzahlungsrechnung.',
    'There is already a deposit invoice for this settlement.'],
  'deposit.noRatesForSplit': [
    'Zu diesem Aufenthalt sind keine Preise hinterlegt, aus denen sich die '
    + 'Steuersaetze ableiten liessen. Bitte taxRateBp oder lines mitgeben.',
    'This stay has no rates from which tax rates could be derived. Please '
    + 'send taxRateBp or lines.'],
  'deposit.settlementOnInvoice': [
    'Dieser Zahlungsvermerk steht schon als Zahlung auf Rechnung {number}. '
    + 'Aus ihm laesst sich keine Anzahlungsrechnung mehr machen, sonst waere '
    + 'derselbe Betrag zweimal abgerechnet.',
    'This settlement is already recorded as a payment on invoice {number}. '
    + 'It cannot also become a deposit invoice; the same amount would be '
    + 'billed twice.'],
  'deposit.exceedsServices': [
    'Die angerechnete Anzahlung uebersteigt die abzurechnenden Leistungen um '
    + '{cent} Cent. Das ist eine Rueckzahlung und keine Rechnung; sie ist in '
    + 'diesem System noch nicht vorgesehen.',
    'The applied deposit exceeds the services to be billed by {cent} cents. '
    + 'That is a refund and not an invoice; this system does not provide for '
    + 'it yet.'],
  'invoice.requirementsUnmet': [
    'Die Rechnung erfüllt die Pflichtangaben nicht: {maengel}',
    'The invoice does not meet the mandatory particulars: {maengel}'],
  'deposit.requirementsUnmet': [
    'Die Anzahlungsrechnung erfüllt die Pflichtangaben nicht: {maengel}',
    'The deposit invoice does not meet the mandatory particulars: {maengel}'],

  // ------------------------------------------------------------ Kontingent

  'block.alreadyStatus': [
    'Kontingent ist bereits {status}.', 'The block is already {status}.'],
  'block.notPickable': [
    'Kontingent ist {status} und nicht mehr abrufbar.',
    'The block is {status} and can no longer be picked up.'],
  'block.fullyPickedUp': [
    'Kontingent ist vollstaendig abgerufen.', 'The block is fully picked up.'],
  'block.pickupWholePeriod': [
    'Ein Abruf laeuft ueber den ganzen Zeitraum des Kontingents ({from} bis '
    + '{to}). Fuer abweichende Naechte eine eigene Reservierung anlegen.',
    'A pickup runs for the whole period of the block ({from} to {to}). For '
    + 'different nights, create a separate reservation.'],

  // --------------------------------------------------- Zimmer und Aufenthalt

  'room.inactive': ['Zimmer ist stillgelegt.', 'The room is deactivated.'],
  'room.outOfOrder': [
    'Zimmer ist im Zeitraum ausser Betrieb.',
    'The room is out of order during that period.'],
  'room.occupied': [
    'Zimmer ist im Zeitraum bereits belegt.',
    'The room is already occupied during that period.'],
  'inventory.unknownError': [
    'Unbekannter Inventarfehler: {code}', 'Unknown inventory error: {code}'],
  'stay.pickupNotMovable': [
    'Ein Abruf aus einem Kontingent laesst sich nicht verschieben. '
    + 'Abruf stornieren und frei neu buchen.',
    'A pickup from a block cannot be moved. Cancel the pickup and book again.'],
  'stay.statusHoldsNoInventory': [
    'Eine Reservierung im Zustand {status} bindet kein Kontingent und '
    + 'laesst sich nicht aendern.',
    'A reservation in state {status} holds no inventory and cannot be changed.'],
  'stay.inHouseArrivalFixed': [
    'Die Anreise eines Gastes im Haus laesst sich nicht verlegen.',
    'The arrival of a guest in house cannot be moved.'],
  'stay.checkinNeedsRoom': [
    'Check-in erfordert ein zugewiesenes Zimmer.',
    'Check-in requires an assigned room.'],

  // ---------------------------------------------------------------- Gastpost

  'mail.alreadySent': [
    'Diese Rechnung ist bereits verschickt oder eingereiht. '
    + 'Zum erneuten Versand resend=true angeben.',
    'This invoice has already been sent or queued. To send it again, pass '
    + 'resend=true.'],
  'mail.guestAnonymized': [
    'Der Gast ist anonymisiert. An eine geloeschte Adresse wird nicht versandt.',
    'The guest is anonymized. Nothing is sent to a deleted address.'],
  'mail.noInvoiceAddress': [
    'Zu dieser Rechnung ist keine brauchbare Empfaengeradresse hinterlegt. '
    + 'Adresse am Gast- oder Firmenprofil ergaenzen oder mit to angeben.',
    'This invoice has no usable recipient address. Add one to the guest or '
    + 'company profile, or pass it as to.'],
  'mail.noReservationAddress': [
    'Zu dieser Reservierung ist keine brauchbare Empfaengeradresse hinterlegt.',
    'This reservation has no usable recipient address.'],
  'mail.onlyUnsentCancellable': [
    'Nur eine noch nicht abgeschickte Nachricht laesst sich zurueckziehen.',
    'Only a message that has not gone out yet can be withdrawn.'],

  // -------------------------------------------------------------------- Gast

  'guest.anonymizedNotRevived': [
    'Ein anonymisiertes Profil wird nicht wiederbelebt.',
    'An anonymized profile is not revived.'],
  'guest.hasOpenReservations': [
    'Es gibt noch offene oder laufende Reservierungen fuer diesen Gast.',
    'There are still open or current reservations for this guest.'],

  // -------------------------------------------------------------- Meldeschein

  'registration.noPrimaryGuest': [
    'Die Reservierung hat keinen Hauptgast. Meldeschein nicht moeglich.',
    'The reservation has no primary guest. No registration form is possible.'],
  'registration.alreadyExists': [
    'Fuer diese Reservierung liegt bereits ein Meldeschein vor.',
    'A registration form already exists for this reservation.'],
  // Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste.
  'registration.signatureRequired': [
    'Fuer auslaendische Gaeste ist die Unterschrift nach § 30 BMG erforderlich.',
    'For foreign guests the signature is required under § 30 BMG.'],
  'registration.signatureNotForeseen': [
    'Fuer inlaendische Gaeste ist seit dem 1.1.2025 keine Unterschrift vorgesehen.',
    'For domestic guests no signature has been foreseen since 1 January 2025.'],
  'registration.alreadySigned': [
    'Der Meldeschein ist bereits unterschrieben.',
    'The registration form is already signed.'],

  // -------------------------------------------------------- Kasse und Kanal

  'pos.roomUnknown': [
    'Zimmer {room} gibt es in diesem Haus nicht.',
    'There is no room {room} in this property.'],
  'pos.nobodyCheckedIn': [
    'Auf Zimmer {room} ist niemand angereist. Fehlt der Check-in?',
    'Nobody has checked in to room {room}. Is the check-in missing?'],
  'pos.productUnknown': [
    'Artikel {product} ist in diesem Haus nicht eingerichtet. Er braucht ein '
    + 'Erloeskonto und einen Steuersatz, bevor die Kasse darauf buchen kann.',
    'Product {product} is not set up in this property. It needs a revenue '
    + 'account and a tax rate before the POS can post to it.'],
  'pos.productNoTaxRate': [
    'Fuer {product} ist kein Steuersatz hinterlegt. Entweder am Artikel '
    + 'einrichten oder als taxRateBp mitschicken.',
    'No tax rate is stored for {product}. Either set it up on the product or '
    + 'pass it as taxRateBp.'],
  'pos.severalGuestsInRoom': [
    'Auf Zimmer {room} sind mehrere Gaeste angereist. Bitte folioRef '
    + 'mitschicken: {folios}',
    'Several guests have checked in to room {room}. Please pass folioRef: '
    + '{folios}'],
  'channel.referenceInFlight': [
    'Externe Nummer ist bereits in Bearbeitung. Bitte spaeter erneut zustellen.',
    'That external reference is being processed. Please deliver again later.'],

  // ---------------------------------------------- Raten, Einrichtung, Rollen

  'rate.derivationCycle': [
    'Die Ableitungskette enthaelt einen Zyklus.',
    'The derivation chain contains a cycle.'],
  'setup.onlyNightUnit': [
    'Andere Zeiteinheiten als die Nacht sind noch nicht freigeschaltet.',
    'Time units other than the night are not enabled yet.'],
  'setup.duplicateCategoryCode': [
    'Eine Zimmergruppe mit dem Kürzel {code} gibt es schon.',
    'A room type with the code {code} already exists.'],
  'setup.duplicateRoomCode': [
    'Die Nummer {code} ist im Haus schon vergeben.',
    'The number {code} is already taken in this property.'],
  'setup.categoryHasFutureReservations': [
    'Die Gruppe hat noch {count} künftige Reservierungen. '
    + 'Erst umbuchen, dann stilllegen.',
    'The room type still has {count} future reservations. Move them first, '
    + 'then deactivate.'],
  'setup.roomHasFutureReservations': [
    'Auf dem Zimmer liegen noch künftige Reservierungen: {reservations}. '
    + 'Erst umbuchen, dann stilllegen.',
    'The room still carries future reservations: {reservations}. Move them '
    + 'first, then deactivate.'],
  'report.noOpenBusinessDay': [
    'Fuer die Property ist kein Tag geoeffnet.',
    'No business day is open for this property.'],
  'user.wouldLockYourselfOut': [
    'Damit naehmen Sie sich selbst das Recht, Rollen zu vergeben. '
    + 'Lassen Sie das jemand anderen tun.',
    'That would take away your own right to assign roles. Let somebody else '
    + 'do it.'],
  'payments.stripeKeyMissing': [
    'STRIPE_SECRET_KEY ist nicht gesetzt.', 'STRIPE_SECRET_KEY is not set.'],
  'payments.stripeWebhookSecretMissing': [
    'STRIPE_WEBHOOK_SECRET ist nicht gesetzt.',
    'STRIPE_WEBHOOK_SECRET is not set.'],

  // ------------------------------------------------ Hinweise in Antworten
  //
  // Saetze, die neben einer Antwort stehen und eine Erwartung geraderuecken.
  // Sie gehen denselben Weg wie eine Fehlermeldung: die Antwort traegt den
  // deutschen Satz **und** den Schluessel.

  'hint.settlementIsNotPayment': [
    'Ein Zahlungsvermerk ordnet zu, er wickelt nicht ab. Die Zahlung selbst '
    + 'laeuft ueber Kasse, Portal oder Bank des Betriebs.',
    'A settlement records where money was taken; it does not process it. The '
    + 'payment itself runs through the till, the portal or the bank.'],
  'hint.invoiceRetention': [
    'Rechnungen unterliegen der steuerlichen Aufbewahrungsfrist und werden '
    + 'bei einer Loeschung nicht entfernt.',
    'Invoices are subject to the statutory retention period and are not '
    + 'removed when a profile is deleted.'],
  'hint.statisticsSubmission': [
    'Uebermittlung an das Statistische Landesamt ueber eSTATISTIK.core. '
    + 'Land XX bedeutet: kein Wohnsitzland erfasst.',
    'Submission to the statistical office via eSTATISTIK.core. Country XX '
    + 'means no country of residence was recorded.'],
  'hint.webhookSecretOnce': [
    'Der Schluessel wird nur hier einmal ausgegeben. Signatur: HMAC-SHA256 '
    + 'ueber "Zeitstempel.Rumpf".',
    'The key is handed out here once and never again. Signature: HMAC-SHA256 '
    + 'over "timestamp.body".'],
  'hint.oauthSecretOnce': [
    'Das Geheimnis wird nur hier einmal ausgegeben. Token holen: POST '
    + '/oauth/token mit grant_type=client_credentials.',
    'The secret is handed out here once and never again. Get a token: POST '
    + '/oauth/token with grant_type=client_credentials.'],
  'hint.occupancyNotCapacity': [
    'Die Belegungszahl wirkt auf Preise und Meldeschein, nicht auf die Kapazität.',
    'Occupancy affects prices and the registration form, not capacity.'],
  'hint.legacyFormatsUnverified': [
    'Keines dieser drei Formate ist eine veroeffentlichte Spezifikation '
    + '(Dokument 05, Abschnitt 6). Vor dem ersten echten Kunden gegen eine '
    + 'tatsaechliche Exportdatei pruefen.',
    'None of these three formats is a published specification (document 05, '
    + 'section 6). Check against a real export file before the first real '
    + 'customer.'],

  // ------------------------------------------------------- Einrichtungsstand

  'setup.step.categories': ['Zimmergruppen angelegt', 'Room types created'],
  'setup.step.categories.hint': [
    'Mindestens eine Gruppe, etwa Doppelzimmer oder Ferienwohnung.',
    'At least one type, such as a double room or a holiday flat.'],
  'setup.step.rooms': ['Zimmer angelegt', 'Rooms created'],
  'setup.step.rooms.hint': [
    'Am schnellsten als Serie: Nummernbereich und Etage angeben.',
    'Fastest as a series: give a number range and a floor.'],
  'setup.step.inventory': ['Inventar materialisiert', 'Inventory materialized'],
  'setup.step.inventory.hint.missing': [
    'Ohne materialisierten Zeitraum weist jede Buchung ab. Der Worker legt '
    + 'ihn an, oder einmal von Hand anstoßen.',
    'Without a materialized period every booking is refused. The worker '
    + 'creates it, or trigger it once by hand.'],
  'setup.step.inventory.hint.until': [
    'Belegbar bis {date}.', 'Bookable until {date}.'],
  'setup.step.tax_rules': ['Steuersätze hinterlegt', 'Tax rates stored'],
  'setup.step.tax_rules.hint': [
    'Ohne Regel bucht der Nachtlauf Logis mit 7 Prozent.',
    'Without a rule the night audit posts accommodation at 7 percent.'],
  'setup.step.rate_plans': ['Ratenpläne angelegt', 'Rate plans created'],
  'setup.step.rate_plans.hint': [
    'Je Gruppe mindestens eine Basisrate.', 'At least one base rate per type.'],
  'setup.step.prices': ['Preise gepflegt', 'Prices maintained'],
  'setup.step.prices.hint': [
    'Ohne Preise werden Reservierungen mit 0 Cent gebucht.',
    'Without prices, reservations are booked at 0 cents.'],
  'setup.step.payment_methods': ['Zahlungsarten angelegt', 'Payment methods created'],
  'setup.step.payment_methods.hint': [
    'Nur zur Zuordnung. Die Zahlung selbst läuft außerhalb dieses Systems.',
    'For assignment only. The payment itself runs outside this system.'],
  'setup.step.business_day': ['Geschäftstag geöffnet', 'Business day open'],
  'setup.step.business_day.hint.missing': [
    'Ohne offenen Tag läuft kein Nachtlauf.',
    'Without an open day no night audit runs.'],
  'setup.step.business_day.hint.since': [
    'Offen seit {date}.', 'Open since {date}.'],

  'field.depositPartsMismatch': [
    'Die Teile ergeben {sum} Cent, vereinnahmt sind {received} Cent.',
    'The parts add up to {sum} cents, {received} cents were received.']
} as const satisfies Record<string, Eintrag>

export type MessageKey = keyof typeof M
export type MessageParams = Record<string, string | number>
export type MessageLocale = 'de' | 'en'

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
  const text = eintrag === null ? key : eintrag[locale === 'en' ? 1 : 0]
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    // Ein Platzhalter ohne Wert bleibt stehen. Ihn durch nichts zu ersetzen
    // ergaebe einen Satz mit einem Loch, den niemand als Fehler erkennt.
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
}
