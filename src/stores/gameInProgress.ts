import AsyncStorage from '@react-native-async-storage/async-storage'

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

export async function loadGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId): Promise<SavedGame<TState, TUndo> | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(gameId))
    return raw ? (JSON.parse(raw) as SavedGame<TState, TUndo>) : null
  } catch {
    return null
  }
}

export async function saveGameInProgress<TState, TUndo = UndoEntry<TState>>(gameId: SolitaireGameId, saved: SavedGame<TState, TUndo>): Promise<void> {
  await AsyncStorage.setItem(keyFor(gameId), JSON.stringify(saved))
}

export async function clearGameInProgress(gameId: SolitaireGameId): Promise<void> {
  await AsyncStorage.removeItem(keyFor(gameId))
}
