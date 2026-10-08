import { configureStore } from '@reduxjs/toolkit'

import gameInProgress, { gameInProgressActions, type SavedGame } from '@/redux/gameInProgressSlice'
import { SOLITAIRE_GAME_IDS, type SolitaireGameId } from '@/stores/statsTypes'

// Test-only stand-in for '@/redux/store' in game-screen tests: a store holding just the real saved-games
// slice, so the real stores/gameInProgress module (debounce, flush, load, clear) runs against it without
// pulling in the app's whole store and every package its reducers come from. Wire it with
//   jest.mock('@/redux/store', () => require('<relative path>/testUtils/gameInProgressStore').storeModule)
// Lives outside __tests__ because jest runs every file under there as a suite.
const store = configureStore({ reducer: { gameInProgress }, middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false, immutableCheck: false }) })

export const storeModule = { store, persistor: { flush: () => Promise.resolve() } }

/** Drops every game's save. */
export function resetGameInProgress(): void {
  SOLITAIRE_GAME_IDS.forEach((id) => store.dispatch(gameInProgressActions[id].setSaved(null)))
}

/** Starts a test from `saved` as `gameId`'s only save, JSON round-tripped like a save read back after a
 * relaunch (so an older save shape behaves exactly as it would in the app). */
export function seedGameInProgress(gameId: SolitaireGameId, saved: object): void {
  resetGameInProgress()
  store.dispatch(gameInProgressActions[gameId].setSaved(JSON.parse(JSON.stringify(saved)) as SavedGame<unknown, unknown>))
}

/** What is currently stored for `gameId` (what a relaunch would resume). */
export function storedGame(gameId: SolitaireGameId): SavedGame<unknown, unknown> | null {
  return store.getState().gameInProgress[gameId].saved
}
