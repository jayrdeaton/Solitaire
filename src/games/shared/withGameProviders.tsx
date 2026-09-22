import { ComponentType } from 'react'
import { StyleSheet } from 'react-native'
import { Portal } from 'react-native-paper'

import { DealProvider } from '@/components/dealing/DealLayer'
import { DragGhostProvider } from '@/components/dragdrop/DragGhostLayer'
import { GameStatusBar } from '@/components/GameStatusBar'
import { RotatedGameView } from '@/components/RotatedGameView'
import { WinCascadeProvider } from '@/components/winning/WinCascadeLayer'

/**
 * Wraps a game's own "Inner" screen component in the three providers every game needs, in the
 * same fixed order: DealProvider outermost (the initial-deal animation engine - see
 * components/dealing/DealLayer.tsx), DragGhostProvider next (the Inner component itself calls
 * useDragGhost() to drive its own tap-to-move/drag flights, not just its PileView/DraggableCard
 * children), WinCascadeProvider innermost. Byte-identical across all four games before this
 * extraction.
 *
 * RotatedGameView (this app's stable-structure stand-in for @tastic/core's FakeLandscapeView) wraps
 * OUTSIDE all three - not just around Inner - because DealProvider and DragGhostProvider each render
 * their own screen-level ghost-overlay View as a sibling of `{children}`, one level outside anything
 * Inner itself can reach (see DealLayer.tsx/DragGhostLayer.tsx's own always-mounted overlay views).
 * Wrapping only Inner would leave a card mid-drag or mid-deal rendering unrotated while the board
 * underneath it rotates - a visible, jarring break, not a subtle one. Those overlays convert their
 * screen-space positions into the rotated frame themselves - see overlayFrame.ts. This is every game
 * screen's own entire exported component (src/app/<game>.tsx re-exports withGameProviders(Inner)
 * directly), so this one wrapper is what gives a game screen the rotation. Home, Achievements and Profiles
 * get the same frame from RotatedScreen (components/RotatedScreen.tsx: RotatedGameView + a Portal.Host + a focus-gated
 * status bar), and the root layout's toaster/update dialog from RotatedFrame - so nothing in the app is left in
 * physical portrait.
 *
 * The Portal.Host sits inside RotatedGameView and OUTSIDE the three providers, for two reasons. (1) The
 * game's dialogs (Settings, Rules, the New Game confirm) render through Paper's Portal, which by default
 * mounts at the APP ROOT - outside the rotated frame - so each had to rotate itself with a transform while
 * its layout (a `maxHeight: '90%'` sheet, etc.) was still resolved against the PORTRAIT window: once
 * turned 90 degrees a ~790pt-tall dialog ran off a 402pt-wide screen and the Settings sheet lost its
 * first row (Lock Orientation - the one you need to get OUT of landscape) with no way to scroll to it.
 * Hosted here they lay out against the rotated size and take rotation={0}. (2) A Portal.Host draws its
 * portals as a LATER sibling of its children, so putting it outside the providers keeps the dialogs
 * painting above the deal/drag ghost overlays and DealLayer's full-screen skip-tap layer (which are
 * later siblings of Inner) - a host inside GameChrome would have put them below those.
 *
 * GameStatusBar sits beside it (it renders nothing itself) so the OS status bar hides exactly when
 * the board is rotated - see its own doc comment.
 */
export function withGameProviders(Inner: ComponentType): ComponentType {
  return function GameScreen() {
    return (
      <>
        <GameStatusBar />
        <RotatedGameView style={styles.root}>
          <Portal.Host>
            <DealProvider>
              <DragGhostProvider>
                <WinCascadeProvider>
                  <Inner />
                </WinCascadeProvider>
              </DragGhostProvider>
            </DealProvider>
          </Portal.Host>
        </RotatedGameView>
      </>
    )
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  }
})
