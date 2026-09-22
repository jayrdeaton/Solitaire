import { render, screen } from '@testing-library/react-native'
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native'
import { IconButton } from 'react-native-paper'

// ---------------------------------------------------------------------------------------------------------------------
// The root cause behind Home's corner-button wrapper (see the cornerButtons comment in src/app/index.tsx), pinned against
// the REAL react-native-paper: an IconButton is a Surface, and on iOS Surface splits its style over TWO views - only
// position/top/left/.../transform/opacity/margins go to the OUTER one, everything else (zIndex included) stays on the INNER
// one. zIndex only orders siblings of ONE parent on native, so a zIndex on the inner layer is stacked inside the outer
// layer and never lifts the button above a later sibling: an IconButton with `style={{ zIndex: 10 }}` is still at 0 among
// its siblings and (when a full-screen ScrollView follows it) never receives a touch. If a Paper upgrade ever moves zIndex
// onto the outer layer this test fails - at which point the wrapper View in Home is no longer needed (and this file can go).
// ---------------------------------------------------------------------------------------------------------------------

const CORNER = StyleSheet.create({ corner: { left: 8, position: 'absolute', top: 8, zIndex: 10 } }).corner

const styleOf = (node: { props: { style?: unknown } }): ViewStyle => StyleSheet.flatten(node.props.style as ViewStyle) ?? {}

describe('Paper IconButton on iOS: where a zIndex ends up', () => {
  it('runs on the iOS Surface path in jest-expo (the two-layer one)', () => {
    expect(Platform.OS).toBe('ios')
  })

  it('keeps position/top/left on the OUTER layer but leaves zIndex on the INNER one', async () => {
    await render(<IconButton icon='cog' onPress={() => {}} style={CORNER} />)

    const outer = styleOf(screen.getByTestId('icon-button-container-outer-layer'))
    const inner = styleOf(screen.getByTestId('icon-button-container'))

    // Placement is hoisted to the outermost view...
    expect(outer.position).toBe('absolute')
    expect(outer.top).toBe(8)
    expect(outer.left).toBe(8)
    // ...but the stacking is not: the outer view (the only one that is a sibling of the ScrollView) has none.
    expect(outer.zIndex).toBeUndefined()
    expect(inner.zIndex).toBe(10)
    // And the inner layer is left in normal flow inside it - the placement did not stay behind.
    expect(inner.position).toBeUndefined()
  })

  it('is why a zIndex has to sit on a plain View around the button instead', async () => {
    // The contrast case: the same style on a plain View stays on that one view, which IS the sibling being ordered.
    await render(<View testID='plain' style={CORNER} />)

    const plain = styleOf(screen.getByTestId('plain'))
    expect(plain.position).toBe('absolute')
    expect(plain.zIndex).toBe(10)
  })
})
