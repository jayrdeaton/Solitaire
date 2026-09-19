import { CARD_ASPECT } from '@tastic/cards'

import { TABLEAU_ROW_PADDING_BOTTOM, TOP_ROW_MARGIN_BOTTOM, useGameLayout } from '@/components/gameLayout'

/**
 * Computes how tall a tableau column's card fan is allowed to grow before PileView starts
 * compressing it (see PileView's own `maxHeight` prop), from the real window height - the same
 * "derive from useWindowDimensions() instead of a fixed pixel constant" idiom card WIDTH already
 * uses (see cardWidthForRow()/computeContentBounds()), rather than a fixed per-game constant that
 * compresses a fan on a tall screen with plenty of room to spare.
 *
 * `floor` is each game's own previous fixed TABLEAU_MAX_HEIGHT value, kept as a lower bound so a
 * short/cramped screen never gets less generous than it did before - only a screen with real
 * headroom to spare gets more of it.
 *
 * topRow is exactly one card tall on every screen that calls this (confirmed across Klondike,
 * Yukon, FreeCell, Canfield, Golf), so its height is derived from `cardWidth` via CARD_ASPECT
 * (same pattern PyramidScreen already uses for its own analytic layout) rather than measured live
 * - avoiding the onLayout-vs-mount-commit race the deal animation elsewhere in this app had to
 * work around for a very different reason (see this app's CLAUDE.md).
 *
 * Reads useGameLayout() (rotated window dimensions + rotated insets + the portrait/wide chrome
 * reservation - see gameLayout.ts), so a screen rendered inside a rotated ancestor gets a height
 * budget for its own actual, post-rotation footprint - and, unchanged, the plain portrait numbers
 * everywhere else.
 */
export function tableauMaxHeightFor(availableHeight: number, cardWidth: number, topRowCards = 1): number {
  const topRowHeight = topRowCards * (cardWidth / CARD_ASPECT)
  const topRowMargin = topRowCards > 0 ? TOP_ROW_MARGIN_BOTTOM : 0
  return availableHeight - topRowHeight - topRowMargin - TABLEAU_ROW_PADDING_BOTTOM
}

/** `opts.topRowCards` (default 1 = every existing caller, unchanged): how many card-heights tall the
 * row above the tableau is - 0 for a board that draws none (Scorpion's wide layout). */
export function useTableauMaxHeight(cardWidth: number, floor: number, opts?: { topRowCards?: number }): number {
  const { isWide, availableHeight } = useGameLayout()
  const available = tableauMaxHeightFor(availableHeight, cardWidth, opts?.topRowCards ?? 1)
  // The wide (landscape) layout has no floor: `floor` is each game's portrait-tuned lower bound
  // (~300-460pt), and a landscape window is only ~402pt tall in total - honouring it there is exactly
  // what pushed the playable bottom cards off the edge of the screen. There the cards are sized to fit
  // (see fitCardWidthToHeight), and a column that still runs long compresses like any other.
  return isWide ? Math.max(0, available) : Math.max(floor, available)
}
