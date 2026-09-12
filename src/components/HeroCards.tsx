import { CardBack, DecoratedCardBack, type TableColors } from '@tastic/cards'
import { useEffect } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import Animated, { Easing, SharedValue, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, WithSpringConfig, withTiming } from 'react-native-reanimated'

import { useProfiles } from '@/stores/profiles'
import { useSettings } from '@/stores/settings'

import { CARD_HEIGHT, CARD_RADIUS, CARD_WIDTH, useTableColors } from './theme'

// marginHorizontal on each card - about 37% of CARD_WIDTH overlap per adjacent pair.
const HERO_FAN_OVERLAP = -12
// How far each card sits from its neighbor in the fan, applied symmetrically around the center
// card - rotateDeg widens going outward, restY sinks going outward (the usual fanned-hand look).
const HERO_FAN_ROTATE_STEP_DEG = 9
const HERO_FAN_SINK_STEP_PX = 6
const HERO_CARD_COUNT = 5
const HERO_CENTER_INDEX = (HERO_CARD_COUNT - 1) / 2
// Per-card entrance stagger - kept well under dealing/dealSpring.ts's 35ms-for-28-fast-dealt-cards
// pace, since this fan is meant to be watched one card at a time as it lands, not read as a block.
const HERO_STAGGER_MS = 90
const HERO_RISE_PX = 36
// Same critically-damped, zero-overshoot shape as dragdrop/dragSpring.ts's SNAP_BACK_SPRING/
// AUTO_MOVE_SPRING and dealing/dealSpring.ts's DEAL_SPRING - just slower, since this is a one-time
// flourish meant to be watched, not a responsive gameplay snap.
const HERO_ENTRANCE_DURATION_MS = 420
const HERO_ENTRANCE_SPRING: WithSpringConfig = { duration: HERO_ENTRANCE_DURATION_MS, dampingRatio: 1, overshootClamping: true }
// When the last card's own entrance spring finishes settling - the earliest moment the whole fan
// has actually landed, since later cards start their entrance later too.
const HERO_ENTRANCE_TOTAL_MS = (HERO_CARD_COUNT - 1) * HERO_STAGGER_MS + HERO_ENTRANCE_DURATION_MS

// Idle "wave" once the entrance settles - unlike every other animation in this codebase (one-shot
// springs/shake), this one runs forever, so the hero reads as alive no matter when you land on the
// home screen (a plain mount-only entrance is easy to miss on first load, and on web never replays
// at all once you've navigated into a game and back - expo-router's web stack keeps this screen
// mounted rather than remounting it, see the ProfilesManager web note in .claude/CLAUDE.md for the
// same underlying behavior elsewhere in this app).
//
// Each card pops up and settles back in turn, left to right, followed by a rest beat before it
// repeats. Two earlier shapes were tried and rejected: a single shared value moving every card in
// unison read as static/flat, while giving each card its own continuously-running, evenly
// phase-shifted sine wave meant that at any instant most cards were always moving the same
// direction against the rest, which flips over time and reads as noise rather than a clear
// sequence. A discrete one-at-a-time bump, all other cards otherwise motionless, is unambiguous.
//
// HERO_BUMP_STAGGER_MS (how soon the next card starts) is deliberately shorter than one card's own
// up+down time (HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS, ~500ms) - the next card starts while the
// previous one is still mid-bump, which is what makes it read as a domino/ripple ("one moves
// because the other moved") instead of a strict take-turns relay where each card waits for the
// last to fully finish. Kept above half the bump time (>250ms) so at most 2 *adjacent* cards are
// ever mid-bump together - below that threshold, 5 cards means a 3rd (non-adjacent) card joins in
// before the 1st finishes, which reads as several cards moving at once rather than a clean sweep.
const HERO_BUMP_UP_MS = 240
const HERO_BUMP_DOWN_MS = 260
const HERO_BUMP_STAGGER_MS = 260
const HERO_BUMP_REST_MS = 500
const HERO_BUMP_RISE_PX = 8

interface HeroCardSpec {
  key: string
  rotateDeg: number
  restY: number
  zIndex: number
  delayMs: number
  // This card's position in the left-to-right bump sequence (0-based).
  turnIndex: number
}

const HERO_CARD_SPECS: HeroCardSpec[] = Array.from({ length: HERO_CARD_COUNT }, (_, i) => {
  const offsetFromCenter = i - HERO_CENTER_INDEX
  return {
    key: `card-${i}`,
    rotateDeg: offsetFromCenter * HERO_FAN_ROTATE_STEP_DEG,
    restY: Math.abs(offsetFromCenter) * HERO_FAN_SINK_STEP_PX,
    // Left-behind-right stacking, like an actual hand of cards fanned out in the order they were
    // picked up - not peaked at center. This also happens to keep every card fully visible during
    // its own bump: the animation sweeps left to right in the same direction as the stack, so a
    // card popping up is never tucked behind a still-settling neighbor closer to center.
    zIndex: i + 1,
    delayMs: i * HERO_STAGGER_MS,
    turnIndex: i
  }
})

// Every card's own sequence is the same total length (the staggered starts + the last card's own
// bump + the rest beat), just shifted by its turnIndex - that keeps every card repeating in
// lockstep forever, never drifting apart, while still overlapping mid-sequence as intended.
// leadInMs is the delay before this run's very first cycle only; every repeat after it keeps the
// same rhythm regardless of what leadInMs was.
function startBumpLoop(bump: SharedValue<number>, spec: HeroCardSpec, leadInMs: number) {
  const trailingHoldMs = (HERO_CARD_SPECS.length - 1 - spec.turnIndex) * HERO_BUMP_STAGGER_MS + HERO_BUMP_REST_MS
  bump.value = withDelay(
    leadInMs,
    withRepeat(
      withSequence(
        withDelay(spec.turnIndex * HERO_BUMP_STAGGER_MS, withTiming(1, { duration: HERO_BUMP_UP_MS, easing: Easing.out(Easing.quad) })),
        withTiming(0, { duration: HERO_BUMP_DOWN_MS, easing: Easing.in(Easing.quad) }),
        withTiming(0, { duration: trailingHoldMs }) // holds at 0 - a wait, not a visible animation
      ),
      -1,
      false
    )
  )
}

function HeroCard({ spec, colors, tag, cardBackStyle, invertDarkModeColors }: { spec: HeroCardSpec; colors: TableColors; tag?: string; cardBackStyle: 'geometric' | 'ornate' | 'plain'; invertDarkModeColors?: boolean }) {
  const lift = useSharedValue(0)
  const bump = useSharedValue(0)

  useEffect(() => {
    lift.value = withDelay(spec.delayMs, withSpring(1, HERO_ENTRANCE_SPRING))

    // The loop's first-ever cycle waits for the whole fan to actually land (HERO_ENTRANCE_TOTAL_MS)
    // plus its own rest beat, rather than starting mid-entrance - otherwise the earliest cards'
    // bumps would overlap their own entrance motion instead of the fan getting a beat to settle
    // first.
    startBumpLoop(bump, spec, HERO_ENTRANCE_TOTAL_MS + HERO_BUMP_REST_MS)

    // Browsers pause or heavily throttle a hidden tab's render loop - and Reanimated's timers with
    // it - so 5 independently-running loops can each "catch up" to a different point once the tab
    // is visible again, falling out of the lockstep that made this read as one continuous sweep
    // rather than 5 separate ones. Restarting clean on every return to the foreground sidesteps
    // that entirely instead of trusting 5 separate catch-up computations to agree. react-native-web
    // maps AppState's 'active' to the browser's visibilitychange event, so this also covers a real
    // user switching tabs and back on web, not just this dev preview.
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return
      // Snap back to rest first - resuming the new sequence from wherever this was frozen mid-bump
      // would carry that stale pose into it instead of a clean restart.
      bump.value = 0
      startBumpLoop(bump, spec, HERO_BUMP_REST_MS)
    })

    return () => subscription.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: lift.value,
    transform: [{ translateY: spec.restY + (1 - lift.value) * HERO_RISE_PX - bump.value * HERO_BUMP_RISE_PX }, { rotate: `${spec.rotateDeg * lift.value}deg` }]
  }))

  return (
    <Animated.View style={[styles.cardShadow, { width: CARD_WIDTH, height: CARD_HEIGHT, marginHorizontal: HERO_FAN_OVERLAP, zIndex: spec.zIndex }, animatedStyle]}>
      <View style={styles.cardClip}>{cardBackStyle === 'geometric' ? <CardBack colors={colors} width={CARD_WIDTH} height={CARD_HEIGHT} tag={tag} invertDarkModeColors={invertDarkModeColors} /> : <DecoratedCardBack style={cardBackStyle} colors={colors} width={CARD_WIDTH} height={CARD_HEIGHT} invertDarkModeColors={invertDarkModeColors} />}</View>
    </Animated.View>
  )
}

/** Purely decorative hero for the home screen - a fan of face-down cards that spring into place on
 * mount, then pop up one at a time left to right, then rest, forever. Not reactive to color/profile
 * changes: CardBack already re-renders live from useTableColors()/the active profile's tag/
 * invertDarkModeColors, same as every in-game card, so the fan just shows whatever's current
 * without any "detect a change" logic of its own. */
export function HeroCards() {
  const colors = useTableColors()
  const { activeProfile } = useProfiles()
  const { settings } = useSettings()

  return (
    <View style={styles.row} pointerEvents='none'>
      {HERO_CARD_SPECS.map((spec) => (
        <HeroCard key={spec.key} spec={spec} colors={colors} tag={activeProfile?.tag} cardBackStyle={settings.cardBackStyle} invertDarkModeColors={settings.invertDarkModeColors} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // CardBack's own outer Rect has no rx - it doesn't self-clip to rounded corners - so, same as
  // PlayingCard.tsx's `clip` style, rounding comes entirely from this wrapping overflow:hidden
  // View, kept off the shadow-bearing node above (iOS draws a view's shadow and its overflow clip
  // on the same layer, so a masked layer would otherwise clip away its own shadow).
  cardClip: {
    borderRadius: CARD_RADIUS,
    flex: 1,
    overflow: 'hidden'
  },
  // borderRadius here (not just on cardClip) so Android's elevation shadow itself follows the
  // rounded shape rather than boxing it.
  cardShadow: {
    borderRadius: CARD_RADIUS,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 20
  }
})
