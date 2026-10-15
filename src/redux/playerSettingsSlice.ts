import type { Action, Dispatch, Middleware } from '@reduxjs/toolkit'
import { themeActions, type ThemeSettings } from '@rific/auto-paper'
import { hapticActions, type HapticSettings, soundActions, type SoundSettings } from '@rific/feedback-press'
import { createProfileExtensionSlice, type Profile, type ProfileExtensionState } from '@tastic/profile'

import type { Settings } from '@/types'

import { activeProfileActions, GUEST_PLAYER_ID } from './activeProfileSlice'
import { settingsActions } from './settingsSlice'

// Every setting follows the player (2026-10-15, Jay: his kids want sounds and hints, he doesn't, and
// any line between "the player's" and "the phone's" would be invisible to the people using it). That is
// the whole Settings sheet: the `settings` slice (rules, play aids, card looks, Lock Orientation with its
// angle, Reduce Motion), `sound`, `haptic`, and the theme's appearance and Blur. The theme's color is
// already the player's (ProfileThemeSync). Sound can follow the player safely: the iPhone's ring/silent
// switch still mutes every game sound (@rific/feedback-press plays them as ambient audio).
//
// The live slices always hold the SELECTED player's values, so nothing that reads them changes (each
// provider bridged from them - FeedbackPressProvider, auto-paper's, the orientation lock - adopts a
// changed value, see @rific/core's createSettingsContext). This slice keeps everyone else's:
// playerSettingsMiddleware files the outgoing player's live values here and loads the incoming player's
// whenever the selection changes. A player with nothing filed (new, from a sibling app, or anyone before
// this existed) starts with the settings on screen, so picking them changes nothing. Within Solitaire
// only: these settings don't exist in the other games.
export interface PlayerSettings {
  settings: Settings
  sound: SoundSettings
  haptic: HapticSettings
  theme: Pick<ThemeSettings, 'appearance' | 'blur'>
}

const slice = createProfileExtensionSlice<PlayerSettings>('playerSettings')
export const playerSettingsActions = slice.actions
export default slice.reducer

/** The slices this middleware reads; a subset of RootState, so a test can build a small store. */
export interface PlayerSettingsState {
  activeProfile: string | null
  profiles: Profile[]
  settings: Settings
  sound: SoundSettings
  haptic: HapticSettings
  theme: Pick<ThemeSettings, 'appearance' | 'blur'>
  playerSettings: ProfileExtensionState<PlayerSettings>
}

function livePlayerSettings(state: PlayerSettingsState): PlayerSettings {
  return { settings: state.settings, sound: state.sound, haptic: state.haptic, theme: { appearance: state.theme.appearance, blur: state.theme.blur } }
}

/**
 * On every change of `activeProfile` (a pick at Home, a deletion, the self-heal when a sibling app
 * deleted the selected profile): files the live values under the player leaving (unless they are no
 * longer on the roster, i.e. just deleted), then loads the arriving player's, laid over the live values
 * so a setting added after they were filed keeps what is on screen. Nothing filed: nothing changes.
 */
// Dispatch<Action>: @tastic/profile's action creators type their actions without RTK's index signature.
export const playerSettingsMiddleware: Middleware<object, PlayerSettingsState, Dispatch<Action>> = (api) => (next) => (action) => {
  if (!activeProfileActions.select.match(action)) return next(action)

  const before = api.getState()
  const from = before.activeProfile ?? GUEST_PLAYER_ID
  const to = action.payload ?? GUEST_PLAYER_ID
  if (from === to) return next(action)
  if (from === GUEST_PLAYER_ID || before.profiles.some((p) => p.id === from)) api.dispatch(playerSettingsActions.set({ id: from, extension: livePlayerSettings(before) }))
  const result = next(action)

  const after = api.getState()
  const stored = after.playerSettings[to]
  if (!stored) return result
  // `lockedRotation` is absent while unlocked, and a merge never removes a key: name it, or the last
  // player's locked angle would stay behind.
  api.dispatch(settingsActions.initialize({ ...stored.settings, lockedRotation: stored.settings.lockedRotation }))
  api.dispatch(soundActions.initialize({ ...after.sound, ...stored.sound }))
  api.dispatch(hapticActions.initialize({ ...after.haptic, ...stored.haptic }))
  api.dispatch(themeActions.initialize(stored.theme))
  return result
}
