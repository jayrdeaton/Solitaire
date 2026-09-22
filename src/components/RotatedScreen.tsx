import { rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { useIsFocused } from 'expo-router'
import { type ReactNode, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { Portal } from 'react-native-paper'
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context'

import { GameStatusBar } from './GameStatusBar'
import { RotatedGameView } from './RotatedGameView'

interface RotatedFrameProps {
  children: ReactNode
  /** Give everything inside the frame the safe-area insets already remapped onto the frame's own edges (see
   * @tastic/core's rotateInsets), so a component that reads `useSafeAreaInsets()` itself - a library screen,
   * Paper's Modal, the toaster - lands on the right edge when the frame is turned. Leave it off for a screen
   * that rotates the insets itself (Home, the games), which would otherwise rotate them twice. */
  rotatedSafeArea?: boolean
  /** Mount a Paper Portal.Host INSIDE the frame, so dialogs (Paper's Portal otherwise mounts at the APP ROOT,
   * outside the frame) are laid out and turned with it. The dialog must then be told `rotation={0}`. */
  portalHost?: boolean
  /** Let touches fall through the frame to whatever is beneath it (see RotatedGameView). */
  passThrough?: boolean
  /** Cap on the content column's width in the WIDE layout only (the rotated footprint is landscape), centred - a stats
   * list or a roster stretched across a 874pt-wide landscape screen reads badly. Portrait is never capped, so it
   * stays exactly what it was on an iPad or a desktop window. Omit for no cap. */
  maxContentWidth?: number
}

/** The visually-rotated frame every screen shares: the OS stays portrait-locked and the frame is turned to
 * follow the phone (see RotatedGameView), with the tree kept IDENTICAL at every ROTATION angle, so a rotation never
 * remounts what is inside. The structure is `RotatedGameView > [SafeArea provider] > [Portal.Host] > column`;
 * `rotatedSafeArea`, `passThrough` and `maxContentWidth` only change styles and values, but `portalHost` adds or removes
 * the Portal.Host element, so it must be STATIC per call site (flipping it at runtime would remount everything inside). */
export function RotatedFrame({ children, rotatedSafeArea = false, portalHost = false, passThrough = false, maxContentWidth }: RotatedFrameProps) {
  const rotation = useRotation()
  const { width, height } = useRotatedWindowDimensions()
  const rawInsets = useSafeAreaInsets()
  const insets = useMemo(() => (rotatedSafeArea ? rotateInsets(rawInsets, rotation) : rawInsets), [rotatedSafeArea, rawInsets, rotation])
  const cappedWidth = maxContentWidth !== undefined && width > height ? maxContentWidth : undefined
  const column = (
    <View style={[styles.column, cappedWidth !== undefined && { maxWidth: cappedWidth }]} pointerEvents={passThrough ? 'box-none' : undefined}>
      {children}
    </View>
  )

  return (
    <RotatedGameView style={styles.root} passThrough={passThrough}>
      <SafeAreaInsetsContext.Provider value={insets}>{portalHost ? <Portal.Host>{column}</Portal.Host> : column}</SafeAreaInsetsContext.Provider>
    </RotatedGameView>
  )
}

/** The status bar for a routed screen that rotates: mounted only while that screen is focused. A screen stays
 * mounted beneath whatever is pushed over it, and expo-status-bar keeps a mount-order stack of props (latest
 * mounted wins), so a covered screen's hidden bar would stay hidden over a screen that has its own say. Its own
 * leaf, so a focus flip re-renders just this. */
function FocusedStatusBar() {
  return useIsFocused() ? <GameStatusBar /> : null
}

/** A routed screen (Home, Achievements, Profiles) that rotates with the phone: the focus-gated status bar plus
 * the rotated frame with its own Portal.Host. Game screens get the same frame from withGameProviders. */
export function RotatedScreen({ children, rotatedSafeArea, maxContentWidth }: Pick<RotatedFrameProps, 'children' | 'rotatedSafeArea' | 'maxContentWidth'>) {
  return (
    <>
      <FocusedStatusBar />
      <RotatedFrame portalHost rotatedSafeArea={rotatedSafeArea} maxContentWidth={maxContentWidth}>
        {children}
      </RotatedFrame>
    </>
  )
}

const styles = StyleSheet.create({
  // A centred column: full width up to `maxWidth`, so a capped screen sits in the middle of a wider frame.
  column: {
    alignSelf: 'center',
    flex: 1,
    width: '100%'
  },
  root: {
    flex: 1
  }
})
