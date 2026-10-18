import { type Action, configureStore, type Dispatch } from '@reduxjs/toolkit'
import { unlockedKey } from '@tastic/achievements'
import { act, renderHook } from '@testing-library/react-native'
import { ReactNode } from 'react'
import { Provider } from 'react-redux'

import achievements, { achievementsActions } from '@/redux/achievementsSlice'
import playerSettings, { type PlayerSettings, playerSettingsActions } from '@/redux/playerSettingsSlice'
import recentWins, { recentWinsActions } from '@/redux/recentWinsSlice'
import { DEFAULT_SETTINGS } from '@/redux/settingsSlice'
import tableColor, { tableColorActions } from '@/redux/tableColorSlice'
import { clearProfileGamesInProgress } from '@/stores/gameInProgress'
import { GameStatsProvider, useGameStats } from '@/stores/gameStats'
import { usePlayerData } from '@/stores/playerData'
import type { StatsState } from '@/stores/statsTypes'
import { DEFAULT_PROFILE_STATS, DEFAULT_STATS } from '@/stores/statsValidation'

// Saved games are covered by gameInProgress.test.ts; here only that the right player's are dropped.
jest.mock('@/stores/gameInProgress', () => ({ clearProfileGamesInProgress: jest.fn(), clearAllGamesInProgress: jest.fn() }))
let mockActiveProfileId: string | null = null
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfileId: mockActiveProfileId }) }))

const KID = 'profile-kid'
const DAD = 'profile-dad'
const played = { ...DEFAULT_PROFILE_STATS, currentDayStreak: 3 }
const settingsOf = (klondikeDraw: 1 | 3): PlayerSettings => ({ settings: { ...DEFAULT_SETTINGS, klondikeDraw }, sound: { enabled: true }, haptic: { vibrate: true }, keepAwake: { enabled: true }, theme: { appearance: 'system', blur: true } })

async function setup() {
  const store = configureStore({ reducer: { achievements, playerSettings, tableColor, recentWins }, middleware: (getDefault) => getDefault({ serializableCheck: false }) })
  const stats: StatsState = { ...DEFAULT_STATS, currentDayStreak: 5, profiles: { [KID]: played, [DAD]: played } }
  store.dispatch(achievementsActions.update({ stats, unlocked: { [unlockedKey('first_win', null)]: 1, [unlockedKey('first_win', KID)]: 2, [unlockedKey('first_win', DAD)]: 3 } }))
  // @tastic/profile's action creators type their actions without RTK's index signature.
  ;(store.dispatch as Dispatch<Action>)(playerSettingsActions.set({ id: KID, extension: settingsOf(1) }))
  store.dispatch(tableColorActions.setColor({ id: KID, color: '#abcdef' }))
  store.dispatch(tableColorActions.setColor({ id: DAD, color: '#123456' }))
  store.dispatch(recentWinsActions.add({ player: KID, variant: 'klondike', win: { score: 400, moves: 150, seconds: 250 } }))
  store.dispatch(recentWinsActions.add({ player: DAD, variant: 'klondike', win: { score: 300, moves: 120, seconds: 180 } }))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <GameStatsProvider>{children}</GameStatsProvider>
    </Provider>
  )
  const { result } = await renderHook(() => ({ ...usePlayerData(), ...useGameStats() }), { wrapper })
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
    // Their par starts over, on expert par.
    expect(store.getState().recentWins).toEqual({ [DAD]: { klondike: [{ score: 300, moves: 120, seconds: 180 }] } })
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
    expect(store.getState().recentWins[KID]).toBeUndefined()
    expect(store.getState().tableColor.profileColors).toEqual({ [DAD]: '#123456' })
  })
})

describe("a player's par", () => {
  const metrics = (moves: number, seconds: number) => ({ moves, seconds, score: moves + seconds, usedHint: false })

  afterEach(() => {
    mockActiveProfileId = null
  })

  it('measures a win against the par from before it, then keeps it', async () => {
    mockActiveProfileId = KID
    const { store, result } = await setup()

    await act(() => void result.current.recordDealWon('klondike', metrics(140, 230)))

    // Kid's one earlier win was 400; the new one is measured against that, not against itself.
    expect(result.current.lastWin).toEqual({ variant: 'klondike', par: { kind: 'personal', moves: 150, seconds: 250, score: 400, goldScore: null } })
    expect(store.getState().recentWins[KID]?.klondike).toEqual([
      { score: 400, moves: 150, seconds: 250 },
      { score: 370, moves: 140, seconds: 230 }
    ])
    expect(store.getState().recentWins[DAD]?.klondike).toHaveLength(1)
  })

  it("files guest's wins under guest, measured against expert par at first", async () => {
    const { store, result } = await setup()

    await act(() => void result.current.recordDealWon('freecell', metrics(100, 150)))

    expect(result.current.lastWin?.par.kind).toBe('expert')
    expect(store.getState().recentWins.guest?.freecell).toEqual([{ score: 250, moves: 100, seconds: 150 }])
  })

  it('keeps the last 20 wins', async () => {
    const { store, result } = await setup()

    for (let i = 0; i < 25; i++) await act(() => void result.current.recordDealWon('golf', metrics(50, 100 + i)))

    const wins = store.getState().recentWins.guest?.golf ?? []
    expect(wins).toHaveLength(20)
    expect(wins[0].seconds).toBe(105)
    expect(wins[19].seconds).toBe(124)
  })

  it("Reset Stats on All Profiles drops everyone's", async () => {
    const { store, result } = await setup()

    await act(() => result.current.resetAll())

    expect(store.getState().recentWins).toEqual({})
  })
})
