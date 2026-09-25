import AsyncStorage from '@react-native-async-storage/async-storage'
import { combineReducers, legacy_createStore as createStore } from '@reduxjs/toolkit'
import { createReturningPlayerMigrate, type GuideStorageReader } from '@tastic/hud/guide'
import { type PersistedState, persistReducer, persistStore } from 'redux-persist'

import { GUIDE_VERSION } from '@/constants/guide'
import reducer, { guideActions, LEGACY_STORAGE_KEYS, selectGuideVersionSeen } from '@/redux/guideSlice'

const REHYDRATE = 'persist/REHYDRATE'
// redux-persist's own default persistConfig version (store.ts doesn't set one).
const PERSIST_VERSION = -1

// The factory's own behavior is covered in @tastic/hud's tests. This only pins this app's binding of
// it: GUIDE_VERSION is what an existing player is stamped with, and the slice is mounted (and
// therefore rehydrated) under `guide`.
describe('guideSlice', () => {
  it('starts a fresh install as never seen, so the guide auto-shows on Home', () => {
    const state = reducer(undefined, { type: REHYDRATE, key: 'root', payload: undefined })
    expect(state.versionSeen).toBe(0)
  })

  it('stamps a player who already had a root store (otaVersion 4 or later) with the current version, so an update never nags them', () => {
    const state = reducer(undefined, { type: REHYDRATE, key: 'root', payload: { haptic: {}, sound: {}, tableColor: {} } })
    expect(state.versionSeen).toBe(GUIDE_VERSION)
  })

  it('records the version on finish or skip, and reads back from the root state under `guide`', () => {
    const state = reducer(undefined, guideActions.markSeen(GUIDE_VERSION))

    expect(state.versionSeen).toBe(GUIDE_VERSION)
    expect(selectGuideVersionSeen({ guide: state })).toBe(GUIDE_VERSION)
  })
})

function storageWith(items: Record<string, string>): GuideStorageReader & { getItem: jest.Mock } {
  return { getItem: jest.fn(async (key: string) => items[key] ?? null) }
}

// Runs store.ts's migrate on what storage held, then rehydrates the guide slice with its result, the
// same order redux-persist uses.
async function launch(persistedRoot: PersistedState, storage: GuideStorageReader) {
  const payload = await createReturningPlayerMigrate(storage, LEGACY_STORAGE_KEYS)(persistedRoot, PERSIST_VERSION)
  return reducer(undefined, { type: REHYDRATE, key: 'root', payload }).versionSeen
}

describe('LEGACY_STORAGE_KEYS', () => {
  it("lists the shipped pre-redux build's keys, every one namespaced to this app", () => {
    expect(LEGACY_STORAGE_KEYS.length).toBeGreaterThan(0)
    for (const key of LEGACY_STORAGE_KEYS) {
      expect(key).toMatch(/^solitaire\.[a-z0-9.-]+$/)
    }
    expect(new Set(LEGACY_STORAGE_KEYS).size).toBe(LEGACY_STORAGE_KEYS.length)
  })

  it('includes the saved-deal key of every one of the 11 games that build shipped, and the theme key it wrote on every launch', () => {
    expect(LEGACY_STORAGE_KEYS.filter((key) => key.startsWith('solitaire.game-in-progress.v1.'))).toHaveLength(11)
    expect(LEGACY_STORAGE_KEYS).toContain('solitaire.theme-settings.v1')
  })

  it('leaves out the much older per-game stats keys, which that build only ever read', () => {
    expect(LEGACY_STORAGE_KEYS.some((key) => key.startsWith('solitaire.stats.v1'))).toBe(false)
  })

  it.each(LEGACY_STORAGE_KEYS)('grandfathers a player from the shipped build who only has %s', async (key) => {
    expect(await launch(undefined, storageWith({ [key]: '{}' }))).toBe(GUIDE_VERSION)
  })

  it('still shows the guide on a fresh install: no root store and none of the legacy keys', async () => {
    expect(await launch(undefined, storageWith({}))).toBe(0)
  })

  it('shows the guide when the legacy read fails, rather than skipping it for a new player', async () => {
    const storage: GuideStorageReader = { getItem: () => Promise.reject(new Error('storage unavailable')) }
    expect(await launch(undefined, storage)).toBe(0)
  })

  it('passes an existing root store through untouched, without reading any legacy key', async () => {
    const storage = storageWith({ 'solitaire.settings.v1': '{}' })
    const persistedRoot = { _persist: { version: PERSIST_VERSION, rehydrated: true } }

    expect(await createReturningPlayerMigrate(storage, LEGACY_STORAGE_KEYS)(persistedRoot, PERSIST_VERSION)).toBe(persistedRoot)
    expect(storage.getItem).not.toHaveBeenCalled()
  })

  // store.ts's wiring (key 'root', no whitelist, the default reconciler, this migrate) run through real
  // redux-persist against an in-memory storage, so the grandfathered stamp is shown to land in the root
  // store and survive the next launch.
  async function launchStore(items: Record<string, string>) {
    const storage = {
      getItem: async (key: string) => items[key] ?? null,
      setItem: async (key: string, value: string) => {
        items[key] = value
      },
      removeItem: async (key: string) => {
        delete items[key]
      }
    }
    const store = createStore(persistReducer({ key: 'root', storage, timeout: 0, migrate: createReturningPlayerMigrate(storage, LEGACY_STORAGE_KEYS) }, combineReducers({ guide: reducer })))
    const persistor = persistStore(store)
    await new Promise<void>((resolve) => {
      if (persistor.getState().bootstrapped) resolve()
      else persistor.subscribe(() => persistor.getState().bootstrapped && resolve())
    })
    await persistor.flush()
    return selectGuideVersionSeen(store.getState())
  }

  it('grandfathers a shipped-build player and shows a fresh install the guide through real redux-persist', async () => {
    const shipped: Record<string, string> = { 'solitaire.game-in-progress.v1.klondike': '{}' }
    expect(await launchStore(shipped)).toBe(GUIDE_VERSION)
    // Their root store now exists and holds the stamp, so every later launch keeps it.
    expect(JSON.parse(JSON.parse(shipped['persist:root']).guide)).toEqual({ versionSeen: GUIDE_VERSION })
    expect(await launchStore(shipped)).toBe(GUIDE_VERSION)

    const fresh: Record<string, string> = {}
    expect(await launchStore(fresh)).toBe(0)
    // Closing the app with the guide unfinished still shows it next launch, even once that first
    // session has written legacy-named keys of its own (today's build still writes the theme key,
    // from inside PersistGate): the root store exists by then, so the migrate never looks.
    fresh['solitaire.theme-settings.v1'] = '{}'
    expect(await launchStore(fresh)).toBe(0)
  })
})

describe("store.ts's persistConfig", () => {
  // Importing store.ts builds the app's real store, and redux-persist then schedules its 5s rehydrate
  // failsafe (persistConfig sets no `timeout`), which would hold the Jest worker open after the suite.
  // Fake timers park it, and clearAllTimers drops it.
  let storeModule: typeof import('@/redux/store')

  beforeAll(() => {
    jest.useFakeTimers()
    storeModule = jest.requireActual<typeof import('@/redux/store')>('@/redux/store')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('mounts the guide slice under `guide`', () => {
    expect(selectGuideVersionSeen(storeModule.store.getState())).toBe(storeModule.store.getState().guide.versionSeen)
    expect(storeModule.store.getState().guide).toEqual({ versionSeen: expect.any(Number) })
  })

  it('runs the returning-player migrate over AsyncStorage and the legacy keys', async () => {
    const { persistConfig } = storeModule

    expect(await persistConfig.migrate(undefined, PERSIST_VERSION)).toBeUndefined()

    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => (key === 'solitaire.vibrate.v1' ? 'true' : null))
    expect(await persistConfig.migrate(undefined, PERSIST_VERSION)).toEqual({ _persist: { version: PERSIST_VERSION, rehydrated: false } })
  })
})
