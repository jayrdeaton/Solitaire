import { layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createSpiderController } from './rules'

export function buildSpiderPreview(): PreviewCardPlacement[] {
  const state = createSpiderController(1).newGame(PREVIEW_SEED)
  return layoutColumns(state.tableau)
}
