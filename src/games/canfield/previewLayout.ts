import { layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { createCanfieldController } from './rules'

export function buildCanfieldPreview(): PreviewCardPlacement[] {
  const state = createCanfieldController(3).newGame(PREVIEW_SEED)
  return layoutColumns(state.tableau)
}
