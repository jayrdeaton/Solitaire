import { centerVertically, layoutColumns, PREVIEW_SEED, PreviewCardPlacement } from '@/components/GamePreview'

import { AcesUpController } from './rules'

export function buildAcesUpPreview(): PreviewCardPlacement[] {
  const state = AcesUpController.newGame(PREVIEW_SEED)
  return centerVertically(layoutColumns(state.piles, 0))
}
