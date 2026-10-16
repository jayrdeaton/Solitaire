// First, so the @tastic/hud <-> @tastic/profile import cycle starts from hud: the '@tastic/profile' mock
// below spreads the real module, which must not be half-evaluated when hud reaches back into it.
import '@tastic/hud'

import { configureStore } from '@reduxjs/toolkit'
import { type Profile, profilesReducer, resolveInitialProfiles, useSharedProfilesSync, type UseSharedProfilesSyncOptions } from '@tastic/profile'
import { act, renderHook } from '@testing-library/react-native'
import { ReactNode } from 'react'
import { Provider } from 'react-redux'

import activeProfile from '@/redux/activeProfileSlice'
import tableColor, { type TableColorState } from '@/redux/tableColorSlice'
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
const PICK = '#abcdef'
const red: Profile = { id: 'red', name: 'Red', color: '#ff0000', tag: 'RED', createdAt: 1, updatedAt: 1 }
const blue: Profile = { id: 'blue', name: 'Blue', color: '#0000ff', tag: 'BLU', createdAt: 2, updatedAt: 2 }

// A store holding just the three slices ProfilesProvider reads, seeded the way a rehydrated store would be.
async function setup({ local, active, resolved, colors = { guestColor: GUEST, profileColors: {} } }: { local: Profile[]; active: string | null; resolved: Profile[]; colors?: TableColorState }) {
  const store = configureStore({
    preloadedState: { activeProfile: active, profiles: local, tableColor: colors },
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
    expect(result.current.tableColorOverride).toBe(GUEST)
    expect(result.current.activeProfile).toBeNull()
  })

  it('keeps an active profile the resolved roster still has', async () => {
    const { store, result } = await setup({ local: [red], active: 'red', resolved: [red, blue] })

    expect(store.getState().activeProfile).toBe('red')
    expect(result.current.tableColorOverride).toBe(red.color)
    expect(result.current.activeProfile).toEqual(red)
  })

  it('drops the active profile when a sibling app deleted it while this one was backgrounded', async () => {
    const { store, remote, result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue] })

    await act(async () => remote.onRemoteChange([blue]))

    expect(store.getState().profiles).toEqual([blue])
    expect(store.getState().activeProfile).toBeNull()
    expect(result.current.tableColorOverride).toBe(GUEST)
    expect(result.current.activeProfile).toBeNull()
  })

  it('leaves the active profile alone when a remote change still has it', async () => {
    const { store, remote, result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue] })

    await act(async () => remote.onRemoteChange([red]))

    expect(store.getState().profiles).toEqual([red])
    expect(store.getState().activeProfile).toBe('red')
    expect(result.current.tableColorOverride).toBe(red.color)
    expect(result.current.activeProfile).toEqual(red)
  })
})

// Each player's color pick in Solitaire is kept across relaunches (Jay, 2026-10-16); it used to last only until
// the next launch or profile switch for a profile.
describe('ProfilesProvider color picks', () => {
  it("shows a profile's pick from an earlier launch", async () => {
    const { result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue], colors: { guestColor: GUEST, profileColors: { red: PICK } } })

    expect(result.current.tableColorOverride).toBe(PICK)
  })

  it("saves a pick under the selected profile and shows each player's own on a switch", async () => {
    const { store, result } = await setup({ local: [red, blue], active: 'red', resolved: [red, blue] })

    await act(async () => result.current.setTableColorOverride(PICK))
    expect(store.getState().tableColor.profileColors).toEqual({ red: PICK })
    expect(result.current.tableColorOverride).toBe(PICK)

    await act(async () => result.current.selectProfile('blue'))
    expect(result.current.tableColorOverride).toBe(blue.color)
    await act(async () => result.current.selectProfile(null))
    expect(result.current.tableColorOverride).toBe(GUEST)
    await act(async () => result.current.selectProfile('red'))
    expect(result.current.tableColorOverride).toBe(PICK)
  })

  it("drops a profile's pick when the profile's own color is picked, in any case", async () => {
    const { store, result } = await setup({ local: [red], active: 'red', resolved: [red], colors: { guestColor: GUEST, profileColors: { red: PICK } } })

    await act(async () => result.current.setTableColorOverride(red.color.toUpperCase()))

    expect(store.getState().tableColor.profileColors).toEqual({})
    expect(result.current.tableColorOverride).toBe(red.color)
  })

  it("saves guest's pick as guest's color", async () => {
    const { store, result } = await setup({ local: [red], active: null, resolved: [red] })

    await act(async () => result.current.setTableColorOverride(PICK))

    expect(store.getState().tableColor).toEqual({ guestColor: PICK, profileColors: {} })
    expect(result.current.tableColorOverride).toBe(PICK)
  })

  it('lets a new color for the profile itself replace its pick, but keeps the pick through a rename', async () => {
    const { store, result } = await setup({ local: [red], active: 'red', resolved: [red], colors: { guestColor: GUEST, profileColors: { red: PICK } } })

    await act(async () => result.current.updateProfile('red', { name: 'Ruby', color: red.color, tag: red.tag }))
    expect(store.getState().tableColor.profileColors).toEqual({ red: PICK })

    await act(async () => result.current.updateProfile('red', { name: 'Ruby', color: '#ff8800', tag: red.tag }))
    expect(store.getState().tableColor.profileColors).toEqual({})
    expect(result.current.tableColorOverride).toBe('#ff8800')
  })

  it("shows the profile's own color from a store saved before picks were kept", async () => {
    const legacy = { guestColor: GUEST, override: '#123456' } as TableColorState
    const { result } = await setup({ local: [red], active: 'red', resolved: [red], colors: legacy })

    expect(result.current.tableColorOverride).toBe(red.color)
  })
})
