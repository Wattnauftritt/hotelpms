import type { FastifyRequest } from 'fastify'
import { Errors } from './errors.js'
import { can, type Principal } from './context.js'

/**
 * Was die Routen des Gaesteterminals gemeinsam brauchen (Dokument 31).
 *
 * Zwei Pruefungen, die nicht am Recht allein haengen duerfen:
 */

/**
 * Nur ein gekoppeltes Geraet. Das Recht `terminal:device` allein genuegt
 * nie -- es koennte eines Tages in einer Rolle landen, und dann hielte nur
 * noch diese Zeile.
 */
export function geraetVon(req: FastifyRequest): {
  deviceId: number; propertyId: number; propertyIds: number[] } {
  const p = req.principal as Principal
  if (p.terminalDeviceId === null) throw Errors.forbidden('terminal.deviceOnly')
  const haeuser = [...p.permissionsByProperty.keys()]
  const haus = haeuser[0]
  if (haus === undefined) throw Errors.forbidden('terminal.deviceOnly')
  // `propertyId` ist das Haus des Geraets, der Master: Seiten, Diashow und
  // Wachzeit kommen nur von dort. `propertyIds` nimmt die Haeuser dazu, die
  // das Geraet mitnutzen (Migration 0103) -- fuer das, was zu deren
  // Auftraegen gehoert.
  return { deviceId: p.terminalDeviceId, propertyId: haus, propertyIds: haeuser }
}

/**
 * Das Recht im Haus des Vorgangs, nicht in irgendeinem.
 *
 * Die Routen der Rezeption nehmen eine Reservierung oder einen Auftrag
 * entgegen und keine Property -- das Seitenfenster der Reservierung kennt
 * sein Haus nicht. `registerRoute` prueft das Recht dann nur "in
 * irgendeinem Haus"; bei zwei Haeusern im Account genuegte das Recht in
 * Haus A fuer einen Vorgang in Haus B. Deshalb hier noch einmal, am Haus
 * der gefundenen Zeile.
 */
export function pruefeHaus(req: FastifyRequest, propertyId: number): void {
  if (!can(req.principal as Principal, 'reservation:checkin', propertyId)) {
    throw Errors.forbidden('access.missingPermission',
      { permission: 'reservation:checkin' })
  }
}
