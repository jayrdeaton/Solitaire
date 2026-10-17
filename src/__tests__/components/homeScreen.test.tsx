import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet, type ViewStyle } from 'react-native'

import Home from '@/app/index'
import { computeHomeLayout } from '@/components/homeLayout'

// ---------------------------------------------------------------------------------------------------------------------
// A render test of the REAL Home screen (src/app/index.tsx): the real RotatedScreen (@tastic/hud's RotatedFrame over
// @tastic/core's FakeLandscapeView), the real @tastic/core rotation math (rotateInsets / rotateDimensions /
// toRotationStyle), the real Paper Portal.Host, the real @tastic/hud usePopoverHost + PressAwayOverlay and the real
// homeLayout. Only what needs a native runtime, a store or a provider is replaced:
//   - rotation, the window and the safe-area insets are mutable (`mockRotation`, `mockWindow`, `mockInsets`). useRotation
//     AND useRotatedWindowDimensions are both replaced (the latter imports the former internally, so replacing only
//     useRotation would leave it reading rotation 0), and react-native's useWindowDimensions - which RotatedFrame and
//     FakeLandscapeView read directly - is replaced at its module.
//   - the heavy children (HeroCards, ProfilePanel, GamePreview, the two dialogs) are recording stand-ins.
//   - @rific/feedback-press's IconButton/Pressable are thin RN Pressables that keep accessibilityLabel/onPress/style (the real
//     ones, without a provider, drop `style` - which would hide the corner offsets under test).
// The tree is inspected through screen.toJSON() (host elements only, in tree order), so "ancestor of", "sibling order" and
// "inside the frame" are asserted on what would really reach the native side.
// ---------------------------------------------------------------------------------------------------------------------

type ViewRotation = 0 | 90 | 180 | -90

let mockRotation: ViewRotation = 0
let mockWindow = { width: 402, height: 874 }
let mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }
let mockResume: string | null = null
let mockFocused = true

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }
const mockConsumeResumeGame = jest.fn(() => mockResume)
const mockHeroCards = jest.fn((_props: { scale?: number }) => null)
const mockSettingsDialog = jest.fn((_props: { visible: boolean; onDismiss: () => void; rotation?: number }) => null)
/** Every render's props of auto-paper's FadingScrollView, which still renders for real (see the mock below). */
const mockFadingScrollView = jest.fn()
const mockRulesDialog = jest.fn((_props: { visible: boolean; onDismiss: () => void; title: string; rules: string[] }) => null)
/** The popover host the Home screen hands its ProfilePanel - the test opens a popover through it. */
const mockHostRef: { current: { openId: string | null; toggle: (id: string) => void; close: () => void } | null } = { current: null }
/** How many times each stand-in has been MOUNTED / UNMOUNTED - an unchanged tree keeps these at 1 / 0 across a rotation. */
const mockMounts: Record<string, number> = {}
const mockUnmounts: Record<string, number> = {}

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => ({ ...mockWindow, scale: 1, fontScale: 1 }) }))
jest.mock('@tastic/core', () => {
  const actual = jest.requireActual('@tastic/core')
  return {
    ...actual,
    useRotation: () => mockRotation,
    useRotatedWindowDimensions: () => actual.rotateDimensions(mockWindow.width, mockWindow.height, mockRotation)
  }
})
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => mockInsets
}))
jest.mock('expo-router', () => {
  const { View, Text } = require('react-native')
  return {
    useRouter: () => mockRouter,
    useIsFocused: () => mockFocused,
    Link: ({ children, href }: { children: unknown; href: string }) => <View testID={`link-${href}`}>{children}</View>,
    Redirect: ({ href }: { href: string }) => <Text testID='redirect'>{href}</Text>
  }
})
jest.mock('@rific/feedback-press', () => {
  const { Pressable: RNPressable } = require('react-native')
  const { useEffect } = require('react')
  const useCount = (name: string) =>
    useEffect(() => {
      mockMounts[name] = (mockMounts[name] ?? 0) + 1
      return () => {
        mockUnmounts[name] = (mockUnmounts[name] ?? 0) + 1
      }
    }, [name])
  return {
    IconButton: ({ icon, iconColor: _iconColor, size: _size, ...rest }: { icon: string; iconColor?: string; size?: number }) => {
      useCount(`icon-${icon}`)
      return <RNPressable {...rest} />
    },
    Pressable: (props: object) => <RNPressable {...props} />,
    useVibration: () => ({ short: () => {}, selection: () => {} })
  }
})
// The real FadingScrollView, recorded: a function component adds no host element, so the tree under test is unchanged.
jest.mock('@rific/auto-paper', () => {
  const actual = jest.requireActual('@rific/auto-paper')
  const { createElement } = require('react')
  return {
    ...actual,
    FadingScrollView: (props: object) => {
      mockFadingScrollView(props)
      return createElement(actual.FadingScrollView, props)
    }
  }
})
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ consumeResumeGame: mockConsumeResumeGame }) }))
jest.mock('@/stores/gameInProgress', () => ({ preloadGameInProgress: () => {} }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
jest.mock('@/components/HeroCards', () => {
  const { View } = require('react-native')
  return {
    HeroCards: (props: { scale?: number }) => {
      mockHeroCards(props)
      return <View testID='hero-cards' />
    }
  }
})
jest.mock('@/components/ProfilePanel', () => {
  const { View } = require('react-native')
  return {
    ProfilePanel: ({ host }: { host: NonNullable<typeof mockHostRef.current> }) => {
      mockHostRef.current = host
      return <View testID='profile-panel' />
    }
  }
})
jest.mock('@/components/GamePreview', () => {
  const { View } = require('react-native')
  // Only the component is replaced: the games' previewLayout builders (run at module load by index.tsx) import the layout helpers from here.
  return { ...jest.requireActual('@/components/GamePreview'), GamePreview: () => <View testID='game-preview' /> }
})
jest.mock('@/components/SettingsDialog', () => {
  const { View, Text } = require('react-native')
  const { useEffect } = require('react')
  const { Portal } = require('react-native-paper')
  return {
    SettingsDialog: (props: { visible: boolean; onDismiss: () => void; rotation?: number }) => {
      useEffect(() => {
        mockMounts.settings = (mockMounts.settings ?? 0) + 1
        return () => {
          mockUnmounts.settings = (mockUnmounts.settings ?? 0) + 1
        }
      }, [])
      mockSettingsDialog(props)
      // A real dialog portals its content into the nearest Portal.Host; Paper's Portal THROWS when there is none.
      return (
        <View testID='settings-dialog'>
          <Portal>
            <Text testID='portal-probe'>probe</Text>
          </Portal>
        </View>
      )
    }
  }
})
jest.mock('@/components/RulesDialog', () => {
  const { View } = require('react-native')
  return {
    RulesDialog: (props: { visible: boolean; onDismiss: () => void; title: string; rules: string[] }) => {
      mockRulesDialog(props)
      return <View testID='rules-dialog' />
    }
  }
})

// ------------------------------------------------------------------------------------------------- tree helpers

interface Json {
  type: string
  props: Record<string, unknown>
  children: (Json | string)[] | null
}

/** ONE toJSON() snapshot: every call builds fresh objects, so paths (and the identity comparisons between them) must all come from the same one. */
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
const byLabel = (label: string) => (node: Json) => node.props.accessibilityLabel === label
const pathOrFail = (roots: Json[], predicate: (node: Json) => boolean, what: string): Json[] => {
  const path = pathTo(roots, predicate)
  if (!path) throw new Error(`no element for ${what}`)
  return path
}
const styleOf = (node: Json): ViewStyle => StyleSheet.flatten(node.props.style as ViewStyle) ?? {}
const zIndexOf = (node: Json) => styleOf(node).zIndex

/** The host ancestors of the path's target, nearest first (the target itself excluded). */
const ancestorsOf = (path: Json[]) => path.slice(0, -1).reverse()
/** The nearest host ancestor that carries a rotate transform - the rotated frame - or null. */
const rotatedFrameOf = (path: Json[]) => ancestorsOf(path).find((node) => styleOf(node).transform !== undefined) ?? null

/** The index (in tree order) of the child of `parent` that contains `path`'s target. */
function branchIndex(parent: Json, path: Json[]): number {
  const at = path.indexOf(parent)
  const branch = path[at + 1]
  return asElements(parent.children).indexOf(branch)
}

const lastProps = <P,>(fn: jest.Mock<unknown, [P]>): P => {
  const call = fn.mock.calls[fn.mock.calls.length - 1]
  if (!call) throw new Error('never rendered')
  return call[0]
}

// ------------------------------------------------------------------------------------------------- render helpers

async function flush() {
  // Home defers its tile art by one requestAnimationFrame (a setState); flush it inside act.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(50)
  })
}

async function renderHome() {
  await render(<Home />)
  await flush()
}

/** Re-renders the same Home in place (no new mount) so it re-reads the mutable rotation/window/insets. */
async function rerenderHome() {
  await screen.rerender(<Home />)
  await flush()
}

const PORTRAIT_WINDOW = { width: 402, height: 874 }
// A phone held sideways: the OS is portrait-locked, so the physical insets are top 62 (island) / bottom 34 (home bar),
// and a +90 rotation maps physical top -> rotated left, physical bottom -> rotated right.
const PHYSICAL_INSETS = { top: 62, right: 0, bottom: 34, left: 0 }

beforeEach(() => {
  jest.useFakeTimers()
  mockRotation = 0
  mockWindow = { ...PORTRAIT_WINDOW }
  mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }
  mockResume = null
  mockFocused = true
  mockHostRef.current = null
  for (const key of Object.keys(mockMounts)) delete mockMounts[key]
  for (const key of Object.keys(mockUnmounts)) delete mockUnmounts[key]
  mockRouter.push.mockClear()
  mockConsumeResumeGame.mockClear()
  mockHeroCards.mockClear()
  mockSettingsDialog.mockClear()
  mockRulesDialog.mockClear()
})
afterEach(() => {
  jest.useRealTimers()
})

const TILE_HREFS = ['/klondike', '/freecell', '/yukon', '/canfield', '/fortythieves', '/spider', '/scorpion', '/pyramid', '/golf', '/tripeaks', '/acesup']
/** The tile's own Pressable (the Link stand-in's only child). */
const tileOf = (roots: Json[], href: string) => asElements(pathOrFail(roots, byTestId(`link-${href}`), `tile ${href}`).at(-1)!.children)[0]

// ------------------------------------------------------------------------------------------------- the corner buttons

describe('Home: the trophy and cog corner buttons', () => {
  it.each([
    ['Stats & Achievements', 'trophy'],
    ['Settings', 'cog']
  ])('%s sits in a plain, box-none View that carries the stacking (and has no zIndex of its own)', async (label) => {
    await renderHome()

    const t = snapshot()
    const path = pathOrFail(t, byLabel(label), label)
    const button = path[path.length - 1]
    // The button itself must not be relying on a zIndex: on iOS a Paper IconButton's zIndex never reaches its outer view
    // (see paperIconButtonZIndex.test.tsx), so any it carried would be dead weight that only looks like a fix.
    expect(zIndexOf(button)).toBeUndefined()

    const container = ancestorsOf(path).find((node) => (zIndexOf(node) ?? 0) >= 10)
    expect(container).toBeDefined()
    expect(container!.type).toBe('View')
    expect(container!.props.pointerEvents).toBe('box-none')
    // ...and it is a real full-frame carrier, not a zero-height strip.
    expect(styleOf(container!)).toMatchObject({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 })
  })

  it.each([
    ['portrait', 0],
    ['landscape', 90]
  ] as const)('is ONE container for both buttons in %s, mounted AFTER the content it must outrank', async (_name, rotation) => {
    mockRotation = rotation
    if (rotation !== 0) mockInsets = { ...PHYSICAL_INSETS }
    await renderHome()

    const t = snapshot()
    const trophy = pathOrFail(t, byLabel('Stats & Achievements'), 'trophy')
    const cog = pathOrFail(t, byLabel('Settings'), 'cog')
    const container = ancestorsOf(trophy).find((node) => (zIndexOf(node) ?? 0) >= 10)!
    expect(ancestorsOf(cog)).toContain(container)

    // The container's parent is the screen; every piece of content it has to outrank (the hero / the game grid) is a
    // child of that same screen that comes BEFORE it, so DOM/paint order cannot let a later sibling swallow its taps.
    const screenView = trophy[trophy.indexOf(container) - 1]
    const containerAt = branchIndex(screenView, trophy)
    for (const content of [pathOrFail(t, byTestId('hero-cards'), 'hero cards'), pathOrFail(t, byTestId('link-/klondike'), 'game grid')]) {
      expect(content).toContain(screenView)
      expect(branchIndex(screenView, content)).toBeGreaterThanOrEqual(0)
      expect(branchIndex(screenView, content)).toBeLessThan(containerAt)
    }
  })

  it('pressing the trophy opens Stats & Achievements', async () => {
    await renderHome()

    await fireEvent.press(screen.getByLabelText('Stats & Achievements'))

    expect(mockRouter.push).toHaveBeenCalledTimes(1)
    expect(mockRouter.push).toHaveBeenCalledWith('/achievements')
  })

  it('pressing the cog opens the Settings dialog, which is told not to rotate itself again', async () => {
    await renderHome()
    expect(lastProps(mockSettingsDialog).visible).toBe(false)

    await fireEvent.press(screen.getByLabelText('Settings'))

    const props = lastProps(mockSettingsDialog)
    expect(props.visible).toBe(true)
    // The dialog portals into the Portal.Host inside the rotated frame, so it is already turned with it.
    expect(props.rotation).toBe(0)

    await act(() => props.onDismiss())
    expect(lastProps(mockSettingsDialog).visible).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------- portrait

describe('Home: portrait', () => {
  it('renders the single-column layout: a full-size hero and one row per game', async () => {
    await renderHome()

    for (const href of TILE_HREFS) {
      expect(screen.getByTestId(`link-${href}`)).toBeTruthy()
    }
    expect(screen.getAllByTestId(/^link-/)).toHaveLength(TILE_HREFS.length)
    // HeroCards is rendered with no props at all: its natural size.
    expect(lastProps(mockHeroCards).scale).toBeUndefined()
    // A portrait tile is the horizontal "index card" row and has no fixed width of its own.
    const t = snapshot()
    const tile = styleOf(tileOf(t, '/klondike'))
    expect(tile.flexDirection).toBe('row')
    expect(tile.width).toBeUndefined()
    // No frame rotation.
    expect(rotatedFrameOf(pathOrFail(t, byTestId('hero-cards'), 'hero'))).toBeNull()
  })

  it('has the corner buttons at the plain 8pt margin from the (unrotated) safe area', async () => {
    mockInsets = { top: 47, right: 0, bottom: 34, left: 0 }
    await renderHome()

    const t = snapshot()
    const trophy = styleOf(pathOrFail(t, byLabel('Stats & Achievements'), 'trophy').at(-1)!)
    const cog = styleOf(pathOrFail(t, byLabel('Settings'), 'cog').at(-1)!)
    expect(trophy).toMatchObject({ position: 'absolute', top: 8 + 47, left: 8 })
    expect(cog).toMatchObject({ position: 'absolute', top: 8 + 47, right: 8 })
  })

  // The edge fade the Settings and Rules sheets, the player dropdown, Achievements and Profiles give (2026-10-16).
  it("scrolls the menu in auto-paper's FadingScrollView, in both layouts", async () => {
    await renderHome()
    expect(mockFadingScrollView).toHaveBeenCalled()
    expect(StyleSheet.flatten((lastProps(mockFadingScrollView) as { contentContainerStyle: ViewStyle }).contentContainerStyle).paddingTop).toBe(56)

    mockFadingScrollView.mockClear()
    mockRotation = 90
    await rerenderHome()
    expect(mockFadingScrollView).toHaveBeenCalled()
    expect(StyleSheet.flatten((lastProps(mockFadingScrollView) as { style: ViewStyle }).style).position).toBe('absolute')
  })

  it("tapping a tile's rules button opens the rules dialog for that game, without navigating", async () => {
    await renderHome()
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() }

    await fireEvent.press(screen.getByLabelText('Klondike rules'), event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    const props = lastProps(mockRulesDialog)
    expect(props.visible).toBe(true)
    expect(props.title).toBe('Klondike')
    expect(props.rules.length).toBeGreaterThan(0)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------------------------------------- landscape

describe('Home: landscape (rotated 90)', () => {
  const setLandscape = () => {
    mockRotation = 90
    mockWindow = { ...PORTRAIT_WINDOW }
    mockInsets = { ...PHYSICAL_INSETS }
  }
  // The frame's own footprint (874x402) and the physical insets mapped onto its edges (left 62, right 34).
  const layout = computeHomeLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 })

  it('puts the corner buttons at the margin from EACH rotated inset, not from the physical ones', async () => {
    setLandscape()
    await renderHome()

    const t = snapshot()
    const trophy = styleOf(pathOrFail(t, byLabel('Stats & Achievements'), 'trophy').at(-1)!)
    const cog = styleOf(pathOrFail(t, byLabel('Settings'), 'cog').at(-1)!)
    // Physical top (62) is now the frame's LEFT edge, physical bottom (34) its RIGHT edge, and the frame's own top is 0.
    expect(trophy).toMatchObject({ position: 'absolute', top: 8, left: 8 + 62 })
    expect(cog).toMatchObject({ position: 'absolute', top: 8, right: 8 + 34 })
  })

  it('renders the wide two-pane layout', async () => {
    setLandscape()
    await renderHome()

    // Same eleven games, but as fixed-width vertical tiles in the grid.
    expect(screen.getAllByTestId(/^link-/)).toHaveLength(TILE_HREFS.length)
    const t = snapshot()
    const tile = styleOf(tileOf(t, '/klondike'))
    expect(layout.isWide).toBe(true)
    expect(tile.width).toBe(layout.tileWidth)
    expect(tile.flexDirection).toBeUndefined()
    // The hero is scaled down to leave the height to the game tiles.
    const { scale } = lastProps(mockHeroCards)
    expect(scale).toBe(layout.heroScale)
    expect(scale).toBeLessThan(1)
  })

  // A web scrollbar is drawn at its scroller's edge: the grid's scroller used to stop at the cog's gutter, which put the
  // scrollbar 110pt in from the window's edge at 1280 wide, and a classic scrollbar's 15pt then wrapped the third column.
  it("runs the grid's scroller to the frame's right edge, with the cog's gutter as padding and the grid at its own width", async () => {
    setLandscape()
    await renderHome()

    const { style, contentContainerStyle } = lastProps(mockFadingScrollView) as { style: ViewStyle; contentContainerStyle: ViewStyle }
    expect(StyleSheet.flatten(style)).toMatchObject({ position: 'absolute', right: 0 })
    expect(StyleSheet.flatten(contentContainerStyle).paddingRight).toBe(layout.paddingRight)
    const grid = pathOrFail(snapshot(), byTestId('link-/klondike'), 'the Klondike tile').at(-2)!
    expect(styleOf(grid)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', width: layout.rightPaneWidth })
  })

  it("opens the rules dialog for a tile from the wide layout's floating rules button", async () => {
    setLandscape()
    await renderHome()
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() }

    await fireEvent.press(screen.getByLabelText('Golf rules'), event)

    const props = lastProps(mockRulesDialog)
    expect(props).toMatchObject({ visible: true, title: 'Golf' })
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  it.each([
    [90, '90deg'],
    [-90, '-90deg']
  ] as const)('renders inside a rotated frame at %s: the swapped 874x402 footprint, centred, with a %s transform', async (rotation, angle) => {
    mockRotation = rotation
    mockInsets = { ...PHYSICAL_INSETS }
    await renderHome()

    const t = snapshot()
    const frame = rotatedFrameOf(pathOrFail(t, byTestId('hero-cards'), 'hero'))
    expect(frame).not.toBeNull()
    const style = styleOf(frame!)
    expect(style).toMatchObject({ position: 'absolute', width: 874, height: 402, left: (402 - 874) / 2, top: (874 - 402) / 2 })
    expect(style.transform).toEqual([{ rotate: angle }])
  })

  it('renders the Settings dialog, the rules dialog and the corner buttons inside that same frame', async () => {
    setLandscape()
    await renderHome()

    const frameOf = (path: Json[]) => rotatedFrameOf(path)
    const t = snapshot()
    const hero = frameOf(pathOrFail(t, byTestId('hero-cards'), 'hero'))
    expect(hero).not.toBeNull()
    expect(frameOf(pathOrFail(t, byTestId('settings-dialog'), 'settings'))).toBe(hero)
    expect(frameOf(pathOrFail(t, byTestId('rules-dialog'), 'rules'))).toBe(hero)
    expect(frameOf(pathOrFail(t, byLabel('Settings'), 'cog'))).toBe(hero)
  })
})

// ------------------------------------------------------------------------------------------------- the frame + Portal.Host

describe('Home: the rotated frame and its Portal.Host', () => {
  it('has no transform at all in portrait', async () => {
    await renderHome()

    for (const id of ['hero-cards', 'settings-dialog', 'profile-panel']) {
      const t = snapshot()
      const path = pathOrFail(t, byTestId(id), id)
      expect(ancestorsOf(path).filter((node) => styleOf(node).transform !== undefined)).toHaveLength(0)
    }
  })

  it('portals dialog content into a Portal.Host that lives INSIDE the rotated frame', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await renderHome()

    // Paper's Portal throws when there is no Portal.Host above it, so simply rendering the probe proves a host exists; and
    // where its content lands proves WHICH host it is: the one inside the frame, not one at the app root.
    const t = snapshot()
    const probe = pathOrFail(t, byTestId('portal-probe'), 'portal probe')
    const hero = pathOrFail(t, byTestId('hero-cards'), 'hero')
    const frame = rotatedFrameOf(hero)
    expect(frame).not.toBeNull()
    expect(rotatedFrameOf(probe)).toBe(frame)
  })

  it('keeps the same tree across a rotation: nothing outside the layout branch is remounted', async () => {
    await renderHome()
    expect(mockMounts).toMatchObject({ settings: 1, 'icon-trophy': 1, 'icon-cog': 1 })

    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await rerenderHome()

    // The layout branch (portrait scroll column <-> two panes) legitimately swaps; everything outside it must not.
    expect(lastProps(mockHeroCards).scale).toBeLessThan(1)
    expect(mockMounts).toMatchObject({ settings: 1, 'icon-trophy': 1, 'icon-cog': 1 })
    expect(mockUnmounts.settings ?? 0).toBe(0)
    expect(mockUnmounts['icon-trophy'] ?? 0).toBe(0)
    expect(mockUnmounts['icon-cog'] ?? 0).toBe(0)

    // ...and back again.
    mockRotation = 0
    mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }
    await rerenderHome()
    expect(mockMounts).toMatchObject({ settings: 1, 'icon-trophy': 1, 'icon-cog': 1 })
    expect(mockUnmounts.settings ?? 0).toBe(0)
  })

  it('keeps an open Settings dialog open across a rotation', async () => {
    await renderHome()
    await fireEvent.press(screen.getByLabelText('Settings'))
    expect(lastProps(mockSettingsDialog).visible).toBe(true)

    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await rerenderHome()

    expect(lastProps(mockSettingsDialog).visible).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------- the resume redirect

describe('Home: the cold-launch resume redirect', () => {
  it('redirects to the game that was in progress and renders no menu at all', async () => {
    mockResume = 'klondike'
    await renderHome()

    expect(screen.getByTestId('redirect').props.children).toBe('/klondike')
    expect(screen.queryByTestId('hero-cards')).toBeNull()
    expect(screen.queryByTestId('settings-dialog')).toBeNull()
    expect(screen.queryByLabelText('Settings')).toBeNull()
    expect(screen.queryAllByTestId(/^link-/)).toHaveLength(0)
  })

  it('renders the menu when there is nothing to resume', async () => {
    await renderHome()

    expect(screen.queryByTestId('redirect')).toBeNull()
    expect(screen.getByTestId('hero-cards')).toBeTruthy()
  })

  it('reads the resume decision exactly once per mount, however often it re-renders', async () => {
    await renderHome()
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await rerenderHome()
    mockResume = 'spider'
    await rerenderHome()

    // A later change of the stored value must not swap a mounted menu for a Redirect (see stores/lastActiveGame.tsx).
    expect(mockConsumeResumeGame).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('redirect')).toBeNull()
    expect(screen.getByTestId('hero-cards')).toBeTruthy()
  })
})

// ------------------------------------------------------------------------------------------------- covered by another screen

describe('Home: while another screen covers it', () => {
  it('holds its portrait/wide layout through a rotation, and re-syncs when it is shown again', async () => {
    await renderHome()
    // (portrait renders the hero at its natural size, i.e. without a `scale` prop)
    expect(lastProps(mockHeroCards).scale).toBeUndefined()

    // A game is pushed on top, then the phone is turned: the (invisible) menu must not swap its whole tree.
    mockFocused = false
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await rerenderHome()
    // (portrait renders the hero at its natural size, i.e. without a `scale` prop)
    expect(lastProps(mockHeroCards).scale).toBeUndefined()

    // Back on the menu: it catches up to the way the phone is held now.
    mockFocused = true
    await rerenderHome()
    expect(lastProps(mockHeroCards).scale).toBeLessThan(1)
  })
})

// ------------------------------------------------------------------------------------------------- the profile popover

describe('Home: the profile popover and its press-away overlay', () => {
  const openPopover = async () => {
    await act(() => mockHostRef.current!.toggle('home-player-color'))
  }
  const overlayPath = () => pathTo(snapshot(), byLabel('Dismiss'))

  it('renders no overlay until a popover is open, then a press-away catcher below the panel that owns the popover', async () => {
    await renderHome()
    expect(overlayPath()).toBeNull()

    await openPopover()

    const t = snapshot()
    const overlay = pathOrFail(t, byLabel('Dismiss'), 'overlay')
    const panel = pathOrFail(t, byTestId('profile-panel'), 'panel')
    // PORTRAIT: the overlay is the first child of the scroll content, a SIBLING of the panel's wrapper - so the wrapper's
    // higher zIndex really does lift the popover's rows above it (zIndex only orders siblings of one parent on native).
    const overlayParent = overlay[overlay.length - 2]
    const wrapper = panel[panel.length - 2]
    const wrapperParent = panel[panel.length - 3]
    expect(overlayParent).toBe(wrapperParent)
    expect(zIndexOf(overlay[overlay.length - 1])).toBe(5)
    expect(zIndexOf(wrapper)).toBe(10)
    expect(asElements(overlayParent.children).indexOf(overlay[overlay.length - 1])).toBeLessThan(asElements(overlayParent.children).indexOf(wrapper))
  })

  it('in the wide layout the overlay is a screen-level sibling of the (higher) left pane', async () => {
    mockRotation = 90
    mockInsets = { ...PHYSICAL_INSETS }
    await renderHome()
    await openPopover()

    const t = snapshot()
    const overlay = pathOrFail(t, byLabel('Dismiss'), 'overlay')
    const panel = pathOrFail(t, byTestId('profile-panel'), 'panel')
    const leftPane = panel[panel.length - 3] // panel -> wideProfileWrap -> wideLeftPane
    expect(overlay[overlay.length - 2]).toBe(panel[panel.length - 4]) // same parent: the screen
    expect(zIndexOf(overlay[overlay.length - 1])).toBe(5)
    expect(zIndexOf(leftPane)).toBe(10)
  })

  it('pressing away closes the popover', async () => {
    await renderHome()
    await openPopover()

    await fireEvent.press(screen.getByLabelText('Dismiss'))

    expect(overlayPath()).toBeNull()
    expect(mockHostRef.current!.openId).toBeNull()
  })

  it('stays open across an unrelated re-render', async () => {
    await renderHome()
    await openPopover()

    await rerenderHome()

    expect(overlayPath()).not.toBeNull()
  })

  it.each([
    [
      'a rotation to landscape',
      () => {
        mockRotation = 90
        mockInsets = { ...PHYSICAL_INSETS }
      }
    ],
    [
      'a resize that keeps the orientation',
      () => {
        mockWindow = { width: 430, height: 932 }
      }
    ]
  ])('is closed by %s', async (_name, change) => {
    await renderHome()
    await openPopover()
    expect(overlayPath()).not.toBeNull()

    change()
    await rerenderHome()

    expect(overlayPath()).toBeNull()
    expect(mockHostRef.current!.openId).toBeNull()
  })
})
