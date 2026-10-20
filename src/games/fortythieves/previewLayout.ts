import { layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createFortyThievesController } from './rules'

export function buildFortyThievesPreview(): PreviewCardPlacement[] {
  const state = createFortyThievesController(false).newGame(PREVIEW_SEED)
  return layoutColumns(state.tableau)
}
