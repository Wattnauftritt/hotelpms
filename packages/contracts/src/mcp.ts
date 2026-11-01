/**
 * Der lesende Zugang fuer Claude zum Livesystem (Migration 0222, Dokument 38).
 *
 * Hier stehen die festen Groessen, die API, Dienst und Oberflaeche teilen.
 * Wer eine davon aendert, aendert die Zusage aus Dokument 38 -- die Zahlen
 * stehen dort ebenso, und die Migration prueft die beiden letzten selbst.
 */

/**
 * Die eine Kennung, unter der sich claude.ai anmeldet. Die dynamische
 * Registrierung (RFC 7591) gibt immer diese zurueck: es gibt genau einen
 * Aufrufer, und eine Tabelle voller Clients, die jeder anlegen kann, waere
 * nur eine Flaeche mehr.
 */
export const MCP_CLIENT_ID = 'staygrid-claude'

/**
 * Wohin der Code nach der Zustimmung geht. Nur claude.ai: ein Code an eine
 * fremde Adresse waere ein Token fuer Fremde, sobald jemand den Link baut
 * und die Leitung ihn arglos bestaetigt.
 */
export const MCP_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback'
]

/** Eine Verbindung gilt so lange und wird nicht verlaengert. */
export const MCP_VERBINDUNG_STUNDEN = 8
/** Eine Klartext-Freigabe gilt so lange (Migration 0222, `mcp_release_grant`). */
export const MCP_FREIGABE_MINUTEN = 60
/** Hoechstens so viele Zeilen unter einer Freigabe (`mcp_dienst.klartext_haeuser`). */
export const MCP_KLARTEXT_ZEILEN = 2000

/**
 * Aus diesem Netz ruft Anthropic fremde MCP-Server auf
 * (https://platform.claude.com/docs/en/api/ip-addresses, Stand 01.11.2026).
 * Caddy laesst den Zugang nur von dort zu (ops/caddy/Caddyfile).
 */
export const ANTHROPIC_AUSGANG = ['160.79.104.0/21'] as const

/** Zustand einer Klartext-Anfrage im Adminpanel. */
export type McpReleaseState = 'pending' | 'active' | 'denied' | 'ended' | 'expired'

export interface McpReleaseRow {
  ref: string
  propertyId: number
  propertyName: string
  accountName: string
  reason: string
  matchCode: string
  requestedAt: string
  expiresAt: string | null
  rowsUsed: number
  state: McpReleaseState
  /** Darf die angemeldete Person das freigeben (eigener Betrieb oder Support-Freigabe)? */
  allowed: boolean
}

export interface McpConnectionRow {
  ref: string
  userName: string | null
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  active: boolean
}

export interface McpCallRow {
  id: number
  at: string
  tool: string
  propertyId: number | null
  rows: number
  plaintext: boolean
  durationMs: number
  ok: boolean
  detail: string | null
}

/** `GET /v1/platform/mcp` */
export interface McpOverview {
  locked: boolean
  lockedAt: string | null
  connections: McpConnectionRow[]
  releases: McpReleaseRow[]
  calls: McpCallRow[]
}
