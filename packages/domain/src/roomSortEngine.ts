/**
 * Der Sortierer: verteilt die Aufenthalte einer Zimmergruppe auf ihre
 * Zimmer (Plan im Projektordner `zimmer-sortierung/plan.md`).
 *
 * Das Verfahren ist das des Adminpanels, das Hotel und Gaestehaus bisher
 * sortiert hat (`RoomSortPlanner`, `GuesthouseSyncService`), nur in einem:
 *
 * 1. Wer liegen bleibt, entscheidet der Aufrufer (`fixed`): angereist,
 *    "Zimmer fest", Anreise heute, ueber den Zeitraum hinaus, im Zimmer
 *    einer anderen Gruppe. Diese Aufenthalte und die Out-of-Order-Sperren
 *    belegen ihre Zimmer, und niemand wird hineingelegt.
 * 2. Gierig: die wichtigsten Gaeste zuerst ins guenstigste freie Zimmer.
 *    Wichtig ist, wer viel zahlt und lange bleibt (`pricePercent`); das
 *    Gaestehaus ist derselbe Fall mit `pricePercent = 0` -- der laengste
 *    Aufenthalt bekommt das schoenste Zimmer.
 * 3. Verbessern: einzeln umsetzen und paarweise tauschen, solange die
 *    Kosten sinken.
 *
 * **Nie schlechter als vorher.** Die bisherige Verteilung ist immer ein
 * Kandidat. Findet der Sortierer fuer einen Gast, der heute ein Zimmer hat,
 * keines, bleibt die bisherige stehen -- halb sortiert waere schlimmer als
 * unsortiert, das war im Adminpanel ein eigener Aerger. Gaeste ohne Zimmer
 * (die Ablage) bekommen eines, wenn eines frei ist; sonst bleiben sie dort.
 *
 * **Keine Teilung.** Ein Gast bleibt den ganzen Aufenthalt in einem Zimmer.
 * Im Hotel ist das die Regel, im Gaestehaus vorerst (Entscheidung E3).
 *
 * Reine Funktion ohne Datenbank und ohne Uhr: dieselbe Eingabe ergibt
 * dieselbe Verteilung, und die Vorschau zeigt genau, was Uebernehmen tut.
 */
import type { IsoDate } from './dates.js'
import type { RoomSortWeights } from './roomSort.js'

export interface SortRoom {
  id: number
  categoryId: number
  code: string
  quality: number
  floor: string | null
  building: string | null
  attributes: string[]
  /** Out of Order: dort darf niemand hinein. */
  blocked: Array<{ from: IsoDate; to: IsoDate }>
}

export interface SortStay {
  id: number
  /** Dieselbe Buchung heisst Gruppe: sie soll beieinander liegen. */
  bookingId: number
  categoryId: number
  arrival: IsoDate
  departure: IsoDate
  resourceId: number | null
  /** Bleibt, wo er ist. Belegt sein Zimmer, wenn er eines hat. */
  fixed: boolean
  /** Durchschnitt je Nacht; `null`, wenn unbekannt (dann zaehlt er mittig). */
  pricePerNightCent: number | null
  /** Notiz und Kurznotiz, fuer die Wuensche. */
  text: string
}

export interface SortMove { stayId: number; fromRoomId: number | null; toRoomId: number }

export interface SortResult {
  moves: SortMove[]
  /** Hatten kein Zimmer und bekommen auch jetzt keines. */
  unplaced: number[]
  costBefore: number
  costAfter: number
}

/** Ein Gast ohne Zimmer kostet mehr als jede Strafe: Unterbringen geht vor. */
const UNPLACED = 1e9
const MAX_PASSES = 30

const tag = (d: IsoDate): number => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000)

interface Iv { a: number; d: number }
const overlaps = (x: Iv, y: Iv): boolean => x.a < y.d && y.a < x.d

/** Nummer als Zahl, wo es eine ist ("12", "601"); sonst keine Naehe. */
const nummer = (code: string): number | null => (/^\d+$/.test(code) ? Number(code) : null)
const etage = (floor: string | null): number | null => {
  const m = floor === null ? null : /-?\d+/.exec(floor)
  return m === null ? (floor !== null && /^(eg|erdgeschoss)$/i.test(floor.trim()) ? 0 : null)
                    : Number(m[0])
}

const VERNEINT = new Set(['kein', 'keine', 'keinen', 'ohne', 'nicht'])

/**
 * Welche Merkmale ein Gast sich wuenscht. Ganze Woerter, und "kein Balkon"
 * oder "ohne Terrasse" ist das Gegenteil eines Wunsches.
 */
export function wishesFromText(text: string, weights: Pick<RoomSortWeights, 'wishes'>): string[] {
  const woerter = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w !== '')
  const out = new Set<string>()
  for (const w of weights.wishes) {
    for (let i = 0; i < woerter.length; i++) {
      if (woerter[i] !== w.keyword) continue
      if (i > 0 && VERNEINT.has(woerter[i - 1]!)) continue
      out.add(w.attribute)
    }
  }
  return [...out]
}

/** Rang zwischen 0 und 1, Gleichstand mittelt. Ein Einzelner steht oben. */
function raenge(werte: number[]): number[] {
  const n = werte.length
  if (n <= 1) return werte.map(() => 1)
  const sortiert = [...werte].sort((x, y) => x - y)
  return werte.map(v => {
    const erst = sortiert.indexOf(v)
    const letzt = sortiert.lastIndexOf(v)
    return (erst + letzt) / 2 / (n - 1)
  })
}

interface Gast {
  s: SortStay
  iv: Iv
  nights: number
  score: number
  wishes: string[]
  /** Gruppenmitglieder in derselben Zimmergruppe, die sich zeitlich ueberschneiden. */
  mates: number[]
}

/**
 * Verteilt die beweglichen Aufenthalte neu. Gibt nur die Zuege zurueck, die
 * etwas aendern; `fixed` und Zimmer anderer Gruppen bleiben unberuehrt.
 */
export function sortRooms(rooms: SortRoom[], stays: SortStay[], weights: RoomSortWeights): SortResult {
  const result: SortResult = { moves: [], unplaced: [], costBefore: 0, costAfter: 0 }
  const raumNach = new Map(rooms.map(r => [r.id, r]))

  // Belegung, die sich nicht bewegt: Sperren und feste Aufenthalte.
  const fest = new Map<number, Iv[]>(rooms.map(r => [r.id, r.blocked.map(b => ({ a: tag(b.from), d: tag(b.to) }))]))
  for (const s of stays) {
    if (!s.fixed || s.resourceId === null) continue
    fest.get(s.resourceId)?.push({ a: tag(s.arrival), d: tag(s.departure) })
  }

  const gruppen = new Map<number, SortStay[]>()
  for (const s of stays) {
    if (s.fixed) continue
    // Liegt ein beweglicher Gast in einem Zimmer einer anderen Gruppe, ist
    // das ein Upgrade, das jemand bewusst gemacht hat: er bleibt. Der
    // Aufrufer markiert das schon; hier nur als Sicherung.
    if (s.resourceId !== null && raumNach.get(s.resourceId)?.categoryId !== s.categoryId) {
      fest.get(s.resourceId)?.push({ a: tag(s.arrival), d: tag(s.departure) })
      continue
    }
    const l = gruppen.get(s.categoryId) ?? []
    l.push(s)
    gruppen.set(s.categoryId, l)
  }

  for (const [categoryId, liste] of gruppen) {
    const zimmer = rooms.filter(r => r.categoryId === categoryId)
    if (zimmer.length === 0) {
      result.unplaced.push(...liste.filter(s => s.resourceId === null).map(s => s.id))
      continue
    }
    const r = sortiereGruppe(zimmer, liste, fest, weights)
    result.moves.push(...r.moves)
    result.unplaced.push(...r.unplaced)
    result.costBefore += r.costBefore
    result.costAfter += r.costAfter
  }
  return result
}

function sortiereGruppe(
  zimmer: SortRoom[], liste: SortStay[], fest: Map<number, Iv[]>, w: RoomSortWeights
): SortResult {
  const qMax = Math.max(...zimmer.map(z => z.quality))
  const preise = liste.map(s => s.pricePerNightCent)
  const bekannt = preise.filter((p): p is number => p !== null)
  const schnitt = bekannt.length > 0 ? bekannt.reduce((a, b) => a + b, 0) / bekannt.length : null
  const preisRang = raenge(bekannt)
  const naechte = liste.map(s => Math.max(1, tag(s.departure) - tag(s.arrival)))
  const naechteRang = raenge(naechte)

  let k = 0
  const gaeste: Gast[] = liste.map((s, i) => {
    const rp = s.pricePerNightCent === null ? 0.5 : preisRang[k++]!
    return {
      s, iv: { a: tag(s.arrival), d: tag(s.departure) }, nights: naechte[i]!,
      score: (w.pricePercent * rp + (100 - w.pricePercent) * naechteRang[i]!) / 100,
      wishes: wishesFromText(s.text, w), mates: []
    }
  })
  gaeste.forEach((g, i) => {
    gaeste.forEach((h, j) => {
      if (i !== j && g.s.bookingId === h.s.bookingId && overlaps(g.iv, h.iv)) g.mates.push(j)
    })
  })

  const kostenEinzeln = (g: Gast, z: SortRoom): number => {
    let c = g.nights * (g.score + 0.05) * (qMax - z.quality)
    if (schnitt !== null && g.s.pricePerNightCent !== null && z.quality >= w.topRoomQuality
        && g.s.pricePerNightCent <= schnitt - w.cheapGuestMarginCent) {
      c += w.topRoomPenalty * g.nights
    }
    for (const a of g.wishes) if (!z.attributes.includes(a)) c += w.wishPenalty * g.nights
    if (z.attributes.includes(w.smallRoomAttribute) && g.nights >= w.smallRoomFromNights) {
      c += w.smallRoomPenalty * g.nights * (g.nights - (w.smallRoomFromNights - 1))
    }
    if (g.s.resourceId !== null && g.s.resourceId !== z.id) c += w.movePenalty
    return c
  }
  const kostenPaar = (x: SortRoom, y: SortRoom): number => {
    let c = 0
    if ((x.building ?? '') !== (y.building ?? '')) c += w.groupBuildingPenalty
    c += w.groupQualityPenalty * Math.abs(x.quality - y.quality)
    const ex = etage(x.floor)
    const ey = etage(y.floor)
    if (ex !== null && ey !== null) c += w.groupFloorPenalty * Math.abs(ex - ey)
    const nx = nummer(x.code)
    const ny = nummer(y.code)
    if (nx !== null && ny !== null) c += Math.min(w.groupNumberPenaltyMax, Math.abs(nx - ny))
    return c
  }

  type Plan = Array<SortRoom | null>
  const beitrag = (plan: Plan, i: number, ohne?: number): number => {
    const z = plan[i]
    if (z === null || z === undefined) return UNPLACED
    let c = kostenEinzeln(gaeste[i]!, z)
    for (const j of gaeste[i]!.mates) {
      const y = plan[j]
      if (j !== ohne && y !== null && y !== undefined) c += kostenPaar(z, y)
    }
    return c
  }
  const gesamt = (plan: Plan): number => {
    let c = 0
    plan.forEach((z, i) => {
      if (z === null) { c += UNPLACED; return }
      c += kostenEinzeln(gaeste[i]!, z)
      // Jedes Paar einmal.
      for (const j of gaeste[i]!.mates) if (j > i && plan[j] !== null) c += kostenPaar(z, plan[j]!)
    })
    return c
  }

  const frei = (plan: Plan, i: number, z: SortRoom, ausser: number[] = []): boolean => {
    const iv = gaeste[i]!.iv
    if (fest.get(z.id)?.some(b => overlaps(b, iv))) return false
    for (let j = 0; j < plan.length; j++) {
      if (j === i || ausser.includes(j) || plan[j] !== z) continue
      if (overlaps(gaeste[j]!.iv, iv)) return false
    }
    return true
  }

  const nachId = new Map(zimmer.map(z => [z.id, z]))
  const vorher: Plan = gaeste.map(g => (g.s.resourceId === null ? null : nachId.get(g.s.resourceId)!))

  /*
   * Der bisherige Stand ist nicht immer zulaessig: zwei Aufenthalte im
   * selben Zimmer (aus einem Import, von Hand ueberbucht) oder ein Gast in
   * einem gesperrten Zimmer. Dann sortiert diese Gruppe nicht -- ein
   * Sortierer, der eine Doppelbelegung still aufloest, verschiebt dabei
   * einen Gast, von dem die Rezeption nichts weiss.
   */
  const vorherZulaessig = vorher.every((z, i) => z === null || frei(vorher, i, z))
  const costBefore = gesamt(vorher)
  if (!vorherZulaessig) {
    return { moves: [], unplaced: gaeste.filter(g => g.s.resourceId === null).map(g => g.s.id),
             costBefore, costAfter: costBefore }
  }

  const ordnung = gaeste.map((_, i) => i).sort((x, y) => {
    const a = gaeste[x]!
    const b = gaeste[y]!
    return b.score - a.score || b.nights - a.nights || a.iv.a - b.iv.a || a.s.id - b.s.id
  })

  /** Engste Luecke zum Nachbarn im Zimmer: so bleiben grosse Luecken verkaeuflich. */
  const luecke = (plan: Plan, i: number, z: SortRoom): number => {
    const iv = gaeste[i]!.iv
    let best = 10_000
    const alle = [...(fest.get(z.id) ?? []), ...gaeste.filter((_, j) => plan[j] === z).map(g => g.iv)]
    for (const o of alle) {
      if (o.d <= iv.a) best = Math.min(best, iv.a - o.d)
      if (o.a >= iv.d) best = Math.min(best, o.a - iv.d)
    }
    return best
  }

  const gierig = (): Plan => {
    const plan: Plan = gaeste.map(() => null)
    for (const i of ordnung) {
      let bestZ: SortRoom | null = null
      let bestK = Infinity
      let bestL = Infinity
      for (const z of zimmer) {
        if (!frei(plan, i, z)) continue
        plan[i] = z
        const kz = beitrag(plan, i)
        plan[i] = null
        const lz = luecke(plan, i, z)
        if (kz < bestK - 1e-9 || (Math.abs(kz - bestK) <= 1e-9
            && (lz < bestL || (lz === bestL && bestZ !== null
                && (z.quality > bestZ.quality
                    || (z.quality === bestZ.quality && z.code.localeCompare(bestZ.code, 'de', { numeric: true }) < 0)))))) {
          bestZ = z
          bestK = kz
          bestL = lz
        }
      }
      plan[i] = bestZ
    }
    return plan
  }

  /** Wie ein Plan an der Tafel: nach Anreise, ins Zimmer mit der engsten Luecke davor. */
  const nachAnreise = (): Plan => {
    const plan: Plan = gaeste.map(() => null)
    const reihe = gaeste.map((_, i) => i).sort((x, y) => gaeste[x]!.iv.a - gaeste[y]!.iv.a
      || gaeste[y]!.iv.d - gaeste[x]!.iv.d)
    for (const i of reihe) {
      let bestZ: SortRoom | null = null
      let bestL = Infinity
      for (const z of zimmer) {
        if (!frei(plan, i, z)) continue
        const l = luecke(plan, i, z)
        if (l < bestL) { bestZ = z; bestL = l }
      }
      plan[i] = bestZ
    }
    return plan
  }

  /** Wer vorher ein Zimmer hatte, muss eines behalten. */
  const vollstaendig = (plan: Plan): boolean => plan.every((z, i) => z !== null || vorher[i] === null)

  // Die Ablage im bisherigen Stand unterbringen, wo noch etwas frei ist.
  const vorherErgaenzt: Plan = [...vorher]
  for (const i of ordnung) {
    if (vorherErgaenzt[i] !== null) continue
    let bestZ: SortRoom | null = null
    let bestK = Infinity
    for (const z of zimmer) {
      if (!frei(vorherErgaenzt, i, z)) continue
      vorherErgaenzt[i] = z
      const kz = beitrag(vorherErgaenzt, i)
      vorherErgaenzt[i] = null
      if (kz < bestK) { bestZ = z; bestK = kz }
    }
    vorherErgaenzt[i] = bestZ
  }

  let plan = vorherErgaenzt
  let kosten = gesamt(plan)
  for (const kandidat of [gierig(), nachAnreise()]) {
    if (!vollstaendig(kandidat)) continue
    const k2 = gesamt(kandidat)
    if (k2 < kosten - 1e-9) { plan = kandidat; kosten = k2 }
  }
  plan = [...plan]

  // Verbessern: umsetzen und tauschen, solange es billiger wird.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let besser = false
    for (let i = 0; i < gaeste.length; i++) {
      const alt = plan[i]
      if (alt === null || alt === undefined) continue
      // `beitrag` traegt die Paare mit den Gruppenmitgliedern schon.
      const altK = beitrag(plan, i)
      let bestZ = alt
      let bestK = altK
      for (const z of zimmer) {
        if (z === alt || !frei(plan, i, z)) continue
        plan[i] = z
        const kz = beitrag(plan, i)
        plan[i] = alt
        if (kz < bestK - 1e-9) { bestZ = z; bestK = kz }
      }
      if (bestZ !== alt) { plan[i] = bestZ; besser = true }
    }
    for (let i = 0; i < gaeste.length; i++) {
      for (let j = i + 1; j < gaeste.length; j++) {
        const zi = plan[i] ?? null
        const zj = plan[j] ?? null
        if (zi === null || zj === null || zi === zj || !overlaps(gaeste[i]!.iv, gaeste[j]!.iv)) continue
        if (!frei(plan, i, zj, [j]) || !frei(plan, j, zi, [i])) continue
        const vorK = gesamtTeil(plan, i, j)
        plan[i] = zj
        plan[j] = zi
        const nachK = gesamtTeil(plan, i, j)
        if (nachK < vorK - 1e-9) { besser = true } else { plan[i] = zi; plan[j] = zj }
      }
    }
    if (!besser) break
  }

  /** Kosten von zwei Gaesten samt ihren Paaren, das Paar zwischen beiden einmal. */
  function gesamtTeil(p: Plan, i: number, j: number): number {
    return beitrag(p, i) + beitrag(p, j, i)
  }

  const costAfter = gesamt(plan)
  const moves: SortMove[] = []
  const unplaced: number[] = []
  plan.forEach((z, i) => {
    const g = gaeste[i]!
    if (z === null) { unplaced.push(g.s.id); return }
    if (z.id !== g.s.resourceId) moves.push({ stayId: g.s.id, fromRoomId: g.s.resourceId, toRoomId: z.id })
  })
  return { moves, unplaced, costBefore, costAfter }
}
