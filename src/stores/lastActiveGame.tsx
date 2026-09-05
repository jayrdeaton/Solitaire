import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, ReactNode, useContext, useState } from 'react'

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
  if (gameId === null) {
    await AsyncStorage.removeItem(KEY)
  } else {
    await AsyncStorage.setItem(KEY, gameId)
  }
}

interface LastActiveGameContextValue {
  lastActiveGame: SolitaireGameId | null
  setLastActiveGame: (gameId: SolitaireGameId) => void
  clearLastActiveGame: () => void
}

const LastActiveGameContext = createContext<LastActiveGameContextValue | null>(null)

/** Which game screen the player is currently on, so a cold launch/relaunch can drop them straight
 * back onto it (see app/index.tsx) instead of the main menu - independent of whether that game
 * still has a resumable board (see stores/gameInProgress.ts). Seeded from a pre-loaded
 * `initialValue` (see _layout.tsx's splash-gate loader), same convention as SettingsProvider. */
export function LastActiveGameProvider({ initialValue, children }: { initialValue: SolitaireGameId | null; children: ReactNode }) {
  const [lastActiveGame, setLastActiveGameState] = useState<SolitaireGameId | null>(initialValue)

  const setLastActiveGame = (gameId: SolitaireGameId) => {
    setLastActiveGameState(gameId)
    persistLastActiveGame(gameId)
  }

  // Called from each game screen's unmount cleanup - fires on a Back tap, swipe-back, or hardware
  // back (all pop the stack the same way), but not on mere app backgrounding, where the screen
  // stays mounted. That's exactly "explicitly back out."
  const clearLastActiveGame = () => {
    setLastActiveGameState(null)
    persistLastActiveGame(null)
  }

  return <LastActiveGameContext.Provider value={{ lastActiveGame, setLastActiveGame, clearLastActiveGame }}>{children}</LastActiveGameContext.Provider>
}

export function useLastActiveGame(): LastActiveGameContextValue {
  const ctx = useContext(LastActiveGameContext)
  if (!ctx) throw new Error('useLastActiveGame must be used within a LastActiveGameProvider')
  return ctx
}
