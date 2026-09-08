import { ComponentType } from 'react'

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
 */
export function withGameProviders(Inner: ComponentType): ComponentType {
  return function GameScreen() {
    return (
      <DealProvider>
        <DragGhostProvider>
          <WinCascadeProvider>
            <Inner />
          </WinCascadeProvider>
        </DragGhostProvider>
      </DealProvider>
    )
  }
}
