import { createSettingsSlice } from '@rific/core'

import type { Settings } from '@/types'

// The persisted settings: a Redux slice like every other persisted value in this app, read and
// written only through hooks/useSettings.ts. Built on @rific/core's createSettingsSlice: `initialize`
// in 'merge' mode is the single write path (setSettings' partial patch), and its REHYDRATE handling
// fills any field added after a player's settings were saved from DEFAULT_SETTINGS, so no
// validation or migration is needed.
export const DEFAULT_SETTINGS: Settings = {
  klondikeDraw: 1,
  spiderSuits: 1,
  canfieldDraw: 3,
  golfRankWrap: false,
  tripeaksRankWrap: false,
  scorpionAssistedStock: true,
  fortyThievesRunMoves: false,
  autoMoveToFoundation: true,
  dimUnplayable: true,
  cardStyle: 'compact',
  cardBackStyle: 'geometric',
  invertDarkModeColors: false,
  lockOrientation: false,
  reduceMotion: false
}

const { actions, reducer } = createSettingsSlice<Settings, 'merge', never>('settings', {
  initialState: DEFAULT_SETTINGS,
  initializeMode: 'merge',
  fieldSetters: []
})

export const settingsActions = actions
export default reducer
