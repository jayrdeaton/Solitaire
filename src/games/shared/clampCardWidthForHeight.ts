/**
 * Clamps a width-derived card width so the resulting board height never exceeds `availableHeight` -
 * for a board whose height is a pure function of cardWidth with no PileView/compression mechanism to
 * fall back on (Pyramid's triangle, TriPeaks' 3-peak board). Both compute their own board height as
 * `deepestRowIndex * cardHeight * faceUpOffsetRatio + cardHeight` (cardHeight = cardWidth / cardAspect)
 * - Pyramid's deepestRowIndex is ROWS-1, TriPeaks' is 3 - so solving that equation for the largest
 * cardWidth whose height still fits `availableHeight` is the same formula either way, just fed a
 * different constant. Kept as one shared function (not per-game copies the way dealSequence.ts is)
 * since this is genuinely the same equation, not just superficially similar per-game logic.
 *
 * 28 mirrors @tastic/cards' own cardWidthForRow default minimum, so this can never push cardWidth
 * below what the width-only path already guarantees as a floor - a landscape hold with almost no
 * vertical room left still renders visible, tappable cards rather than shrinking toward zero.
 */
export function clampCardWidthForHeight(widthCardWidth: number, availableHeight: number, deepestRowIndex: number, faceUpOffsetRatio: number, cardAspect: number): number {
  const heightDerivedCardWidth = (availableHeight * cardAspect) / (deepestRowIndex * faceUpOffsetRatio + 1)
  return Math.max(28, Math.min(widthCardWidth, heightDerivedCardWidth))
}
