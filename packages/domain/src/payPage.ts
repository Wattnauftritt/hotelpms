import { schreibrichtung, type EmailLanguage } from '@hotelpms/contracts'
import { formatCent } from './money.js'

/**
 * Die Seite, die der Gast hinter seinem Zahlungslink sieht (Migration 0068).
 *
 * **Warum eine Seite und keine sofortige Weiterleitung.** Erstens: Mail-
 * programme und Virenscanner rufen Links in einer Mail vorab auf. Leitete
 * schon dieser Aufruf zum Anbieter weiter, entstuende bei jedem Scan ein
 * Checkout. Erst der Knopf auf der Seite tut das. Zweitens: eine Mail mit
 * einem Zahlungslink sieht aus wie jede Phishing-Mail. Die Seite sagt, an
 * wen, wofuer und wie viel -- bevor der Gast seine Karte irgendwo eingibt.
 *
 * **Fachtext, kein Darstellungsdetail**, deshalb in der Domaene neben den
 * Vorlagen der Gastpost und in denselben Sprachen.
 *
 * **Keine `<style>`-Elemente, nur Stilattribute.** Die Inhaltsrichtlinie im
 * Caddyfile erlaubt eingebettete Stylesheets nicht (H7, Dokument 25), und
 * eine Seite, die nur mit ihnen gut aussieht, saehe beim Gast nackt aus.
 * Kein Skript, keine fremden Herkuenfte, kein Formular: der Knopf ist ein
 * Link, denn `form-action 'self'` verbietet einem Formular die Weiterleitung
 * zum Anbieter.
 *
 * **Kein Gastname.** Wer den Link hat, ist nicht zwingend der Gast -- eine
 * weitergeleitete Mail, ein geteilter Rechner. Haus, Zeitraum und Betrag
 * genuegen, um die Zahlung zuzuordnen.
 */

export type PayPageKind =
  | 'open' | 'paid' | 'processing' | 'revoked' | 'expired' | 'training'
  | 'unavailable' | 'unknown' | 'returned' | 'abandoned'

export interface PayPageData {
  propertyName?: string
  arrival?: string
  departure?: string
  amountCent?: number
  currency?: string
  /** Faelligkeit einer Anzahlung; null bei einem freien Betrag. */
  dueDate?: string | null
  deposit?: boolean
  /** Bis wann der Link annimmt, Kalendertag. */
  validUntil?: string
  /** Wohin der Knopf fuehrt. Relativ, auf dieselbe Herkunft. */
  checkoutHref?: string
}

interface Seitentexte {
  titel: string
  offenAnzahlung: string
  offenAnzahlungFrist: string
  offenZahlung: string
  betrag: string
  gueltig: string
  knopf: string
  karte: string
  bezahlt: string
  inBearbeitung: string
  widerrufen: string
  abgelaufen: string
  uebung: string
  nichtMoeglich: string
  unbekannt: string
  zurueck: string
  abgebrochen: string
  rueckfrage: string
}

const TEXTE: Record<EmailLanguage, Seitentexte> = {
  // Echte Umlaute: anders als die Gastpost, deren Text seit jeher in
  // Umschrift steht, ist diese Seite HTML mit erklaertem Zeichensatz, und
  // "faellig" auf einer Zahlungsseite sieht aus wie eine Phishing-Seite.
  de: {
    titel: 'Zahlung',
    offenAnzahlung: 'Anzahlung für Ihren Aufenthalt vom {anreise} bis {abreise}.',
    offenAnzahlungFrist: 'Anzahlung für Ihren Aufenthalt vom {anreise} bis {abreise}, '
      + 'fällig am {frist}.',
    offenZahlung: 'Zahlung für Ihren Aufenthalt vom {anreise} bis {abreise}.',
    betrag: 'Offener Betrag',
    gueltig: 'Dieser Link gilt bis einschließlich {datum}.',
    knopf: 'Weiter zur Zahlung',
    karte: 'Sie zahlen beim Zahlungsdienstleister des Hauses. Ihre Kartendaten '
      + 'geben Sie nur dort ein; das Haus erhält sie nicht.',
    bezahlt: 'Diese Zahlung ist eingegangen. Vielen Dank.',
    inBearbeitung: 'Ihre Zahlung wird gerade verarbeitet. Sie müssen nichts weiter '
      + 'tun; bitte zahlen Sie nicht ein zweites Mal.',
    widerrufen: 'Dieser Zahlungslink gilt nicht mehr. Bitte wenden Sie sich an das Haus.',
    abgelaufen: 'Dieser Zahlungslink ist abgelaufen. Bitte wenden Sie sich an das Haus; '
      + 'es schickt Ihnen gern einen neuen.',
    uebung: 'Dies ist ein Übungshaus. Hier wird nichts bezahlt.',
    nichtMoeglich: 'Die Zahlung ist gerade nicht möglich. Bitte versuchen Sie es '
      + 'später noch einmal.',
    unbekannt: 'Dieser Link ist ungültig. Bitte prüfen Sie, ob er vollständig '
      + 'aus der E-Mail übernommen wurde.',
    zurueck: 'Vielen Dank. Sobald der Zahlungsdienstleister die Zahlung bestätigt, '
      + 'vermerkt das Haus sie. Sie können dieses Fenster schließen.',
    abgebrochen: 'Die Zahlung wurde nicht abgeschlossen. Sie können den Link aus '
      + 'Ihrer E-Mail erneut öffnen.',
    rueckfrage: 'Bei Fragen antworten Sie auf die E-Mail, mit der Sie diesen Link '
      + 'erhalten haben.'
  },
  en: {
    titel: 'Payment',
    offenAnzahlung: 'Deposit for your stay from {anreise} to {abreise}.',
    offenAnzahlungFrist: 'Deposit for your stay from {anreise} to {abreise}, due on {frist}.',
    offenZahlung: 'Payment for your stay from {anreise} to {abreise}.',
    betrag: 'Amount due',
    gueltig: 'This link is valid up to and including {datum}.',
    knopf: 'Continue to payment',
    karte: 'You pay with the property’s payment provider. You enter your card '
      + 'details only there; the property never receives them.',
    bezahlt: 'This payment has been received. Thank you.',
    inBearbeitung: 'Your payment is being processed. There is nothing more to do; '
      + 'please do not pay a second time.',
    widerrufen: 'This payment link is no longer valid. Please contact the property.',
    abgelaufen: 'This payment link has expired. Please contact the property; it will '
      + 'gladly send you a new one.',
    uebung: 'This is a training property. Nothing is paid here.',
    nichtMoeglich: 'Payment is not possible right now. Please try again later.',
    unbekannt: 'This link is invalid. Please check that it was copied completely '
      + 'from the email.',
    zurueck: 'Thank you. As soon as the payment provider confirms the payment, the '
      + 'property will record it. You can close this window.',
    abgebrochen: 'The payment was not completed. You can open the link from your '
      + 'email again.',
    rueckfrage: 'If you have any questions, reply to the email in which you '
      + 'received this link.'
  },
  nl: {
    titel: 'Betaling',
    offenAnzahlung: 'Aanbetaling voor uw verblijf van {anreise} tot {abreise}.',
    offenAnzahlungFrist: 'Aanbetaling voor uw verblijf van {anreise} tot {abreise}, '
      + 'te voldoen uiterlijk {frist}.',
    offenZahlung: 'Betaling voor uw verblijf van {anreise} tot {abreise}.',
    betrag: 'Openstaand bedrag',
    gueltig: 'Deze link is geldig tot en met {datum}.',
    knopf: 'Verder naar betaling',
    karte: 'U betaalt bij de betaaldienst van het hotel. Uw kaartgegevens voert u '
      + 'alleen daar in; het hotel ontvangt ze niet.',
    bezahlt: 'Deze betaling is ontvangen. Hartelijk dank.',
    inBearbeitung: 'Uw betaling wordt verwerkt. U hoeft verder niets te doen; '
      + 'betaal alstublieft niet nog een keer.',
    widerrufen: 'Deze betaallink is niet meer geldig. Neem contact op met het hotel.',
    abgelaufen: 'Deze betaallink is verlopen. Neem contact op met het hotel; het '
      + 'stuurt u graag een nieuwe.',
    uebung: 'Dit is een oefenhotel. Hier wordt niets betaald.',
    nichtMoeglich: 'Betalen is op dit moment niet mogelijk. Probeer het later nog eens.',
    unbekannt: 'Deze link is ongeldig. Controleer of hij volledig uit de e-mail is '
      + 'overgenomen.',
    zurueck: 'Hartelijk dank. Zodra de betaaldienst de betaling bevestigt, legt het '
      + 'hotel haar vast. U kunt dit venster sluiten.',
    abgebrochen: 'De betaling is niet afgerond. U kunt de link uit uw e-mail opnieuw '
      + 'openen.',
    rueckfrage: 'Heeft u vragen, antwoord dan op de e-mail waarmee u deze link heeft '
      + 'ontvangen.'
  },
  pl: {
    titel: 'Płatność',
    offenAnzahlung: 'Zaliczka za pobyt w terminie {anreise} – {abreise}.',
    offenAnzahlungFrist: 'Zaliczka za pobyt w terminie {anreise} – {abreise}, '
      + 'płatna do dnia {frist}.',
    offenZahlung: 'Płatność za pobyt w terminie {anreise} – {abreise}.',
    betrag: 'Kwota do zapłaty',
    gueltig: 'Ten link jest ważny do dnia {datum} włącznie.',
    knopf: 'Przejdź do płatności',
    karte: 'Płatności dokonują Państwo u operatora płatności obiektu. Dane karty '
      + 'podają Państwo wyłącznie tam; obiekt ich nie otrzymuje.',
    bezahlt: 'Ta płatność została zaksięgowana. Dziękujemy.',
    inBearbeitung: 'Płatność jest właśnie przetwarzana. Nie trzeba nic więcej robić; '
      + 'prosimy nie płacić drugi raz.',
    widerrufen: 'Ten link do płatności nie jest już ważny. Prosimy o kontakt z obiektem.',
    abgelaufen: 'Ten link do płatności wygasł. Prosimy o kontakt z obiektem; '
      + 'chętnie prześle nowy.',
    uebung: 'To jest obiekt szkoleniowy. Tutaj nic nie jest płacone.',
    nichtMoeglich: 'Płatność nie jest w tej chwili możliwa. Prosimy spróbować później.',
    unbekannt: 'Ten link jest nieprawidłowy. Prosimy sprawdzić, czy został w całości '
      + 'skopiowany z wiadomości.',
    zurueck: 'Dziękujemy. Gdy operator płatności potwierdzi płatność, obiekt ją '
      + 'odnotuje. Można zamknąć to okno.',
    abgebrochen: 'Płatność nie została zakończona. Link z wiadomości można otworzyć '
      + 'ponownie.',
    rueckfrage: 'W razie pytań prosimy odpowiedzieć na wiadomość, w której '
      + 'otrzymali Państwo ten link.'
  },

  da: {
    titel: 'Betaling',
    offenAnzahlung: 'Depositum for dit ophold fra {anreise} til {abreise}.',
    offenAnzahlungFrist: 'Depositum for dit ophold fra {anreise} til {abreise}, forfalder den {frist}.',
    offenZahlung: 'Betaling for dit ophold fra {anreise} til {abreise}.',
    betrag: 'Udestående beløb',
    gueltig: 'Dette link gælder til og med {datum}.',
    knopf: 'Videre til betaling',
    karte: 'Du betaler hos hotellets betalingsudbyder. Dine kortoplysninger indtaster du kun der; hotellet modtager dem aldrig.',
    bezahlt: 'Denne betaling er modtaget. Mange tak.',
    inBearbeitung: 'Din betaling behandles lige nu. Du behøver ikke gøre mere; betal venligst ikke en gang til.',
    widerrufen: 'Dette betalingslink gælder ikke længere. Kontakt venligst hotellet.',
    abgelaufen: 'Dette betalingslink er udløbet. Kontakt venligst hotellet; det sender dig gerne et nyt.',
    uebung: 'Dette er et øvelseshotel. Her betales der ikke noget.',
    nichtMoeglich: 'Betaling er ikke mulig lige nu. Prøv venligst igen senere.',
    unbekannt: 'Dette link er ugyldigt. Kontrollér venligst, at det er kopieret helt fra e-mailen.',
    zurueck: 'Mange tak. Så snart betalingsudbyderen bekræfter betalingen, registrerer hotellet den. Du kan lukke dette vindue.',
    abgebrochen: 'Betalingen blev ikke gennemført. Du kan åbne linket fra din e-mail igen.',
    rueckfrage: 'Har du spørgsmål, så svar på den e-mail, du har modtaget dette link med.'
  },

  sv: {
    titel: 'Betalning',
    offenAnzahlung: 'Förskott för din vistelse från {anreise} till {abreise}.',
    offenAnzahlungFrist: 'Förskott för din vistelse från {anreise} till {abreise}, förfaller den {frist}.',
    offenZahlung: 'Betalning för din vistelse från {anreise} till {abreise}.',
    betrag: 'Belopp att betala',
    gueltig: 'Denna länk gäller till och med {datum}.',
    knopf: 'Vidare till betalning',
    karte: 'Du betalar hos hotellets betalleverantör. Du anger dina kortuppgifter bara där; hotellet får aldrig ta del av dem.',
    bezahlt: 'Denna betalning har tagits emot. Tack.',
    inBearbeitung: 'Din betalning behandlas. Du behöver inte göra något mer; betala inte en gång till.',
    widerrufen: 'Denna betallänk är inte längre giltig. Kontakta hotellet.',
    abgelaufen: 'Denna betallänk har gått ut. Kontakta hotellet; det skickar gärna en ny.',
    uebung: 'Detta är ett övningshotell. Här betalas ingenting.',
    nichtMoeglich: 'Betalning är inte möjlig just nu. Försök igen senare.',
    unbekannt: 'Denna länk är ogiltig. Kontrollera att den kopierats fullständigt från mejlet.',
    zurueck: 'Tack. Så snart betalleverantören bekräftar betalningen registrerar hotellet den. Du kan stänga detta fönster.',
    abgebrochen: 'Betalningen slutfördes inte. Du kan öppna länken i ditt mejl igen.',
    rueckfrage: 'Har du frågor, svara på mejlet där du fick denna länk.'
  },

  nb: {
    titel: 'Betaling',
    offenAnzahlung: 'Forskudd for oppholdet ditt fra {anreise} til {abreise}.',
    offenAnzahlungFrist: 'Forskudd for oppholdet ditt fra {anreise} til {abreise}, forfaller {frist}.',
    offenZahlung: 'Betaling for oppholdet ditt fra {anreise} til {abreise}.',
    betrag: 'Utestående beløp',
    gueltig: 'Denne lenken gjelder til og med {datum}.',
    knopf: 'Gå videre til betaling',
    karte: 'Du betaler hos hotellets betalingsleverandør. Kortopplysningene dine legger du bare inn der; hotellet mottar dem aldri.',
    bezahlt: 'Denne betalingen er mottatt. Tusen takk.',
    inBearbeitung: 'Betalingen din behandles nå. Du trenger ikke gjøre noe mer; ikke betal en gang til.',
    widerrufen: 'Denne betalingslenken gjelder ikke lenger. Ta kontakt med hotellet.',
    abgelaufen: 'Denne betalingslenken er utløpt. Ta kontakt med hotellet; de sender deg gjerne en ny.',
    uebung: 'Dette er et øvingshotell. Her betales ingenting.',
    nichtMoeglich: 'Betaling er ikke mulig akkurat nå. Prøv igjen senere.',
    unbekannt: 'Denne lenken er ugyldig. Kontroller at den er kopiert fullstendig fra e-posten.',
    zurueck: 'Tusen takk. Så snart betalingsleverandøren bekrefter betalingen, registrerer hotellet den. Du kan lukke dette vinduet.',
    abgebrochen: 'Betalingen ble ikke fullført. Du kan åpne lenken fra e-posten din på nytt.',
    rueckfrage: 'Har du spørsmål, svarer du på e-posten du fikk denne lenken i.'
  },

  fr: {
    titel: 'Paiement',
    offenAnzahlung: 'Acompte pour votre séjour du {anreise} au {abreise}.',
    offenAnzahlungFrist: 'Acompte pour votre séjour du {anreise} au {abreise}, à régler le {frist}.',
    offenZahlung: 'Paiement de votre séjour du {anreise} au {abreise}.',
    betrag: 'Montant dû',
    gueltig: 'Ce lien est valable jusqu’au {datum} inclus.',
    knopf: 'Continuer vers le paiement',
    karte: 'Vous payez auprès du prestataire de paiement de l’établissement. Vous saisissez vos données de carte uniquement là-bas ; l’établissement ne les reçoit pas.',
    bezahlt: 'Ce paiement a bien été reçu. Merci beaucoup.',
    inBearbeitung: 'Votre paiement est en cours de traitement. Vous n’avez rien d’autre à faire ; veuillez ne pas payer une seconde fois.',
    widerrufen: 'Ce lien de paiement n’est plus valable. Veuillez contacter l’établissement.',
    abgelaufen: 'Ce lien de paiement a expiré. Veuillez contacter l’établissement ; il vous en enverra volontiers un nouveau.',
    uebung: 'Ceci est un établissement d’exercice. Aucun paiement n’est effectué ici.',
    nichtMoeglich: 'Le paiement n’est pas possible pour le moment. Veuillez réessayer plus tard.',
    unbekannt: 'Ce lien n’est pas valable. Veuillez vérifier qu’il a été copié en entier depuis l’e-mail.',
    zurueck: 'Merci beaucoup. Dès que le prestataire de paiement aura confirmé le paiement, l’établissement l’enregistrera. Vous pouvez fermer cette fenêtre.',
    abgebrochen: 'Le paiement n’a pas abouti. Vous pouvez rouvrir le lien figurant dans votre e-mail.',
    rueckfrage: 'Pour toute question, répondez à l’e-mail par lequel vous avez reçu ce lien.'
  },

  it: {
    titel: 'Pagamento',
    offenAnzahlung: 'Acconto per il Suo soggiorno dal {anreise} al {abreise}.',
    offenAnzahlungFrist: 'Acconto per il Suo soggiorno dal {anreise} al {abreise}, da pagare entro il {frist}.',
    offenZahlung: 'Pagamento per il Suo soggiorno dal {anreise} al {abreise}.',
    betrag: 'Importo da pagare',
    gueltig: 'Questo link è valido fino al {datum} incluso.',
    knopf: 'Procedi al pagamento',
    karte: 'Il pagamento avviene presso il fornitore di pagamento della struttura. I dati della Sua carta li inserisce solo lì; la struttura non li riceve.',
    bezahlt: 'Questo pagamento è stato ricevuto. Grazie mille.',
    inBearbeitung: 'Il Suo pagamento è in fase di elaborazione. Non deve fare altro; La preghiamo di non pagare una seconda volta.',
    widerrufen: 'Questo link di pagamento non è più valido. La preghiamo di rivolgersi alla struttura.',
    abgelaufen: 'Questo link di pagamento è scaduto. La preghiamo di rivolgersi alla struttura, che Le invierà volentieri un nuovo link.',
    uebung: 'Questa è una struttura di prova. Qui non si paga nulla.',
    nichtMoeglich: 'Il pagamento al momento non è possibile. La preghiamo di riprovare più tardi.',
    unbekannt: 'Questo link non è valido. Verifichi di averlo copiato per intero dall’e-mail.',
    zurueck: 'Grazie mille. Non appena il fornitore di pagamento conferma il pagamento, la struttura lo registra. Può chiudere questa finestra.',
    abgebrochen: 'Il pagamento non è stato completato. Può riaprire il link dalla Sua e-mail.',
    rueckfrage: 'Per qualsiasi domanda risponda all’e-mail con cui ha ricevuto questo link.'
  },

  es: {
    titel: 'Pago',
    offenAnzahlung: 'Anticipo para su estancia del {anreise} al {abreise}.',
    offenAnzahlungFrist: 'Anticipo para su estancia del {anreise} al {abreise}, con vencimiento el {frist}.',
    offenZahlung: 'Pago de su estancia del {anreise} al {abreise}.',
    betrag: 'Importe pendiente',
    gueltig: 'Este enlace es válido hasta el {datum} inclusive.',
    knopf: 'Continuar al pago',
    karte: 'Paga a través del proveedor de pagos del establecimiento. Sus datos de tarjeta solo los introduce allí; el establecimiento no los recibe.',
    bezahlt: 'Hemos recibido este pago. Muchas gracias.',
    inBearbeitung: 'Su pago se está procesando. No tiene que hacer nada más; por favor, no pague una segunda vez.',
    widerrufen: 'Este enlace de pago ya no es válido. Póngase en contacto con el establecimiento.',
    abgelaufen: 'Este enlace de pago ha caducado. Póngase en contacto con el establecimiento; le enviará uno nuevo con mucho gusto.',
    uebung: 'Este es un establecimiento de prácticas. Aquí no se paga nada.',
    nichtMoeglich: 'En este momento no es posible realizar el pago. Vuelva a intentarlo más tarde.',
    unbekannt: 'Este enlace no es válido. Compruebe que lo ha copiado completo desde el e-mail.',
    zurueck: 'Muchas gracias. En cuanto el proveedor de pagos confirme el pago, el establecimiento lo registrará. Puede cerrar esta ventana.',
    abgebrochen: 'El pago no se ha completado. Puede volver a abrir el enlace desde su e-mail.',
    rueckfrage: 'Si tiene alguna pregunta, responda al e-mail con el que recibió este enlace.'
  },

  tr: {
    titel: 'Ödeme',
    offenAnzahlung: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için ön ödeme.',
    offenAnzahlungFrist: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için ön ödeme, son ödeme tarihi {frist}.',
    offenZahlung: '{anreise} – {abreise} tarihleri arasındaki konaklamanız için ödeme.',
    betrag: 'Ödenecek tutar',
    gueltig: 'Bu bağlantı {datum} tarihi dahil geçerlidir.',
    knopf: 'Ödemeye geç',
    karte: 'Ödemeyi tesisin ödeme hizmet sağlayıcısında yaparsınız. Kart bilgilerinizi yalnızca orada girersiniz; tesis bu bilgileri almaz.',
    bezahlt: 'Bu ödeme alınmıştır. Çok teşekkür ederiz.',
    inBearbeitung: 'Ödemeniz şu anda işleniyor. Başka bir şey yapmanıza gerek yok; lütfen ikinci kez ödeme yapmayın.',
    widerrufen: 'Bu ödeme bağlantısı artık geçerli değil. Lütfen tesisle iletişime geçin.',
    abgelaufen: 'Bu ödeme bağlantısının süresi doldu. Lütfen tesisle iletişime geçin; size memnuniyetle yenisini gönderecektir.',
    uebung: 'Bu bir eğitim tesisidir. Burada ödeme yapılmaz.',
    nichtMoeglich: 'Ödeme şu anda mümkün değil. Lütfen daha sonra tekrar deneyin.',
    unbekannt: 'Bu bağlantı geçersiz. Lütfen e-postadan eksiksiz kopyalanıp kopyalanmadığını kontrol edin.',
    zurueck: 'Teşekkür ederiz. Ödeme hizmet sağlayıcısı ödemeyi onaylar onaylamaz tesis bunu kaydedecektir. Bu pencereyi kapatabilirsiniz.',
    abgebrochen: 'Ödeme tamamlanmadı. E-postanızdaki bağlantıyı yeniden açabilirsiniz.',
    rueckfrage: 'Sorularınız için bu bağlantıyı aldığınız e-postayı yanıtlayın.'
  },

  ru: {
    titel: 'Оплата',
    offenAnzahlung: 'Предоплата за Ваше пребывание с {anreise} по {abreise}.',
    offenAnzahlungFrist: 'Предоплата за Ваше пребывание с {anreise} по {abreise}, срок оплаты — {frist}.',
    offenZahlung: 'Оплата Вашего пребывания с {anreise} по {abreise}.',
    betrag: 'Сумма к оплате',
    gueltig: 'Эта ссылка действует до {datum} включительно.',
    knopf: 'Перейти к оплате',
    karte: 'Вы оплачиваете у платёжного провайдера отеля. Данные карты Вы вводите только там; отель их не получает.',
    bezahlt: 'Этот платёж получен. Большое спасибо.',
    inBearbeitung: 'Ваш платёж сейчас обрабатывается. Больше ничего делать не нужно; пожалуйста, не оплачивайте повторно.',
    widerrufen: 'Эта платёжная ссылка больше не действует. Пожалуйста, свяжитесь с отелем.',
    abgelaufen: 'Срок действия этой платёжной ссылки истёк. Пожалуйста, свяжитесь с отелем — Вам с удовольствием пришлют новую.',
    uebung: 'Это учебный отель. Здесь ничего не оплачивается.',
    nichtMoeglich: 'Оплата сейчас невозможна. Пожалуйста, попробуйте позже.',
    unbekannt: 'Эта ссылка недействительна. Пожалуйста, проверьте, полностью ли она скопирована из письма.',
    zurueck: 'Большое спасибо. Как только платёжный провайдер подтвердит платёж, отель его зарегистрирует. Вы можете закрыть это окно.',
    abgebrochen: 'Оплата не была завершена. Вы можете снова открыть ссылку из Вашего письма.',
    rueckfrage: 'Если у Вас есть вопросы, ответьте на письмо, в котором Вы получили эту ссылку.'
  },

  cs: {
    titel: 'Platba',
    offenAnzahlung: 'Záloha za Váš pobyt od {anreise} do {abreise}.',
    offenAnzahlungFrist: 'Záloha za Váš pobyt od {anreise} do {abreise}, splatná dne {frist}.',
    offenZahlung: 'Platba za Váš pobyt od {anreise} do {abreise}.',
    betrag: 'Částka k úhradě',
    gueltig: 'Tento odkaz platí do {datum} včetně.',
    knopf: 'Pokračovat k platbě',
    karte: 'Platíte u poskytovatele platebních služeb hotelu. Údaje o kartě zadáváte pouze tam; hotel je nedostane.',
    bezahlt: 'Tato platba byla přijata. Děkujeme.',
    inBearbeitung: 'Vaše platba se právě zpracovává. Nemusíte nic dalšího dělat; prosím neplaťte podruhé.',
    widerrufen: 'Tento platební odkaz již neplatí. Obraťte se prosím na hotel.',
    abgelaufen: 'Platnost tohoto platebního odkazu vypršela. Obraťte se prosím na hotel; rád Vám pošle nový.',
    uebung: 'Toto je cvičný hotel. Zde se nic neplatí.',
    nichtMoeglich: 'Platba momentálně není možná. Zkuste to prosím později.',
    unbekannt: 'Tento odkaz je neplatný. Zkontrolujte prosím, zda byl z e-mailu převzat celý.',
    zurueck: 'Děkujeme. Jakmile poskytovatel platebních služeb platbu potvrdí, hotel ji zaznamená. Toto okno můžete zavřít.',
    abgebrochen: 'Platba nebyla dokončena. Odkaz z Vašeho e-mailu můžete otevřít znovu.',
    rueckfrage: 'S dotazy odpovězte na e-mail, ve kterém jste tento odkaz obdrželi.'
  },

  uk: {
    titel: 'Оплата',
    offenAnzahlung: 'Аванс за Ваше перебування з {anreise} по {abreise}.',
    offenAnzahlungFrist: 'Аванс за Ваше перебування з {anreise} по {abreise}, сплатити до {frist}.',
    offenZahlung: 'Оплата Вашого перебування з {anreise} по {abreise}.',
    betrag: 'Сума до сплати',
    gueltig: 'Це посилання дійсне до {datum} включно.',
    knopf: 'Перейти до оплати',
    karte: 'Ви оплачуєте через платіжного провайдера готелю. Дані своєї картки Ви вводите лише там; готель їх не отримує.',
    bezahlt: 'Цей платіж надійшов. Щиро дякуємо.',
    inBearbeitung: 'Ваш платіж зараз обробляється. Більше нічого робити не потрібно; будь ласка, не оплачуйте вдруге.',
    widerrufen: 'Це посилання на оплату більше не дійсне. Будь ласка, зверніться до готелю.',
    abgelaufen: 'Термін дії цього посилання на оплату минув. Будь ласка, зверніться до готелю — Вам охоче надішлють нове.',
    uebung: 'Це навчальний готель. Тут нічого не оплачується.',
    nichtMoeglich: 'Оплата зараз неможлива. Будь ласка, спробуйте пізніше ще раз.',
    unbekannt: 'Це посилання недійсне. Будь ласка, перевірте, чи його повністю скопійовано з листа.',
    zurueck: 'Щиро дякуємо. Щойно платіжний провайдер підтвердить оплату, готель її зафіксує. Ви можете закрити це вікно.',
    abgebrochen: 'Оплату не завершено. Ви можете знову відкрити посилання з Вашого листа.',
    rueckfrage: 'Якщо у Вас є запитання, дайте відповідь на лист, у якому Ви отримали це посилання.'
  },

  zh: {
    titel: '付款',
    offenAnzahlung: '您 {anreise} 至 {abreise} 住宿的预付款。',
    offenAnzahlungFrist: '您 {anreise} 至 {abreise} 住宿的预付款，{frist} 到期。',
    offenZahlung: '您 {anreise} 至 {abreise} 住宿的付款。',
    betrag: '应付金额',
    gueltig: '此链接有效期至 {datum}（含当日）。',
    knopf: '继续付款',
    karte: '您将在酒店的支付服务商处付款。您只需在那里输入银行卡信息；酒店不会获得这些信息。',
    bezahlt: '此笔付款已收到。非常感谢。',
    inBearbeitung: '您的付款正在处理中。您无需再做任何操作；请勿重复付款。',
    widerrufen: '此付款链接已失效。请联系酒店。',
    abgelaufen: '此付款链接已过期。请联系酒店；酒店很乐意为您发送新链接。',
    uebung: '这是一家培训酒店。此处不会产生任何付款。',
    nichtMoeglich: '目前无法付款。请稍后再试。',
    unbekannt: '此链接无效。请检查是否已从邮件中完整复制。',
    zurueck: '非常感谢。支付服务商确认付款后，酒店将予以登记。您可以关闭此窗口。',
    abgebrochen: '付款未完成。您可以从邮件中再次打开链接。',
    rueckfrage: '如有任何疑问，请回复您收到此链接的那封邮件。'
  },

  ko: {
    titel: '결제',
    offenAnzahlung: '{anreise}부터 {abreise}까지 숙박의 선금입니다.',
    offenAnzahlungFrist: '{anreise}부터 {abreise}까지 숙박의 선금이며, 기한은 {frist}입니다.',
    offenZahlung: '{anreise}부터 {abreise}까지 숙박의 결제입니다.',
    betrag: '결제할 금액',
    gueltig: '이 링크는 {datum}까지(당일 포함) 유효합니다.',
    knopf: '결제 계속하기',
    karte: '호텔의 결제 대행사에서 결제하십니다. 카드 정보는 그곳에서만 입력하시며, 호텔은 카드 정보를 받지 않습니다.',
    bezahlt: '결제가 완료되었습니다. 감사합니다.',
    inBearbeitung: '결제를 처리하고 있습니다. 더 하실 일은 없으니 다시 결제하지 마세요.',
    widerrufen: '이 결제 링크는 더 이상 유효하지 않습니다. 호텔에 문의해 주세요.',
    abgelaufen: '이 결제 링크는 만료되었습니다. 호텔에 문의해 주시면 새 링크를 보내 드립니다.',
    uebung: '연습용 호텔입니다. 여기서는 결제가 이루어지지 않습니다.',
    nichtMoeglich: '지금은 결제할 수 없습니다. 나중에 다시 시도해 주세요.',
    unbekannt: '유효하지 않은 링크입니다. 이메일에서 링크 전체를 복사했는지 확인해 주세요.',
    zurueck: '감사합니다. 결제 대행사가 결제를 확인하는 대로 호텔에서 기록합니다. 이 창을 닫으셔도 됩니다.',
    abgebrochen: '결제가 완료되지 않았습니다. 이메일의 링크를 다시 열어 주세요.',
    rueckfrage: '궁금하신 점이 있으시면 이 링크를 받으신 이메일에 회신해 주세요.'
  },

  ar: {
    titel: 'الدفع',
    offenAnzahlung: 'دفعة مقدمة لإقامتكم من {anreise} إلى {abreise}.',
    offenAnzahlungFrist: 'دفعة مقدمة لإقامتكم من {anreise} إلى {abreise}، مستحقة في {frist}.',
    offenZahlung: 'دفعة لإقامتكم من {anreise} إلى {abreise}.',
    betrag: 'المبلغ المستحق',
    gueltig: 'هذا الرابط صالح حتى {datum} شاملًا.',
    knopf: 'متابعة إلى الدفع',
    karte: 'تدفعون لدى مزوّد خدمة الدفع الخاص بالمنشأة. تُدخلون بيانات بطاقتكم هناك فقط؛ ولا تحصل عليها المنشأة.',
    bezahlt: 'تم استلام هذه الدفعة. شكرًا جزيلًا.',
    inBearbeitung: 'دفعتكم قيد المعالجة. لا يلزمكم فعل أي شيء آخر؛ يرجى عدم الدفع مرة ثانية.',
    widerrufen: 'رابط الدفع هذا لم يعد صالحًا. يرجى التواصل مع المنشأة.',
    abgelaufen: 'انتهت صلاحية رابط الدفع هذا. يرجى التواصل مع المنشأة؛ ويسعدها أن ترسل لكم رابطًا جديدًا.',
    uebung: 'هذه منشأة تدريب. لا يتم دفع أي شيء هنا.',
    nichtMoeglich: 'الدفع غير ممكن حاليًا. يرجى المحاولة مرة أخرى لاحقًا.',
    unbekannt: 'هذا الرابط غير صالح. يرجى التحقق من أنه نُسخ كاملًا من الرسالة.',
    zurueck: 'شكرًا جزيلًا. بمجرد أن يؤكد مزوّد خدمة الدفع الدفعة، ستسجّلها المنشأة. يمكنكم إغلاق هذه النافذة.',
    abgebrochen: 'لم تكتمل عملية الدفع. يمكنكم فتح الرابط من رسالتكم مرة أخرى.',
    rueckfrage: 'إذا كانت لديكم أي أسئلة، فردّوا على الرسالة التي تلقيتم فيها هذا الرابط.'
  },

  pt: {
    titel: 'Pagamento',
    offenAnzahlung: 'Adiantamento para a sua estadia de {anreise} a {abreise}.',
    offenAnzahlungFrist: 'Adiantamento para a sua estadia de {anreise} a {abreise}, com vencimento a {frist}.',
    offenZahlung: 'Pagamento da sua estadia de {anreise} a {abreise}.',
    betrag: 'Montante em aberto',
    gueltig: 'Este link é válido até {datum}, inclusive.',
    knopf: 'Continuar para o pagamento',
    karte: 'O pagamento é feito junto do prestador de serviços de pagamento do hotel. Os dados do seu cartão são introduzidos apenas aí; o hotel nunca os recebe.',
    bezahlt: 'Este pagamento foi recebido. Muito obrigado.',
    inBearbeitung: 'O seu pagamento está a ser processado. Não precisa de fazer mais nada; por favor, não pague uma segunda vez.',
    widerrufen: 'Este link de pagamento já não é válido. Por favor, contacte o hotel.',
    abgelaufen: 'Este link de pagamento expirou. Por favor, contacte o hotel; terá todo o gosto em enviar-lhe um novo.',
    uebung: 'Este é um hotel de formação. Aqui não se paga nada.',
    nichtMoeglich: 'De momento não é possível efetuar o pagamento. Por favor, tente novamente mais tarde.',
    unbekannt: 'Este link é inválido. Verifique se foi copiado por completo do e-mail.',
    zurueck: 'Muito obrigado. Assim que o prestador de serviços de pagamento confirmar o pagamento, o hotel regista-o. Pode fechar esta janela.',
    abgebrochen: 'O pagamento não foi concluído. Pode abrir novamente o link do seu e-mail.',
    rueckfrage: 'Em caso de dúvidas, responda ao e-mail através do qual recebeu este link.'
  },

  fi: {
    titel: 'Maksu',
    offenAnzahlung: 'Ennakkomaksu oleskelustanne {anreise}–{abreise}.',
    offenAnzahlungFrist: 'Ennakkomaksu oleskelustanne {anreise}–{abreise}, erääntyy {frist}.',
    offenZahlung: 'Maksu oleskelustanne {anreise}–{abreise}.',
    betrag: 'Avoin summa',
    gueltig: 'Tämä linkki on voimassa {datum} asti (mukaan lukien).',
    knopf: 'Jatka maksamaan',
    karte: 'Maksatte majoituspaikan maksupalveluntarjoajalle. Syötätte korttitietonne vain siellä; majoituspaikka ei saa niitä.',
    bezahlt: 'Maksu on vastaanotettu. Kiitos.',
    inBearbeitung: 'Maksuanne käsitellään parhaillaan. Teidän ei tarvitse tehdä muuta; älkää maksako toista kertaa.',
    widerrufen: 'Tämä maksulinkki ei ole enää voimassa. Ottakaa yhteyttä majoituspaikkaan.',
    abgelaufen: 'Tämä maksulinkki on vanhentunut. Ottakaa yhteyttä majoituspaikkaan; se lähettää mielellään uuden.',
    uebung: 'Tämä on harjoitushotelli. Täällä ei makseta mitään.',
    nichtMoeglich: 'Maksaminen ei ole juuri nyt mahdollista. Yrittäkää myöhemmin uudelleen.',
    unbekannt: 'Tämä linkki on virheellinen. Tarkistakaa, että se on kopioitu sähköpostista kokonaan.',
    zurueck: 'Kiitos. Heti kun maksupalveluntarjoaja vahvistaa maksun, majoituspaikka kirjaa sen. Voitte sulkea tämän ikkunan.',
    abgebrochen: 'Maksua ei suoritettu loppuun. Voitte avata sähköpostissanne olevan linkin uudelleen.',
    rueckfrage: 'Jos teillä on kysyttävää, vastatkaa sähköpostiin, jossa saitte tämän linkin.'
  },

  is: {
    titel: 'Greiðsla',
    offenAnzahlung: 'Innborgun fyrir dvöl þína frá {anreise} til {abreise}.',
    offenAnzahlungFrist: 'Innborgun fyrir dvöl þína frá {anreise} til {abreise}, gjalddagi {frist}.',
    offenZahlung: 'Greiðsla fyrir dvöl þína frá {anreise} til {abreise}.',
    betrag: 'Upphæð til greiðslu',
    gueltig: 'Þessi tengill gildir til og með {datum}.',
    knopf: 'Áfram í greiðslu',
    karte: 'Þú greiðir hjá greiðsluþjónustu hótelsins. Kortaupplýsingarnar slærðu aðeins inn þar; hótelið fær þær aldrei.',
    bezahlt: 'Þessi greiðsla hefur borist. Kærar þakkir.',
    inBearbeitung: 'Verið er að vinna úr greiðslu þinni. Þú þarft ekki að gera neitt meira; vinsamlegast greiddu ekki aftur.',
    widerrufen: 'Þessi greiðslutengill gildir ekki lengur. Vinsamlegast hafðu samband við hótelið.',
    abgelaufen: 'Þessi greiðslutengill er útrunninn. Vinsamlegast hafðu samband við hótelið; það sendir þér gjarnan nýjan.',
    uebung: 'Þetta er æfingahótel. Hér er ekkert greitt.',
    nichtMoeglich: 'Greiðsla er ekki möguleg eins og er. Vinsamlegast reyndu aftur síðar.',
    unbekannt: 'Þessi tengill er ógildur. Vinsamlegast athugaðu hvort hann hafi verið afritaður í heild úr tölvupóstinum.',
    zurueck: 'Kærar þakkir. Um leið og greiðsluþjónustan staðfestir greiðsluna skráir hótelið hana. Þú getur lokað þessum glugga.',
    abgebrochen: 'Greiðslunni var ekki lokið. Þú getur opnað tengilinn úr tölvupóstinum aftur.',
    rueckfrage: 'Ef þú hefur spurningar skaltu svara tölvupóstinum sem þú fékkst þennan tengil í.'
  },

  sk: {
    titel: 'Platba',
    offenAnzahlung: 'Záloha za Váš pobyt od {anreise} do {abreise}.',
    offenAnzahlungFrist: 'Záloha za Váš pobyt od {anreise} do {abreise}, splatná {frist}.',
    offenZahlung: 'Platba za Váš pobyt od {anreise} do {abreise}.',
    betrag: 'Suma na úhradu',
    gueltig: 'Tento odkaz platí do {datum} vrátane.',
    knopf: 'Pokračovať na platbu',
    karte: 'Platíte u poskytovateľa platobných služieb hotela. Údaje o svojej karte zadávate len tam; hotel ich nedostane.',
    bezahlt: 'Táto platba bola prijatá. Ďakujeme.',
    inBearbeitung: 'Vaša platba sa práve spracúva. Nemusíte robiť nič ďalšie; prosím, neplaťte druhýkrát.',
    widerrufen: 'Tento platobný odkaz už neplatí. Obráťte sa, prosím, na hotel.',
    abgelaufen: 'Platnosť tohto platobného odkazu vypršala. Obráťte sa, prosím, na hotel; rád Vám pošle nový.',
    uebung: 'Toto je cvičný hotel. Nič sa tu neplatí.',
    nichtMoeglich: 'Platba momentálne nie je možná. Skúste to, prosím, neskôr.',
    unbekannt: 'Tento odkaz je neplatný. Skontrolujte, prosím, či bol z e-mailu prevzatý celý.',
    zurueck: 'Ďakujeme. Hneď ako poskytovateľ platobných služieb platbu potvrdí, hotel ju zaznamená. Toto okno môžete zavrieť.',
    abgebrochen: 'Platba nebola dokončená. Odkaz z Vášho e-mailu môžete otvoriť znova.',
    rueckfrage: 'Ak máte otázky, odpovedzte na e-mail, v ktorom ste dostali tento odkaz.'
  },

  sl: {
    titel: 'Plačilo',
    offenAnzahlung: 'Predplačilo za vaše bivanje od {anreise} do {abreise}.',
    offenAnzahlungFrist: 'Predplačilo za vaše bivanje od {anreise} do {abreise}, zapade {frist}.',
    offenZahlung: 'Plačilo za vaše bivanje od {anreise} do {abreise}.',
    betrag: 'Odprti znesek',
    gueltig: 'Ta povezava velja do vključno {datum}.',
    knopf: 'Naprej na plačilo',
    karte: 'Plačate pri ponudniku plačilnih storitev hotela. Podatke kartice vnesete le tam; hotel jih ne prejme.',
    bezahlt: 'To plačilo je prejeto. Najlepša hvala.',
    inBearbeitung: 'Vaše plačilo se pravkar obdeluje. Ničesar več vam ni treba storiti; prosimo, ne plačajte drugič.',
    widerrufen: 'Ta plačilna povezava ne velja več. Prosimo, obrnite se na hotel.',
    abgelaufen: 'Ta plačilna povezava je potekla. Prosimo, obrnite se na hotel; z veseljem vam bo poslal novo.',
    uebung: 'To je hotel za usposabljanje. Tukaj se nič ne plačuje.',
    nichtMoeglich: 'Plačilo trenutno ni mogoče. Prosimo, poskusite znova pozneje.',
    unbekannt: 'Ta povezava ni veljavna. Prosimo, preverite, ali ste jo iz e-pošte prevzeli v celoti.',
    zurueck: 'Najlepša hvala. Takoj ko ponudnik plačilnih storitev potrdi plačilo, ga bo hotel evidentiral. To okno lahko zaprete.',
    abgebrochen: 'Plačilo ni bilo zaključeno. Povezavo iz e-pošte lahko odprete znova.',
    rueckfrage: 'Če imate vprašanja, odgovorite na e-pošto, s katero ste prejeli to povezavo.'
  },

  hu: {
    titel: 'Fizetés',
    offenAnzahlung: 'Előleg a(z) {anreise} és {abreise} közötti tartózkodásához.',
    offenAnzahlungFrist: 'Előleg a(z) {anreise} és {abreise} közötti tartózkodásához, esedékes: {frist}.',
    offenZahlung: 'Fizetés a(z) {anreise} és {abreise} közötti tartózkodásához.',
    betrag: 'Fizetendő összeg',
    gueltig: 'Ez a link {datum} napjával bezárólag érvényes.',
    knopf: 'Tovább a fizetéshez',
    karte: 'A szálloda fizetési szolgáltatójánál fizet. Kártyaadatait csak ott adja meg; a szálloda nem kapja meg őket.',
    bezahlt: 'Ez a fizetés beérkezett. Köszönjük.',
    inBearbeitung: 'Fizetése feldolgozás alatt van. Önnek nincs további teendője; kérjük, ne fizessen másodszor.',
    widerrufen: 'Ez a fizetési link már nem érvényes. Kérjük, forduljon a szállodához.',
    abgelaufen: 'Ez a fizetési link lejárt. Kérjük, forduljon a szállodához; szívesen küld újat.',
    uebung: 'Ez egy gyakorló szálloda. Itt semmit sem kell fizetni.',
    nichtMoeglich: 'A fizetés jelenleg nem lehetséges. Kérjük, próbálja újra később.',
    unbekannt: 'Ez a link érvénytelen. Kérjük, ellenőrizze, hogy teljes egészében átmásolta-e az e-mailből.',
    zurueck: 'Köszönjük. Amint a fizetési szolgáltató visszaigazolja a fizetést, a szálloda rögzíti. Ezt az ablakot bezárhatja.',
    abgebrochen: 'A fizetés nem fejeződött be. Az e-mailjében lévő linket újra megnyithatja.',
    rueckfrage: 'Kérdés esetén válaszoljon arra az e-mailre, amelyben ezt a linket kapta.'
  },

  ro: {
    titel: 'Plată',
    offenAnzahlung: 'Avans pentru sejurul dumneavoastră din {anreise} până în {abreise}.',
    offenAnzahlungFrist: 'Avans pentru sejurul dumneavoastră din {anreise} până în {abreise}, scadent pe {frist}.',
    offenZahlung: 'Plată pentru sejurul dumneavoastră din {anreise} până în {abreise}.',
    betrag: 'Sumă de plată',
    gueltig: 'Acest link este valabil până la {datum} inclusiv.',
    knopf: 'Continuă spre plată',
    karte: 'Plătiți la furnizorul de plăți al hotelului. Datele cardului le introduceți doar acolo; hotelul nu le primește.',
    bezahlt: 'Această plată a fost primită. Vă mulțumim.',
    inBearbeitung: 'Plata dumneavoastră este în curs de procesare. Nu trebuie să mai faceți nimic; vă rugăm să nu plătiți a doua oară.',
    widerrufen: 'Acest link de plată nu mai este valabil. Vă rugăm să contactați hotelul.',
    abgelaufen: 'Acest link de plată a expirat. Vă rugăm să contactați hotelul; vă va trimite cu plăcere unul nou.',
    uebung: 'Acesta este un hotel de instruire. Aici nu se plătește nimic.',
    nichtMoeglich: 'Plata nu este posibilă momentan. Vă rugăm să încercați din nou mai târziu.',
    unbekannt: 'Acest link este invalid. Vă rugăm să verificați dacă a fost copiat complet din e-mail.',
    zurueck: 'Vă mulțumim. Imediat ce furnizorul de plăți confirmă plata, hotelul o va înregistra. Puteți închide această fereastră.',
    abgebrochen: 'Plata nu a fost finalizată. Puteți deschide din nou linkul din e-mailul dumneavoastră.',
    rueckfrage: 'Pentru întrebări, răspundeți la e-mailul prin care ați primit acest link.'
  },

  bg: {
    titel: 'Плащане',
    offenAnzahlung: 'Авансово плащане за Вашия престой от {anreise} до {abreise}.',
    offenAnzahlungFrist: 'Авансово плащане за Вашия престой от {anreise} до {abreise}, дължимо на {frist}.',
    offenZahlung: 'Плащане за Вашия престой от {anreise} до {abreise}.',
    betrag: 'Дължима сума',
    gueltig: 'Този линк е валиден до {datum} включително.',
    knopf: 'Към плащането',
    karte: 'Плащате при доставчика на платежни услуги на хотела. Данните от картата си въвеждате само там; хотелът не ги получава.',
    bezahlt: 'Това плащане е постъпило. Благодарим Ви.',
    inBearbeitung: 'Вашето плащане се обработва в момента. Не е нужно да правите нищо повече; моля, не плащайте втори път.',
    widerrufen: 'Този линк за плащане вече не е валиден. Моля, свържете се с хотела.',
    abgelaufen: 'Този линк за плащане е изтекъл. Моля, свържете се с хотела; той с удоволствие ще Ви изпрати нов.',
    uebung: 'Това е тренировъчен хотел. Тук не се плаща нищо.',
    nichtMoeglich: 'В момента плащането не е възможно. Моля, опитайте отново по-късно.',
    unbekannt: 'Този линк е невалиден. Моля, проверете дали е копиран изцяло от имейла.',
    zurueck: 'Благодарим Ви. Щом доставчикът на платежни услуги потвърди плащането, хотелът ще го отбележи. Можете да затворите този прозорец.',
    abgebrochen: 'Плащането не беше завършено. Можете да отворите отново линка от имейла си.',
    rueckfrage: 'При въпроси отговорете на имейла, с който сте получили този линк.'
  },

  hr: {
    titel: 'Plaćanje',
    offenAnzahlung: 'Predujam za Vaš boravak od {anreise} do {abreise}.',
    offenAnzahlungFrist: 'Predujam za Vaš boravak od {anreise} do {abreise}, dospijeva {frist}.',
    offenZahlung: 'Plaćanje za Vaš boravak od {anreise} do {abreise}.',
    betrag: 'Iznos za plaćanje',
    gueltig: 'Ova poveznica vrijedi do uključivo {datum}.',
    knopf: 'Dalje na plaćanje',
    karte: 'Plaćate kod pružatelja platnih usluga objekta. Podatke svoje kartice unosite samo ondje; objekt ih ne dobiva.',
    bezahlt: 'Ova uplata je primljena. Hvala Vam.',
    inBearbeitung: 'Vaše plaćanje upravo se obrađuje. Ne morate ništa više činiti; molimo ne plaćajte drugi put.',
    widerrufen: 'Ova poveznica za plaćanje više ne vrijedi. Molimo obratite se objektu.',
    abgelaufen: 'Ova poveznica za plaćanje je istekla. Molimo obratite se objektu; rado će Vam poslati novu.',
    uebung: 'Ovo je objekt za vježbu. Ovdje se ništa ne plaća.',
    nichtMoeglich: 'Plaćanje trenutačno nije moguće. Molimo pokušajte ponovno kasnije.',
    unbekannt: 'Ova poveznica nije valjana. Molimo provjerite je li u cijelosti preuzeta iz e-poruke.',
    zurueck: 'Hvala Vam. Čim pružatelj platnih usluga potvrdi plaćanje, objekt će ga evidentirati. Možete zatvoriti ovaj prozor.',
    abgebrochen: 'Plaćanje nije dovršeno. Poveznicu iz svoje e-poruke možete ponovno otvoriti.',
    rueckfrage: 'Za pitanja odgovorite na e-poruku kojom ste primili ovu poveznicu.'
  },

  sr: {
    titel: 'Plaćanje',
    offenAnzahlung: 'Avans za Vaš boravak od {anreise} do {abreise}.',
    offenAnzahlungFrist: 'Avans za Vaš boravak od {anreise} do {abreise}, dospeva {frist}.',
    offenZahlung: 'Plaćanje za Vaš boravak od {anreise} do {abreise}.',
    betrag: 'Iznos za plaćanje',
    gueltig: 'Ovaj link važi do uključno {datum}.',
    knopf: 'Nastavi na plaćanje',
    karte: 'Plaćate kod pružaoca platnih usluga objekta. Podatke o kartici unosite samo tamo; objekat ih ne dobija.',
    bezahlt: 'Ova uplata je primljena. Hvala Vam.',
    inBearbeitung: 'Vaše plaćanje se upravo obrađuje. Ne morate ništa više da radite; molimo ne plaćajte drugi put.',
    widerrufen: 'Ovaj link za plaćanje više ne važi. Molimo obratite se objektu.',
    abgelaufen: 'Ovaj link za plaćanje je istekao. Molimo obratite se objektu; rado će Vam poslati novi.',
    uebung: 'Ovo je objekat za obuku. Ovde se ništa ne plaća.',
    nichtMoeglich: 'Plaćanje trenutno nije moguće. Molimo pokušajte ponovo kasnije.',
    unbekannt: 'Ovaj link je nevažeći. Molimo proverite da li je u potpunosti preuzet iz e-poruke.',
    zurueck: 'Hvala Vam. Čim pružalac platnih usluga potvrdi plaćanje, objekat će ga evidentirati. Možete zatvoriti ovaj prozor.',
    abgebrochen: 'Plaćanje nije završeno. Možete ponovo otvoriti link iz Vaše e-poruke.',
    rueckfrage: 'Za pitanja odgovorite na e-poruku kojom ste dobili ovaj link.'
  },

  mk: {
    titel: 'Плаќање',
    offenAnzahlung: 'Аванс за Вашиот престој од {anreise} до {abreise}.',
    offenAnzahlungFrist: 'Аванс за Вашиот престој од {anreise} до {abreise}, доспева на {frist}.',
    offenZahlung: 'Плаќање за Вашиот престој од {anreise} до {abreise}.',
    betrag: 'Износ за плаќање',
    gueltig: 'Овој линк важи до и вклучително {datum}.',
    knopf: 'Продолжи кон плаќање',
    karte: 'Плаќате кај давателот на платежни услуги на објектот. Податоците за Вашата картичка ги внесувате само таму; објектот не ги добива.',
    bezahlt: 'Ова плаќање е примено. Ви благодариме.',
    inBearbeitung: 'Вашето плаќање моментално се обработува. Не треба ништо повеќе да правите; ве молиме не плаќајте втор пат.',
    widerrufen: 'Овој линк за плаќање повеќе не важи. Ве молиме обратете се на објектот.',
    abgelaufen: 'Овој линк за плаќање е истечен. Ве молиме обратете се на објектот; со задоволство ќе Ви испрати нов.',
    uebung: 'Ова е објект за обука. Тука ништо не се плаќа.',
    nichtMoeglich: 'Плаќањето моментално не е можно. Ве молиме обидете се повторно подоцна.',
    unbekannt: 'Овој линк е неважечки. Ве молиме проверете дали е целосно копиран од е-пораката.',
    zurueck: 'Ви благодариме. Штом давателот на платежни услуги го потврди плаќањето, објектот ќе го евидентира. Можете да го затворите овој прозорец.',
    abgebrochen: 'Плаќањето не е завршено. Можете повторно да го отворите линкот од Вашата е-порака.',
    rueckfrage: 'Ако имате прашања, одговорете на е-пораката со која го добивте овој линк.'
  },

  sq: {
    titel: 'Pagesa',
    offenAnzahlung: 'Paradhënie për qëndrimin tuaj nga {anreise} deri më {abreise}.',
    offenAnzahlungFrist: 'Paradhënie për qëndrimin tuaj nga {anreise} deri më {abreise}, me afat më {frist}.',
    offenZahlung: 'Pagesë për qëndrimin tuaj nga {anreise} deri më {abreise}.',
    betrag: 'Shuma e papaguar',
    gueltig: 'Kjo lidhje është e vlefshme deri më {datum} përfshirë.',
    knopf: 'Vazhdo te pagesa',
    karte: 'Paguani te ofruesi i shërbimit të pagesave i hotelit. Të dhënat e kartës i futni vetëm atje; hoteli nuk i merr ato.',
    bezahlt: 'Kjo pagesë është marrë. Faleminderit.',
    inBearbeitung: 'Pagesa juaj po përpunohet. Nuk keni nevojë të bëni asgjë tjetër; ju lutemi mos paguani për herë të dytë.',
    widerrufen: 'Kjo lidhje pagese nuk vlen më. Ju lutemi kontaktoni hotelin.',
    abgelaufen: 'Kjo lidhje pagese ka skaduar. Ju lutemi kontaktoni hotelin; ai do t\'ju dërgojë me kënaqësi një të re.',
    uebung: 'Ky është një hotel trajnimi. Këtu nuk paguhet asgjë.',
    nichtMoeglich: 'Pagesa nuk është e mundur për momentin. Ju lutemi provoni sërish më vonë.',
    unbekannt: 'Kjo lidhje është e pavlefshme. Ju lutemi kontrolloni nëse është kopjuar plotësisht nga e-maili.',
    zurueck: 'Faleminderit. Sapo ofruesi i shërbimit të pagesave ta konfirmojë pagesën, hoteli do ta regjistrojë. Mund ta mbyllni këtë dritare.',
    abgebrochen: 'Pagesa nuk u përfundua. Mund ta hapni sërish lidhjen nga e-maili juaj.',
    rueckfrage: 'Për pyetje, përgjigjuni e-mailit me të cilin morët këtë lidhje.'
  },

  el: {
    titel: 'Πληρωμή',
    offenAnzahlung: 'Προκαταβολή για τη διαμονή σας από {anreise} έως {abreise}.',
    offenAnzahlungFrist: 'Προκαταβολή για τη διαμονή σας από {anreise} έως {abreise}, πληρωτέα έως τις {frist}.',
    offenZahlung: 'Πληρωμή για τη διαμονή σας από {anreise} έως {abreise}.',
    betrag: 'Οφειλόμενο ποσό',
    gueltig: 'Αυτός ο σύνδεσμος ισχύει έως και {datum}.',
    knopf: 'Συνέχεια στην πληρωμή',
    karte: 'Πληρώνετε στον πάροχο πληρωμών του καταλύματος. Τα στοιχεία της κάρτας σας τα εισάγετε μόνο εκεί· το κατάλυμα δεν τα λαμβάνει.',
    bezahlt: 'Η πληρωμή αυτή έχει ληφθεί. Σας ευχαριστούμε πολύ.',
    inBearbeitung: 'Η πληρωμή σας βρίσκεται σε επεξεργασία. Δεν χρειάζεται να κάνετε τίποτα άλλο· παρακαλούμε μην πληρώσετε δεύτερη φορά.',
    widerrufen: 'Αυτός ο σύνδεσμος πληρωμής δεν ισχύει πλέον. Παρακαλούμε επικοινωνήστε με το κατάλυμα.',
    abgelaufen: 'Αυτός ο σύνδεσμος πληρωμής έχει λήξει. Παρακαλούμε επικοινωνήστε με το κατάλυμα· θα σας στείλει ευχαρίστως νέο.',
    uebung: 'Αυτό είναι εκπαιδευτικό κατάλυμα. Εδώ δεν πληρώνεται τίποτα.',
    nichtMoeglich: 'Η πληρωμή δεν είναι δυνατή αυτή τη στιγμή. Παρακαλούμε δοκιμάστε ξανά αργότερα.',
    unbekannt: 'Αυτός ο σύνδεσμος δεν είναι έγκυρος. Παρακαλούμε ελέγξτε ότι αντιγράφηκε ολόκληρος από το email.',
    zurueck: 'Σας ευχαριστούμε. Μόλις ο πάροχος πληρωμών επιβεβαιώσει την πληρωμή, το κατάλυμα θα την καταχωρίσει. Μπορείτε να κλείσετε αυτό το παράθυρο.',
    abgebrochen: 'Η πληρωμή δεν ολοκληρώθηκε. Μπορείτε να ανοίξετε ξανά τον σύνδεσμο από το email σας.',
    rueckfrage: 'Για οποιαδήποτε ερώτηση απαντήστε στο email με το οποίο λάβατε αυτόν τον σύνδεσμο.'
  },

  lt: {
    titel: 'Mokėjimas',
    offenAnzahlung: 'Avansas už Jūsų viešnagę nuo {anreise} iki {abreise}.',
    offenAnzahlungFrist: 'Avansas už Jūsų viešnagę nuo {anreise} iki {abreise}, mokėtinas iki {frist}.',
    offenZahlung: 'Mokėjimas už Jūsų viešnagę nuo {anreise} iki {abreise}.',
    betrag: 'Mokėtina suma',
    gueltig: 'Ši nuoroda galioja iki {datum} imtinai.',
    knopf: 'Toliau į mokėjimą',
    karte: 'Mokate per viešbučio mokėjimo paslaugų teikėją. Kortelės duomenis įvedate tik ten; viešbutis jų negauna.',
    bezahlt: 'Šis mokėjimas gautas. Labai ačiū.',
    inBearbeitung: 'Jūsų mokėjimas šiuo metu apdorojamas. Daugiau nieko daryti nereikia; prašome nemokėti antrą kartą.',
    widerrufen: 'Ši mokėjimo nuoroda nebegalioja. Prašome kreiptis į viešbutį.',
    abgelaufen: 'Ši mokėjimo nuoroda nebegalioja. Prašome kreiptis į viešbutį; jis mielai atsiųs Jums naują.',
    uebung: 'Tai mokomasis viešbutis. Čia niekas nemokama.',
    nichtMoeglich: 'Šiuo metu mokėjimas negalimas. Bandykite vėliau dar kartą.',
    unbekannt: 'Ši nuoroda neteisinga. Patikrinkite, ar ji visiškai nukopijuota iš el. laiško.',
    zurueck: 'Labai ačiū. Kai tik mokėjimo paslaugų teikėjas patvirtins mokėjimą, viešbutis jį užregistruos. Galite uždaryti šį langą.',
    abgebrochen: 'Mokėjimas nebuvo užbaigtas. Galite dar kartą atidaryti nuorodą iš savo el. laiško.',
    rueckfrage: 'Kilus klausimams, atsakykite į el. laišką, kuriuo gavote šią nuorodą.'
  },

  lv: {
    titel: 'Maksājums',
    offenAnzahlung: 'Avanss par Jūsu uzturēšanos no {anreise} līdz {abreise}.',
    offenAnzahlungFrist: 'Avanss par Jūsu uzturēšanos no {anreise} līdz {abreise}, termiņš {frist}.',
    offenZahlung: 'Maksājums par Jūsu uzturēšanos no {anreise} līdz {abreise}.',
    betrag: 'Maksājamā summa',
    gueltig: 'Šī saite ir derīga līdz {datum} ieskaitot.',
    knopf: 'Turpināt uz maksājumu',
    karte: 'Jūs maksājat pie viesnīcas maksājumu pakalpojumu sniedzēja. Kartes datus ievadāt tikai tur; viesnīca tos nekad nesaņem.',
    bezahlt: 'Šis maksājums ir saņemts. Paldies.',
    inBearbeitung: 'Jūsu maksājums tiek apstrādāts. Vairs nekas nav jādara; lūdzu, nemaksājiet otrreiz.',
    widerrufen: 'Šī maksājuma saite vairs nav derīga. Lūdzu, sazinieties ar viesnīcu.',
    abgelaufen: 'Šīs maksājuma saites derīgums ir beidzies. Lūdzu, sazinieties ar viesnīcu; tā labprāt nosūtīs Jums jaunu.',
    uebung: 'Šī ir mācību viesnīca. Šeit nekas netiek maksāts.',
    nichtMoeglich: 'Maksājums pašlaik nav iespējams. Lūdzu, mēģiniet vēlāk.',
    unbekannt: 'Šī saite nav derīga. Lūdzu, pārbaudiet, vai tā no e-pasta nokopēta pilnībā.',
    zurueck: 'Paldies. Tiklīdz maksājumu pakalpojumu sniedzējs apstiprinās maksājumu, viesnīca to reģistrēs. Varat aizvērt šo logu.',
    abgebrochen: 'Maksājums netika pabeigts. Varat vēlreiz atvērt saiti no sava e-pasta.',
    rueckfrage: 'Ja Jums ir jautājumi, atbildiet uz e-pastu, kurā saņēmāt šo saiti.'
  },

  et: {
    titel: 'Makse',
    offenAnzahlung: 'Ettemaks Teie viibimise eest ajavahemikus {anreise} kuni {abreise}.',
    offenAnzahlungFrist: 'Ettemaks Teie viibimise eest ajavahemikus {anreise} kuni {abreise}, tähtaeg {frist}.',
    offenZahlung: 'Makse Teie viibimise eest ajavahemikus {anreise} kuni {abreise}.',
    betrag: 'Tasumisele kuuluv summa',
    gueltig: 'See link kehtib kuni {datum} (kaasa arvatud).',
    knopf: 'Edasi maksma',
    karte: 'Maksate hotelli makseteenuse pakkuja juures. Kaardiandmed sisestate ainult seal; hotell neid ei saa.',
    bezahlt: 'See makse on laekunud. Täname!',
    inBearbeitung: 'Teie makset töödeldakse. Teil pole vaja midagi rohkem teha; palun ärge makske teist korda.',
    widerrufen: 'See makselink ei kehti enam. Palun pöörduge hotelli poole.',
    abgelaufen: 'See makselink on aegunud. Palun pöörduge hotelli poole; see saadab Teile hea meelega uue.',
    uebung: 'See on harjutushotell. Siin ei maksta midagi.',
    nichtMoeglich: 'Makse pole praegu võimalik. Palun proovige hiljem uuesti.',
    unbekannt: 'See link on kehtetu. Palun kontrollige, kas see kopeeriti e-kirjast täielikult.',
    zurueck: 'Täname! Niipea kui makseteenuse pakkuja makse kinnitab, märgib hotell selle. Võite selle akna sulgeda.',
    abgebrochen: 'Makset ei lõpetatud. Võite oma e-kirjast lingi uuesti avada.',
    rueckfrage: 'Küsimuste korral vastake e-kirjale, millega selle lingi saite.'
  }
}

/** Die Saetze einer Sprache. Fuer den Test, der Platzhalter und Luecken sucht. */
export function payPageTexts(lang: EmailLanguage): Readonly<Record<string, string>> {
  return { ...TEXTE[lang] }
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function einsetzen(satz: string, werte: Record<string, string>): string {
  return satz.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    Object.prototype.hasOwnProperty.call(werte, name) ? werte[name]! : ganz)
}

/** Kalendertag in der Schreibweise der Sprache, ohne `Date` (wie in der Gastpost). */
const JAHR_ZUERST: ReadonlySet<EmailLanguage> = new Set(['en', 'sv', 'hu', 'lt', 'zh', 'ko'])

function kalendertag(iso: string, lang: EmailLanguage): string {
  const [jahr, monat, tag] = iso.split('-')
  if (jahr === undefined || monat === undefined || tag === undefined) return iso
  // Schwedisch, Ungarisch, Litauisch, Chinesisch und Koreanisch schreiben
  // das Jahr selbst zuerst; dieselbe Wahl wie `DATUMSFORM` der Oberflaeche.
  if (JAHR_ZUERST.has(lang)) return iso
  if (lang === 'nl') return `${tag}-${monat}-${jahr}`
  return `${tag}.${monat}.${jahr}`
}

const P = 'margin:0 0 14px 0'

export function renderPayPage(
  kind: PayPageKind, d: PayPageData, lang: EmailLanguage = 'de'
): string {
  const t = TEXTE[lang]
  const werte = {
    anreise: d.arrival === undefined ? '' : kalendertag(d.arrival, lang),
    abreise: d.departure === undefined ? '' : kalendertag(d.departure, lang),
    frist: d.dueDate == null ? '' : kalendertag(d.dueDate, lang),
    datum: d.validUntil === undefined ? '' : kalendertag(d.validUntil, lang)
  }

  const teile: string[] = []
  if (d.propertyName !== undefined) {
    teile.push(`<h1 style="font-size:20px;margin:0 0 18px 0">${esc(d.propertyName)}</h1>`)
  }

  const absatz = (s: string): string => `<p style="${P}">${esc(s)}</p>`
  switch (kind) {
    case 'open': {
      const satz = !d.deposit ? t.offenZahlung
        : d.dueDate == null ? t.offenAnzahlung : t.offenAnzahlungFrist
      teile.push(absatz(einsetzen(satz, werte)))
      teile.push(`<p style="${P}"><span style="color:#555">${esc(t.betrag)}</span><br>`
        + `<strong style="font-size:28px">${esc(formatCent(d.amountCent ?? 0))} `
        + `${esc(d.currency ?? 'EUR')}</strong></p>`)
      teile.push(`<p style="margin:0 0 18px 0"><a href="${esc(d.checkoutHref ?? '#')}" `
        + 'style="display:inline-block;background:#111;color:#fff;padding:12px 20px;'
        + `border-radius:6px;text-decoration:none">${esc(t.knopf)}</a></p>`)
      teile.push(absatz(t.karte))
      if (d.validUntil !== undefined) teile.push(absatz(einsetzen(t.gueltig, werte)))
      break
    }
    case 'paid': teile.push(absatz(t.bezahlt)); break
    case 'processing': teile.push(absatz(t.inBearbeitung)); break
    case 'revoked': teile.push(absatz(t.widerrufen)); break
    case 'expired': teile.push(absatz(t.abgelaufen)); break
    case 'training': teile.push(absatz(t.uebung)); break
    case 'unavailable': teile.push(absatz(t.nichtMoeglich)); break
    case 'unknown': teile.push(absatz(t.unbekannt)); break
    case 'returned': teile.push(absatz(t.zurueck)); break
    case 'abandoned': teile.push(absatz(t.abgebrochen)); break
  }
  if (kind !== 'unknown') teile.push(`<p style="${P};color:#555">${esc(t.rueckfrage)}</p>`)

  return '<!doctype html>\n'
    + `<html lang="${lang}" dir="${schreibrichtung(lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + `<title>${esc(d.propertyName === undefined ? t.titel
                                                  : `${t.titel} — ${d.propertyName}`)}</title>`
    + '</head><body style="margin:0;background:#f5f5f5;'
    + 'font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111">'
    + '<main style="max-width:520px;margin:40px auto;background:#fff;padding:28px;'
    + 'border:1px solid #e5e5e5;border-radius:8px;font-size:16px;line-height:1.5">'
    + teile.join('\n')
    + '</main></body></html>'
}
