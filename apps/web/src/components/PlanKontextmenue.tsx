import type { JSX } from 'react'
import { Kontextmenue, type KontextZiel, type MenueEintrag } from './Kontextmenue.tsx'
import { useReservationStatusAction, useAssignUnit } from '../lib/queries/booking.js'
import { useHausrechte } from '../lib/rechte.js'
import { useT } from '../lib/i18n/index.js'

/**
 * Welche Eintraege der rechte Knopf im Belegungsplan bekommt.
 *
 * **Eine eigene Komponente, weil sie nur dann existiert, wenn ein Ziel da
 * ist.** `useReservationStatusAction` braucht die Referenz beim Anlegen des
 * Hooks, und Hooks stehen nicht in Bedingungen. Als Kind, das erst mit dem
 * Menue eingehaengt wird, ist das kein Problem -- im Bildschirm daneben
 * waere es eines.
 *
 * **Was hineingehoert.** Was man entscheidet, waehrend man auf den Plan
 * sieht, und was heute Navigation kostet. Bewusst **nicht** dabei:
 *
 * - **Das Folio.** Der Plan kennt die Folio-Referenz nicht; ein Eintrag
 *   dafuer braeuchte eine eigene Runde zum Server, nur um zu wissen, ob er
 *   ueberhaupt anzuzeigen ist. Das Seitenfenster ist einen Klick entfernt
 *   und hat sie ohnehin.
 * - **Check-out.** Der gehoert neben den offenen Betrag, nicht in ein
 *   Menue: wer auscheckt, ohne die Rechnung gesehen zu haben, laesst
 *   Geld stehen.
 *
 * **Was nicht geht, steht nicht da.** Ausgegraute Eintraege stellen eine
 * Frage ("warum nicht?"), die ein Menue nicht beantworten kann -- und
 * fehlende Rechte sind keine Einladung zum Ausprobieren.
 */
export function PlanKontextmenue({ propertyId, ziel, onClose,
                                   onOeffnen, onCheckIn, onGruppe, onAnlegen, onSperren }: {
  propertyId: number
  ziel: KontextZiel
  onClose: () => void
  onOeffnen: (reservationRef: string) => void
  onCheckIn: (reservationRef: string) => void
  onGruppe: (bookingRef: string) => void
  onAnlegen: (ziel: Extract<KontextZiel, { art: 'frei' }>) => void
  onSperren: (z: { zimmer: Array<{ resourceId: number; roomCode: string }>
                   ab: string; bis: string }) => void
}): JSX.Element {
  const t = useT()
  const rechte = useHausrechte(propertyId)
  const zuweisen = useAssignUnit()
  const status = useReservationStatusAction(
    ziel.art === 'reservierung' ? ziel.reservationRef : '')

  const eintraege: MenueEintrag[] = []

  if (ziel.art === 'reservierung') {
    eintraege.push({ schluessel: 'oeffnen', text: t('kontext.open'),
                     onClick: () => onOeffnen(ziel.reservationRef) })

    /*
     * Check-in nur, wenn er auch gehen kann: bestaetigt und mit Zimmer.
     * Eine Option kann nicht anreisen, und ohne Zimmer weiss niemand,
     * wohin -- der Check-in-Bildschirm wuerde beides sagen, aber erst nach
     * einem Wechsel des Bildschirms.
     */
    if (rechte.darf('reservation:checkin')
        && ziel.status === 'Confirmed' && ziel.resourceId !== null) {
      eintraege.push({ schluessel: 'checkin', text: t('kontext.checkIn'),
                       onClick: () => onCheckIn(ziel.reservationRef) })
    }

    if (ziel.bookingRooms > 1) {
      eintraege.push({ schluessel: 'gruppe',
                       text: t('kontext.group', { n: ziel.bookingRooms }),
                       onClick: () => onGruppe(ziel.bookingRef) })
    }

    /*
     * Zimmer abnehmen: derselbe Weg wie das Ziehen ins Band, nur ohne
     * Zielen. Das ist kein doppelter Weg ohne Grund -- wer in Zeile 180
     * arbeitet, hat das Band nicht auf dem Bildschirm, und bis dorthin zu
     * ziehen heisst, den Plan waehrend des Zugs scrollen zu lassen.
     *
     * Nicht bei angereistem Gast: der liegt im Zimmer. Die API weist es
     * ohnehin ab; den Eintrag trotzdem anzubieten hiesse, eine Fehlermeldung
     * anzubieten.
     */
    if (rechte.darf('reservation:write')
        && ziel.resourceId !== null && ziel.status !== 'InHouse') {
      eintraege.push({ schluessel: 'abnehmen', text: t('kontext.unassign'),
                       onClick: () => zuweisen.mutate(
                         { reservationRef: ziel.reservationRef, resourceId: null }) })
    }

    // Storno steht unten und abgesetzt, und er fragt. Ein Klick daneben
    // trifft im Menue die Nachbarzeile, und ein Storno ist nicht
    // zurueckzunehmen, ohne dass er im Protokoll steht.
    if (rechte.darf('reservation:write')
        && (ziel.status === 'Confirmed' || ziel.status === 'Optional')) {
      eintraege.push({ schluessel: 'storno', text: t('kontext.cancel'),
                       abgesetzt: true, gefaehrlich: true,
                       onClick: () => {
                         if (confirm(t('kontext.cancelConfirm'))) status.mutate('cancel')
                       } })
    }
  } else {
    /*
     * **Alle oder keines.**
     *
     * Liegt der Klick in einer stehenden Markierung, meinen beide Eintraege
     * sie ganz -- und die Zahl steht dabei, damit das vor dem Klick zu
     * sehen ist. Vorher erwischte man nach einer Mehrfachmarkierung genau
     * eines der markierten Zimmer, ohne dass irgendwo stand, welches: acht
     * Zimmer markiert, eines gesperrt, sieben offen und niemand merkt es
     * bis zum Anreisetag.
     *
     * `ziel.auswahl` ist `null`, wenn daneben geklickt wurde. Dann gilt die
     * Stelle unter dem Zeiger -- wer neben seine Markierung klickt, meint
     * nicht sie.
     */
    const zimmer = ziel.auswahl ?? [ziel]

    if (rechte.darf('reservation:write')) {
      eintraege.push({ schluessel: 'neu',
                       text: zimmer.length === 1 ? t('kontext.newReservation')
                         : t('kontext.newReservationN', { n: zimmer.length }),
                       onClick: () => { ziel.leeren(); onAnlegen(ziel) } })
    }
    if (rechte.darf('maintenance:write')) {
      eintraege.push({ schluessel: 'sperren',
                       text: zimmer.length === 1 ? t('kontext.blockRoom')
                         : t('kontext.blockRoomN', { n: zimmer.length }),
                       onClick: () => { ziel.leeren(); onSperren({
                         zimmer: zimmer.map(z => ({ resourceId: z.resourceId,
                                                    roomCode: z.roomCode })),
                         /*
                          * Der markierte Zeitraum, nicht der angeklickte
                          * Tag: wer eine Etage vom 3. bis zum 6. markiert
                          * und am 5. rechtsklickt, meint den 3. bis 6. --
                          * und eine Sperrung, die auf eine Nacht
                          * voreingestellt ist, wird als eine Nacht
                          * gespeichert.
                          *
                          * Ohne Markierung ist beides die eine Nacht unter
                          * dem Zeiger, also unveraendert.
                          */
                         ab: zimmer.reduce(
                           (fr, z) => z.arrival < fr ? z.arrival : fr,
                           zimmer[0]!.arrival),
                         bis: zimmer.reduce(
                           (sp, z) => z.departure > sp ? z.departure : sp,
                           zimmer[0]!.departure) }) } })
    }
  }

  return <Kontextmenue punkt={ziel.punkt} eintraege={eintraege} onClose={onClose} />
}
