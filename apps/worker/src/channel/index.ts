import type { ChannelAdapter } from '@hotelpms/domain'

/*
 * Die Kanaladapter je Anbieter (Migration 0198). Leer, bis der erste gebaut
 * ist: Channex (Block 2) und RoomCloud (Block 5, sobald RoomCloud seine
 * Unterlagen schickt). Ein Zugang, fuer dessen Anbieter hier nichts steht,
 * bekommt im Kanalprotokoll `channel.adapterMissing` und wird sonst in Ruhe
 * gelassen.
 */
export const kanalAdapter: Partial<Record<string, ChannelAdapter>> = {}
