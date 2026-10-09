// First, so the @tastic/hud <-> @tastic/profile import cycle starts from hud: the '@tastic/profile' mock
// below spreads the real module, which must not be half-evaluated when hud reaches back into it.
import '@tastic/hud'

import { configureStore } from '@reduxjs/toolkit'
import { type Profile, profilesReducer, resolveInitialProfiles, useSharedProfilesSync, type UseSharedProfilesSyncOptions } from '@tastic/profile'
import { act, renderHook } from '@testing-library/react-native'
import { ReactNode } from 'react'
import { Provider } from 'react-redux'

import activeProfile from '@/redux/activeProfileSlice'
import tableColor from '@/redux/tableColorSlice'
import { ProfilesProvider, useProfiles } from '@/stores/profiles'

// The fleet's multi-seat games prune their per-seat selection against the roster with @tastic/profile's
// pruneToRoster. Solitaire's single activeProfileId does the same job inline in ProfilesProvider, in both
// places the roster is replaced wholesale: the initial reconcile and a sibling app's remote change.

jest.mock('@tastic/profile', () => ({
  ...jest.requireActual('@tastic/profile'),
  resolveInitialProfiles: jest.fn(),
  useSharedProfilesSync: jest.fn()
}))

const GUEST = '#00ff00'
// A persisted override from an earlier session, which the reconcile always replaces.
const STALE = '#123456'
const red: Profile = { id: 'red', name: 'Red', color: '#ff0000', tag: 'RED', createdAt: 1, updatedAt: 1 }
const blue: Profile = { id: 'blue', name: 'Blue', color: '#0000ff', tag: 'BLU', createdAt: 2, updatedAt: 2 }

// A store holding just the three slices ProfilesProvider reads, seeded the way a rehydrated store would be.
async function setup({ local, active, resolved }: { local: Profile[]; active: string | null; resolved: Profile[] }) {
  const store = configureStore({
    preloadedState: { activeProfile: active, profiles: local, tableColor: { guestColor: GUEST, override: STALE } },
    reducer: { activeProfile, profiles: profilesReducer, tableColor }
  })
  jest.mocked(resolveInitialProfiles).mockResolvedValue(resolved)
  const remote: { onRemoteChange: UseSharedProfilesSyncOptions['onRemoteChange'] } = { onRemoteChange: () => undefined }
  jest.mocked(useSharedProfilesSync).mockImplementation(({ onRemoteChange }) => {
    remote.onRemoteChange = onRemoteChange
    return { syncToShared: jest.fn() }
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <ProfilesProvider>{children}</ProfilesProvider>
    </Provider>
  )
  const view = await renderHook(() => useProfiles(), { wrapper })
  // The splash gate holds the consumer back until resolveInitialProfiles settles.
  await act(async () => {})
  return { store, remote, ...view }
}

describe('ProfilesProvider roster reconcile', () => {
  it('drops an active profile the resolved roster no longer has, and puts the felt back on guest', async () => {
    const { store, result } = await setup({ local: [red], active: 'red', resolved: [blue] })

    expect(store.getState().activeProfile).toBeNull()
    expect(store.getState().tableColor.override).toBe(GUEST)
    expect(result.current.activeProfile).toBeNull()
  })

  it('keeps an active profile the resolved roster still has', async () => {
    const { store, result } = await setup({ local: [red], active: 'red', resolved: [red, blue] })

    expect(store.getState().activeProfile).toBe('red')
    expect(store.getState().tableColor.override).toBe(red.color)
    expect(result.current.activeProfile).toEqual(red)
  })

  it('drops the active profile when a sibling app deleted it while this one was backgrounded', async () => {
    const { store, remote, result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue] })

    await act(async () => remote.onRemoteChange([blue]))

    expect(store.getState().profiles).toEqual([blue])
    expect(store.getState().activeProfile).toBeNull()
    expect(store.getState().tableColor.override).toBe(GUEST)
    expect(result.current.activeProfile).toBeNull()
  })

  it('leaves the active profile alone when a remote change still has it', async () => {
    const { store, remote, result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue] })

    await act(async () => remote.onRemoteChange([red]))

    expect(store.getState().profiles).toEqual([red])
    expect(store.getState().activeProfile).toBe('red')
    expect(store.getState().tableColor.override).toBe(red.color)
    expect(result.current.activeProfile).toEqual(red)
  })
})
