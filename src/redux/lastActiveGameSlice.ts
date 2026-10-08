import { createSettingsSlice } from '@rific/core'

import type { SolitaireGameId } from '@/stores/statsTypes'

// The game screen the player was last on, so a cold launch can drop them straight back onto it. Read
// once and written only through stores/lastActiveGame.tsx, which deliberately never subscribes to it
// (see that file's doc for why).
export type LastActiveGameState = { gameId: SolitaireGameId | null }

const { actions, reducer } = createSettingsSlice<LastActiveGameState>('lastActiveGame', { initialState: { gameId: null } })

export const lastActiveGameActions = actions
export default reducer
