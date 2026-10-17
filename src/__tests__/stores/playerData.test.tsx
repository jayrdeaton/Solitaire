import { type Action, configureStore, type Dispatch } from '@reduxjs/toolkit'
import { unlockedKey } from '@tastic/achievements'
import { act, renderHook } from '@testing-library/react-native'
import { ReactNode } from 'react'
import { Provider } from 'react-redux'

import achievements, { achievementsActions } from '@/redux/achievementsSlice'
import playerSettings, { type PlayerSettings, playerSettingsActions } from '@/redux/playerSettingsSlice'
import { DEFAULT_SETTINGS } from '@/redux/settingsSlice'
import tableColor, { tableColorActions } from '@/redux/tableColorSlice'
import { clearProfileGamesInProgress } from '@/stores/gameInProgress'
import { GameStatsProvider } from '@/stores/gameStats'
import { usePlayerData } from '@/stores/playerData'
import type { StatsState } from '@/stores/statsTypes'
import { DEFAULT_PROFILE_STATS, DEFAULT_STATS } from '@/stores/statsValidation'

// Saved games are covered by gameInProgress.test.ts; here only that the right player's are dropped.
jest.mock('@/stores/gameInProgress', () => ({ clearProfileGamesInProgress: jest.fn(), clearAllGamesInProgress: jest.fn() }))
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfileId: null }) }))

const KID = 'profile-kid'
const DAD = 'profile-dad'
const played = { ...DEFAULT_PROFILE_STATS, currentDayStreak: 3 }
const settingsOf = (klondikeDraw: 1 | 3): PlayerSettings => ({ settings: { ...DEFAULT_SETTINGS, klondikeDraw }, sound: { enabled: true }, haptic: { vibrate: true }, keepAwake: { enabled: true }, theme: { appearance: 'system', blur: true } })

async function setup() {
  const store = configureStore({ reducer: { achievements, playerSettings, tableColor }, middleware: (getDefault) => getDefault({ serializableCheck: false }) })
  const stats: StatsState = { ...DEFAULT_STATS, currentDayStreak: 5, profiles: { [KID]: played, [DAD]: played } }
  store.dispatch(achievementsActions.update({ stats, unlocked: { [unlockedKey('first_win', null)]: 1, [unlockedKey('first_win', KID)]: 2, [unlockedKey('first_win', DAD)]: 3 } }))
  // @tastic/profile's action creators type their actions without RTK's index signature.
  ;(store.dispatch as Dispatch<Action>)(playerSettingsActions.set({ id: KID, extension: settingsOf(1) }))
  store.dispatch(tableColorActions.setColor({ id: KID, color: '#abcdef' }))
  store.dispatch(tableColorActions.setColor({ id: DAD, color: '#123456' }))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <GameStatsProvider>{children}</GameStatsProvider>
    </Provider>
  )
  const { result } = await renderHook(() => usePlayerData(), { wrapper })
  return { store, result }
}

describe('one player at a time', () => {
  beforeEach(() => jest.mocked(clearProfileGamesInProgress).mockClear())

  it("resetting a player drops their stats, achievements and saved games, and nobody else's", async () => {
    const { store, result } = await setup()

    await act(() => result.current.resetPlayer(KID))

    const { stats, unlocked } = store.getState().achievements
    expect(stats.profiles[KID]).toBeUndefined()
    expect(stats.profiles[DAD]).toEqual(played)
    // The All Profiles totals keep every deal the phone has seen.
    expect(stats.currentDayStreak).toBe(5)
    expect(Object.keys(unlocked).sort()).toEqual([unlockedKey('first_win', null), unlockedKey('first_win', DAD)].sort())
    expect(clearProfileGamesInProgress).toHaveBeenCalledWith(KID)
    // Their settings and their color are still theirs.
    expect(store.getState().playerSettings[KID]?.settings.klondikeDraw).toBe(1)
    expect(store.getState().tableColor.profileColors?.[KID]).toBe('#abcdef')
  })

  it('forgetting a deleted player also drops their settings and their color', async () => {
    const { store, result } = await setup()

    await act(() => result.current.forgetPlayer(KID))

    expect(store.getState().achievements.stats.profiles[KID]).toBeUndefined()
    expect(clearProfileGamesInProgress).toHaveBeenCalledWith(KID)
    expect(store.getState().playerSettings[KID]).toBeUndefined()
    expect(store.getState().tableColor.profileColors).toEqual({ [DAD]: '#123456' })
  })
})
