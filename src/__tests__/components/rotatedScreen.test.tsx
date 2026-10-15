import { FakeLandscapeView } from '@tastic/core'
import { RotatedFrame } from '@tastic/hud'
import { render, screen } from '@testing-library/react-native'
import { useContext, useEffect } from 'react'
import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { Portal } from 'react-native-paper'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'

import { RotatedScreen } from '@/components/RotatedScreen'

// ---------------------------------------------------------------------------------------------------------------------
// Render tests of the REAL RotatedScreen (src/components/RotatedScreen.tsx) and the package frames it and the root overlays
// are built on (@tastic/hud's RotatedFrame, over @tastic/core's FakeLandscapeView): the real @tastic/core rotation math
// (rotateInsets / rotateDimensions / toRotationStyle), the real Paper Portal + Portal.Host and the real safe-area context +
// provider. Same technique as homeScreen.test.tsx: only what needs a native runtime or a provider is replaced.
//   - rotation, the window and the safe-area insets are mutable (`mockRotation`, `mockWindow`, `mockInsets`). useRotation AND
//     useRotatedWindowDimensions are both replaced, and react-native's useWindowDimensions (which RotatedFrame and
//     FakeLandscapeView read directly) is replaced at its module. RotatedFrame turns its FakeLandscapeView by the mocked
//     useRotation(); a bare FakeLandscapeView reads the orientation state itself, so the tests hand it `rotation`.
//   - react-native-safe-area-context keeps its REAL SafeAreaInsetsContext (and Provider); only the FRAME's own read
//     (`useSafeAreaInsets`) is a mutable stand-in. The children read the context itself through `Probe`, so what they see is
//     exactly what the frame's provider hands its subtree.
// The tree is inspected through screen.toJSON() (host elements only, in tree order), so "inside the frame" and "ancestor of"
// are asserted on what would really reach the native side.
// ---------------------------------------------------------------------------------------------------------------------

type ViewRotation = 0 | 90 | 180 | -90

let mockRotation: ViewRotation = 0
let mockWindow = { width: 402, height: 874 }
let mockInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** How many times each probe has been MOUNTED / UNMOUNTED - an unchanged tree keeps these at 1 / 0 across a rotation. */
const mockMounts: Record<string, number> = {}
const mockUnmounts: Record<string, number> = {}
/** Every insets value the probes read from the context, in render order. */
const mockSeenInsets = jest.fn((_insets: EdgeInsets | null) => {})

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
  // The REAL SafeAreaInsetsContext / Provider stay: the test reads back what the frame's provider hands its subtree.
  ...jest.requireActual('react-native-safe-area-context'),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => mockInsets
}))

// ------------------------------------------------------------------------------------------------- probes

/** A child that records the safe-area insets its context hands it and counts its own mounts/unmounts. */
function Probe({ name = 'probe' }: { name?: string }) {
  const insets = useContext(SafeAreaInsetsContext)
  mockSeenInsets(insets)
  useEffect(() => {
    mockMounts[name] = (mockMounts[name] ?? 0) + 1
    return () => {
      mockUnmounts[name] = (mockUnmounts[name] ?? 0) + 1
    }
  }, [name])
  return <View testID={name} />
}

/** Content that goes through a Paper Portal, with its own mount counter. */
function PortalProbe() {
  return (
    <Portal>
      <PortalContent />
    </Portal>
  )
}
function PortalContent() {
  useEffect(() => {
    mockMounts['portal-content'] = (mockMounts['portal-content'] ?? 0) + 1
    return () => {
      mockUnmounts['portal-content'] = (mockUnmounts['portal-content'] ?? 0) + 1
    }
  }, [])
  return <Text testID='portal-content'>portal</Text>
}

// ------------------------------------------------------------------------------------------------- tree helpers

interface Json {
  type: string
  props: Record<string, unknown>
  children: (Json | string)[] | null
}

const asElements = (children: (Json | string)[] | null): Json[] => (children ?? []).filter((c): c is Json => typeof c !== 'string')

/** ONE toJSON() snapshot: every call builds fresh objects, so paths (and the identity comparisons between them) must all come from the same one.
 * More than one root (RotatedScreen's status bar beside its frame) comes back wrapped in an unnamed (type '') container: unwrapped here. */
const snapshot = (): Json[] => {
  const root = screen.toJSON() as Json | Json[] | null
  if (Array.isArray(root)) return root
  if (!root) return []
  return root.type === '' ? asElements(root.children) : [root]
}

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
const pathOrFail = (id: string, roots: Json[] = snapshot()): Json[] => {
  const path = pathTo(roots, byTestId(id))
  if (!path) throw new Error(`no element with testID ${id}`)
  return path
}
const styleOf = (node: Json): ViewStyle => StyleSheet.flatten(node.props.style as ViewStyle) ?? {}

/** The frame's three Views around a probe: the outer full-screen box, the (rotated) inner frame and the content column.
 * Pass one `roots` snapshot to compare against other paths taken from the same snapshot (identity is per snapshot). */
function frameOf(id = 'probe', roots: Json[] = snapshot()) {
  const path = pathOrFail(id, roots)
  return { path, outer: path[0], inner: path[1], column: path[path.length - 2] }
}

/** The host ancestors of the path's target, nearest first (the target itself excluded). */
const ancestorsOf = (path: Json[]) => path.slice(0, -1).reverse()
const transformedAncestors = (path: Json[]) => ancestorsOf(path).filter((node) => styleOf(node).transform !== undefined)

/** The insets the probe read on its most recent render. */
const lastSeenInsets = (): EdgeInsets | null => {
  const call = mockSeenInsets.mock.calls[mockSeenInsets.mock.calls.length - 1]
  if (!call) throw new Error('probe never rendered')
  return call[0]
}

// ------------------------------------------------------------------------------------------------- fixtures

const PORTRAIT_WINDOW = { width: 402, height: 874 }
// A phone held sideways: the OS is portrait-locked, so the physical insets stay top 62 (island) / bottom 34 (home bar).
const PHYSICAL_INSETS = { top: 62, right: 0, bottom: 34, left: 0 }
const TINTED: ViewStyle = { backgroundColor: 'rebeccapurple' }

beforeEach(() => {
  mockRotation = 0
  mockWindow = { ...PORTRAIT_WINDOW }
  mockInsets = { ...PHYSICAL_INSETS }
  for (const key of Object.keys(mockMounts)) delete mockMounts[key]
  for (const key of Object.keys(mockUnmounts)) delete mockUnmounts[key]
  mockSeenInsets.mockClear()
})

// ------------------------------------------------------------------------------------------------- the frame's geometry

describe('RotatedFrame: geometry', () => {
  it('has no transform anywhere at rotation 0, and the frame is a plain flex fill', async () => {
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    const { path, outer, inner } = frameOf()
    expect(transformedAncestors(path)).toHaveLength(0)
    // FakeLandscapeView puts the caller's flex:1 on the outer View; the inner one just fills it.
    expect(styleOf(outer)).toMatchObject({ flex: 1 })
    expect(styleOf(inner)).toMatchObject({ flexGrow: 1, flexShrink: 1 })
    expect(styleOf(inner).transform).toBeUndefined()
    // Not the absolutely positioned, swapped-footprint frame of a landscape hold.
    expect(styleOf(inner).position).toBeUndefined()
    expect(styleOf(inner).width).toBeUndefined()
  })

  it.each([
    [90, '90deg'],
    [-90, '-90deg']
  ] as const)('at %s the inner frame is the swapped 874x402 footprint, centred (left -236, top 236), turned %s', async (rotation, angle) => {
    mockRotation = rotation
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    const { outer, inner } = frameOf()
    // The outer View absolutely fills the (portrait) window; the inner one is what is sized, centred and rotated.
    expect(styleOf(outer)).toMatchObject({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 })
    expect(styleOf(inner)).toMatchObject({ position: 'absolute', width: 874, height: 402, left: -236, top: 236 })
    expect(styleOf(inner).transform).toEqual([{ rotate: angle }])
  })

  it('centres the swapped footprint for any window, not just the 402x874 one', async () => {
    mockRotation = 90
    mockWindow = { width: 430, height: 932 }
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    expect(styleOf(frameOf().inner)).toMatchObject({ width: 932, height: 430, left: (430 - 932) / 2, top: (932 - 430) / 2 })
  })

  it('at 180 applies a 180deg transform without touching the footprint', async () => {
    mockRotation = 180
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    const { outer, inner } = frameOf()
    expect(styleOf(outer)).toMatchObject({ flex: 1 })
    expect(styleOf(inner).transform).toEqual([{ rotate: '180deg' }])
    expect(styleOf(inner).position).toBeUndefined()
    expect(styleOf(inner).width).toBeUndefined()
    expect(styleOf(inner).height).toBeUndefined()
  })

  it('follows a rotation change in place: portrait -> landscape -> portrait', async () => {
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )
    expect(styleOf(frameOf().inner).transform).toBeUndefined()

    mockRotation = 90
    await screen.rerender(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )
    expect(styleOf(frameOf().inner)).toMatchObject({ width: 874, height: 402, transform: [{ rotate: '90deg' }] })

    mockRotation = 0
    await screen.rerender(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )
    expect(styleOf(frameOf().inner).transform).toBeUndefined()
    expect(styleOf(frameOf().inner).width).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------- the safe-area insets

describe('RotatedFrame: the safe-area insets its children see', () => {
  it('hands children the RAW insets by default (rotatedSafeArea omitted), at every rotation', async () => {
    for (const rotation of [0, 90, -90, 180] as const) {
      mockRotation = rotation
      mockSeenInsets.mockClear()
      await render(
        <RotatedFrame>
          <Probe />
        </RotatedFrame>
      )
      expect(lastSeenInsets()).toEqual(PHYSICAL_INSETS)
      await screen.unmount()
    }
  })

  it.each([0, 90, -90, 180] as const)('hands children the RAW insets with rotatedSafeArea={false} at %s', async (rotation) => {
    mockRotation = rotation
    await render(
      <RotatedFrame rotatedSafeArea={false}>
        <Probe />
      </RotatedFrame>
    )

    expect(lastSeenInsets()).toEqual({ top: 62, right: 0, bottom: 34, left: 0 })
  })

  it.each([
    ['0', 0, { top: 62, right: 0, bottom: 34, left: 0 }],
    ['+90 (physical top -> rotated left, physical bottom -> rotated right)', 90, { top: 0, right: 34, bottom: 0, left: 62 }],
    ['-90 (the mirror: physical top -> rotated right, physical bottom -> rotated left)', -90, { top: 0, right: 62, bottom: 0, left: 34 }],
    ['180 (top and bottom swap)', 180, { top: 34, right: 0, bottom: 62, left: 0 }]
  ] as const)('hands children rotateInsets(raw, rotation) with rotatedSafeArea at %s', async (_name, rotation, expected) => {
    mockRotation = rotation
    await render(
      <RotatedFrame rotatedSafeArea>
        <Probe />
      </RotatedFrame>
    )

    expect(lastSeenInsets()).toEqual(expected)
  })

  it('remaps the insets again when the rotation changes, without a new mount', async () => {
    await render(
      <RotatedFrame rotatedSafeArea>
        <Probe />
      </RotatedFrame>
    )
    expect(lastSeenInsets()).toEqual({ top: 62, right: 0, bottom: 34, left: 0 })

    mockRotation = 90
    await screen.rerender(
      <RotatedFrame rotatedSafeArea>
        <Probe />
      </RotatedFrame>
    )
    expect(lastSeenInsets()).toEqual({ top: 0, right: 34, bottom: 0, left: 62 })
    expect(mockMounts.probe).toBe(1)
  })

  it('keeps the SAME insets object across an unrelated re-render (memoised, so consumers do not churn)', async () => {
    mockRotation = 90
    const tree = (
      <RotatedFrame rotatedSafeArea>
        <Probe />
      </RotatedFrame>
    )
    await render(tree)
    const first = lastSeenInsets()

    await screen.rerender(
      <RotatedFrame rotatedSafeArea>
        <Probe />
      </RotatedFrame>
    )

    expect(lastSeenInsets()).toBe(first)
  })
})

// ------------------------------------------------------------------------------------------------- the Portal.Host

describe('RotatedFrame: portalHost', () => {
  it('renders a Paper Portal child and lands its content inside the frame (rotation 0)', async () => {
    await render(
      <RotatedFrame portalHost>
        <Probe />
        <PortalProbe />
      </RotatedFrame>
    )

    // Paper's Portal throws when there is no Portal.Host above it, so simply rendering proves a host exists...
    const roots = snapshot()
    const portal = pathOrFail('portal-content', roots)
    const { inner } = frameOf('probe', roots)
    // ...and where its content lands proves WHICH one: inside the frame, not at an app root.
    expect(portal).toContain(inner)
  })

  it.each([90, -90] as const)('at %s the portal content lands inside the ROTATED frame (the one carrying the transform)', async (rotation) => {
    mockRotation = rotation
    await render(
      <RotatedFrame portalHost>
        <Probe />
        <PortalProbe />
      </RotatedFrame>
    )

    const roots = snapshot()
    const { inner } = frameOf('probe', roots)
    const portal = pathOrFail('portal-content', roots)
    expect(styleOf(inner).transform).toEqual([{ rotate: `${rotation}deg` }])
    expect(portal).toContain(inner)
    // The nearest transformed ancestor of the portal content IS that frame - nothing else turns it.
    expect(transformedAncestors(portal)).toEqual([inner])
  })

  it('leaves the column (and the children in it) one View deep inside the host, so the content is unaffected by the host', async () => {
    await render(
      <RotatedFrame portalHost>
        <Probe />
      </RotatedFrame>
    )

    const { path, inner, column } = frameOf()
    expect(path).toContain(inner)
    // The column is still the probe's direct parent; the host only adds wrapper(s) between it and the frame.
    expect(styleOf(column)).toMatchObject({ width: '100%', alignSelf: 'center', flex: 1 })
    expect(path.indexOf(column)).toBeGreaterThan(path.indexOf(inner))
  })

  it('without portalHost there is no in-frame host: a Paper Portal has nowhere to mount and throws', async () => {
    // Nothing above the frame is a PaperProvider in this test, so a Portal with no Portal.Host beneath it can only fail.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let failure: unknown = null
    try {
      await render(
        <RotatedFrame>
          <PortalProbe />
        </RotatedFrame>
      )
    } catch (error) {
      failure = error
    } finally {
      errorSpy.mockRestore()
    }

    // React aggregates the errors thrown during the commit into an AggregateError whose own message is empty.
    expect(failure).not.toBeNull()
    const messages = failure instanceof AggregateError ? failure.errors.map((e: Error) => e.message) : [(failure as Error).message]
    expect(messages.some((message: string) => /forgot to wrap your root component/.test(message))).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------- the content column

describe('RotatedFrame: the content column', () => {
  it('is a full-width, centred, flex-filling column with no maxWidth when maxContentWidth is omitted', async () => {
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    const style = styleOf(frameOf().column)
    expect(style).toMatchObject({ width: '100%', alignSelf: 'center', flex: 1 })
    expect(style.maxWidth).toBeUndefined()
  })

  it('never caps the column in portrait, even when maxContentWidth is given', async () => {
    await render(
      <RotatedFrame maxContentWidth={640}>
        <Probe />
      </RotatedFrame>
    )

    const style = styleOf(frameOf().column)
    expect(style).toMatchObject({ width: '100%', alignSelf: 'center', flex: 1 })
    expect(style.maxWidth).toBeUndefined()
  })

  it('caps the column with maxWidth in the wide layout, and keeps it full-width/centred/flex', async () => {
    mockRotation = 90
    await render(
      <RotatedFrame maxContentWidth={640}>
        <Probe />
      </RotatedFrame>
    )

    expect(styleOf(frameOf().column)).toMatchObject({ width: '100%', alignSelf: 'center', flex: 1, maxWidth: 640 })
  })

  it('caps the column the same way in the rotated (wide) frame', async () => {
    mockRotation = 90
    await render(
      <RotatedFrame maxContentWidth={480} portalHost>
        <Probe />
      </RotatedFrame>
    )

    const { column, inner } = frameOf()
    expect(styleOf(column).maxWidth).toBe(480)
    // The cap belongs to the column, not the frame: the frame still spans the whole swapped footprint.
    expect(styleOf(inner).maxWidth).toBeUndefined()
    expect(styleOf(inner).width).toBe(874)
  })
})

// ------------------------------------------------------------------------------------------------- passThrough

describe('RotatedFrame: passThrough', () => {
  it.each([
    ['portrait', 0],
    ['landscape', 90]
  ] as const)("sets pointerEvents box-none on the frame's inner View AND the column in %s", async (_name, rotation) => {
    mockRotation = rotation
    await render(
      <RotatedFrame passThrough>
        <Probe />
      </RotatedFrame>
    )

    const { inner, column } = frameOf()
    expect(inner.props.pointerEvents).toBe('box-none')
    expect(column.props.pointerEvents).toBe('box-none')
  })

  it('also does so with a portal host in between', async () => {
    mockRotation = 90
    await render(
      <RotatedFrame passThrough portalHost>
        <Probe />
      </RotatedFrame>
    )

    const { inner, column } = frameOf()
    expect(inner.props.pointerEvents).toBe('box-none')
    expect(column.props.pointerEvents).toBe('box-none')
  })

  it.each([
    ['portrait', 0],
    ['landscape', 90]
  ] as const)('leaves pointerEvents undefined on the inner View and the column by default in %s', async (_name, rotation) => {
    mockRotation = rotation
    await render(
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )

    const { inner, column } = frameOf()
    expect(inner.props.pointerEvents).toBeUndefined()
    expect(column.props.pointerEvents).toBeUndefined()
  })
})

describe('FakeLandscapeView: passThrough on its own', () => {
  it.each([
    ['0', 0],
    ['+90', 90],
    ['-90', -90],
    ['180', 180]
  ] as const)('at %s: the inner View is box-none with passThrough, undefined without; the outer View is box-none either way', async (_name, rotation) => {
    await render(
      <FakeLandscapeView rotation={rotation} passThrough>
        <Probe />
      </FakeLandscapeView>
    )
    let { outer, inner } = frameOf()
    expect(outer.props.pointerEvents).toBe('box-none')
    expect(inner.props.pointerEvents).toBe('box-none')

    await screen.rerender(
      <FakeLandscapeView rotation={rotation} passThrough={false}>
        <Probe />
      </FakeLandscapeView>
    )
    ;({ outer, inner } = frameOf())
    expect(outer.props.pointerEvents).toBe('box-none')
    expect(inner.props.pointerEvents).toBeUndefined()

    await screen.rerender(
      <FakeLandscapeView rotation={rotation}>
        <Probe />
      </FakeLandscapeView>
    )
    ;({ outer, inner } = frameOf())
    expect(outer.props.pointerEvents).toBe('box-none')
    expect(inner.props.pointerEvents).toBeUndefined()
  })

  it.each([0, 90] as const)('applies its style prop to the inner View at %s', async (rotation) => {
    await render(
      <FakeLandscapeView rotation={rotation} style={TINTED}>
        <Probe />
      </FakeLandscapeView>
    )

    const { outer, inner } = frameOf()
    expect(styleOf(inner).backgroundColor).toBe('rebeccapurple')
    expect(styleOf(outer).backgroundColor).toBeUndefined()
  })
})

// ------------------------------------------------------------------------------------------------- tree stability

describe('RotatedFrame: one tree at every angle', () => {
  const ANGLES: ViewRotation[] = [0, 90, -90, 0, 180, 0]

  it.each([
    ['defaults', {}],
    ['every option', { rotatedSafeArea: true, portalHost: true, passThrough: true, maxContentWidth: 640 }]
  ] as const)('does not remount a child across 0 -> 90 -> -90 -> 0 -> 180 -> 0 (%s)', async (_name, props) => {
    const tree = () => (
      <RotatedFrame {...props}>
        <Probe />
      </RotatedFrame>
    )
    await render(tree())
    expect(mockMounts.probe).toBe(1)

    for (const rotation of ANGLES.slice(1)) {
      mockRotation = rotation
      await screen.rerender(tree())
      expect(mockMounts.probe).toBe(1)
      expect(mockUnmounts.probe ?? 0).toBe(0)
      expect(screen.getByTestId('probe')).toBeTruthy()
    }
  })

  it('keeps a Portal child mounted across rotations too (the host is not rebuilt)', async () => {
    const tree = () => (
      <RotatedFrame portalHost rotatedSafeArea>
        <Probe />
        <PortalProbe />
      </RotatedFrame>
    )
    await render(tree())
    expect(mockMounts['portal-content']).toBe(1)

    for (const rotation of ANGLES.slice(1)) {
      mockRotation = rotation
      await screen.rerender(tree())
    }

    expect(mockMounts['portal-content']).toBe(1)
    expect(mockUnmounts['portal-content'] ?? 0).toBe(0)
    expect(mockMounts.probe).toBe(1)
    expect(mockUnmounts.probe ?? 0).toBe(0)
  })

  it('keeps the identical host-element shape (outer View > inner View > ... > column > child) at every angle', async () => {
    const tree = () => (
      <RotatedFrame>
        <Probe />
      </RotatedFrame>
    )
    await render(tree())
    const depthAt0 = pathOrFail('probe').length

    for (const rotation of ANGLES.slice(1)) {
      mockRotation = rotation
      await screen.rerender(tree())
      expect(pathOrFail('probe')).toHaveLength(depthAt0)
    }
  })
})

// ------------------------------------------------------------------------------------------------- RotatedScreen

describe('RotatedScreen', () => {
  it('always mounts a Portal.Host inside the frame (a Portal child renders, inside the rotated frame)', async () => {
    mockRotation = 90
    await render(
      <RotatedScreen>
        <Probe />
        <PortalProbe />
      </RotatedScreen>
    )

    const roots = snapshot()
    const { inner } = frameOf('probe', roots)
    expect(styleOf(inner).transform).toEqual([{ rotate: '90deg' }])
    expect(pathOrFail('portal-content', roots)).toContain(inner)
  })

  it('passes rotatedSafeArea through: rotated insets when set, raw when not', async () => {
    mockRotation = 90
    await render(
      <RotatedScreen rotatedSafeArea>
        <Probe />
      </RotatedScreen>
    )
    expect(lastSeenInsets()).toEqual({ top: 0, right: 34, bottom: 0, left: 62 })

    await screen.rerender(
      <RotatedScreen>
        <Probe />
      </RotatedScreen>
    )
    expect(lastSeenInsets()).toEqual(PHYSICAL_INSETS)
  })

  it('passes maxContentWidth through to the column (in the wide layout, where it applies)', async () => {
    mockRotation = 90
    await render(
      <RotatedScreen maxContentWidth={640}>
        <Probe />
      </RotatedScreen>
    )

    expect(styleOf(frameOf().column)).toMatchObject({ width: '100%', alignSelf: 'center', flex: 1, maxWidth: 640 })
  })

  it('does not let touches fall through (a routed screen owns the whole screen)', async () => {
    await render(
      <RotatedScreen>
        <Probe />
      </RotatedScreen>
    )

    const { inner, column } = frameOf()
    expect(inner.props.pointerEvents).toBeUndefined()
    expect(column.props.pointerEvents).toBeUndefined()
  })

  it('does not remount its content across rotations', async () => {
    const tree = () => (
      <RotatedScreen rotatedSafeArea maxContentWidth={640}>
        <Probe />
      </RotatedScreen>
    )
    await render(tree())

    for (const rotation of [90, -90, 0, 180, 0] as const) {
      mockRotation = rotation
      await screen.rerender(tree())
    }

    expect(mockMounts.probe).toBe(1)
    expect(mockUnmounts.probe ?? 0).toBe(0)
  })
})
