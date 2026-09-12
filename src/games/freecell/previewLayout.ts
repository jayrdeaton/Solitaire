import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/GamePreview'

import { FreeCellController } from './rules'

export function buildFreeCellPreview(): PreviewCardPlacement[] {
  const state = FreeCellController.newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
