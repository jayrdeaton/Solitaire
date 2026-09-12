import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/GamePreview'

import { createGolfController } from './rules'

export function buildGolfPreview(): PreviewCardPlacement[] {
  const state = createGolfController(false).newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
