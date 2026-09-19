import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'

import { UndoEntry } from '@/games/shared/undoTypes'

import { SolitaireGameId } from './statsTypes'

// One save slot per game type (not one combined blob) - the games are never written concurrently
// from the same screen, and this avoids any cross-game read-modify-write race.
const keyFor = (gameId: SolitaireGameId) => `solitaire.game-in-progress.v1.${gameId}`

// TUndo defaults to the shared UndoEntry<TState> shape (a nullable MoveInfo), matching most
// games' own undo stack type. FreeCell/Golf/TriPeaks/Yukon instantiate UndoEntry<TState, MoveInfo>
// locally (their moves are never null) and pass that as TUndo explicitly; Pyramid's undo entries
// carry an extra removedCards field and pass its own local type instead. All are plain data (no
// refs/functions/Animated values), so every shape round-trips through JSON.stringify/parse as-is.
export interface SavedGame<TState, TUndo = UndoEntry<TState>> {
  state: TState
  // Optional for backward compatibility: a save written before undo persistence existed has no
  // undoStack field at all, and JSON.parse of that older shape simply leaves this `undefined` -
  // restoreGame() falls back to an empty stack in that case, same as the old always-empty behavior.
  undoStack?: TUndo[]
  // moves/elapsedSeconds are kept so the resumed timer/move-counter display is correct, and so
  // "has this deal had any progress made" can be evaluated right after a resume, before any new
  // move (see components/GameChrome.tsx's warning dialog).
  moves: number
  elapsedSeconds: number
  // The variant-specific rule a deal is locked to at deal time and never re-reads from live
  // settings mid-game (Klondike's draw count, Spider's suit count) - undefined for games with no
  // such config. Kept as a plain number (not a narrower union) since it round-trips through JSON;
  // each screen narrows it back on restore.
  config?: number
}

// Saves are coalesced: every move/undo/autoplay used to JSON.stringify the WHOLE board plus the whole undo
// stack (each undo entry embeds a full state snapshot, so the blob grows with every move - ~1MB after 300
// Klondike moves, several MB for a long Spider game) and hand it to AsyncStorage, synchronously in the
// move's own commit, and a foundation cascade fires dozens of moves back to back. Now the latest object is
// just remembered and written once the moves stop (SAVE_DEBOUNCE_MS), or at the latest SAVE_MAX_WAIT_MS
// after the first unsaved move during a long burst. It is also flushed straight away whenever the app
// leaves the foreground (which is what precedes a swipe-away kill), when a game screen unmounts (see
// useSaveInProgressBackstop), and before any read - so the only thing a hard crash can lose is the last
// half second of moves. Callers' `state`/`undoStack` values are immutable snapshots, so serializing them
// a moment later writes exactly what was handed in (or something newer, never anything inconsistent).
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

async function writePending(gameId: SolitaireGameId): Promise<void> {
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  const entry = pendingSaves.get(gameId)
  if (!entry) return
  pendingSaves.delete(gameId)
  try {
    await AsyncStorage.setItem(keyFor(gameId), JSON.stringify(entry.saved))
  } catch {
    // Best effort - a failed write only costs the resume, and there is nothing a player could do about it.
  }
}

/** Writes any coalesced save for `gameId` (or every game's, with no argument) right now. */
export async function flushGameInProgress(gameId?: SolitaireGameId): Promise<void> {
  const ids = gameId ? [gameId] : Array.from(pendingSaves.keys())
  await Promise.all(ids.map(writePending))
}

// A read started on finger-down (see preloadGameInProgress), so the AsyncStorage round trip overlaps the tap itself and
// the screen's mount instead of starting only after it. Consumed by the next load, and dropped by any save/clear.
const preloaded = new Map<SolitaireGameId, Promise<string | null>>()

/** Starts reading `gameId`'s saved board now so a load a moment later (the game screen mounting after a tap) finds it
 * already in flight. Purely an optimization: a load without one behaves exactly as before. */
export function preloadGameInProgress(gameId: SolitaireGameId): void {
  // A save still waiting out its debounce means storage is about to change; a read started now would be stale.
  if (preloaded.has(gameId) || pendingSaves.has(gameId)) return
  preloaded.set(
    gameId,
    AsyncStorage.getItem(keyFor(gameId)).catch(() => null)
  )
}

export async function loadGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId): Promise<SavedGame<TState, TUndo> | null> {
  try {
    const early = preloaded.get(gameId)
    preloaded.delete(gameId)
    // A save still waiting out its debounce must land first, or this would resume a stale board - and it makes
    // any read already in flight stale too.
    const hadPending = pendingSaves.has(gameId)
    await flushGameInProgress(gameId)
    const raw = early && !hadPending ? await early : await AsyncStorage.getItem(keyFor(gameId))
    return raw ? (JSON.parse(raw) as SavedGame<TState, TUndo>) : null
  } catch {
    return null
  }
}

export function saveGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId, saved: SavedGame<TState, TUndo>): void {
  ensureFlushOnBackground()
  preloaded.delete(gameId)
  const now = Date.now()
  const firstAt = pendingSaves.get(gameId)?.firstAt ?? now
  pendingSaves.set(gameId, { saved: saved as SavedGame<unknown, unknown>, firstAt })
  const existing = saveTimers.get(gameId)
  if (existing) clearTimeout(existing)
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, firstAt + SAVE_MAX_WAIT_MS - now))
  saveTimers.set(
    gameId,
    setTimeout(() => writePending(gameId), wait)
  )
}

export async function clearGameInProgress(gameId: SolitaireGameId): Promise<void> {
  // Drop anything still waiting to be written first, or it would resurrect the save being cleared.
  preloaded.delete(gameId)
  const timer = saveTimers.get(gameId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(gameId)
  pendingSaves.delete(gameId)
  await AsyncStorage.removeItem(keyFor(gameId))
}
