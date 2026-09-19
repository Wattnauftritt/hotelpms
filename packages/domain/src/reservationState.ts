/**
 * Zustandsautomat der Reservierung.
 * Als Tabelle, nicht als verstreute if-Ketten: jeder erlaubte Uebergang steht
 * an genau einer Stelle und ist testbar.
 */
export const RESERVATION_STATES = [
  'Inquired', 'Optional', 'Confirmed', 'InHouse', 'CheckedOut', 'Canceled', 'NoShow'
] as const
export type ReservationStatus = (typeof RESERVATION_STATES)[number]

export type ReservationAction =
  | 'confirm' | 'hold' | 'check_in' | 'check_out' | 'cancel' | 'no_show' | 'reinstate'

const TRANSITIONS: Record<ReservationStatus, Partial<Record<ReservationAction, ReservationStatus>>> = {
  Inquired:   { hold: 'Optional', confirm: 'Confirmed', cancel: 'Canceled' },
  Optional:   { confirm: 'Confirmed', cancel: 'Canceled' },
  Confirmed:  { check_in: 'InHouse', cancel: 'Canceled', no_show: 'NoShow' },
  InHouse:    { check_out: 'CheckedOut' },
  CheckedOut: {},
  // Wiederherstellen ist bewusst erlaubt: ein versehentlicher Storno oder ein
  // No-Show, der doch noch anreist, kommt taeglich vor. Beides ist protokolliert.
  Canceled:   { reinstate: 'Confirmed' },
  NoShow:     { reinstate: 'Confirmed', check_in: 'InHouse' }
}

/** Zustaende, die Kontingent binden. Muss zum Index in 0009 passen. */
export const OCCUPYING_STATES: readonly ReservationStatus[] = ['Optional', 'Confirmed', 'InHouse']

export function occupiesInventory(status: ReservationStatus): boolean {
  return OCCUPYING_STATES.includes(status)
}

export function nextState(
  from: ReservationStatus, action: ReservationAction
): ReservationStatus | null {
  return TRANSITIONS[from][action] ?? null
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly action: ReservationAction
  ) {
    super(`Uebergang ${action} ist aus dem Zustand ${from} nicht erlaubt`)
    this.name = 'InvalidTransitionError'
  }
}

export function applyAction(
  from: ReservationStatus, action: ReservationAction
): ReservationStatus {
  const to = nextState(from, action)
  if (to === null) throw new InvalidTransitionError(from, action)
  return to
}
