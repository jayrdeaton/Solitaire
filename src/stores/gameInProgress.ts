import AsyncStorage from '@react-native-async-storage/async-storage'

import { SolitaireGameId } from './statsTypes'

// One save slot per game type (not one combined blob) - the four games are never written
// concurrently from the same screen, and this avoids any cross-game read-modify-write race.
const keyFor = (gameId: SolitaireGameId) => `solitaire.game-in-progress.v1.${gameId}`

export interface SavedGame<TState> {
  state: TState
  // Undo history is deliberately not part of this: a resumed game starts with an empty undo
  // stack. moves/elapsedSeconds are kept so the resumed timer/move-counter display is correct,
  // and so "has this deal had any progress made" can be evaluated right after a resume, before any
  // new move (see components/GameChrome.tsx's warning dialog).
  moves: number
  elapsedSeconds: number
  // The variant-specific rule a deal is locked to at deal time and never re-reads from live
  // settings mid-game (Klondike's draw count, Spider's suit count) - undefined for FreeCell/
  // Pyramid, which have no such config. Kept as a plain number (not the narrower `1 | 3`/`1 | 2 |
  // 4` union) since it round-trips through JSON; each screen narrows it back on restore.
  config?: number
}

export async function loadGameInProgress<TState>(gameId: SolitaireGameId): Promise<SavedGame<TState> | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(gameId))
    return raw ? (JSON.parse(raw) as SavedGame<TState>) : null
  } catch {
    return null
  }
}

export async function saveGameInProgress<TState>(gameId: SolitaireGameId, saved: SavedGame<TState>): Promise<void> {
  await AsyncStorage.setItem(keyFor(gameId), JSON.stringify(saved))
}

export async function clearGameInProgress(gameId: SolitaireGameId): Promise<void> {
  await AsyncStorage.removeItem(keyFor(gameId))
}
