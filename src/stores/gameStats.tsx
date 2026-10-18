import { useAchievements } from '@tastic/achievements'
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'

import { PlayerPar, playerParFor } from '@/engine/par'
import type { VariantId } from '@/engine/variants'
import { achievementsActions } from '@/redux/achievementsSlice'
import { GUEST_PLAYER_ID } from '@/redux/activeProfileSlice'
import { recentWinsActions, type RecentWinsState } from '@/redux/recentWinsSlice'
import type { AppDispatch, RootState } from '@/redux/store'

import { ACHIEVEMENT_CATALOG } from './achievementCatalog'
import { clearAllGamesInProgress } from './gameInProgress'
import { useProfiles } from './profiles'
import { applyDealAbandoned, applyDealWon, applyHintUsed, getProfileStatsView } from './statsEngine'
import { AchievementDefinition, DealMetrics, StatsState, UnlockedAchievementsState } from './statsTypes'

interface GameStatsContextValue {
  stats: StatsState
  unlockedAchievements: UnlockedAchievementsState
  // Called the instant a deal is won; `metrics` is the elapsed time/moves/score the screen
  // already shows.
  recordDealWon: (variant: VariantId, metrics: DealMetrics) => AchievementDefinition[]
  // Called the instant the player confirms the "start a new game" warning dialog over a deal that
  // was still in progress (see components/GameChrome.tsx).
  recordDealAbandoned: (variant: VariantId) => void
  // Called the instant the Hint button actually produces a hint (not on a press that finds
  // nothing to suggest) - see engine/hint.ts's findHint.
  recordHintUsed: (variant: VariantId) => void
  resetAll: () => void
  removeProfileStats: (profileId: string) => void
  /** Each player's latest wins in each variant, which their par is made from (redux/recentWinsSlice.ts). */
  recentWins: RecentWinsState
  /** The par the latest win was measured against (the win dialog's), taken just before that win joined the player's
   * recent wins. null until a win this session. */
  lastWin: { variant: VariantId; par: PlayerPar } | null
}

const GameStatsContext = createContext<GameStatsContextValue | null>(null)

// A store without the slice (a test's) reads as nobody's wins, with one identity so the context value stays put.
const NO_RECENT_WINS: RecentWinsState = {}

function profileViews(stats: StatsState): Record<string, StatsState> {
  return Object.fromEntries(Object.entries(stats.profiles).map(([profileId, bucket]) => [profileId, getProfileStatsView(bucket)]))
}

export function GameStatsProvider({ children }: { children: ReactNode }) {
  const { activeProfileId } = useProfiles()
  const { stats, unlockedAchievements, recordOutcome, resetAll, removeProfile } = useAchievements<StatsState, RootState>({
    catalog: ACHIEVEMENT_CATALOG,
    select: (state) => state.achievements,
    actions: achievementsActions,
    profileViews
  })

  const store = useStore<RootState>()
  const dispatch = useDispatch<AppDispatch>()
  const recentWins = useSelector((state: RootState) => state.recentWins) ?? NO_RECENT_WINS
  const [lastWin, setLastWin] = useState<GameStatsContextValue['lastWin']>(null)

  const recordDealWon = useCallback(
    (variant: VariantId, metrics: DealMetrics) => {
      const { score, moves, seconds } = metrics
      if (score !== null && moves !== null && seconds !== null) {
        // The win is measured against the player's par as it stood BEFORE this win (read from the store, not a render, so
        // it is never a win behind), and only then joins their recent wins.
        const player = activeProfileId ?? GUEST_PLAYER_ID
        setLastWin({ variant, par: playerParFor(variant, store.getState().recentWins?.[player]?.[variant] ?? []) })
        dispatch(recentWinsActions.add({ player, variant, win: { score, moves, seconds } }))
      }
      const result = recordOutcome((prev) => applyDealWon(prev, variant, metrics, activeProfileId))
      // Solitaire is single-player: whatever the active profile unlocked is the same person the
      // device-wide unlocks belong to, so both lists are surfaced together rather than separately.
      return [...result.device, ...(activeProfileId ? (result.profiles[activeProfileId] ?? []) : [])]
    },
    [recordOutcome, activeProfileId, store, dispatch]
  )

  const recordDealAbandoned = useCallback(
    (variant: VariantId) => {
      recordOutcome((prev) => applyDealAbandoned(prev, variant, activeProfileId))
    },
    [recordOutcome, activeProfileId]
  )

  const recordHintUsed = useCallback(
    (variant: VariantId) => {
      recordOutcome((prev) => applyHintUsed(prev, variant, activeProfileId))
    },
    [recordOutcome, activeProfileId]
  )

  const removeProfileStats = useCallback(
    (profileId: string) => {
      removeProfile(profileId, (prev) => {
        if (!(profileId in prev.profiles)) return prev
        const { [profileId]: _removed, ...rest } = prev.profiles
        return { ...prev, profiles: rest }
      })
    },
    [removeProfile]
  )

  // Wraps the package's own resetAll (which only knows about the achievements slice) so
  // "Reset Stats" also drops any resumable saves - leaving one behind after an explicit full reset
  // would be the more surprising outcome. Every player's, like the stats it resets, and so is every player's par.
  const resetAllAndProgress = useCallback(() => {
    resetAll()
    clearAllGamesInProgress()
    dispatch(recentWinsActions.clear())
  }, [resetAll, dispatch])

  const value = useMemo(
    () => ({
      stats,
      unlockedAchievements,
      recordDealWon,
      recordDealAbandoned,
      recordHintUsed,
      resetAll: resetAllAndProgress,
      removeProfileStats,
      recentWins,
      lastWin
    }),
    [stats, unlockedAchievements, recordDealWon, recordDealAbandoned, recordHintUsed, resetAllAndProgress, removeProfileStats, recentWins, lastWin]
  )

  return <GameStatsContext.Provider value={value}>{children}</GameStatsContext.Provider>
}

export function useGameStats() {
  const ctx = useContext(GameStatsContext)
  if (!ctx) throw new Error('useGameStats must be used within a GameStatsProvider')
  return ctx
}
