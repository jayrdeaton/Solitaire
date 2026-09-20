import { WithSpringConfig } from 'react-native-reanimated'

/** Same critically-damped, no-overshoot feel as dragdrop/dragSpring.ts's AUTO_MOVE_SPRING
 * (dampingRatio 1 + overshootClamping), tuned shorter for a snappy "real dealer" pace across many
 * overlapping simultaneous flights. */
export const DEAL_SPRING: WithSpringConfig = { duration: 280, dampingRatio: 1, overshootClamping: true }

/** Delay between each successive card's flight start, in visit order. With DEAL_SPRING's 280ms
 * flight and 28 cards, total deal time is (28-1)*35 + 280 ≈ 1.2s, with ~8 cards in flight at any
 * instant - reads as a fast, energetic dealer rather than one-at-a-time. */
export const DEAL_STAGGER_MS = 35

/** How long a whole initial deal is allowed to take, first card leaving to last card landing. A fixed per-card stagger
 * made a 52-card deal (FreeCell, Yukon, Spider, Scorpion) run ~2.1s with the board locked until it finished, versus
 * ~1.2s for a 28-card one - the wait read as "slow to get into a game". */
export const DEAL_TARGET_TOTAL_MS = 1200
/** Floor for the compressed stagger, so a very large deal still reads as one card after another, not a single blur. */
export const DEAL_MIN_STAGGER_MS = 14

/** The stagger for an initial deal of `cardCount` cards: DEAL_STAGGER_MS, tightened just enough that the deal fits
 * DEAL_TARGET_TOTAL_MS (deals of ~28 cards or fewer keep - or all but keep - the original pace). Use this for the
 * initial deal only; stock draws and undo flights are a handful of cards and keep DEAL_STAGGER_MS. */
export function dealStaggerMs(cardCount: number): number {
  if (cardCount <= 1) return DEAL_STAGGER_MS
  const staggerSpan = DEAL_TARGET_TOTAL_MS - (DEAL_SPRING.duration ?? 0)
  return Math.max(DEAL_MIN_STAGGER_MS, Math.min(DEAL_STAGGER_MS, staggerSpan / (cardCount - 1)))
}
