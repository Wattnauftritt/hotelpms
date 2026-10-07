import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { addDays, legacyReplaceDays, legacyTaskState, parseLegacyStaffExport,
         LegacyStaffFormatError, type LegacyStaffExport } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { can, propertyIds, type Principal } from '../platform/context.js'

/**
 * Altdaten der alten Personal-App uebernehmen (Aufgabe 18, Baustein 9;
 * Dokument 34, Migration 0114).
 *
 * Ein Aufruf fuer Trockenlauf und Uebernahme, wie beim KWHotel-Import: ohne
 * `commit` wird nur gerechnet und berichtet, mit `commit` in derselben
 * Transaktion geschrieben -- ganz oder gar nicht.
 *
 * **Jeder Tag des Ausschnitts wird ersetzt,** nicht ergaenzt: die Alt-App
 * loescht hart, und ein Folgeexport kann eine geloeschte Zeile nur dadurch
 * mitteilen, dass sie fehlt. Ersetzt wird nur, was aus der Alt-App kam
 * (`source = 'legacy'`); was in StayGrid geplant oder eingetragen wurde,
 * gewinnt, und ein abgeschlossener Monat bleibt unberuehrt.
 *
 * **Eine Datei, mehrere Haeuser.** Die alte App fuehrt Hotel und Gaestehaus
 * in einem Plan (Zimmer 1-35, 601-605, "Bad"), StayGrid als zwei Haeuser.
 * Jede Putzplanzeile geht deshalb in das Haus, das die Zimmernummer
 * traegt: zuerst das Haus, in dem hochgeladen wird, sonst ein anderes Haus
 * desselben Betriebs, in dem die Leitung ebenfalls `worktime:manage` hat.
 * Gibt es die Nummer dort mehrmals, ist sie nicht zuzuordnen und steht im
 * Bericht. Zusatzarbeiten haben kein Zimmer und bleiben im Haus des
 * Hochladens; ebenso die Zuordnung der Benutzernamen.
 *
 * Eine Nummer kann auch ein Reinigungsbereich sein (0116) -- das "Bad" ist
 * keines der Zimmer, sondern ein Bereich des Gaestehauses.
 */

/** Rund fuenf Jahre; die Alt-App laeuft seit 2025. */
const MAX_TAGE = 1900

interface Body {
  data?: unknown
  /** Alt-Benutzername -> Person in StayGrid; `null` heisst bewusst nicht uebernehmen. */
  mapping?: Record<string, number | null>
  commit?: boolean
}

interface Person { userId: number; name: string; username: string | null }

export interface StaffImportReport {
  dryRun: boolean
  exportedAt: string
  since: string | null
  until: string
  days: { from: string; to: string; replaced: number; closed: number } | null
  staff: Array<{ username: string; displayName: string | null; status: string
                 userId: number | null; decided: boolean; schedules: number; workEntries: number }>
  candidates: Person[]
  schedules: { total: number; imported: number; unmapped: number; unknownRoom: number
               staygrid: number; closed: number }
  workEntries: { total: number; imported: number; unmapped: number; closed: number
                 translations: number }
  unknownRooms: string[]
  /** Wie viele Putzplanzeilen in welches Haus gingen. */
  houses: Array<{ propertyId: number; name: string; schedules: number }>
}

/** Ein Ziel einer Putzplanzeile: Zimmer oder Bereich, in einem Haus. */
interface Ziel { propertyId: number; resourceId: number | null; areaId: number | null }
const zielSchluessel = (z: { resourceId: number | null; areaId: number | null }): string =>
  z.areaId !== null ? `a${z.areaId}` : `r${z.resourceId}`

async function personen(client: PoolClient, propertyId: number): Promise<Person[]> {
  const { rows } = await client.query<Person>(
    `SELECT DISTINCT u.id::int AS "userId", u.display_name AS name, u.username
       FROM user_property_role r JOIN app_user u ON u.id = r.user_id
      WHERE r.property_id = ANY (staff_houses($1))
      ORDER BY u.display_name`, [propertyId])
  return rows
}

/**
 * Zuordnung: was die Leitung jetzt sagt, sonst was gespeichert ist, sonst
 * derselbe Benutzername im Haus als Vorschlag. Nur Personen dieses Hauses --
 * die Zeilenrichtlinie trennt Mandanten, nicht Haeuser.
 */
async function zuordnung(
  client: PoolClient, propertyId: number, e: LegacyStaffExport, eingabe: Body['mapping'],
  kandidaten: Person[]
): Promise<Map<string, { userId: number | null; decided: boolean }>> {
  const imHaus = new Set(kandidaten.map(k => k.userId))
  const gespeichert = await client.query<{ legacy_username: string; user_id: number | null }>(
    `SELECT legacy_username, user_id::int FROM staff_legacy_user WHERE property_id = $1`,
    [propertyId])
  const alt = new Map(gespeichert.rows.map(r => [r.legacy_username, r.user_id]))
  const namen = new Set([...e.staff.map(s => s.username),
    ...e.schedules.flatMap(s => s.username === null ? [] : [s.username]),
    ...e.workEntries.map(w => w.username)])
  const ergebnis = new Map<string, { userId: number | null; decided: boolean }>()
  for (const n of namen) {
    if (eingabe !== undefined && Object.hasOwn(eingabe, n)) {
      const u = eingabe[n]
      if (u !== null && (!Number.isInteger(u) || !imHaus.has(u!))) {
        throw Errors.validation({ mapping: ['staffImport.notInProperty'] }, { username: n })
      }
      ergebnis.set(n, { userId: u ?? null, decided: true })
    } else if (alt.has(n)) {
      ergebnis.set(n, { userId: alt.get(n)!, decided: true })
    } else {
      const gleich = kandidaten.find(k => k.username !== null
        && k.username.toLowerCase() === n.toLowerCase())
      ergebnis.set(n, { userId: gleich?.userId ?? null, decided: false })
    }
  }
  return ergebnis
}

async function uebernehmen(
  client: PoolClient, propertyId: number, andere: number[], ich: number | null,
  e: LegacyStaffExport, body: Body
): Promise<StaffImportReport> {
  const kandidaten = await personen(client, propertyId)
  const wer = await zuordnung(client, propertyId, e, body.mapping, kandidaten)
  const bereich = legacyReplaceDays(e)

  const tage: string[] = []
  if (bereich !== null) {
    for (let d = bereich.from; d <= bereich.to; d = addDays(d, 1)) {
      tage.push(d)
      if (tage.length > MAX_TAGE) throw Errors.rangeTooLarge(MAX_TAGE)
    }
  }
  // Die Haeuser, in die Putzplanzeilen gehen koennen: dieses zuerst, dann
  // die anderen desselben Betriebs (siehe oben).
  const haeuserQ = await client.query<{ id: number; name: string }>(
    `SELECT p.id::int, p.name FROM property p
      WHERE p.id = ANY($2::bigint[])
        AND p.account_id = (SELECT account_id FROM property WHERE id = $1)
      ORDER BY p.id = $1 DESC, p.name`, [propertyId, [propertyId, ...andere]])
  const haeuser = haeuserQ.rows
  const hausIds = haeuser.map(h => h.id)

  const zu = await client.query<{ k: string }>(
    `SELECT property_id || '|' || to_char(month, 'YYYY-MM') AS k FROM staff_month_close
      WHERE property_id = ANY($1::bigint[]) AND reopened_at IS NULL`, [hausIds])
  const geschlossen = new Set(zu.rows.map(r => r.k))
  const offenIn = (haus: number, d: string): boolean => !geschlossen.has(`${haus}|${d.slice(0, 7)}`)
  const offen = (d: string): boolean => offenIn(propertyId, d)
  const offeneTage = tage.filter(offen)
  const offeneTageJeHaus = new Map(hausIds.map(h => [h, tage.filter(d => offenIn(h, d))]))

  const ziele = await client.query<Ziel & { code: string }>(
    `SELECT property_id::int AS "propertyId", id::int AS "resourceId", NULL::int AS "areaId", code
       FROM resource WHERE property_id = ANY($1::bigint[])
     UNION ALL
     SELECT property_id::int, NULL, id::int, code
       FROM cleaning_area WHERE property_id = ANY($1::bigint[])`, [hausIds])
  const jeNummer = new Map<string, Array<Ziel & { code: string }>>()
  for (const z of ziele.rows) jeNummer.set(z.code, [...(jeNummer.get(z.code) ?? []), z])
  const zielVon = (code: string): Ziel | undefined => {
    const alle = jeNummer.get(code) ?? []
    const hier = alle.filter(z => z.propertyId === propertyId)
    if (hier.length === 1) return hier[0]
    return hier.length === 0 && alle.length === 1 ? alle[0] : undefined
  }
  // Was in StayGrid selbst steht, gewinnt -- je Zimmer und Tag, gleich
  // welche Art: eine Abreise aus der Alt-App neben einem Bleiber aus
  // StayGrid waere ein Widerspruch, kein Plan.
  const eigene = await client.query<{ k: string }>(
    `SELECT CASE WHEN area_id IS NULL THEN 'r' || resource_id ELSE 'a' || area_id END
              || '|' || business_date AS k
       FROM housekeeping_task
      WHERE property_id = ANY($1::bigint[]) AND source <> 'legacy'
        AND business_date = ANY($2::date[]) AND kind IN ('departure','stayover')`,
    [hausIds, tage])
  const belegt = new Set(eigene.rows.map(r => r.k))

  const r: StaffImportReport = {
    dryRun: body.commit !== true, exportedAt: e.exportedAt, since: e.since, until: e.until,
    days: bereich === null ? null
      : { ...bereich, replaced: offeneTage.length, closed: tage.length - offeneTage.length },
    staff: [], candidates: kandidaten,
    schedules: { total: e.schedules.length, imported: 0, unmapped: 0, unknownRoom: 0,
                 staygrid: 0, closed: 0 },
    workEntries: { total: e.workEntries.length, imported: 0, unmapped: 0, closed: 0,
                   translations: 0 },
    unknownRooms: [],
    houses: haeuser.map(h => ({ propertyId: h.id, name: h.name, schedules: 0 }))
  }
  const unbekannt = new Set<string>()
  const jeName = new Map<string, { schedules: number; workEntries: number }>()
  const zaehle = (n: string, k: 'schedules' | 'workEntries'): void => {
    const z = jeName.get(n) ?? { schedules: 0, workEntries: 0 }
    z[k]++
    jeName.set(n, z)
  }

  const aufgaben: Array<Ziel & { date: string; kind: string; userId: number | null
                                 status: string; outcome: string | null; minutes: number }> = []
  for (const s of e.schedules) {
    if (s.username !== null) zaehle(s.username, 'schedules')
    const z = zielVon(s.room)
    if (z === undefined) { r.schedules.unknownRoom++; unbekannt.add(s.room); continue }
    if (!offenIn(z.propertyId, s.date)) { r.schedules.closed++; continue }
    if (belegt.has(`${zielSchluessel(z)}|${s.date}`)) { r.schedules.staygrid++; continue }
    const userId = s.username === null ? null : wer.get(s.username)?.userId ?? null
    // Eine zugeteilte Zeile ohne Person waere eine Reinigung ohne Kraft --
    // und bei "gereinigt" eine Minute, die niemandem gehoert.
    if (s.username !== null && userId === null) { r.schedules.unmapped++; continue }
    // Ein Bereich wird wie ein Abreisezimmer gereinigt (0116), gleich wie
    // die alte App die Zeile fuehrte.
    aufgaben.push({ ...z, date: s.date, kind: z.areaId !== null ? 'departure' : s.kind, userId,
                    ...legacyTaskState(s.status), minutes: s.minutes })
    r.houses.find(h => h.propertyId === z.propertyId)!.schedules++
  }
  const eintraege: Array<{ userId: number; date: string; text: string; minutes: number
                           language: string | null; translationDe: string | null
                           manual: boolean }> = []
  for (const w of e.workEntries) {
    zaehle(w.username, 'workEntries')
    if (!offen(w.date)) { r.workEntries.closed++; continue }
    const userId = wer.get(w.username)?.userId ?? null
    if (userId === null) { r.workEntries.unmapped++; continue }
    eintraege.push({ userId, date: w.date, text: w.text, minutes: w.minutes,
                     language: w.language, translationDe: w.translationDe,
                     manual: w.translationManual })
  }
  r.schedules.imported = aufgaben.length
  r.workEntries.imported = eintraege.length
  r.workEntries.translations = eintraege.filter(x => x.translationDe !== null
    && x.language !== 'de').length
  r.unknownRooms = [...unbekannt].sort().slice(0, 50)
  const bekannt = new Map(e.staff.map(s => [s.username, s]))
  r.staff = [...wer.entries()].map(([username, z]) => ({
    username, displayName: bekannt.get(username)?.displayName ?? null,
    status: bekannt.get(username)?.status ?? 'unknown', userId: z.userId, decided: z.decided,
    ...(jeName.get(username) ?? { schedules: 0, workEntries: 0 })
  })).sort((a, b) => a.username.localeCompare(b.username))

  if (body.commit !== true) return r

  // Was aus der Alt-App kam, faellt fuer die offenen Tage weg und kommt neu
  // -- in jedem Haus, in das die Datei Zimmer schickt, mit dessen eigenen
  // abgeschlossenen Monaten.
  for (const [haus, offenHier] of offeneTageJeHaus) {
    await client.query(
      `DELETE FROM housekeeping_task
        WHERE property_id = $1 AND source = 'legacy' AND business_date = ANY($2::date[])`,
      [haus, offenHier])
  }
  await client.query(
    `DELETE FROM staff_text_translation tr USING staff_work_entry w
      WHERE tr.source_kind = 'work_entry' AND tr.source_id = w.id
        AND w.property_id = $1 AND w.source = 'legacy' AND w.business_date = ANY($2::date[])`,
    [propertyId, offeneTage])
  await client.query(
    `DELETE FROM staff_text_job j USING staff_work_entry w
      WHERE j.source_kind = 'work_entry' AND j.source_id = w.id
        AND w.property_id = $1 AND w.source = 'legacy' AND w.business_date = ANY($2::date[])`,
    [propertyId, offeneTage])
  await client.query(
    `DELETE FROM staff_work_entry
      WHERE property_id = $1 AND source = 'legacy' AND business_date = ANY($2::date[])`,
    [propertyId, offeneTage])

  if (aufgaben.length > 0) {
    await client.query(
      `INSERT INTO housekeeping_task (property_id, resource_id, area_id, business_date, kind,
                                      assigned_to, status, outcome, minutes, source, done_by,
                                      done_at)
       SELECT a.property_id, a.resource_id, a.area_id, a.date, a.kind, a.user_id, a.status,
              a.outcome, a.minutes, 'legacy', CASE WHEN a.outcome = 'cleaned' THEN a.user_id END,
              CASE WHEN a.status = 'done' THEN a.date::timestamptz END
         FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::date[], $5::text[],
                     $6::bigint[], $7::text[], $8::text[], $9::int[])
              AS a(property_id, resource_id, area_id, date, kind, user_id, status, outcome,
                   minutes)`,
      [aufgaben.map(a => a.propertyId), aufgaben.map(a => a.resourceId),
       aufgaben.map(a => a.areaId), aufgaben.map(a => a.date),
       aufgaben.map(a => a.kind), aufgaben.map(a => a.userId), aufgaben.map(a => a.status),
       aufgaben.map(a => a.outcome), aufgaben.map(a => a.minutes)])
  }
  if (eintraege.length > 0) {
    const neu = await client.query<{ id: number; user_id: number; date: string
                                     description: string }>(
      `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind, description,
                                     minutes, source)
       SELECT $1, x.user_id, x.date, 'extra', x.text, x.minutes, 'legacy'
         FROM unnest($2::bigint[], $3::date[], $4::text[], $5::int[])
              AS x(user_id, date, text, minutes)
       RETURNING id::int, user_id::int, business_date::text AS date, description`,
      [propertyId, eintraege.map(x => x.userId), eintraege.map(x => x.date),
       eintraege.map(x => x.text), eintraege.map(x => x.minutes)])
    // Zugeordnet ueber Person, Tag und Text, nicht ueber die Reihenfolge:
    // die sagt RETURNING nicht zu. Zwei gleiche Texte am selben Tag haben
    // dieselbe Uebersetzung.
    const schluessel = (u: number, d: string, t: string): string => `${u}|${d}|${t}`
    const uebersetzt = new Map(eintraege.filter(x => x.translationDe !== null && x.language !== 'de')
      .map(x => [schluessel(x.userId, x.date, x.text), x]))
    const ue = neu.rows.flatMap(row => {
      const x = uebersetzt.get(schluessel(row.user_id, row.date, row.description))
      return x === undefined ? []
        : [{ id: row.id, text: x.text, lang: x.language, de: x.translationDe!, manual: x.manual }]
    })
    if (ue.length > 0) {
      await client.query(
        `INSERT INTO staff_text_translation (property_id, source_kind, source_id, source_hash,
                                             source_lang, lang, text, origin, updated_by)
         SELECT $1, 'work_entry', u.id, digest(u.quelle, 'sha256'), u.sprache, 'de', u.de,
                CASE WHEN u.manual THEN 'manual' ELSE 'machine' END, NULL
           FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::boolean[])
                AS u(id, quelle, sprache, de, manual)`,
        [propertyId, ue.map(u => u.id), ue.map(u => u.text), ue.map(u => u.lang),
         ue.map(u => u.de), ue.map(u => u.manual)])
    }
  }
  const entschieden = [...wer.entries()].filter(([, z]) => z.decided || z.userId !== null)
  if (entschieden.length > 0) {
    await client.query(
      `INSERT INTO staff_legacy_user (property_id, legacy_username, user_id, updated_by)
       SELECT $1, n, u, $4 FROM unnest($2::text[], $3::bigint[]) AS x(n, u)
       ON CONFLICT (property_id, legacy_username) DO UPDATE
         SET user_id = EXCLUDED.user_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [propertyId, entschieden.map(([n]) => n), entschieden.map(([, z]) => z.userId), ich])
  }
  return r
}

export function staffImportRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/staff-import',
    permission: 'worktime:manage',
    propertyParam: 'propertyId',
    summary: 'Putzplan und Zusatzarbeiten aus der alten Personal-App uebernehmen',
    // Drei Jahre Putzplan eines Hauses sind gut 1 MB JSON.
    bodyLimit: 16 * 1024 * 1024,
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as Body
      if (body.data === undefined) throw Errors.validation({ data: ['field.required'] })
      if (body.mapping !== undefined
          && (typeof body.mapping !== 'object' || body.mapping === null)) {
        throw Errors.validation({ mapping: ['field.required'] })
      }
      let e: LegacyStaffExport
      try {
        e = parseLegacyStaffExport(body.data)
      } catch (e) {
        // Die Meldung ist der Schluessel (`LegacyStaffFormatError`).
        if (e instanceof LegacyStaffFormatError) throw Errors.unprocessable(e.message, e.params)
        throw e
      }
      const principal = req.principal as Principal
      const andere = propertyIds(principal)
        .filter(id => id !== propertyId && can(principal, 'worktime:manage', id))
      return tx(req.pool, req, client =>
        uebernehmen(client, propertyId, andere, principal.userId, e, body))
    }
  })
}
