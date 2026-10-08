import AsyncStorage from '@react-native-async-storage/async-storage'
import { combineReducers } from '@reduxjs/toolkit'
import { createSettingsSlice } from '@rific/core'
import { persistReducer } from 'redux-persist'

import type { UndoEntry } from '@/games/shared/undoTypes'
import { SOLITAIRE_GAME_IDS, type SolitaireGameId } from '@/stores/statsTypes'

// TUndo defaults to the shared UndoEntry<TState> shape (a nullable MoveInfo), matching most
// games' own undo stack type. FreeCell/Golf/TriPeaks/Yukon instantiate UndoEntry<TState, MoveInfo>
// locally (their moves are never null) and pass that as TUndo explicitly; Pyramid's undo entries
// carry an extra removedCards field and pass its own local type instead. All are plain data (no
// refs/functions/Animated values), so every shape persists through redux-persist as-is.
export interface SavedGame<TState, TUndo = UndoEntry<TState>> {
  state: TState
  // Optional: restoreGame() falls back to an empty undo stack when it is missing.
  undoStack?: TUndo[]
  // moves/elapsedSeconds are kept so the resumed timer/move-counter display is correct, and so
  // "has this deal had any progress made" can be evaluated right after a resume, before any new
  // move (see components/GameChrome.tsx's warning dialog).
  moves: number
  elapsedSeconds: number
  // The variant-specific rule a deal is locked to at deal time and never re-reads from live
  // settings mid-game (Klondike's draw count, Spider's suit count) - undefined for games with no
  // such config. Kept as a plain number (not a narrower union); each screen narrows it back on restore.
  config?: number
}

export type GameInProgressSlot = { saved: SavedGame<unknown, unknown> | null }

// One slot per game, each persisted under its OWN redux-persist key (`persist:gameInProgress.<id>`),
// never the root store's: a save holds the whole board plus an undo stack that embeds a full board
// per entry (~1MB after 300 Klondike moves, several MB for a long Spider game). Separate keys mean a
// move rewrites only that game's entry, not the whole store, and no single AsyncStorage entry ever
// holds more than one game (Android's AsyncStorage can't read back an entry past ~2MB). store.ts
// blacklists `gameInProgress` from the root persistConfig, and its serializability check skips it.
// Read and written only through stores/gameInProgress.ts, which coalesces writes; no component
// subscribes to these slots, so a save never re-renders anything.
const slots = Object.fromEntries(SOLITAIRE_GAME_IDS.map((id) => [id, createSettingsSlice<GameInProgressSlot>(`gameInProgress/${id}`, { initialState: { saved: null } })])) as Record<SolitaireGameId, ReturnType<typeof createSettingsSlice<GameInProgressSlot>>>

export const gameInProgressActions = Object.fromEntries(SOLITAIRE_GAME_IDS.map((id) => [id, slots[id].actions])) as Record<SolitaireGameId, (typeof slots)[SolitaireGameId]['actions']>

export default combineReducers(Object.fromEntries(SOLITAIRE_GAME_IDS.map((id) => [id, persistReducer({ key: `gameInProgress.${id}`, storage: AsyncStorage, timeout: 0 }, slots[id].reducer)])) as Record<SolitaireGameId, ReturnType<typeof persistReducer<GameInProgressSlot>>>)
