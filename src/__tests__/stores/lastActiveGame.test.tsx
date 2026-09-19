import AsyncStorage from '@react-native-async-storage/async-storage'
import { renderHook } from '@testing-library/react-native'
import { ReactNode } from 'react'

import { LastActiveGameProvider, useLastActiveGame } from '@/stores/lastActiveGame'
import { SolitaireGameId } from '@/stores/statsTypes'

function setup(initialValue: SolitaireGameId | null) {
  const wrapper = ({ children }: { children: ReactNode }) => <LastActiveGameProvider initialValue={initialValue}>{children}</LastActiveGameProvider>
  return renderHook(() => useLastActiveGame(), { wrapper })
}

describe('LastActiveGameProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('hands the persisted game to the first consumer exactly once (a cold-launch resume is one-shot)', async () => {
    const { result } = await setup('klondike')

    expect(result.current.consumeResumeGame()).toBe('klondike')
    expect(result.current.consumeResumeGame()).toBeNull()
  })

  it('has nothing to resume when no game was active', async () => {
    const { result } = await setup(null)

    expect(result.current.consumeResumeGame()).toBeNull()
  })

  // A launch straight into a game (deep link) while storage says a different game was last active must
  // not let a later Home mount bounce the player into that stale game.
  it('drops a pending resume as soon as any game is entered', async () => {
    const setItem = jest.spyOn(AsyncStorage, 'setItem')
    const { result } = await setup('klondike')

    result.current.setLastActiveGame('spider')

    expect(setItem).toHaveBeenCalledWith('solitaire.last-active-game.v1', 'spider')
    expect(result.current.consumeResumeGame()).toBeNull()
  })

  it('drops a pending resume when the player backs out, and clears the persisted key', async () => {
    const removeItem = jest.spyOn(AsyncStorage, 'removeItem')
    const { result } = await setup('golf')

    result.current.clearLastActiveGame()

    expect(removeItem).toHaveBeenCalledWith('solitaire.last-active-game.v1')
    expect(result.current.consumeResumeGame()).toBeNull()
  })

  it('survives a failing storage write (best effort - never an unhandled rejection)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'))
    const { result } = await setup(null)

    expect(() => result.current.setLastActiveGame('pyramid')).not.toThrow()
    // Let the rejected persist settle; an unhandled rejection here would fail the run.
    await Promise.resolve()
  })

  // The whole point of the provider not being React state: every game mount/unmount and every Home tap
  // calls set/clear, and any change to the context value would re-render every consumer (each Home in the
  // stack, every game screen) - which is how going Home used to rebuild whole menus.
  it('never changes its context value across renders, so set/clear cannot re-render consumers', async () => {
    const { result, rerender } = await setup('klondike')
    const first = result.current

    result.current.setLastActiveGame('yukon')
    result.current.clearLastActiveGame()
    await rerender({})

    expect(result.current).toBe(first)
    expect(result.current.setLastActiveGame).toBe(first.setLastActiveGame)
    expect(result.current.clearLastActiveGame).toBe(first.clearLastActiveGame)
  })
})
