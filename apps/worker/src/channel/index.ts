import type { ChannelAdapter } from '@hotelpms/domain'

/*
 * Die Kanaladapter je Anbieter (Migration 0198). Leer, bis der erste gebaut
 * ist: Channex (Block 2) und RoomCloud (Block 5, sobald RoomCloud seine
 * Unterlagen schickt). Ein Zugang, fuer dessen Anbieter hier nichts steht,
 * bekommt im Kanalprotokoll `channel.adapterMissing` und wird sonst in Ruhe
 * gelassen.
 *
 * Ein Adapter geht nur ueber `kanalAbruf()` (`abruf.ts`) ins Netz, zu einem
 * Ziel aus `KANAL_ZIELE`; ESLint weist ein eigenes `fetch` hier ab. Was er
 * an Buchungen liefert, bereinigt `kanalRumpfPruefen()` im Kern, nicht er.
 */
export const kanalAdapter: Partial<Record<string, ChannelAdapter>> = {}
