import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { FreeCellController } from './rules'

export function buildFreeCellPreview(): PreviewCardPlacement[] {
  const state = FreeCellController.newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
