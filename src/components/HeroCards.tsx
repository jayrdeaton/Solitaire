import { CardBack, DecoratedCardBack, type TableColors } from '@tastic/cards'
import { useIsFocused } from 'expo-router'
import { useEffect, useRef } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, Easing, SharedValue, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSpring, WithSpringConfig, withTiming } from 'react-native-reanimated'

import { useSettings } from '@/hooks/useSettings'
import { useProfiles } from '@/stores/profiles'

import { HERO_CARD_COUNT, HERO_FAN_CARDS, HERO_FAN_CENTER_Y, HERO_FAN_HEIGHT, HERO_FAN_SPAN, HERO_WAVE_CYCLE_MS, heroBumpAt, type HeroFanCard } from './heroFan'
import { CARD_HEIGHT, CARD_RADIUS, CARD_WIDTH, cardRadiusForWidth, useTableColors } from './theme'

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

// The idle wave (heroFan.ts) runs forever, so the hero reads as alive no matter when you land on the
// home screen (a plain mount-only entrance is easy to miss on first load, and on web never replays at
// all once you've navigated into a game and back - expo-router's web stack keeps this screen mounted
// rather than remounting it, see the ProfilesManager web note in .claude/CLAUDE.md for the same
// underlying behavior elsewhere in this app).
//
// How far a card pops out of the fan at the top of its bump - along its own axis (away from the
// fan's pivot), the way a card is drawn up out of a held hand, rather than straight up.
const HERO_BUMP_RISE_PX = 8
// Beat before the wave (re)starts: after the entrance has landed, or on coming back to the screen.
const HERO_WAVE_LEAD_IN_MS = 500

// The one wave clock every card reads (see heroBumpAt): milliseconds into the current wave, counting
// 0 -> HERO_WAVE_CYCLE_MS and starting over, forever. leadInMs delays only this run's first wave.
function startWave(wave: SharedValue<number>, leadInMs: number) {
  // Snap back to rest first - resuming from wherever the clock was frozen mid-wave would carry that
  // stale pose into the new run instead of a clean restart.
  wave.value = 0
  wave.value = withDelay(leadInMs, withRepeat(withTiming(HERO_WAVE_CYCLE_MS, { duration: HERO_WAVE_CYCLE_MS, easing: Easing.linear }), -1, false))
}

function HeroCard({ card, wave, colors, tag, cardBackStyle, invertDarkModeColors, scale }: { card: HeroFanCard; wave: SharedValue<number>; colors: TableColors; tag?: string; cardBackStyle: 'geometric' | 'ornate' | 'plain'; invertDarkModeColors?: boolean; scale: number }) {
  // Every length below is the natural (scale 1) one times `scale`; rotation is never scaled. At scale 1
  // the width/height/radius are exactly CARD_WIDTH/CARD_HEIGHT/CARD_RADIUS.
  const width = Math.round(CARD_WIDTH * scale)
  const height = Math.round(CARD_HEIGHT * scale)
  const radius = scale === 1 ? CARD_RADIUS : cardRadiusForWidth(width)
  const lift = useSharedValue(0)

  useEffect(() => {
    lift.value = withDelay(card.turnIndex * HERO_STAGGER_MS, withSpring(1, HERO_ENTRANCE_SPRING))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const animatedStyle = useAnimatedStyle(() => {
    const bump = heroBumpAt(wave.value, card.turnIndex) * HERO_BUMP_RISE_PX
    return {
      opacity: lift.value,
      transform: [{ translateX: (card.x + card.outX * bump) * scale }, { translateY: (card.y + (1 - lift.value) * HERO_RISE_PX + card.outY * bump) * scale }, { rotate: `${card.angleDeg * lift.value}deg` }]
    }
  })

  // Every card starts stacked on the centre card's spot; its transform fans it out from there.
  const position = { left: (HERO_FAN_SPAN * scale - width) / 2, top: HERO_FAN_CENTER_Y * scale - height / 2 }

  return (
    <Animated.View style={[styles.cardShadow, position, { borderRadius: radius, width, height, zIndex: card.zIndex }, animatedStyle]}>
      <View style={[styles.cardClip, { borderRadius: radius }]}>{cardBackStyle === 'geometric' ? <CardBack colors={colors} width={width} height={height} tag={tag} invertDarkModeColors={invertDarkModeColors} /> : <DecoratedCardBack style={cardBackStyle} colors={colors} width={width} height={height} invertDarkModeColors={invertDarkModeColors} />}</View>
    </Animated.View>
  )
}

/** Purely decorative hero for the home screen (`scale` shrinks it for the landscape layout; 1 is its natural size) - a fan of face-down cards that spring into place on
 * mount, then pop up one at a time left to right, then rest, forever. Not reactive to color/profile
 * changes: CardBack already re-renders live from useTableColors()/the active profile's tag/
 * invertDarkModeColors, same as every in-game card, so the fan just shows whatever's current
 * without any "detect a change" logic of its own. */
export function HeroCards({ scale = 1 }: { scale?: number } = {}) {
  const colors = useTableColors()
  const { activeProfile } = useProfiles()
  const { settings } = useSettings()
  const wave = useSharedValue(0)
  const hasStartedWave = useRef(false)

  // Home stays mounted underneath a game (or Achievements/Profiles) once navigated away from, so an
  // unfocused hero would otherwise keep its forever-running wave alive for as long as that other
  // screen is open - all wasted, since none of it is on screen. Pausing it costs nothing on return:
  // the wave simply restarts from rest.
  const focused = useIsFocused()

  useEffect(() => {
    if (!focused) return

    // The first-ever wave waits for the whole fan to actually land (HERO_ENTRANCE_TOTAL_MS) plus its own
    // beat, rather than starting mid-entrance - otherwise the earliest cards' bumps would overlap their
    // own entrance motion instead of the fan getting a beat to settle first. A restart after coming
    // back to the screen skips that (the fan is long since landed).
    startWave(wave, hasStartedWave.current ? HERO_WAVE_LEAD_IN_MS : HERO_ENTRANCE_TOTAL_MS + HERO_WAVE_LEAD_IN_MS)
    hasStartedWave.current = true

    // Browsers pause or heavily throttle a hidden tab's render loop - and Reanimated's timers with it -
    // and a backgrounded app's frames stop, so the wave restarts clean on every return to the
    // foreground rather than catching up from wherever it froze. react-native-web maps AppState's
    // 'active' to the browser's visibilitychange event, so this also covers a real user switching
    // tabs and back on web, not just this dev preview.
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') startWave(wave, HERO_WAVE_LEAD_IN_MS)
    })

    return () => {
      subscription.remove()
      // Blurred (or unmounting): stop the forever-loop and rest the fan, so nothing keeps ticking on
      // the UI thread for a screen that isn't visible.
      cancelAnimation(wave)
      wave.value = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  return (
    <View style={{ width: HERO_FAN_SPAN * scale, height: HERO_FAN_HEIGHT * scale }} pointerEvents='none'>
      {HERO_FAN_CARDS.map((card) => (
        <HeroCard key={card.key} card={card} wave={wave} colors={colors} tag={activeProfile?.tag} cardBackStyle={settings.cardBackStyle} invertDarkModeColors={settings.invertDarkModeColors} scale={scale} />
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
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3
  }
})
