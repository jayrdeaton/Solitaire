import AsyncStorage from '@react-native-async-storage/async-storage'
import { AchievementsStorage, useAchievements } from '@tastic/achievements'
import { createContext, ReactNode, useCallback, useContext, useMemo } from 'react'

import { ACHIEVEMENT_CATALOG } from './achievementCatalog'
import { clearGameInProgress } from './gameInProgress'
import { useProfiles } from './profiles'
import { applyDealAbandoned, applyDealWon, applyHintUsed, getProfileStatsView } from './statsEngine'
import { legacyKeyFor, toVariantStats } from './statsLegacy'
import { AchievementDefinition, DealMetrics, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState, UnlockedAchievementsState, VariantStats } from './statsTypes'
import { DEFAULT_STATS, DEFAULT_VARIANT, isValidStats } from './statsValidation'

// Produces 'solitaire.stats' and 'solitaire.achievements'.
const STORAGE_NAMESPACE = 'solitaire'
const STATS_KEY = `${STORAGE_NAMESPACE}.stats`

// Wraps AsyncStorage so that the FIRST read of the new stats key, on an install that has never
// written one, is answered from the four legacy per-game keys this app used to write
// ('solitaire.stats.v1.<gameId>' — see stores/statsLegacy.ts). Without this, everyone's existing
// win counts, streaks and best times would silently reset to zero on upgrade.
//
// Done as a storage shim rather than through useAchievements' own `migrateStats` because that hook
// only ever reads its own key: the legacy data lives under four completely different ones, which
// is an app-specific layout the package has no business knowing about. Reads only — the legacy
// keys are never written or deleted, so a downgrade still finds them intact.
function createMigratingStorage(): AchievementsStorage {
  return {
    getItem: async (key) => {
      const existing = await AsyncStorage.getItem(key)
      if (existing !== null || key !== STATS_KEY) return existing

      const legacy = await Promise.all(SOLITAIRE_GAME_IDS.map((id) => AsyncStorage.getItem(legacyKeyFor(id))))
      if (legacy.every((blob) => blob === null)) return null

      const migrated: StatsState = { ...DEFAULT_STATS, variants: { ...DEFAULT_STATS.variants } }
      SOLITAIRE_GAME_IDS.forEach((id, i) => {
        const parsed = toVariantStats(legacy[i])
        if (parsed) migrated.variants[id] = parsed
      })
      return JSON.stringify(migrated)
    },
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key)
  }
}

interface GameStatsContextValue {
  stats: StatsState
  unlockedAchievements: UnlockedAchievementsState
  loaded: boolean
  // Called the instant a deal is won; `metrics` is the elapsed time/moves/score the screen
  // already shows.
  recordDealWon: (variant: SolitaireGameId, metrics: DealMetrics) => AchievementDefinition[]
  // Called the instant the player confirms the "start a new game" warning dialog over a deal that
  // was still in progress (see components/GameChrome.tsx).
  recordDealAbandoned: (variant: SolitaireGameId) => void
  // Called the instant the Hint button actually produces a hint (not on a press that finds
  // nothing to suggest) - see engine/hint.ts's findHint.
  recordHintUsed: (variant: SolitaireGameId) => void
  resetAll: () => void
  removeProfileStats: (profileId: string) => void
}

const GameStatsContext = createContext<GameStatsContextValue | null>(null)

// A stored blob may predate a game id that has since been added (e.g. Yukon) - `variants[id]` is
// then `undefined` entirely, not just missing bestMoves/bestScore, so DEFAULT_VARIANT is spread in
// first as the base for a genuinely missing entry, same as emptyVariants() does for a fresh profile.
function backfillVariants(variants: Record<SolitaireGameId, VariantStats>): Record<SolitaireGameId, VariantStats> {
  return Object.fromEntries(SOLITAIRE_GAME_IDS.map((id) => [id, { ...DEFAULT_VARIANT, ...variants[id], bestMoves: variants[id]?.bestMoves ?? null, bestScore: variants[id]?.bestScore ?? null, hintsUsed: variants[id]?.hintsUsed ?? 0, winsWithoutHint: variants[id]?.winsWithoutHint ?? 0 }])) as Record<SolitaireGameId, VariantStats>
}

function profileViews(stats: StatsState): Record<string, StatsState> {
  return Object.fromEntries(Object.entries(stats.profiles).map(([profileId, bucket]) => [profileId, getProfileStatsView(bucket)]))
}

export function GameStatsProvider({ children }: { children: ReactNode }) {
  const { activeProfileId } = useProfiles()
  // Built once: a new identity each render would restart the hook's one-shot load effect.
  const storage = useMemo(() => createMigratingStorage(), [])

  const { stats, unlockedAchievements, loaded, recordOutcome, resetAll, removeProfile } = useAchievements<StatsState>({
    namespace: STORAGE_NAMESPACE,
    catalog: ACHIEVEMENT_CATALOG,
    defaultStats: DEFAULT_STATS,
    isValidStats,
    profileViews,
    storage,
    // bestMoves/bestScore are newer than the rest of VariantStats, so a blob written before this
    // change has variants that already passed isValidStats (see statsValidation.ts's tolerant
    // check for these two fields) but genuinely lack the keys — backfill them here, device-wide
    // and inside every profile's own bucket, rather than resetting anything to defaults.
    migrateStats: (stored) => ({
      ...stored,
      variants: backfillVariants(stored.variants),
      profiles: Object.fromEntries(Object.entries(stored.profiles ?? {}).map(([id, p]) => [id, { ...p, variants: backfillVariants(p.variants) }])),
      firstGameResult: stored.firstGameResult ?? null
    })
  })

  const recordDealWon = useCallback(
    (variant: SolitaireGameId, metrics: DealMetrics) => {
      const result = recordOutcome((prev) => applyDealWon(prev, variant, metrics, activeProfileId))
      // Solitaire is single-player: whatever the active profile unlocked is the same person the
      // device-wide unlocks belong to, so both lists are surfaced together rather than separately.
      return [...result.device, ...(activeProfileId ? (result.profiles[activeProfileId] ?? []) : [])]
    },
    [recordOutcome, activeProfileId]
  )

  const recordDealAbandoned = useCallback(
    (variant: SolitaireGameId) => {
      recordOutcome((prev) => applyDealAbandoned(prev, variant, activeProfileId))
    },
    [recordOutcome, activeProfileId]
  )

  const recordHintUsed = useCallback(
    (variant: SolitaireGameId) => {
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

  // Wraps the package's own resetAll (which only knows about its own two AsyncStorage keys) so
  // "Reset Stats" also drops any resumable saves - leaving one behind after an explicit full reset
  // would be the more surprising outcome.
  const resetAllAndProgress = useCallback(() => {
    resetAll()
    SOLITAIRE_GAME_IDS.forEach((id) => clearGameInProgress(id))
  }, [resetAll])

  const value = useMemo(
    () => ({
      stats,
      unlockedAchievements,
      loaded,
      recordDealWon,
      recordDealAbandoned,
      recordHintUsed,
      resetAll: resetAllAndProgress,
      removeProfileStats
    }),
    [stats, unlockedAchievements, loaded, recordDealWon, recordDealAbandoned, recordHintUsed, resetAllAndProgress, removeProfileStats]
  )

  return <GameStatsContext.Provider value={value}>{children}</GameStatsContext.Provider>
}

export function useGameStats() {
  const ctx = useContext(GameStatsContext)
  if (!ctx) throw new Error('useGameStats must be used within a GameStatsProvider')
  return ctx
}
