import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createScorpionController } from './rules'

export function buildScorpionPreview(): PreviewCardPlacement[] {
  const state = createScorpionController(true).newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
