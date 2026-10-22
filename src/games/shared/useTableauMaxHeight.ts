import { CARD_ASPECT } from '@tastic/cards'

import { TABLEAU_ROW_PADDING_BOTTOM, TOP_ROW_MARGIN_BOTTOM, useGameLayout } from '@/components/gameLayout'

/**
 * Computes how tall a tableau column's card fan is allowed to grow before PileView starts
 * compressing it (see PileView's own `maxHeight` prop), from the real window height - the same
 * "derive from useWindowDimensions() instead of a fixed pixel constant" idiom card WIDTH already
 * uses (see cardWidthForRow()/computeContentBounds()).
 *
 * No floor, in either layout: the board fits the screen exactly, and a column that would have to
 * compress past its tightest (columnTops' MIN_FACE_UP_FAN_SCALE) runs past this instead, with GameChrome's board scrolling to
 * it. The per-game floors this used to take (each game's old fixed TABLEAU_MAX_HEIGHT, 300-460pt) made
 * every column box taller than a short phone's screen (an iPhone SE, a 640pt Android), so the board
 * scrolled there from the first deal, with every column short.
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
export function useTableauMaxHeight(cardWidth: number, opts?: { topRowCards?: number }): number {
  const { availableHeight } = useGameLayout()
  return Math.max(0, tableauMaxHeightFor(availableHeight, cardWidth, opts?.topRowCards ?? 1))
}
