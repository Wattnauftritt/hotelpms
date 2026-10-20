/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_STAYGRID_API?: string
  /** Commit, aus dem dieser Stand gebaut ist (scripts/www.mjs). */
  readonly VITE_STAYGRID_STAND?: string
  /** '1', wenn die Huelle einen Schluessel fuer Pakete traegt. */
  readonly VITE_STAYGRID_PAKET?: string
}
