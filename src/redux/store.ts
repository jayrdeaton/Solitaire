import AsyncStorage from '@react-native-async-storage/async-storage'
import { combineReducers, configureStore, type Middleware } from '@reduxjs/toolkit'
import { createThemeReducer } from '@rific/auto-paper'
import { keepAwakeReducer } from '@rific/core'
import { defaultSoundSettings, hapticReducer, soundReducer, type SoundSettings } from '@rific/feedback-press'
import { createReturningPlayerMigrate } from '@tastic/hud/guide'
import { profilesReducer } from '@tastic/profile'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'

import { DEFAULT_SEED_COLOR, THEME_HARMONY } from '@/constants/theme'

import achievements from './achievementsSlice'
import activeProfile from './activeProfileSlice'
import gameInProgress from './gameInProgressSlice'
import guide, { LEGACY_STORAGE_KEYS } from './guideSlice'
import lastActiveGame from './lastActiveGameSlice'
import playerSettings, { playerSettingsMiddleware } from './playerSettingsSlice'
import settings from './settingsSlice'
import tableColor from './tableColorSlice'

const hasError = (action: unknown): action is { error?: unknown } => typeof action === 'object' && action !== null && 'error' in action && Boolean(action.error)

const errorMiddleware: Middleware = () => (next) => (action) => {
  if (!hasError(action)) return next(action)
  return action
}

// @rific/feedback-press's own soundReducer defaults `enabled` to true unconditionally (that
// default isn't published with the dev-only override yet). Wrap it so a fresh install with no
// persisted preference (redux-persist finds nothing in AsyncStorage for the `sound` key) defaults
// muted in dev/simulator builds so Claude/local testing doesn't blast audio; production builds
// still default to sound on. All actual action handling still delegates to the package's reducer.
const initialSoundSettings: SoundSettings = { ...defaultSoundSettings, enabled: !__DEV__ }
const appSoundReducer = (state: SoundSettings = initialSoundSettings, action: { type: string }): SoundSettings => soundReducer(state, action)

const rootReducer = combineReducers({
  // auto-paper's appearance/color settings, bridged into its Provider by components/Theme.tsx. Seeded
  // with DEFAULT_SEED_COLOR so a first launch paints the same color useTableColors() falls back to
  // (ProfileThemeSync then sets the active profile's own muted color in that same first commit).
  theme: createThemeReducer({ color: DEFAULT_SEED_COLOR, harmony: THEME_HARMONY }),
  // The game screen the player was last on (see stores/lastActiveGame.tsx).
  lastActiveGame,
  // Each game's resumable board, persisted under its own keys and so blacklisted below (see
  // gameInProgressSlice.ts).
  gameInProgress,
  // Stats and unlocked achievements (see achievementsSlice.ts).
  achievements,
  haptic: hapticReducer,
  sound: appSoundReducer,
  // @rific/core's Keep Awake setting (see _layout.tsx's KeepAwakeBridge), under the namespace its
  // REHYDRATE handling expects.
  keepAwake: keepAwakeReducer,
  // The shared App Group roster (see @tastic/profile's resolveInitialProfiles/
  // useSharedProfilesSync, wired in stores/profiles.tsx) is layered on top of this as a separate
  // sync target - this slice persisting normally via redux-persist, same as every other key here,
  // is what gives it local-fallback behavior for the platforms/builds where the shared store isn't
  // available, with no separate hand-rolled AsyncStorage path needed for that case.
  profiles: profilesReducer,
  // Which profile this device is playing as - always local, see activeProfileSlice.ts's own doc.
  activeProfile,
  // The live table-felt color plus guest's own remembered pick - see tableColorSlice.ts's own doc
  // for why `override` is safe to persist unconditionally despite only guest's picks being
  // meaningfully "remembered."
  tableColor,
  // Which version of the how-to-play flow this player has finished or skipped. Its own key rather than
  // a Settings field, so it survives Reset Stats.
  // See guideSlice.ts's own doc.
  guide,
  // The persisted settings (see settingsSlice.ts): the selected player's, for the ones that follow the
  // player.
  settings,
  // Every other player's settings, swapped with the live ones above (and `sound`/`haptic`) whenever the
  // selected profile changes (see playerSettingsSlice.ts).
  playerSettings
})

export const persistConfig = {
  key: 'root',
  // On web every Tastic game shares one origin (games.infinitetoken.com) and so one localStorage, where AsyncStorage
  // keeps this state under keyPrefix + key: the default prefix would make every game's state the same persist:root.
  // REHYDRATE still reports key 'root', so guideSlice's persistKey is unchanged.
  keyPrefix: 'solitaire:',
  storage: AsyncStorage,
  // Grandfathers players from the shipped pre-redux builds (last one 25532f0, otaVersion 3) past the
  // guide: they have no root store yet, only that build's own keys, which would otherwise look like a
  // fresh install. A no-op once a root store exists. See LEGACY_STORAGE_KEYS in guideSlice.ts.
  migrate: createReturningPlayerMigrate(AsyncStorage, LEGACY_STORAGE_KEYS),
  // Persisted per game under its own keys instead (see gameInProgressSlice.ts).
  blacklist: ['gameInProgress']
}

const persistedReducer = persistReducer(persistConfig, rootReducer)

export const store = configureStore({
  middleware: (getDefaultMiddleware) => {
    const defaultMiddleware = getDefaultMiddleware({
      immutableCheck: false,
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
        // Saved boards are plain data but can run to megabytes; walking them on every action in dev
        // would stall the app for nothing.
        ignoredPaths: ['gameInProgress']
      }
    })
    return defaultMiddleware.concat(errorMiddleware, playerSettingsMiddleware)
  },
  reducer: persistedReducer
})

export const persistor = persistStore(store)
export type RootState = ReturnType<typeof rootReducer>
export type AppDispatch = typeof store.dispatch
