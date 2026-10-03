/* ---------------------------------------------------------------------------------------------
 * Home's hero fan (HeroCards.tsx): where each card rests and how the idle wave moves it.
 *
 * Dependency-free (no React, Reanimated or theme imports) so homeLayout.ts can size the landscape
 * left pane from the very numbers the fan is drawn with, instead of a hand-copied span/height.
 * ------------------------------------------------------------------------------------------- */

/** theme.ts's CARD_WIDTH/CARD_HEIGHT (the hero's natural card size), repeated here so this module stays
 * import-free - heroFan.test.ts fails if the two ever differ. */
export const HERO_CARD_WIDTH = 64
export const HERO_CARD_HEIGHT = 93

export const HERO_CARD_COUNT = 5
const HERO_CENTER_INDEX = (HERO_CARD_COUNT - 1) / 2

// The fan is a real hand of cards: every card turns about ONE shared pivot below the fan, so their
// tops trace a circle (radius HERO_FAN_PIVOT_PX + half a card) rather than a straight-sided tent.
// The old fan spaced the cards evenly along the row and sank each one a flat 6pt per step out from the
// centre, so the tops ran in two straight lines - which with five cards read as a shallow "^", not
// an arc. Each step turns HERO_FAN_STEP_DEG further; the pivot distance was picked with the step so
// the fan keeps the old fan's ~250pt span (homeLayout.ts sizes the landscape left pane from it).
const HERO_FAN_STEP_DEG = 14
const HERO_FAN_PIVOT_PX = 160

export interface HeroFanCard {
  key: string
  /** Resting turn, positive = clockwise (the right half of the fan). */
  angleDeg: number
  /** Resting offset of the card's centre from the centre card's, in natural (scale 1) points. */
  x: number
  y: number
  /** The card's own "up" direction (away from the pivot), for moving it along its own axis. */
  outX: number
  outY: number
  /** Left-behind-right stacking, like a hand fanned out in the order it was picked up - not peaked at
   * the centre. It also keeps every card fully visible during its own bump: the wave sweeps left to
   * right in the same direction as the stack, so a card popping up is never tucked behind a
   * still-settling neighbour. */
  zIndex: number
  /** This card's place in the left-to-right sequence (0-based): the entrance and the wave both use it. */
  turnIndex: number
}

export const HERO_FAN_CARDS: HeroFanCard[] = Array.from({ length: HERO_CARD_COUNT }, (_, i) => {
  const angleDeg = (i - HERO_CENTER_INDEX) * HERO_FAN_STEP_DEG
  const angle = (angleDeg * Math.PI) / 180
  return {
    key: `card-${i}`,
    angleDeg,
    x: HERO_FAN_PIVOT_PX * Math.sin(angle),
    y: HERO_FAN_PIVOT_PX * (1 - Math.cos(angle)),
    outX: Math.sin(angle),
    outY: -Math.cos(angle),
    zIndex: i + 1,
    turnIndex: i
  }
})

// The resting fan's bounding box around the centre card's centre: each card is a turned rectangle, so
// its half-extents are (w cos + h sin) / 2 across and (w sin + h cos) / 2 down.
function restingBounds() {
  let halfSpan = 0
  let top = 0
  let bottom = 0
  for (const card of HERO_FAN_CARDS) {
    const angle = (Math.abs(card.angleDeg) * Math.PI) / 180
    const halfWidth = (HERO_CARD_WIDTH * Math.cos(angle) + HERO_CARD_HEIGHT * Math.sin(angle)) / 2
    const halfHeight = (HERO_CARD_WIDTH * Math.sin(angle) + HERO_CARD_HEIGHT * Math.cos(angle)) / 2
    halfSpan = Math.max(halfSpan, Math.abs(card.x) + halfWidth)
    top = Math.min(top, card.y - halfHeight)
    bottom = Math.max(bottom, card.y + halfHeight)
  }
  return { halfSpan, top, bottom }
}

const BOUNDS = restingBounds()

/** The resting fan's full width and height at scale 1, rounded up to whole points: the box HeroCards
 * lays its row out as (so nothing outside it has to guess at the turned cards' overhang). The wave's
 * bump and the entrance's rise move cards briefly outside it, as they always have. */
export const HERO_FAN_SPAN = Math.ceil(2 * BOUNDS.halfSpan)
export const HERO_FAN_HEIGHT = Math.ceil(BOUNDS.bottom - BOUNDS.top)
/** Where the centre card's centre sits inside that box, from its top. */
export const HERO_FAN_CENTER_Y = -BOUNDS.top

// Idle "wave" once the entrance settles - it runs forever, so the hero reads as alive no matter when
// you land on the home screen.
//
// Each card pops up and settles back in turn, left to right, followed by a rest beat before it
// repeats. Two earlier shapes were tried and rejected: a single shared value moving every card in
// unison read as static/flat, while giving each card its own continuously-running, evenly
// phase-shifted sine wave meant that at any instant most cards were always moving the same
// direction against the rest, which flips over time and reads as noise rather than a clear
// sequence. A discrete one-at-a-time bump, all other cards otherwise motionless, is unambiguous.
//
// HERO_BUMP_STAGGER_MS (how soon the next card starts) is deliberately shorter than one card's own
// up+down time - the next card starts while the previous one is still mid-bump, which is what
// makes it read as a domino/ripple ("one moves because the other moved") instead of a strict
// take-turns relay. Kept at or above half the bump time so at most 2 *adjacent* cards are ever
// mid-bump together - below that, a 3rd (non-adjacent) card joins in before the 1st finishes, which
// reads as several cards moving at once rather than a clean sweep.
// 25% quicker than the original 240/260/260 (Jay, 2026-10-03: the wave read a little slow); the rest
// beat below was left as it was.
export const HERO_BUMP_UP_MS = 180
export const HERO_BUMP_DOWN_MS = 195
export const HERO_BUMP_STAGGER_MS = 195
// Rest between the last card settling and the first card's next bump. 240ms is what the wave has always
// actually shown: the old per-card loops asked for 500, but Reanimated's withTiming continues the
// timeline of a preceding withTiming to the same value, so each card's hold-at-0 step silently started
// counting from its own fall (HERO_BUMP_DOWN_MS earlier).
export const HERO_BUMP_REST_MS = 240
/** One whole wave: every card's bump, staggered, plus the rest beat. */
export const HERO_WAVE_CYCLE_MS = (HERO_CARD_COUNT - 1) * HERO_BUMP_STAGGER_MS + HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS + HERO_BUMP_REST_MS

/** How far a card is popped out of the fan (0 at rest, 1 at the top of its bump) at `cycleMs` into a
 * wave. Every card reads its bump off this ONE shared wave clock: the old fan gave each card its own
 * forever-repeating withSequence, and although their periods matched on paper, each sequence step ends
 * on the first frame past its duration - so each card's real period came out a different whole number
 * of frames, and the cards drifted apart until the left-to-right ripple was scrambled (cards 0 and 2
 * lost ~17ms a wave on 1 and 3 at 60Hz: a whole stagger in under half a minute). One clock cannot
 * drift against itself. */
export function heroBumpAt(cycleMs: number, turnIndex: number): number {
  'worklet'
  const t = cycleMs - turnIndex * HERO_BUMP_STAGGER_MS
  if (t <= 0 || t >= HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS) return 0
  if (t < HERO_BUMP_UP_MS) {
    // rise, easing out (Easing.out(Easing.quad))
    const p = 1 - t / HERO_BUMP_UP_MS
    return 1 - p * p
  }
  // fall, easing in (Easing.in(Easing.quad))
  const p = (t - HERO_BUMP_UP_MS) / HERO_BUMP_DOWN_MS
  return 1 - p * p
}
