import { FakeLandscapeView } from '@tastic/core'
import { ComponentType } from 'react'
import { StyleSheet } from 'react-native'
import { Portal } from 'react-native-paper'

import { DealProvider } from '@/components/dealing/DealLayer'
import { DragGhostProvider } from '@/components/dragdrop/DragGhostLayer'
import { HintGlideProvider } from '@/components/hinting/HintGlideLayer'
import { WinCascadeProvider } from '@/components/winning/WinCascadeLayer'

/**
 * Wraps a game's own "Inner" screen component in the three providers every game needs, in the
 * same fixed order: DealProvider outermost (the initial-deal animation engine - see
 * components/dealing/DealLayer.tsx), DragGhostProvider next (the Inner component itself calls
 * useDragGhost() to drive its own tap-to-move/drag flights, not just its PileView/DraggableCard
 * children), WinCascadeProvider innermost. Byte-identical across all four games before this
 * extraction.
 *
 * @tastic/core's FakeLandscapeView (one element tree at every angle, so a rotation never remounts the
 * board) wraps OUTSIDE all three - not just around Inner - because DealProvider and DragGhostProvider each render
 * their own screen-level ghost-overlay View as a sibling of `{children}`, one level outside anything
 * Inner itself can reach (see DealLayer.tsx/DragGhostLayer.tsx's own always-mounted overlay views).
 * Wrapping only Inner would leave a card mid-drag or mid-deal rendering unrotated while the board
 * underneath it rotates - a visible, jarring break, not a subtle one. Those overlays convert their
 * screen-space positions into the rotated frame themselves - see overlayFrame.ts. This is every game
 * screen's own entire exported component (src/app/<game>.tsx re-exports withGameProviders(Inner)
 * directly), so this one wrapper is what gives a game screen the rotation. Home, Achievements and Profiles
 * get the same frame from RotatedScreen (components/RotatedScreen.tsx: @tastic/hud's RotatedFrame, which is a
 * FakeLandscapeView + a Portal.Host), and the root layout's toaster/update dialog from RotatedFrame - so nothing in
 * the app is left in physical portrait. The status bar hides while the frame is turned from the root Stack's screen
 * options (_layout.tsx's ThemedStack), not from here.
 *
 * The Portal.Host sits inside FakeLandscapeView and OUTSIDE the three providers, for two reasons. (1) The
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
 * HintGlideProvider (the Hint button's see-through glide, components/hinting/HintGlideLayer.tsx) sits innermost, so its
 * overlay paints over the board but under every real flight's ghost.
 *
 */
export function withGameProviders(Inner: ComponentType): ComponentType {
  return function GameScreen() {
    return (
      <FakeLandscapeView style={styles.root}>
        <Portal.Host>
          <DealProvider>
            <DragGhostProvider>
              <WinCascadeProvider>
                <HintGlideProvider>
                  <Inner />
                </HintGlideProvider>
              </WinCascadeProvider>
            </DragGhostProvider>
          </DealProvider>
        </Portal.Host>
      </FakeLandscapeView>
    )
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  }
})
