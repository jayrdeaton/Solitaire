import { layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createGolfController } from './rules'

export function buildGolfPreview(): PreviewCardPlacement[] {
  const state = createGolfController(false).newGame(PREVIEW_SEED)
  return layoutColumns(state.tableau)
}
