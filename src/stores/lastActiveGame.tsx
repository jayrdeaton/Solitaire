import { createContext, ReactNode, useContext, useMemo, useRef, useState } from 'react'
import { useDispatch, useStore } from 'react-redux'

import { lastActiveGameActions } from '@/redux/lastActiveGameSlice'
import type { AppDispatch, RootState } from '@/redux/store'

import { SolitaireGameId } from './statsTypes'

interface LastActiveGameContextValue {
  /** Returns the game a cold launch should drop the player straight back onto (once), or null. */
  consumeResumeGame: () => SolitaireGameId | null
  setLastActiveGame: (gameId: SolitaireGameId) => void
  clearLastActiveGame: () => void
}

const LastActiveGameContext = createContext<LastActiveGameContextValue | null>(null)

/** Which game screen the player is currently on, persisted (the store's `lastActiveGame` slice) so a
 * cold launch/relaunch can drop them straight back onto it (see app/index.tsx) instead of the main
 * menu - independent of whether that game still has a resumable board (see stores/gameInProgress.ts).
 * Mounted inside PersistGate, so the value read once at mount is already the rehydrated one.
 *
 * Deliberately NOT React state, and never read with useSelector. The only thing that ever needed the
 * live value was Home's resume Redirect, and that is a one-shot cold-launch decision - so exposing it
 * as state made every set/clear (each game mount, each Home tap) re-render every consumer, and made
 * every Home instance in the stack swap its whole menu tree for a Redirect and back (tearing down and
 * rebuilding ~370 SVG preview cards on each transition). The value handed out here is stable for the
 * provider's whole lifetime; `pendingResume` is consumed by the first Home to mount and cleared by any
 * set/clear, so a launch straight into a game (deep link) can never later resume a stale one. */
export function LastActiveGameProvider({ children }: { children: ReactNode }) {
  const store = useStore<RootState>()
  const dispatch = useDispatch<AppDispatch>()
  // Read once, at mount (a lazy initializer, never a subscription).
  const [initial] = useState(() => store.getState().lastActiveGame.gameId)
  const pendingResume = useRef<SolitaireGameId | null>(initial)
  // What the store currently holds, so an unchanged value is never rewritten: every game mount sets it
  // and every exit clears it (twice on a Home tap - the tap itself and the screen's unmount cleanup).
  const persisted = useRef<SolitaireGameId | null>(initial)

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
        dispatch(lastActiveGameActions.setGameId(gameId))
      },
      // Called from each game screen's unmount cleanup and from the Home button's own tap - it fires
      // on a Home tap, hardware back, or a browser back, but not on mere app backgrounding, where the
      // screen stays mounted. That's exactly "explicitly back out."
      clearLastActiveGame: () => {
        pendingResume.current = null
        if (persisted.current === null) return
        persisted.current = null
        dispatch(lastActiveGameActions.setGameId(null))
      }
    }),
    [dispatch]
  )

  return <LastActiveGameContext.Provider value={value}>{children}</LastActiveGameContext.Provider>
}

export function useLastActiveGame(): LastActiveGameContextValue {
  const ctx = useContext(LastActiveGameContext)
  if (!ctx) throw new Error('useLastActiveGame must be used within a LastActiveGameProvider')
  return ctx
}
