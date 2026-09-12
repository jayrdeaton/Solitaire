import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/GamePreview'

import { createFortyThievesController } from './rules'

export function buildFortyThievesPreview(): PreviewCardPlacement[] {
  const state = createFortyThievesController(false).newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
