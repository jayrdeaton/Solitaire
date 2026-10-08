import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, type ViewStyle } from 'react-native'

import Achievements from '@/app/achievements'
import Profiles from '@/app/profiles'
import { safeBack } from '@/utils/navigation'

// ---------------------------------------------------------------------------------------------------------------------
// A render test of the REAL Achievements and Profiles screens (src/app/achievements.tsx, src/app/profiles.tsx): the real
// RotatedScreen/RotatedFrame/RotatedGameView, the real @tastic/core rotation math (rotateInsets / rotateDimensions /
// toRotationStyle) and the real Paper Portal.Host. Only what needs a native runtime, a store or a library screen is
// replaced (the same scaffolding as homeScreen.test.tsx):
//   - rotation, the window and the PHYSICAL safe-area insets are mutable (`mockRotation`, `mockWindow`, `mockInsets`).
//     useRotation AND useRotatedWindowDimensions are both replaced (the latter imports the former internally), and
//     react-native's useWindowDimensions - which RotatedGameView reads directly - is replaced at its module.
//   - useSafeAreaInsets reads the CONTEXT value when a provider is above it (the real SafeAreaInsetsContext, which is what
//     RotatedFrame's `rotatedSafeArea` provides) and only falls back to the physical `mockInsets` without one - so what the
//     screens see is exactly what a real device would hand them through the provider chain.
//   - @tastic/hud's BaseStatsScreen and @tastic/profile's ProfilesScreen are RECORDING stand-ins: they keep the props they
//     were given, render their children / a testID, a Back Pressable wired to onBack, and a Paper Portal probe (a real one
//     throws with no Portal.Host above it, and lands in the host whose frame it belongs to).
// The tree is inspected through screen.toJSON() (host elements only, in tree order), so "inside the frame" and "ancestor of"
// are asserted on what would really reach the native side.
// ---------------------------------------------------------------------------------------------------------------------

type ViewRotation = 0 | 90 | 180 | -90
interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

let mockRotation: ViewRotation = 0
let mockWindow = { width: 402, height: 874 }
let mockInsets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
let mockFocused = true

interface BaseStatsProps {
  onBack: () => void
  insets: Insets
  rotation?: number
  fg?: string
  bg?: string
  onReset?: () => void
}
const mockBaseStats = jest.fn((_props: BaseStatsProps) => null)
interface ProfilesScreenProps {
  profiles: unknown[]
  onCreate: (patch: object) => void
  onSave: (id: string, patch: object) => void
  onDelete: (id: string) => void
  onBack: () => void
  bg?: string
  fg?: string
}
const mockProfilesScreen = jest.fn((_props: ProfilesScreenProps) => null)
const mockProfilePicker = jest.fn((_props: { alignOverride?: { maxHeight: number; verticalAlign: string; align: string; measured: boolean } }) => null)
let mockProfilesList: unknown[] = []
/** What ProfilesManager would read: the insets `useSafeAreaInsets()` returns from INSIDE the ProfilesScreen. */
const mockProfilesInsetsSeen: { current: Insets | null } = { current: null }
const mockResetAll = jest.fn()
/** How many times BaseStatsScreen's stand-in has been MOUNTED / UNMOUNTED - an unchanged tree keeps these at 1 / 0 across a rotation. */
const mockBaseStatsLifecycle = { mounts: 0, unmounts: 0 }
const mockStoreActions = { createProfile: jest.fn(), updateProfile: jest.fn(), deleteProfile: jest.fn() }

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => ({ ...mockWindow, scale: 1, fontScale: 1 }) }))
jest.mock('@tastic/core', () => {
  const actual = jest.requireActual('@tastic/core')
  return {
    ...actual,
    useRotation: () => mockRotation,
    useRotatedWindowDimensions: () => actual.rotateDimensions(mockWindow.width, mockWindow.height, mockRotation)
  }
})
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context')
  const React = require('react')
  return {
    ...actual,
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    // The provider's value wins when there is one (RotatedFrame's rotated insets); the physical insets are the no-provider fallback.
    useSafeAreaInsets: () => {
      const ctx = React.useContext(actual.SafeAreaInsetsContext)
      return ctx ?? mockInsets
    }
  }
})
jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() })
}))
jest.mock('@/utils/navigation', () => ({ safeBack: jest.fn() }))
jest.mock('@/stores/gameStats', () => {
  const { DEFAULT_STATS } = jest.requireActual('@/stores/statsValidation')
  return {
    useGameStats: () => ({ stats: DEFAULT_STATS, unlockedAchievements: [], resetAll: mockResetAll })
  }
})
jest.mock('@/stores/profiles', () => ({
  useProfiles: () => ({ profiles: mockProfilesList, ...mockStoreActions })
}))
jest.mock('@/stores/achievementCatalog', () => ({ ACHIEVEMENT_CATALOG: [] }))
jest.mock('@tastic/achievements', () => ({
  ...jest.requireActual('@tastic/achievements'),
  getAchievementCatalogRows: () => []
}))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/GameLoading', () => {
  const { View } = require('react-native')
  return { LoadingIndicator: () => <View testID='loading-indicator' /> }
})
jest.mock('@/components/GameStatusBar', () => {
  const { View } = require('react-native')
  return { GameStatusBar: () => <View testID='status-bar' /> }
})
jest.mock('@tastic/hud', () => {
  const { View, Pressable } = require('react-native')
  const { useEffect } = require('react')
  const { Portal } = require('react-native-paper')
  return {
    ...jest.requireActual('@tastic/hud'),
    BaseStatsScreen: (props: BaseStatsProps & { children: unknown }) => {
      useEffect(() => {
        mockBaseStatsLifecycle.mounts += 1
        return () => {
          mockBaseStatsLifecycle.unmounts += 1
        }
      }, [])
      mockBaseStats(props)
      return (
        <View testID='base-stats'>
          <Pressable accessibilityLabel='Back' onPress={props.onBack} />
          {/* The real one's reset-confirm is a Paper Portal; a real Portal throws with no Portal.Host above it. */}
          <Portal>
            <View testID='portal-probe' />
          </Portal>
          {props.children}
        </View>
      )
    },
    StatSection: ({ children }: { children: unknown }) => <View testID='stat-section'>{children}</View>,
    StatRow: () => null,
    AchievementRow: () => null
  }
})
jest.mock('@tastic/profile', () => {
  const { View, Pressable } = require('react-native')
  const { Portal } = require('react-native-paper')
  const { useSafeAreaInsets } = require('react-native-safe-area-context')
  return {
    ProfilePicker: (props: { alignOverride?: { maxHeight: number; verticalAlign: string; align: string; measured: boolean } }) => {
      mockProfilePicker(props)
      return null
    },
    // The real helper is a pure formula (220pt wide, 8pt padding either side, 36pt per row) - mirrored here so the mocked barrel still has it.
    getProfilePickerContentSize: (profileCount: number, hasManageRow = false) => ({ width: 220, height: 16 + (profileCount + 1 + (hasManageRow ? 1 : 0)) * 36 }),
    ProfilesScreen: (props: ProfilesScreenProps) => {
      mockProfilesScreen(props)
      // ProfilesManager reads the safe-area insets itself (its header padding).
      mockProfilesInsetsSeen.current = useSafeAreaInsets()
      return (
        <View testID='profiles-screen'>
          <Pressable accessibilityLabel='Back' onPress={props.onBack} />
          <Portal>
            <View testID='portal-probe' />
          </Portal>
        </View>
      )
    }
  }
})

// ------------------------------------------------------------------------------------------------- tree helpers

interface Json {
  type: string
  props: Record<string, unknown>
  children: (Json | string)[] | null
}

const snapshot = (): Json[] => {
  const root = screen.toJSON() as Json | Json[] | null
  return Array.isArray(root) ? root : root ? [root] : []
}
const asElements = (children: (Json | string)[] | null): Json[] => (children ?? []).filter((c): c is Json => typeof c !== 'string')

/** The host elements from the root down to the first element matching `predicate` (or null). */
function pathTo(roots: Json[], predicate: (node: Json) => boolean): Json[] | null {
  const walk = (node: Json, trail: Json[]): Json[] | null => {
    const here = [...trail, node]
    if (predicate(node)) return here
    for (const child of asElements(node.children)) {
      const found = walk(child, here)
      if (found) return found
    }
    return null
  }
  for (const node of roots) {
    const found = walk(node, [])
    if (found) return found
  }
  return null
}

const byTestId = (id: string) => (node: Json) => node.props.testID === id
const pathOrFail = (roots: Json[], predicate: (node: Json) => boolean, what: string): Json[] => {
  const path = pathTo(roots, predicate)
  if (!path) throw new Error(`no element for ${what}`)
  return path
}
const styleOf = (node: Json): ViewStyle => StyleSheet.flatten(node.props.style as ViewStyle) ?? {}

/** The host ancestors of the path's target, nearest first (the target itself excluded). */
const ancestorsOf = (path: Json[]) => path.slice(0, -1).reverse()
/** The nearest host ancestor that carries a rotate transform - the rotated frame - or null. */
const rotatedFrameOf = (path: Json[]) => ancestorsOf(path).find((node) => styleOf(node).transform !== undefined) ?? null
/** The nearest host ancestor that caps its own width (RotatedFrame's content column) or null. */
const cappedColumnOf = (path: Json[]) => ancestorsOf(path).find((node) => styleOf(node).maxWidth !== undefined) ?? null

const lastProps = <P,>(fn: jest.Mock<unknown, [P]>): P => {
  const call = fn.mock.calls[fn.mock.calls.length - 1]
  if (!call) throw new Error('never rendered')
  return call[0]
}

// ------------------------------------------------------------------------------------------------- render helpers

const PORTRAIT_WINDOW = { width: 402, height: 874 }
// A phone held sideways: the OS is portrait-locked, so the physical insets are top 62 (island) / bottom 34 (home bar).
const PHYSICAL_INSETS: Insets = { top: 62, right: 0, bottom: 34, left: 0 }

beforeEach(() => {
  mockRotation = 0
  mockWindow = { ...PORTRAIT_WINDOW }
  mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }
  mockFocused = true
  mockProfilesInsetsSeen.current = null
  mockBaseStats.mockClear()
  mockProfilesScreen.mockClear()
  mockProfilePicker.mockClear()
  mockProfilesList = []
  mockResetAll.mockClear()
  mockBaseStatsLifecycle.mounts = 0
  mockBaseStatsLifecycle.unmounts = 0
  mockStoreActions.createProfile.mockClear()
  mockStoreActions.updateProfile.mockClear()
  mockStoreActions.deleteProfile.mockClear()
  jest.mocked(safeBack).mockClear()
})

// ------------------------------------------------------------------------------------------------- Achievements

describe('Achievements screen', () => {
  it.each([
    // 90: physical top -> the frame's left edge, physical bottom -> its right edge.
    [90, '90deg', { top: 0, right: 34, bottom: 0, left: 62 }],
    // -90 is the mirror image: physical top -> the frame's right edge, physical bottom -> its left edge.
    [-90, '-90deg', { top: 0, right: 62, bottom: 0, left: 34 }]
  ] as const)('at rotation %s it renders inside the rotated 874x402 frame and hands BaseStatsScreen the ROTATED insets with rotation 0', async (rotation, angle, expectedInsets) => {
    mockRotation = rotation
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Achievements />)

    const frame = rotatedFrameOf(pathOrFail(snapshot(), byTestId('base-stats'), 'base stats'))
    expect(frame).not.toBeNull()
    expect(styleOf(frame!)).toMatchObject({ position: 'absolute', width: 874, height: 402, left: (402 - 874) / 2, top: (874 - 402) / 2 })
    expect(styleOf(frame!).transform).toEqual([{ rotate: angle }])

    const props = lastProps(mockBaseStats)
    expect(props.insets).toEqual(expectedInsets)
    // rotation={0}: its reset-confirm portals into the Portal.Host INSIDE the frame, which is already turned.
    expect(props.rotation).toBe(0)
    expect(props.bg).toBe('transparent')
  })

  it('at rotation 0 it receives the raw insets and nothing is transformed', async () => {
    mockInsets = { top: 47, right: 0, bottom: 34, left: 0 }

    await render(<Achievements />)

    const props = lastProps(mockBaseStats)
    expect(props.insets).toEqual({ top: 47, right: 0, bottom: 34, left: 0 })
    expect(props.rotation).toBe(0)
    const path = pathOrFail(snapshot(), byTestId('base-stats'), 'base stats')
    expect(ancestorsOf(path).filter((node) => styleOf(node).transform !== undefined)).toHaveLength(0)
  })

  it('at rotation 180 it flips the frame and swaps top/bottom and left/right of the insets', async () => {
    mockRotation = 180
    mockInsets = { top: 62, right: 5, bottom: 34, left: 7 }

    await render(<Achievements />)

    expect(lastProps(mockBaseStats).insets).toEqual({ top: 34, right: 7, bottom: 62, left: 5 })
    const frame = rotatedFrameOf(pathOrFail(snapshot(), byTestId('base-stats'), 'base stats'))
    expect(frame).not.toBeNull()
    expect(styleOf(frame!).transform).toEqual([{ rotate: '180deg' }])
  })

  it('does not cap the content column in portrait, so it stays exactly what it was on an iPad or a desktop window', async () => {
    mockRotation = 0

    await render(<Achievements />)

    const path = pathOrFail(snapshot(), byTestId('base-stats'), 'base stats')
    expect(cappedColumnOf(path)).toBeNull()
  })

  it('caps its content column at 640pt, centred, in landscape (the column is inside the turned frame)', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Achievements />)

    const path = pathOrFail(snapshot(), byTestId('base-stats'), 'base stats')
    const column = cappedColumnOf(path)
    expect(column).not.toBeNull()
    expect(styleOf(column!)).toMatchObject({ maxWidth: 640, alignSelf: 'center', flex: 1, width: '100%' })
    // frame -> column -> screen: the cap lives INSIDE the turned frame, so it caps the frame's 874pt landscape width.
    const frame = rotatedFrameOf(path)!
    expect(path.indexOf(frame)).toBeLessThan(path.indexOf(column!))
  })

  it('hands the profile picker a frame-aware placement override, sized for a list without a Manage row', async () => {
    mockProfilesList = [{ id: 'a' }, { id: 'b' }]

    await render(<Achievements />)

    const { alignOverride } = lastProps(mockProfilePicker)
    expect(alignOverride).toBeDefined()
    // Not measured yet (nothing is open), and its `maxHeight` starts at the popover's own content height: 8+8 padding + guest + 2 profiles.
    expect(alignOverride).toMatchObject({ measured: false, verticalAlign: 'below', maxHeight: 16 + 3 * 36 })
  })

  it('mounts the status bar only while the screen is focused, keeping the content mounted', async () => {
    await render(<Achievements />)
    expect(screen.getByTestId('status-bar')).toBeTruthy()

    mockFocused = false
    await screen.rerender(<Achievements />)

    expect(screen.queryByTestId('status-bar')).toBeNull()
    expect(screen.getByTestId('base-stats')).toBeTruthy()

    mockFocused = true
    await screen.rerender(<Achievements />)
    expect(screen.getByTestId('status-bar')).toBeTruthy()
  })

  it('tapping back calls safeBack', async () => {
    await render(<Achievements />)
    expect(lastProps(mockBaseStats).onBack).toBe(safeBack)

    await fireEvent.press(screen.getByLabelText('Back'))

    expect(safeBack).toHaveBeenCalledTimes(1)
  })

  it("wires the reset action to the stats store's resetAll", async () => {
    await render(<Achievements />)

    await act(() => lastProps(mockBaseStats).onReset?.())

    expect(mockResetAll).toHaveBeenCalledTimes(1)
  })

  it('portals dialogs into a Portal.Host that lives INSIDE the rotated frame', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Achievements />)

    // Paper's Portal throws with no Portal.Host above it, so rendering the probe proves a host exists; where its content lands
    // proves WHICH host it is: the one inside the frame, not one at the app root.
    const t = snapshot()
    const frame = rotatedFrameOf(pathOrFail(t, byTestId('base-stats'), 'base stats'))
    expect(frame).not.toBeNull()
    expect(rotatedFrameOf(pathOrFail(t, byTestId('portal-probe'), 'portal probe'))).toBe(frame)
  })

  it('renders the stat sections straight away (stats come from the already-rehydrated store)', async () => {
    await render(<Achievements />)
    expect(screen.queryByTestId('loading-indicator')).toBeNull()
    expect(screen.queryAllByTestId('stat-section').length).toBeGreaterThan(0)
  })

  it('keeps BaseStatsScreen mounted across a rotation (the tree is identical at every angle)', async () => {
    await render(<Achievements />)
    expect(mockBaseStatsLifecycle).toEqual({ mounts: 1, unmounts: 0 })

    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await screen.rerender(<Achievements />)

    // A per-angle tree branch would have unmounted and remounted it.
    expect(mockBaseStatsLifecycle).toEqual({ mounts: 1, unmounts: 0 })
    expect(rotatedFrameOf(pathOrFail(snapshot(), byTestId('base-stats'), 'base stats'))).not.toBeNull()
    expect(lastProps(mockBaseStats).insets).toEqual({ top: 0, right: 34, bottom: 0, left: 62 })
  })
})

// ------------------------------------------------------------------------------------------------- Profiles

describe('Profiles screen', () => {
  it('renders ProfilesScreen inside the rotated frame at 90, and it reads the ROTATED insets from the safe-area context', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Profiles />)

    const frame = rotatedFrameOf(pathOrFail(snapshot(), byTestId('profiles-screen'), 'profiles screen'))
    expect(frame).not.toBeNull()
    expect(styleOf(frame!)).toMatchObject({ position: 'absolute', width: 874, height: 402 })
    expect(styleOf(frame!).transform).toEqual([{ rotate: '90deg' }])
    // What ProfilesManager's useSafeAreaInsets() sees from inside: physical top (62) is now the frame's LEFT edge.
    expect(mockProfilesInsetsSeen.current).toEqual({ top: 0, right: 34, bottom: 0, left: 62 })
  })

  it('at rotation 0 the roster reads the raw insets and nothing is transformed', async () => {
    mockInsets = { top: 47, right: 0, bottom: 34, left: 0 }

    await render(<Profiles />)

    expect(mockProfilesInsetsSeen.current).toEqual({ top: 47, right: 0, bottom: 34, left: 0 })
    const path = pathOrFail(snapshot(), byTestId('profiles-screen'), 'profiles screen')
    expect(ancestorsOf(path).filter((node) => styleOf(node).transform !== undefined)).toHaveLength(0)
  })

  it('does not cap the content column in portrait', async () => {
    mockRotation = 0

    await render(<Profiles />)

    const path = pathOrFail(snapshot(), byTestId('profiles-screen'), 'profiles screen')
    expect(cappedColumnOf(path)).toBeNull()
  })

  it('caps its content column at 640pt, centred, in landscape', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Profiles />)

    const path = pathOrFail(snapshot(), byTestId('profiles-screen'), 'profiles screen')
    const column = cappedColumnOf(path)
    expect(column).not.toBeNull()
    expect(styleOf(column!)).toMatchObject({ maxWidth: 640, alignSelf: 'center', flex: 1, width: '100%' })
    expect(path.indexOf(rotatedFrameOf(path)!)).toBeLessThan(path.indexOf(column!))
  })

  it('wires onBack to safeBack', async () => {
    await render(<Profiles />)
    expect(lastProps(mockProfilesScreen).onBack).toBe(safeBack)

    await fireEvent.press(screen.getByLabelText('Back'))

    expect(safeBack).toHaveBeenCalledTimes(1)
  })

  it("forwards create / save / delete to the profiles store and stays transparent over the app's felt", async () => {
    await render(<Profiles />)
    const props = lastProps(mockProfilesScreen)

    props.onCreate({ name: 'Ada' })
    props.onSave('p1', { name: 'Bea' })
    props.onDelete('p2')

    expect(mockStoreActions.createProfile).toHaveBeenCalledWith({ name: 'Ada' })
    expect(mockStoreActions.updateProfile).toHaveBeenCalledWith('p1', { name: 'Bea' })
    expect(mockStoreActions.deleteProfile).toHaveBeenCalledWith('p2')
    expect(props.bg).toBe('transparent')
  })

  it('mounts the status bar only while focused', async () => {
    await render(<Profiles />)
    expect(screen.getByTestId('status-bar')).toBeTruthy()

    mockFocused = false
    await screen.rerender(<Profiles />)

    expect(screen.queryByTestId('status-bar')).toBeNull()
    expect(screen.getByTestId('profiles-screen')).toBeTruthy()
  })

  it('portals its delete-confirm into a Portal.Host that lives INSIDE the rotated frame', async () => {
    mockRotation = -90
    mockInsets = { ...PHYSICAL_INSETS }

    await render(<Profiles />)

    const t = snapshot()
    const frame = rotatedFrameOf(pathOrFail(t, byTestId('profiles-screen'), 'profiles screen'))
    expect(frame).not.toBeNull()
    expect(rotatedFrameOf(pathOrFail(t, byTestId('portal-probe'), 'portal probe'))).toBe(frame)
  })
})
