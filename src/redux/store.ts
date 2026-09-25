import AsyncStorage from '@react-native-async-storage/async-storage'
import { combineReducers, configureStore, type Middleware } from '@reduxjs/toolkit'
import { defaultSoundSettings, hapticReducer, soundReducer, type SoundSettings } from '@rific/feedback-press'
import { createReturningPlayerMigrate } from '@tastic/hud/guide'
import { profilesReducer } from '@tastic/profile'
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from 'redux-persist'

import activeProfile from './activeProfileSlice'
import guide, { LEGACY_STORAGE_KEYS } from './guideSlice'
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
  haptic: hapticReducer,
  sound: appSoundReducer,
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
  // a Settings field, so it survives Reset Stats and never touches the hand-rolled settings store.
  // See guideSlice.ts's own doc.
  guide
})

export const persistConfig = {
  key: 'root',
  storage: AsyncStorage,
  // Grandfathers players from the shipped pre-redux builds (last one 25532f0, otaVersion 3) past the
  // guide: they have no root store yet, only that build's own keys, which would otherwise look like a
  // fresh install. A no-op once a root store exists. See LEGACY_STORAGE_KEYS in guideSlice.ts.
  migrate: createReturningPlayerMigrate(AsyncStorage, LEGACY_STORAGE_KEYS)
}

const persistedReducer = persistReducer(persistConfig, rootReducer)

export const store = configureStore({
  middleware: (getDefaultMiddleware) => {
    const defaultMiddleware = getDefaultMiddleware({
      immutableCheck: false,
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
      }
    })
    return defaultMiddleware.concat(errorMiddleware)
  },
  reducer: persistedReducer
})

export const persistor = persistStore(store)
export type RootState = ReturnType<typeof rootReducer>
export type AppDispatch = typeof store.dispatch
