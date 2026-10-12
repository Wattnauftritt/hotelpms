import type { EmailLanguage } from '@hotelpms/contracts'
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
function kalendertag(iso: string, lang: EmailLanguage): string {
  const [jahr, monat, tag] = iso.split('-')
  if (jahr === undefined || monat === undefined || tag === undefined) return iso
  // Schwedisch schreibt Kalendertage selbst in ISO-Form.
  if (lang === 'en' || lang === 'sv') return iso
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
    + `<html lang="${lang}"><head><meta charset="utf-8">`
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
