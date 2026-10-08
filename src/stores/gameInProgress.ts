import { AppState } from 'react-native'

import type { UndoEntry } from '@/games/shared/undoTypes'
import { gameInProgressActions, type SavedGame } from '@/redux/gameInProgressSlice'
import { persistor, store } from '@/redux/store'

import { SolitaireGameId } from './statsTypes'

export type { SavedGame } from '@/redux/gameInProgressSlice'

// Each game's resumable board lives in its own slot of the Redux store's `gameInProgress` slice,
// persisted under its own key (see redux/gameInProgressSlice.ts). This module is the only reader and
// writer, called imperatively from the game screens (no component subscribes to the slice).
//
// Saves are coalesced: every move/undo/autoplay hands over the WHOLE board plus the whole undo stack
// (each undo entry embeds a full state snapshot, so it grows with every move - ~1MB after 300 Klondike
// moves, several MB for a long Spider game), and a foundation cascade fires dozens of moves back to
// back. Dispatching (and so persisting) each one would serialize all of that per move, so the latest
// object is just remembered and dispatched once the moves stop (SAVE_DEBOUNCE_MS), or at the latest
// SAVE_MAX_WAIT_MS after the first unsaved move during a long burst. It is also flushed straight away
// (and redux-persist made to write it) whenever the app leaves the foreground (which is what precedes a
// swipe-away kill), when a game screen unmounts (see useSaveInProgressBackstop), and before any read -
// so the only thing a hard crash can lose is the last half second of moves. Callers' `state`/`undoStack`
// values are immutable snapshots, so storing them a moment later stores exactly what was handed in (or
// something newer, never anything inconsistent).
const SAVE_DEBOUNCE_MS = 500
const SAVE_MAX_WAIT_MS = 3000

interface PendingSave {
  saved: SavedGame<unknown, unknown>
  firstAt: number
}
const pendingSaves = new Map<SolitaireGameId, PendingSave>()
const saveTimers = new Map<SolitaireGameId, ReturnType<typeof setTimeout>>()
let appStateListenerInstalled = false

function ensureFlushOnBackground() {
  if (appStateListenerInstalled) return
  appStateListenerInstalled = true
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') flushGameInProgress()
  })
}

function dispatchPending(gameId: SolitaireGameId): void {
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  const entry = pendingSaves.get(gameId)
  if (!entry) return
  pendingSaves.delete(gameId)
  store.dispatch(gameInProgressActions[gameId].setSaved(entry.saved))
}

/** Stores any coalesced save for `gameId` (or every game's, with no argument) right now, and waits for
 * redux-persist to write it. */
export async function flushGameInProgress(gameId?: SolitaireGameId): Promise<void> {
  const ids = gameId ? [gameId] : Array.from(pendingSaves.keys())
  ids.forEach(dispatchPending)
  try {
    await persistor.flush()
  } catch {
    // Best effort - a failed write only costs the resume, and there is nothing a player could do about it.
  }
}

export async function loadGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId): Promise<SavedGame<TState, TUndo> | null> {
  // A save still waiting out its debounce must land first, or this would resume a stale board.
  dispatchPending(gameId)
  return store.getState().gameInProgress[gameId].saved as SavedGame<TState, TUndo> | null
}

export function saveGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId, saved: SavedGame<TState, TUndo>): void {
  ensureFlushOnBackground()
  const now = Date.now()
  const firstAt = pendingSaves.get(gameId)?.firstAt ?? now
  pendingSaves.set(gameId, { saved: saved as SavedGame<unknown, unknown>, firstAt })
  const existing = saveTimers.get(gameId)
  if (existing) clearTimeout(existing)
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, firstAt + SAVE_MAX_WAIT_MS - now))
  saveTimers.set(
    gameId,
    setTimeout(() => dispatchPending(gameId), wait)
  )
}

export async function clearGameInProgress(gameId: SolitaireGameId): Promise<void> {
  // Drop anything still waiting to be stored first, or it would resurrect the save being cleared.
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  pendingSaves.delete(gameId)
  store.dispatch(gameInProgressActions[gameId].setSaved(null))
}
