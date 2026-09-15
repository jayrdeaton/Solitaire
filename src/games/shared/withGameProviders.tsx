import { FakeLandscapeView } from '@tastic/core'
import { ComponentType } from 'react'
import { StyleSheet } from 'react-native'

import { DealProvider } from '@/components/dealing/DealLayer'
import { DragGhostProvider } from '@/components/dragdrop/DragGhostLayer'
import { WinCascadeProvider } from '@/components/winning/WinCascadeLayer'

/**
 * Wraps a game's own "Inner" screen component in the three providers every game needs, in the
 * same fixed order: DealProvider outermost (the initial-deal animation engine - see
 * components/dealing/DealLayer.tsx), DragGhostProvider next (the Inner component itself calls
 * useDragGhost() to drive its own tap-to-move/drag flights, not just its PileView/DraggableCard
 * children), WinCascadeProvider innermost. Byte-identical across all four games before this
 * extraction.
 *
 * FakeLandscapeView wraps OUTSIDE all three - not just around Inner - because DealProvider and
 * DragGhostProvider each render their own screen-level ghost-overlay View as a sibling of
 * `{children}`, one level outside anything Inner itself can reach (see DealLayer.tsx/
 * DragGhostLayer.tsx's own always-mounted overlay views). Wrapping only Inner would leave a card
 * mid-drag or mid-deal rendering unrotated while the board underneath it rotates - a visible,
 * jarring break, not a subtle one. This is every game screen's own entire exported component
 * (src/app/<game>.tsx re-exports withGameProviders(Inner) directly), so this one wrapper is what
 * scopes the whole feature to gameplay screens - menus/achievements/profiles/settings, which never
 * call withGameProviders, are untouched by it.
 */
export function withGameProviders(Inner: ComponentType): ComponentType {
  return function GameScreen() {
    return (
      <FakeLandscapeView style={styles.root}>
        <DealProvider>
          <DragGhostProvider>
            <WinCascadeProvider>
              <Inner />
            </WinCascadeProvider>
          </DragGhostProvider>
        </DealProvider>
      </FakeLandscapeView>
    )
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  }
})
