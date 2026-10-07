import { createPool, withTransaction, SYSTEM_CONTEXT, STAPEL_TIMEOUT_MS,
         type DbContext, type Pool }
  from '@hotelpms/db'
import pino from 'pino'
import { runNightAudit } from './jobs/nightAudit.js'
import { ensureAuditPartitions, dropOldAuditPartitions,
         auditDefaultPartitionRows, materializeInventory,
         reconcileInventory, purgeRegistrations, purgeGuestDocuments,
         completeGuestErasures, purgeExpired, redactOldEmails,
         overdueNightAudits } from './jobs/maintenance.js'
import { renderPendingInvoices } from './jobs/invoiceDocument.js'
import { deliverWebhooks } from './jobs/webhookDelivery.js'
import { runRateSteering } from './jobs/rateSteering.js'
import { deliverEmails } from './jobs/emailDelivery.js'
import { translateStaffTexts, createDeeplTranslator } from './jobs/staffTranslation.js'
import { deliverPlatformEmails, type PlatformSender } from './jobs/platformEmail.js'
import { inviteOnlineCheckins } from './jobs/onlineCheckin.js'
import { createBrevoAdapter } from './email/brevo.js'
import { parseCidrList } from '@hotelpms/domain'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

/*
 * Netze, in die ein Webhook trotz Sperrliste zugestellt werden darf
 * (Befund B1). Leer in jeder gehosteten Installation; wer selbst betreibt
 * und ein System im eigenen Netz beliefert, traegt genau dieses Netz ein.
 *
 * Gelesen beim Start, nicht je Zustellung: ein Tippfehler soll den Worker
 * anhalten, solange jemand hinsieht, und nicht Wochen spaeter als
 * ausbleibende Zustellung auffallen.
 */
const allowedWebhookCidrs = parseCidrList(process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS)
if (allowedWebhookCidrs.length > 0) {
  log.warn({ netze: allowedWebhookCidrs.length },
    'Webhook-Ziele in private Netze sind freigegeben')
}

// Der Worker verbindet DIREKT mit PostgreSQL, nicht ueber PgBouncer:
// LISTEN/NOTIFY kommt im Transaction Mode nie an (D1, Dokument 13).
/*
 * Stapelarbeit bekommt mehr Zeit je Anweisung als eine Anfrage aus der
 * Oberflaeche (Befund P8, Dokument 29).
 *
 * Dreissig Sekunden sind fuer eine Rezeption richtig -- was laenger
 * braucht, ist kaputt. Fuer den Nachtlauf eines Hauses mit 250 Zimmern
 * oder einen Jahresexport sind sie es nicht: eine einzelne Anweisung darf
 * dort laenger rechnen, und sie stuerbe sonst mitten im Lauf, der
 * daraufhin beim naechsten Tick wieder von vorn beginnt.
 */
const pool = createPool({ kind: 'direct', max: 4, applicationName: 'hotelpms-worker',
                          statementTimeoutMs: STAPEL_TIMEOUT_MS })

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
const admin = createPool({ kind: 'owner', max: 2, applicationName: 'hotelpms-worker-admin',
                           statementTimeoutMs: STAPEL_TIMEOUT_MS })

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
    const dropped = await dropOldAuditPartitions(client)
    if (dropped > 0) log.info({ dropped }, 'Protokollpartitionen jenseits der Frist entfernt')
    const stray = await auditDefaultPartitionRows(client)
    if (stray > 0) log.error({ stray }, 'ALARM: Zeilen in der Default-Partition des Audit-Logs')

    // Sitzungen, Einmaltoken und Idempotenzschluessel gehoeren keinem
    // Mandanten, das Aufraeumen laeuft deshalb hier und nicht je Haus.
    //
    // **Mit der Eigentuemerrolle**, nicht mehr mit der Anwendungsrolle: seit
    // Migration 0047 traegt `idempotency_key` eine Zeilenrichtlinie, und der
    // leere Systemkontext saehe unter ihr keine einzige Zeile. Der Job haette
    // weiter gemeldet, er habe aufgeraeumt, und nichts getan -- genau die
    // Art Fehler, die CLAUDE.md zweimal als still passiert nennt.
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
    const ausweise = await purgeGuestDocuments(client)
    if (ausweise > 0) {
      log.info({ property: p.id, ausweise },
        'Ausweisnummern nach Jahresfrist entfernt')
    }
    const vollendet = await completeGuestErasures(client)
    if (vollendet > 0) {
      log.info({ property: p.id, vollendet },
        'Aufgeschobene Loeschungen vollendet')
    }
    const geschwaerzt = await redactOldEmails(client, p.id)
    if (geschwaerzt > 0) {
      log.info({ property: p.id, emails: geschwaerzt },
        'Gastadressen im Postausgang entfernt')
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

/**
 * Automatische Preissteuerung (Dokument 32). Nach dem Nachtlauf, weil der
 * den Geschaeftstag weiterschaltet und der Lauf je Geschaeftstag einmal
 * faellig wird; vor den Webhooks, damit `rate.changed` im selben Tick
 * hinausgeht.
 */
async function rateSteering(p: PropertyRow): Promise<void> {
  // Ein Fehler hier haelt Webhooks und Gastpost des Hauses nicht auf: die
  // Preise bleiben dann, wie sie sind, und das ist der harmlose Ausfall.
  try {
    const r = await runRateSteering(pool, propertyContext(p.account_id, p.id), p.id)
    if (r.runId === null) return
    log.info({ property: p.id, businessDate: r.businessDate, run: r.runId, changed: r.changed },
      'Preissteuerung gelaufen')
  } catch (e) {
    log.error({ property: p.id, err: e }, 'ALARM: Preissteuerung fehlgeschlagen')
  }
}

/** Faellige ausgehende Ereignisse zustellen (Aufgabe 4, Dokument 16). */
async function webhooks(p: PropertyRow): Promise<void> {
  const r = await deliverWebhooks(pool, propertyContext(p.account_id, p.id), p.id,
    { allowedCidrs: allowedWebhookCidrs })
  if (r.attempted === 0) return
  log.info({ property: p.id, ...r }, 'Ereignisse zugestellt')
  if (r.disabled > 0) {
    log.error({ property: p.id, disabled: r.disabled },
      'ALARM: Abonnement nach dauerhaftem Fehlschlag stillgelegt')
  }
}

/*
 * Zugang zum Mailanbieter. Ohne Schluessel bleibt der Versand aus, statt den
 * Worker anzuhalten: der Nachtlauf ist wichtiger als die Post, und ein Haus
 * ohne Brevo-Vertrag soll trotzdem laufen. Die Nachrichten bleiben dann in
 * der Warteschlange stehen und gehen hinaus, sobald der Schluessel da ist --
 * verloren ist nichts.
 */
const brevoKey = process.env.BREVO_API_KEY ?? null
const mailer = brevoKey ? createBrevoAdapter(brevoKey) : null
if (mailer === null) {
  log.warn('BREVO_API_KEY ist nicht gesetzt: ausgehende Gastpost bleibt in der Warteschlange.')
}

/*
 * Absender der Zugangspost. Aus der Umgebung, weil diese Nachrichten zu
 * keinem Haus gehoeren -- die Gastpost holt ihren Absender aus
 * property_email_setting, hier gibt es keine Property, aus der man ihn
 * nehmen koennte.
 *
 * Ohne PLATFORM_EMAIL_FROM bleibt der Versand aus, statt auf einen
 * erfundenen Absender auszuweichen: eine Einladung von noreply@localhost
 * landet im Spam, und das faellt niemandem auf -- der Eingeladene wartet,
 * und wir sehen eine Nachricht, die der Anbieter angenommen hat.
 */
const platformFrom = process.env.PLATFORM_EMAIL_FROM ?? null
const platformSender: PlatformSender | null = platformFrom === null ? null : {
  from: { email: platformFrom, name: process.env.PLATFORM_EMAIL_FROM_NAME ?? 'StayGrid' },
  replyTo: process.env.PLATFORM_EMAIL_REPLY_TO
    ? { email: process.env.PLATFORM_EMAIL_REPLY_TO } : null
}
if (platformSender === null) {
  log.warn('PLATFORM_EMAIL_FROM ist nicht gesetzt: '
    + 'Einladungen und Kennwortruecksetzungen bleiben in der Warteschlange.')
}

/**
 * Zugangspost zustellen. Mandantenuebergreifend und deshalb genau einmal je
 * Tick, nicht je Property: eine Einladung gehoert einem Benutzer.
 */
async function platformEmails(): Promise<void> {
  if (mailer === null || platformSender === null) return
  const r = await deliverPlatformEmails(pool, SYSTEM_CONTEXT, mailer, platformSender)
  if (r.attempted === 0) return
  // Weder Empfaenger noch Betreff ins Protokoll, und schon gar nicht der
  // Rumpf: darin steht das Token, also der Zugang selbst.
  log.info(r, 'Zugangspost zugestellt')
  if (r.failed > 0) {
    log.error({ failed: r.failed },
      'ALARM: Zugangspost endgueltig nicht zustellbar -- '
      + 'der Empfaenger wartet auf einen Link, der nie kommt')
  }
}

/*
 * Basis der Oberflaeche fuer den Link im Online-Check-in. Dieselbe Variable
 * wie in der API, aus derselben Umgebungsdatei (ops/systemd). Ohne sie
 * bleibt der Versand aus, statt Links auf localhost zu verschicken.
 */
const appUrl = process.env.PUBLIC_APP_URL ?? null
if (appUrl === null) {
  log.warn('PUBLIC_APP_URL ist nicht gesetzt: kein Online-Check-in-Link vor Anreise.')
}

/** Online-Check-in-Links vor Anreise einreihen (Dokument 30). */
async function onlineCheckins(p: PropertyRow): Promise<void> {
  if (appUrl === null) return
  const r = await inviteOnlineCheckins(pool, propertyContext(p.account_id, p.id), p.id,
    { appUrl })
  // Eine Zahl, kein Gast: wer eingeladen wurde, steht im Postausgang.
  if (r.invited > 0) log.info({ property: p.id, ...r }, 'Online-Check-in-Links eingereiht')
}

/** Faellige Gastpost zustellen. */
async function emails(p: PropertyRow): Promise<void> {
  if (mailer === null) return
  const r = await deliverEmails(pool, propertyContext(p.account_id, p.id), p.id, mailer)
  if (r.attempted === 0) return
  // Kein Empfaenger und kein Betreff ins Protokoll: beides ist Gastdatum
  // (C8, Dokument 13). Die Zahlen genuegen; das Einzelne steht im
  // Postausgang, der der Zeilenrichtlinie unterliegt.
  log.info({ property: p.id, ...r }, 'Gastpost zugestellt')
  if (r.failed > 0) {
    log.error({ property: p.id, failed: r.failed },
      'ALARM: Gastpost endgueltig nicht zustellbar')
  }
}

/*
 * Uebersetzung der Personaltexte (Baustein 7). Ohne Schluessel bleiben die
 * Auftraege stehen, und jeder liest das Original -- dasselbe Verhalten wie
 * bei der Post: verloren ist nichts, nachgeholt wird mit dem Schluessel.
 */
const deeplKey = process.env.DEEPL_API_KEY ?? null
const translator = deeplKey ? createDeeplTranslator(deeplKey) : null
if (translator === null) {
  log.warn('DEEPL_API_KEY ist nicht gesetzt: Texte des Personals bleiben unuebersetzt.')
}

async function staffTexts(p: PropertyRow): Promise<void> {
  if (translator === null) return
  const r = await translateStaffTexts(pool, propertyContext(p.account_id, p.id), p.id, translator)
  if (r.attempted === 0) return
  // Zahlen, kein Text: was die Kraft geschrieben hat, gehoert nicht ins Protokoll.
  log.info({ property: p.id, ...r }, 'Personaltexte uebersetzt')
  if (r.failed > 0) {
    log.error({ property: p.id, failed: r.failed },
      'Uebersetzung endgueltig gescheitert -- das Original bleibt lesbar')
  }
}

async function tick(): Promise<void> {
  await platformMaintenance()
  // Vor der Arbeit je Property: wer auf einen Zugangslink wartet, wartet
  // sonst hinter dem Nachtlauf von fuenfhundert Haeusern.
  try {
    await platformEmails()
  } catch (e) {
    log.error({ err: e }, 'Zustellung der Zugangspost fehlgeschlagen')
  }
  for (const p of await activeProperties()) {
    // Eine fehlerhafte Property darf die anderen nicht aufhalten.
    try {
      await propertyMaintenance(p)
      await nightAudit(p)
      await rateSteering(p)
      await webhooks(p)
      // Vor der Zustellung: was hier eingereiht wird, geht im selben Tick hinaus.
      await onlineCheckins(p)
      await emails(p)
      await staffTexts(p)
    } catch (e) {
      log.error({ property: p.id, err: e }, 'Arbeit fuer Property fehlgeschlagen')
    }
  }
}

/*
 * Zugangspost hat ihren eigenen, kurzen Takt. Im Fuenf-Minuten-Tick wartete
 * eine Einladung bis zu fuenf Minuten, und wer am Telefon "ist unterwegs"
 * hoert und nach einer Minute nachsieht, findet nichts und klickt erneut.
 * Doppelt beansprucht wird nichts: claim() sperrt mit SKIP LOCKED und setzt
 * eine Frist, der Tick und dieser Takt duerfen sich ueberschneiden. Der
 * Merker verhindert nur, dass ein langsamer Anbieter Laeufe aufstaut.
 */
const PLATFORM_EMAIL_INTERVAL_MS = 15_000
let platformEmailsLaeuft = false
async function platformEmailsTakt(): Promise<void> {
  if (platformEmailsLaeuft) return
  platformEmailsLaeuft = true
  try {
    await platformEmails()
  } catch (e) {
    log.error({ err: e }, 'Zustellung der Zugangspost fehlgeschlagen')
  } finally {
    platformEmailsLaeuft = false
  }
}

async function main(): Promise<void> {
  log.info('hotelpms Worker gestartet')
  await tick()
  const interval = setInterval(
    () => { void tick().catch(e => log.error({ err: e }, 'Tick fehlgeschlagen')) },
    5 * 60_000)
  const mailInterval = setInterval(() => { void platformEmailsTakt() },
    PLATFORM_EMAIL_INTERVAL_MS)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info('Sanftes Herunterfahren')
      clearInterval(interval)
      clearInterval(mailInterval)
      void Promise.all([pool.end(), admin.end()]).then(() => process.exit(0))
    })
  }
}

export { runNightAudit }
export type { Pool }
await main()
