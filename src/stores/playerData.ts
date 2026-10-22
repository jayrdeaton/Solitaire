import { useMemo } from 'react'
import { useDispatch } from 'react-redux'

import { playerSettingsActions } from '@/redux/playerSettingsSlice'
import { recentWinsActions } from '@/redux/recentWinsSlice'
import type { AppDispatch } from '@/redux/store'
import { tableColorActions } from '@/redux/tableColorSlice'

import { clearProfileGamesInProgress } from './gameInProgress'
import { useGameStats } from './gameStats'

/** Everything Solitaire keeps for one player, by profile id. Resetting everyone is useGameStats' resetAll. */
export function usePlayerData(): { resetPlayer: (profileId: string) => void; forgetPlayer: (profileId: string) => void } {
  const { removeProfileStats } = useGameStats()
  const dispatch = useDispatch<AppDispatch>()
  return useMemo(() => {
    // The player's own stats bucket, their unlocked achievements, their saved deals and the wins their par is
    // made from. Guest's too, by GUEST_PLAYER_ID. The Everyone totals (every deal this phone has seen) keep their games,
    // as they keep a deleted player's.
    const resetPlayer = (profileId: string) => {
      removeProfileStats(profileId)
      clearProfileGamesInProgress(profileId)
      dispatch(recentWinsActions.forget(profileId))
    }
    return {
      resetPlayer,
      // A deleted profile: all of the above plus their settings and their color pick, since nothing could ever use
      // any of it again. A profile deleted in a sibling app leaves its data behind.
      forgetPlayer: (profileId: string) => {
        resetPlayer(profileId)
        dispatch(playerSettingsActions.remove(profileId))
        dispatch(tableColorActions.forget(profileId))
      }
    }
  }, [removeProfileStats, dispatch])
}
