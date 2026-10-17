import { type Action, configureStore, type Dispatch } from '@reduxjs/toolkit'
import { themeActions, themeReducer } from '@rific/auto-paper'
import { keepAwakeActions, keepAwakeReducer } from '@rific/core'
import { hapticActions, hapticReducer, soundActions, soundReducer } from '@rific/feedback-press'
import { type Profile, profilesReducer } from '@tastic/profile'

import activeProfile, { activeProfileActions, GUEST_PLAYER_ID } from '@/redux/activeProfileSlice'
import playerSettings, { type PlayerSettings, playerSettingsActions, playerSettingsMiddleware } from '@/redux/playerSettingsSlice'
import settings, { DEFAULT_SETTINGS, settingsActions } from '@/redux/settingsSlice'

const dad: Profile = { id: 'profile-dad', name: 'Dad', color: '#0000ff', tag: 'DAD', createdAt: 1, updatedAt: 1 }
const kid: Profile = { id: 'profile-kid', name: 'Kid', color: '#ff0000', tag: 'KID', createdAt: 2, updatedAt: 2 }

function makeStore(preloaded: { activeProfile?: string | null; profiles?: Profile[]; playerSettings?: Record<string, PlayerSettings> } = {}) {
  return configureStore({
    preloadedState: { activeProfile: preloaded.activeProfile ?? null, profiles: preloaded.profiles ?? [dad, kid], playerSettings: preloaded.playerSettings ?? {} },
    reducer: { activeProfile, profiles: profilesReducer, settings, sound: soundReducer, haptic: hapticReducer, keepAwake: keepAwakeReducer, theme: themeReducer, playerSettings },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }).concat(playerSettingsMiddleware)
  })
}

describe('settings follow the player', () => {
  it('each player gets back every setting they left: rules, play aids, card looks, sound, haptics, Keep Awake, appearance, Blur, Reduce Motion', () => {
    const store = makeStore()
    store.dispatch(activeProfileActions.select(dad.id))
    store.dispatch(settingsActions.initialize({ klondikeDraw: 3, autoHintSeconds: 0, cardStyle: 'numeric', reduceMotion: true }))
    store.dispatch(soundActions.initialize({ enabled: false }))
    store.dispatch(hapticActions.initialize({ vibrate: false }))
    store.dispatch(keepAwakeActions.initialize({ enabled: false }))
    store.dispatch(themeActions.initialize({ appearance: 'dark', blur: false }))

    store.dispatch(activeProfileActions.select(kid.id))
    store.dispatch(settingsActions.initialize({ klondikeDraw: 1, autoHintSeconds: 15, cardStyle: 'decorated', reduceMotion: false }))
    store.dispatch(soundActions.initialize({ enabled: true }))
    store.dispatch(hapticActions.initialize({ vibrate: true }))
    store.dispatch(keepAwakeActions.initialize({ enabled: true }))
    store.dispatch(themeActions.initialize({ appearance: 'light', blur: true }))

    store.dispatch(activeProfileActions.select(dad.id))
    expect(store.getState().settings).toMatchObject({ klondikeDraw: 3, autoHintSeconds: 0, cardStyle: 'numeric', reduceMotion: true })
    expect(store.getState().sound.enabled).toBe(false)
    expect(store.getState().haptic.vibrate).toBe(false)
    expect(store.getState().keepAwake.enabled).toBe(false)
    expect(store.getState().theme).toMatchObject({ appearance: 'dark', blur: false })

    store.dispatch(activeProfileActions.select(kid.id))
    expect(store.getState().settings).toMatchObject({ klondikeDraw: 1, autoHintSeconds: 15, cardStyle: 'decorated', reduceMotion: false })
    expect(store.getState().sound.enabled).toBe(true)
    expect(store.getState().haptic.vibrate).toBe(true)
    expect(store.getState().keepAwake.enabled).toBe(true)
    expect(store.getState().theme).toMatchObject({ appearance: 'light', blur: true })
  })

  it("a lock comes back at the player's own angle, and an unlocked player doesn't inherit the last one's", () => {
    const store = makeStore()
    store.dispatch(activeProfileActions.select(kid.id))
    store.dispatch(settingsActions.initialize({ lockOrientation: true, lockedRotation: 90 }))

    store.dispatch(activeProfileActions.select(dad.id))
    store.dispatch(settingsActions.initialize({ lockOrientation: false, lockedRotation: undefined }))
    store.dispatch(activeProfileActions.select(kid.id))
    expect(store.getState().settings).toMatchObject({ lockOrientation: true, lockedRotation: 90 })

    store.dispatch(activeProfileActions.select(dad.id))
    expect(store.getState().settings.lockOrientation).toBe(false)
    expect(store.getState().settings.lockedRotation).toBeUndefined()
  })

  it('an unlocked player read back after a relaunch (no lockedRotation key at all) clears the last angle too', () => {
    // JSON drops an undefined key, so that is how an unlocked player's entry comes back from storage.
    const filed = JSON.parse(JSON.stringify({ settings: { ...DEFAULT_SETTINGS, lockedRotation: undefined }, sound: { enabled: true }, haptic: { vibrate: true }, keepAwake: { enabled: true }, theme: { appearance: 'system', blur: true } })) as PlayerSettings
    const store = makeStore({ activeProfile: kid.id, playerSettings: { [dad.id]: filed } })
    store.dispatch(settingsActions.initialize({ lockOrientation: true, lockedRotation: 90 }))

    store.dispatch(activeProfileActions.select(dad.id))

    expect(store.getState().settings.lockOrientation).toBe(false)
    expect(store.getState().settings.lockedRotation).toBeUndefined()
  })

  it('a player with nothing filed starts with the settings on screen, so picking them changes nothing', () => {
    const store = makeStore()
    store.dispatch(settingsActions.initialize({ klondikeDraw: 3, dimUnplayable: false }))
    store.dispatch(soundActions.initialize({ enabled: false }))
    const before = store.getState()

    // New, made in a sibling app, or anyone from before settings followed the player.
    store.dispatch(activeProfileActions.select(kid.id))

    expect(store.getState().settings).toEqual(before.settings)
    expect(store.getState().sound).toEqual(before.sound)
    expect(store.getState().theme).toEqual(before.theme)
    // ...and from then on they are their own.
    store.dispatch(settingsActions.initialize({ klondikeDraw: 1 }))
    store.dispatch(activeProfileActions.select(null))
    expect(store.getState().settings.klondikeDraw).toBe(3)
  })

  it('a setting added after a player was filed keeps what is on screen', () => {
    const { autoHintSeconds: _added, ...older } = DEFAULT_SETTINGS
    const filed = { settings: older as typeof DEFAULT_SETTINGS, sound: { enabled: true }, haptic: { vibrate: true }, keepAwake: { enabled: true }, theme: { appearance: 'system' as const, blur: true } }
    const store = makeStore({ playerSettings: { [kid.id]: filed } })
    store.dispatch(settingsActions.initialize({ autoHintSeconds: 30 }))

    store.dispatch(activeProfileActions.select(kid.id))

    expect(store.getState().settings.autoHintSeconds).toBe(30)
  })

  it('files Guest like any player', () => {
    const store = makeStore()
    store.dispatch(settingsActions.initialize({ spiderSuits: 4 }))
    store.dispatch(activeProfileActions.select(dad.id))
    store.dispatch(settingsActions.initialize({ spiderSuits: 1 }))

    store.dispatch(activeProfileActions.select(null))

    expect(store.getState().playerSettings[GUEST_PLAYER_ID]?.settings.spiderSuits).toBe(4)
    expect(store.getState().settings.spiderSuits).toBe(4)
  })

  it('does not file a player who was just deleted', () => {
    const store = makeStore({ activeProfile: kid.id, profiles: [dad] })
    // @tastic/profile's action creators type their actions without RTK's index signature.
    ;(store.dispatch as Dispatch<Action>)(playerSettingsActions.remove(kid.id))

    store.dispatch(activeProfileActions.select(null))

    expect(store.getState().playerSettings[kid.id]).toBeUndefined()
  })
})
