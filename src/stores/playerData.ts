import { playerSettingsActions } from '@/redux/playerSettingsSlice'
import { store } from '@/redux/store'

import { clearProfileGamesInProgress } from './gameInProgress'

/** Drops everything Solitaire keeps for one player (saved games, settings) once their profile is
 * deleted: nothing could ever use it again. A profile deleted in a sibling app leaves its data behind. */
export function forgetPlayerData(profileId: string): void {
  clearProfileGamesInProgress(profileId)
  store.dispatch(playerSettingsActions.remove(profileId))
}
