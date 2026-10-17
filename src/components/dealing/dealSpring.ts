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

/** The stagger a FACE-UP card flight is given once it is paced by paceFaceUpDeal (never tighter than the flight it follows).
 * The compressed initial-deal stagger (dealStaggerMs, ~18ms for 52 cards) is fine for face-down backs, which are all
 * identical, but a face-up ghost is a distinct, readable card: at ~18ms apart the flights blur into a smear of faces.
 * 44 rather than a rounder 40 was picked when every card clicked and buzzed, each throttled to one per 40ms: a stagger exactly ON
 * that boundary let timer jitter drop a click here and a buzz there. A deal now clicks and buzzes on its own beat instead
 * (DealLayer.tsx's dealBeatTicks: every second face-up card at this pace). */
export const FACE_UP_STAGGER_MS = 44
/** How long a deal made of face-up flights may take, first card leaving to last card landing - deliberately longer than
 * DEAL_TARGET_TOTAL_MS, since a face-up card is worth seeing land. paceFaceUpDeal spends up to this much, and no more.
 * Reverted a same-day 2000 -> 2300 (+15%) bump: real screen-recording evidence (frame-by-frame, on the Simulator) showed
 * that stretching this total did NOT smooth out the deal - it only spaced the same per-card stutter further apart, which
 * reads as a MORE isolated, more noticeable judder rather than fewer/smaller ones, while also making the whole deal take
 * longer. The actual stutter comes from GhostSlot's per-launch face mount/commit cost (a court card is ~100-150 SVG
 * nodes), which no amount of rescheduling fixes - see the "Face-up deals are slower on purpose" and "Known remaining
 * costs" sections of .claude/CLAUDE.md, and the pre-launch face-seeding fix landing alongside this revert. Settings' own
 * Reduce Motion toggle (types/index.ts) remains the real escape hatch for anyone who'd rather skip the wait
 * entirely - it does NOT license creeping the default total back up; do that only with real on-device evidence it helps. */
export const FACE_UP_TARGET_TOTAL_MS = 2000

/** Slows the FACE-UP part of an initial deal (FreeCell, Yukon's second phase, Forty Thieves, Golf) to FACE_UP_STAGGER_MS per
 * card - or, when that would run past FACE_UP_TARGET_TOTAL_MS, as close to it as fits - and leaves every face-down flight's
 * timing exactly as it was.
 *
 * Entries are grouped by their delayMs (cards that leave together stay together); a group is face-up if ANY card in it flies
 * face-up (`card` is the FLOWN face, so a game that forces its down cards face-down before this point is read correctly).
 * Only the gap in front of a face-up group is stretched: a gap never shrinks, so a deal that is already slower than the
 * face-up pace is returned unchanged, and everything after a stretched gap shifts later by the same amount. The very first
 * group has no gap and keeps its delay.
 *
 * Returns the SAME array when there is nothing to pace (empty, or no face-up group after the first); otherwise new entry
 * objects in the original order - the input is never mutated. */
export function paceFaceUpDeal<T extends { delayMs: number; card: { faceUp: boolean } }>(entries: T[]): T[] {
  const groupIsUp = new Map<number, boolean>()
  entries.forEach((entry) => groupIsUp.set(entry.delayMs, (groupIsUp.get(entry.delayMs) ?? false) || entry.card.faceUp))
  const delays = [...groupIsUp.keys()].sort((a, b) => a - b)

  // Time the face-down groups already take (their own gaps, which stay as they are), and how many gaps are up for stretching.
  let downTime = 0
  let upGaps = 0
  for (let i = 1; i < delays.length; i++) {
    if (groupIsUp.get(delays[i])) upGaps += 1
    else downTime += delays[i] - delays[i - 1]
  }
  if (upGaps === 0) return entries

  const upGap = Math.max(0, Math.min(FACE_UP_STAGGER_MS, (FACE_UP_TARGET_TOTAL_MS - (DEAL_SPRING.duration ?? 0) - downTime) / upGaps))

  // Every group moves by the total extra time added in front of it, so an unstretched group lands on its ORIGINAL delay
  // exactly (no float drift from re-summing gaps) and ties can never be split.
  const paced = new Map<number, number>()
  let shift = 0
  delays.forEach((delay, i) => {
    if (i > 0 && groupIsUp.get(delay)) shift += Math.max(0, upGap - (delay - delays[i - 1]))
    paced.set(delay, delay + shift)
  })
  return entries.map((entry) => ({ ...entry, delayMs: paced.get(entry.delayMs) ?? entry.delayMs }))
}
