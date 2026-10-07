import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, ReactNode, useContext, useMemo, useRef } from 'react'

import { SolitaireGameId } from './statsTypes'

const KEY = 'solitaire.last-active-game.v1'

export async function loadLastActiveGame(): Promise<SolitaireGameId | null> {
  try {
    return (await AsyncStorage.getItem(KEY)) as SolitaireGameId | null
  } catch {
    return null
  }
}

async function persistLastActiveGame(gameId: SolitaireGameId | null): Promise<void> {
  try {
    if (gameId === null) {
      await AsyncStorage.removeItem(KEY)
    } else {
      await AsyncStorage.setItem(KEY, gameId)
    }
  } catch {
    // Best effort: the worst case is a cold launch that lands on the menu instead of resuming.
  }
}

interface LastActiveGameContextValue {
  /** Returns the game a cold launch should drop the player straight back onto (once), or null. */
  consumeResumeGame: () => SolitaireGameId | null
  setLastActiveGame: (gameId: SolitaireGameId) => void
  clearLastActiveGame: () => void
}

const LastActiveGameContext = createContext<LastActiveGameContextValue | null>(null)

/** Which game screen the player is currently on, persisted so a cold launch/relaunch can drop them
 * straight back onto it (see app/index.tsx) instead of the main menu - independent of whether that
 * game still has a resumable board (see stores/gameInProgress.ts). Seeded from a pre-loaded
 * `initialValue` (see _layout.tsx's splash-gate loader).
 *
 * Deliberately NOT React state. The only thing that ever needed the live value was Home's resume
 * Redirect, and that is a one-shot cold-launch decision - so exposing it as state made every set/clear
 * (each game mount, each Home tap) re-render every consumer, and made every Home instance in the
 * stack swap its whole menu tree for a Redirect and back (tearing down and rebuilding ~370 SVG preview
 * cards on each transition). The value handed out here is stable for the provider's whole lifetime;
 * `pendingResume` is consumed by the first Home to mount and cleared by any set/clear, so a launch
 * straight into a game (deep link) can never later resume a stale one. */
export function LastActiveGameProvider({ initialValue, children }: { initialValue: SolitaireGameId | null; children: ReactNode }) {
  const pendingResume = useRef<SolitaireGameId | null>(initialValue)
  // What storage currently holds, so an unchanged value is never rewritten: every game mount sets it and
  // every exit clears it (twice on a Home tap - the tap itself and the screen's unmount cleanup).
  const persisted = useRef<SolitaireGameId | null>(initialValue)

  const value = useMemo<LastActiveGameContextValue>(
    () => ({
      consumeResumeGame: () => {
        const game = pendingResume.current
        pendingResume.current = null
        return game
      },
      setLastActiveGame: (gameId) => {
        pendingResume.current = null
        if (persisted.current === gameId) return
        persisted.current = gameId
        persistLastActiveGame(gameId)
      },
      // Called from each game screen's unmount cleanup and from the Home button's own tap - it fires
      // on a Home tap, hardware back, or a browser back, but not on mere app backgrounding, where the
      // screen stays mounted. That's exactly "explicitly back out."
      clearLastActiveGame: () => {
        pendingResume.current = null
        if (persisted.current === null) return
        persisted.current = null
        persistLastActiveGame(null)
      }
    }),
    []
  )

  return <LastActiveGameContext.Provider value={value}>{children}</LastActiveGameContext.Provider>
}

export function useLastActiveGame(): LastActiveGameContextValue {
  const ctx = useContext(LastActiveGameContext)
  if (!ctx) throw new Error('useLastActiveGame must be used within a LastActiveGameProvider')
  return ctx
}
