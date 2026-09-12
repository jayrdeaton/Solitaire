import { centerVertically, layoutColumns, PREVIEW_SEED, type PreviewCardPlacement } from '@/components/GamePreview'

import { createKlondikeController } from './rules'

export function buildKlondikePreview(): PreviewCardPlacement[] {
  const state = createKlondikeController(1).newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.tableau, 0))
}
