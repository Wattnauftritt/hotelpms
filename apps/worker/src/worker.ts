import { createPool, withTransaction, SYSTEM_CONTEXT, type DbContext, type Pool }
  from '@hotelpms/db'
import pino from 'pino'
import { runNightAudit } from './jobs/nightAudit.js'
import { ensureAuditPartitions, auditDefaultPartitionRows, materializeInventory,
         reconcileInventory, purgeRegistrations, purgeExpired,
         overdueNightAudits } from './jobs/maintenance.js'
import { renderPendingInvoices } from './jobs/invoiceDocument.js'
import { deliverWebhooks } from './jobs/webhookDelivery.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

// Der Worker verbindet DIREKT mit PostgreSQL, nicht ueber PgBouncer:
// LISTEN/NOTIFY kommt im Transaction Mode nie an (D1, Dokument 13).
const pool = createPool({ kind: 'direct', max: 4, applicationName: 'hotelpms-worker' })

// Zwei Verbindungen, zwei Rollen, und das mit Absicht:
//
//   pool   hotelpms_app     Die eigentliche Arbeit. Kein BYPASSRLS. Jede
//                           Arbeitseinheit laeuft im Kontext genau einer
//                           Property, damit die Zeilenrichtlinie den Worker
//                           genauso einschraenkt wie die Rezeption. Ein
//                           Programmfehler im Nachtlauf kann damit keine
//                           fremden Mandanten beruehren.
//   admin  hotelpms_owner   Nur zwei Dinge: Partitionen anlegen (DDL) und die
//                           Liste der aktiven Properties lesen. Beides ist
//                           mandantenuebergreifend und laesst sich in keiner
//                           Zeilenrichtlinie ausdruecken. Bewusst klein
//                           gehalten und nie fuer Fachdaten benutzt.
const admin = createPool({ kind: 'owner', max: 2, applicationName: 'hotelpms-worker-admin' })

/**
 * Streuung der Nachtlauf-Startzeit ueber ein Fenster, abgeleitet aus der
 * Property-ID. Sonst starten bei 500 Mandanten 500 Laeufe zur selben Minute
 * (P4, Dokument 12).
 */
export function jitterMinutes(propertyId: number, windowMinutes = 120): number {
  return (propertyId * 37) % windowMinutes
}

/** Kontext einer einzelnen Property. Kein Benutzer: das Audit-Log haelt das fest. */
export function propertyContext(accountId: number, propertyId: number): DbContext {
  return { accountIds: [accountId], propertyIds: [propertyId], userId: null }
}

interface PropertyRow { id: number; account_id: number }

async function activeProperties(): Promise<PropertyRow[]> {
  const r = await withTransaction(admin, SYSTEM_CONTEXT, c =>
    c.query<PropertyRow>(
      `SELECT id, account_id FROM property WHERE status = 'active' ORDER BY id`))
  return r.rows
}

/** Mandantenuebergreifende Pflege. Beruehrt keine Fachdaten. */
async function platformMaintenance(): Promise<void> {
  await withTransaction(admin, SYSTEM_CONTEXT, async client => {
    const created = await ensureAuditPartitions(client)
    if (created > 0) log.info({ created }, 'Audit-Partitionen angelegt')
    const stray = await auditDefaultPartitionRows(client)
    if (stray > 0) log.error({ stray }, 'ALARM: Zeilen in der Default-Partition des Audit-Logs')
  })
  // Sitzungen und Idempotenzschluessel haben keine Zeilenrichtlinie und
  // gehoeren keinem Mandanten. Die Anwendungsrolle genuegt.
  await withTransaction(pool, SYSTEM_CONTEXT, async client => {
    const purged = await purgeExpired(client)
    if (purged > 0) log.info({ purged }, 'Abgelaufene Sitzungen und Schluessel entfernt')
  })

  // Der schlimmste Ausfall ist der stille: laeuft der Nachtlauf nicht, fehlt
  // die Logis auf den Folios, und bemerkt wird es vom Gast beim Check-out.
  await withTransaction(admin, SYSTEM_CONTEXT, async client => {
    const rueckstand = await overdueNightAudits(client)
    for (const r of rueckstand) {
      log.error({ property: r.propertyId, name: r.propertyName,
                  openDate: r.openDate, daysBehind: r.daysBehind },
        r.openDate === null
          ? 'ALARM: Property hat keinen offenen Geschaeftstag'
          : 'ALARM: Nachtlauf ist im Rueckstand')
    }
  })
}

async function propertyMaintenance(p: PropertyRow): Promise<void> {
  const ctx = propertyContext(p.account_id, p.id)
  await withTransaction(pool, ctx, async client => {
    const materialized = await materializeInventory(client, p.id)
    if (materialized > 0) log.info({ property: p.id, materialized }, 'Inventar materialisiert')
    const drift = await reconcileInventory(client, p.id)
    if (drift.length > 0) {
      log.error({ property: p.id, drift: drift.slice(0, 5) },
        'ALARM: Bestandszaehler weicht von den Reservierungen ab')
    }
    const registrations = await purgeRegistrations(client, p.id)
    if (registrations > 0) {
      log.info({ property: p.id, registrations }, 'Meldescheine nach Jahresfrist vernichtet')
    }
  })

  // Eigene Transaktionen je Beleg, deshalb ausserhalb der obigen: das
  // Zeichnen eines PDF ist Rechenarbeit und hat in einer offenen
  // Datenbanktransaktion nichts verloren.
  const belege = await renderPendingInvoices(pool, ctx, p.id)
  if (belege.created > 0) {
    log.info({ property: p.id, created: belege.created, withoutXml: belege.withoutXml },
      'Rechnungsbelege erzeugt')
  }
  for (const fehler of belege.failed) {
    // Kein Beleg heisst: die Rechnung ist festgeschrieben, aber nicht
    // ausgebbar. Das faellt sonst erst dem Gast an der Rezeption auf.
    log.error({ property: p.id, invoice: fehler.invoiceId, reason: fehler.reason },
      'ALARM: Rechnungsbeleg konnte nicht erzeugt werden')
  }
  for (const luecke of belege.masterDataGaps) {
    // Am Haus, nicht an der Rechnung: ohne diese Angabe traegt **keine**
    // Rechnung dieses Hauses die elektronische Fassung, und ab dem
    // Stichtag ist sie damit gegenueber Firmenkunden nicht verkehrsfaehig.
    log.error({ property: p.id, rule: luecke.rule, key: luecke.key },
      `ALARM: Stammdaten unvollstaendig fuer ZUGFeRD. ${luecke.de}`)
  }
}

/**
 * Der Nachtlauf entscheidet selbst, ob er faellig ist: er laeuft nur, wenn
 * das Geschaeftsdatum ueber den offenen Tag hinaus ist. Der Worker muss
 * deshalb keine Uhrzeit kennen und darf beliebig oft ticken.
 */
async function nightAudit(p: PropertyRow): Promise<void> {
  const result = await runNightAudit(pool, propertyContext(p.account_id, p.id), p.id)
  if (result === null) return
  log.info({ property: p.id, businessDate: result.businessDate, steps: result.steps,
             skipped: result.skipped, checklist: result.checklist.length },
    'Nachtlauf abgeschlossen')
}

/** Faellige ausgehende Ereignisse zustellen (Aufgabe 4, Dokument 16). */
async function webhooks(p: PropertyRow): Promise<void> {
  const r = await deliverWebhooks(pool, propertyContext(p.account_id, p.id), p.id)
  if (r.attempted === 0) return
  log.info({ property: p.id, ...r }, 'Ereignisse zugestellt')
  if (r.disabled > 0) {
    log.error({ property: p.id, disabled: r.disabled },
      'ALARM: Abonnement nach dauerhaftem Fehlschlag stillgelegt')
  }
}

async function tick(): Promise<void> {
  await platformMaintenance()
  for (const p of await activeProperties()) {
    // Eine fehlerhafte Property darf die anderen nicht aufhalten.
    try {
      await propertyMaintenance(p)
      await nightAudit(p)
      await webhooks(p)
    } catch (e) {
      log.error({ property: p.id, err: e }, 'Arbeit fuer Property fehlgeschlagen')
    }
  }
}

async function main(): Promise<void> {
  log.info('hotelpms Worker gestartet')
  await tick()
  const interval = setInterval(
    () => { void tick().catch(e => log.error({ err: e }, 'Tick fehlgeschlagen')) },
    5 * 60_000)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info('Sanftes Herunterfahren')
      clearInterval(interval)
      void Promise.all([pool.end(), admin.end()]).then(() => process.exit(0))
    })
  }
}

export { runNightAudit }
export type { Pool }
await main()
