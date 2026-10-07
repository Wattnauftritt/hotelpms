/**
 * Zimmer sortieren: Gewichte und ihre Pruefung (Migration 0104).
 *
 * Die Zahlen stammen aus dem Adminpanel, das Hotel und Gaestehaus bisher
 * selbst sortiert hat (`config/room_sorting.php`, Antwort vom 07.10.2026).
 * Sie sind dort ueber Monate an einem echten Haus eingestellt worden und
 * deshalb die Vorgabe -- aber eine Vorgabe, keine Regel: ein anderes Haus hat
 * andere Zimmer. Jede Zahl laesst sich je Haus ueberschreiben, und was ein
 * Haus nicht angibt, nimmt die Vorgabe. Gespeichert wird nur die
 * Abweichung, damit eine spaeter verbesserte Vorgabe auch bei Haeusern
 * ankommt, die nie etwas eingestellt haben.
 *
 * Reine Funktionen ohne Datenbank, wie die uebrigen in diesem Paket.
 */

export const ROOM_SORT_MODES = ['off', 'manual', 'auto'] as const
export type RoomSortMode = typeof ROOM_SORT_MODES[number]

/** Ein Stichwort in der Notiz, das einen Wunsch nach einem Merkmal bedeutet. */
export interface RoomSortWish {
  /** Kleingeschrieben verglichen, als ganzes Wort. */
  keyword: string
  /** Merkmal des Zimmers (`resource.attributes`), das den Wunsch erfuellt. */
  attribute: string
}

export interface RoomSortWeights {
  /**
   * Anteil des Preises je Nacht an der Wichtigkeit eines Gastes, in Prozent.
   * Der Rest geht an die Zahl der Naechte. 70: wer mehr zahlt, bekommt das
   * bessere Zimmer eher als wer laenger bleibt.
   */
  pricePercent: number
  /** Ab dieser Qualitaet gilt ein Zimmer als Spitzenzimmer. */
  topRoomQuality: number
  /**
   * Ein Gast gilt fuer ein Spitzenzimmer als zu guenstig, wenn sein Preis je
   * Nacht so viel unter dem Durchschnitt seiner Zimmergruppe liegt.
   */
  cheapGuestMarginCent: number
  /** Strafe je Nacht fuer einen zu guenstigen Gast im Spitzenzimmer. */
  topRoomPenalty: number
  /** Strafe je Nacht, wenn ein Wunsch aus der Notiz nicht erfuellt ist. */
  wishPenalty: number
  /** Stichwoerter in der Notiz. "kein", "ohne", "nicht" davor heben sie auf. */
  wishes: RoomSortWish[]
  /** Merkmal der kleinen Zimmer (im Hotel: 1,60-m-Betten). */
  smallRoomAttribute: string
  /** Ab so vielen Naechten wird ein kleines Zimmer teurer. */
  smallRoomFromNights: number
  /** Strafe je Nacht und je Nacht ueber der Grenze. */
  smallRoomPenalty: number
  /** Gruppe: Strafe je Paar in verschiedenen Gebaeuden. */
  groupBuildingPenalty: number
  /** Gruppe: Strafe je Paar und Punkt Qualitaetsunterschied. */
  groupQualityPenalty: number
  /** Gruppe: Strafe je Paar und Etage Abstand. */
  groupFloorPenalty: number
  /** Gruppe: Strafe je Paar fuer den Abstand der Zimmernummern, hoechstens. */
  groupNumberPenaltyMax: number
  /** Strafe je Umsetzen. Haelt Zuege klein, die nichts bringen. */
  movePenalty: number
}

export const DEFAULT_ROOM_SORT_WEIGHTS: Readonly<RoomSortWeights> = Object.freeze({
  pricePercent: 70,
  topRoomQuality: 50,
  cheapGuestMarginCent: 3000,
  topRoomPenalty: 1000,
  wishPenalty: 200,
  wishes: [
    { keyword: 'balkon', attribute: 'balkon' },
    { keyword: 'terrasse', attribute: 'dachterrasse' },
    { keyword: 'dachterrasse', attribute: 'dachterrasse' },
    { keyword: 'gross', attribute: 'gross' },
    { keyword: 'groß', attribute: 'gross' }
  ],
  smallRoomAttribute: 'klein',
  smallRoomFromNights: 6,
  smallRoomPenalty: 40,
  groupBuildingPenalty: 300,
  groupQualityPenalty: 5,
  groupFloorPenalty: 20,
  groupNumberPenaltyMax: 10,
  movePenalty: 1
})

/** Ganzzahlige Gewichte mit ihrer Obergrenze. Null ist immer erlaubt. */
const ZAHLEN: Record<Exclude<keyof RoomSortWeights, 'wishes' | 'smallRoomAttribute'>, number> = {
  pricePercent: 100,
  topRoomQuality: 100,
  cheapGuestMarginCent: 1_000_000,
  topRoomPenalty: 100_000,
  wishPenalty: 100_000,
  smallRoomFromNights: 365,
  smallRoomPenalty: 100_000,
  groupBuildingPenalty: 100_000,
  groupQualityPenalty: 100_000,
  groupFloorPenalty: 100_000,
  groupNumberPenaltyMax: 100_000,
  movePenalty: 100_000
}

const MAX_WISHES = 30
const MERKMAL = /^[\p{Ll}\p{N}][\p{Ll}\p{N} _-]{0,29}$/u

export type RoomSortWeightErrors = Record<string, string[]>

/**
 * Prueft eine Abweichung von der Vorgabe, wie sie gespeichert werden soll.
 *
 * Unbekannte Schluessel weisen ab, statt still zu verschwinden: ein
 * vertippter Name ("wishPenality") saehe sonst gespeichert aus und wirkte
 * nie. Die Fehler tragen die Schluessel der Meldungen aus `messages.ts`.
 */
export function checkRoomSortWeights(input: unknown):
  { ok: true; value: Partial<RoomSortWeights> } | { ok: false; errors: RoomSortWeightErrors } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { weights: ['field.invalid'] } }
  }
  const errors: RoomSortWeightErrors = {}
  const value: Partial<RoomSortWeights> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (key in ZAHLEN) {
      const max = ZAHLEN[key as keyof typeof ZAHLEN]
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
        errors[`weights.${key}`] = ['field.invalid']
      } else {
        (value as Record<string, number>)[key] = raw
      }
    } else if (key === 'smallRoomAttribute') {
      if (typeof raw !== 'string' || !MERKMAL.test(raw)) {
        errors[`weights.${key}`] = ['field.invalid']
      } else {
        value.smallRoomAttribute = raw
      }
    } else if (key === 'wishes') {
      if (!Array.isArray(raw) || raw.length > MAX_WISHES) {
        errors['weights.wishes'] = ['field.invalid']
        continue
      }
      const wishes: RoomSortWish[] = []
      raw.forEach((w: unknown, i) => {
        const o = (w ?? {}) as Record<string, unknown>
        const keyword = typeof o.keyword === 'string' ? o.keyword.trim().toLowerCase() : ''
        const attribute = typeof o.attribute === 'string' ? o.attribute.trim() : ''
        if (keyword.length < 2 || keyword.length > 30 || /\s/.test(keyword)
            || !MERKMAL.test(attribute)) {
          errors[`weights.wishes.${i}`] = ['field.invalid']
        } else {
          wishes.push({ keyword, attribute })
        }
      })
      value.wishes = wishes
    } else {
      errors[`weights.${key}`] = ['field.unknownKey']
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value }
}

/** Vorgabe und Abweichung des Hauses zusammen: das, womit sortiert wird. */
export function resolveRoomSortWeights(stored: Partial<RoomSortWeights> | null | undefined):
  RoomSortWeights {
  return { ...DEFAULT_ROOM_SORT_WEIGHTS, wishes: [...DEFAULT_ROOM_SORT_WEIGHTS.wishes],
           ...(stored ?? {}) }
}
