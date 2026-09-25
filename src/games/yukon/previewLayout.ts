import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createYukonController } from './rules'

export function buildYukonPreview(): PreviewCardPlacement[] {
  const state = createYukonController().newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
