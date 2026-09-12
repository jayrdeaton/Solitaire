import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/GamePreview'

import { createCanfieldController } from './rules'

export function buildCanfieldPreview(): PreviewCardPlacement[] {
  const state = createCanfieldController(3).newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
