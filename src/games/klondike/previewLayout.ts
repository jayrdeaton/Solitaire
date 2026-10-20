import { layoutColumns, PREVIEW_SEED, type PreviewCardPlacement } from '@/components/previewCanvas'

import { createKlondikeController } from './rules'

export function buildKlondikePreview(): PreviewCardPlacement[] {
  const state = createKlondikeController(1).newGame(PREVIEW_SEED)
  return layoutColumns(state.tableau)
}
