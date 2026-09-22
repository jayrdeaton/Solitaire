import { rotateDimensions, toRotationStyle, useRotation } from '@tastic/core'
import { ReactNode } from 'react'
import { StyleProp, StyleSheet, useWindowDimensions, View, ViewStyle } from 'react-native'

interface RotatedGameViewProps {
  style?: StyleProp<ViewStyle>
  /** Lets touches fall through the frame's own (full-screen) box to whatever is beneath it, so only its
   * children claim them. For a frame laid OVER other screens (the root-level toaster/update dialog) - a game
   * screen owns the whole screen and leaves this off. */
  passThrough?: boolean
  children: ReactNode
}

/** Drop-in for @tastic/core's FakeLandscapeView that keeps its element tree IDENTICAL at every
 * rotation angle, changing only styles.
 *
 * FakeLandscapeView returns a different tree per angle - `<View>{children}</View>` at 0deg or 180deg,
 * `<View><View>{children}</View></View>` at +/-90deg - and React reconciles by position/type, so the
 * moment the phone goes from portrait to landscape (or back) it treats `children` as a brand-new
 * subtree: the ENTIRE game screen - every card, the deal/drag/cascade providers, and all of
 * Inner's own state (undo history, hint, selection) - is unmounted and mounted from scratch.
 * Measured live in the simulator: a rotation cost ~700-800ms of JS (a full remount) versus ~90ms for
 * a plain update, which read as the rotation being very slow to respond - and silently wiped the
 * undo stack and any in-flight animation each time.
 *
 * Here the outer View is always `<View><View>{children}</View></View>` regardless of angle:
 *  - 0deg / 180deg: both are plain flex fills (the inner one also flipped at 180deg), exactly what
 *    FakeLandscapeView rendered.
 *  - +/-90deg: the outer one absolutely fills the window, and the inner one is sized to the
 *    swapped (landscape) footprint, centred, and rotated - the standard fake-landscape trick.
 * Uses the same useRotation()/rotateDimensions math FakeLandscapeView does, so anything reading
 * useRotatedWindowDimensions() elsewhere still sees exactly the footprint rendered here. */
export function RotatedGameView({ style, passThrough = false, children }: RotatedGameViewProps) {
  const innerPointerEvents = passThrough ? 'box-none' : undefined
  const { width, height } = useWindowDimensions()
  const rotation = useRotation()

  if (Math.abs(rotation) === 90) {
    const swapped = rotateDimensions(width, height, rotation)
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents='box-none'>
        <View style={[style, styles.absolute, { height: swapped.height, left: (width - swapped.width) / 2, top: (height - swapped.height) / 2, width: swapped.width }, toRotationStyle(rotation)]} pointerEvents={innerPointerEvents}>
          {children}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.fill} pointerEvents='box-none'>
      <View style={[style, toRotationStyle(rotation)]} pointerEvents={innerPointerEvents}>
        {children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  absolute: {
    position: 'absolute'
  },
  fill: {
    flex: 1
  }
})
