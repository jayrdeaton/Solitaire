import { cardFaceColor, type Suit, suitInk, SuitPip, SUITS } from '@tastic/cards'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'
import Animated, { Easing, type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { useMotionReduced } from '@/components/reducedMotion'
import { useTableColors } from '@/components/theme'
import { useSettings } from '@/hooks/useSettings'

/** Which pips a show throws: the standard four suits, or the tarot deck's cups, coins, wands and swords (the same art the cards use). */
export type PipDeck = 'standard' | 'tarot'

/** How a show draws its pips: each suit's ink, and the ring round every pip. */
export type PipLook = { deck: PipDeck; inks: Record<Suit, string>; outline: string }

const PIPS_PER_BURST = 10
const PIP_SIZE = 14
/** The pip's box: room for the spades' width compensation and a quarter turn of the diagonal tarot art. */
const PIP_BOX = Math.ceil(PIP_SIZE * 1.6)
const BURST_LIFETIME_MS = 1100
const EXPAND_MS = 650
const FADE_IN_MS = 100
const FADE_START_MS = 380
/** How far a pip has dropped by the end of its life, so a burst sags like sparks instead of stopping in a ring. */
const DROOP_PX = 34
const MIN_BURST_INTERVAL_MS = 180
const MAX_BURST_INTERVAL_MS = 420
const EASE_EXPAND = Easing.out(Easing.cubic)
const EASE_FADE = Easing.in(Easing.quad)
const EASE_POP = Easing.out(Easing.back(2))
const POP_MS = 180

/** The ring round each pip, in points. A pip is the card's own ink, ringed in the card's own face color, so a black spade reads on the dark felt the
 * way it does on a card (Jay, 2026-10-17). */
const PIP_OUTLINE_WIDTH = 1.25

/** Wands and swords are drawn on a diagonal with the tip up and to the right. Turned by the flight angle plus this, the tip leads, so a burst of them
 * radiates like blades or sparks instead of landing like a pile of dropped sticks. */
const TIP_UP_RIGHT_DEG = 45

function pointsAlongFlight(deck: PipDeck, suit: Suit): boolean {
  return deck === 'tarot' && (suit === 'clubs' || suit === 'spades')
}

type PipSpec = { key: string; angle: number; distance: number; rotateFrom: number; rotateTo: number }

type BurstSpec = { id: number; originX: number; originY: number; suit: Suit; pips: PipSpec[] }

/** A burst's spread, rolled once when it spawns (outside render, so a re-render can never reshuffle it mid-flight). */
function rollPips(deck: PipDeck, suit: Suit): PipSpec[] {
  const along = pointsAlongFlight(deck, suit)
  const specs: PipSpec[] = []
  for (let i = 0; i < PIPS_PER_BURST; i++) {
    const angle = (i / PIPS_PER_BURST) * Math.PI * 2 + Math.random() * 0.3
    const heading = (angle * 180) / Math.PI + TIP_UP_RIGHT_DEG
    // A suit reads best near upright, so it only tilts and turns a little. A blade keeps to its heading.
    const rotateFrom = along ? heading : (Math.random() - 0.5) * 30
    const spin = along ? (Math.random() - 0.5) * 20 : (Math.random() - 0.5) * 120
    specs.push({ angle, distance: 70 + Math.random() * 40, key: `${i}`, rotateFrom, rotateTo: rotateFrom + spin })
  }
  return specs
}

function Pip({ spec, elapsed, burst, look }: { spec: PipSpec; elapsed: SharedValue<number>; burst: BurstSpec; look: PipLook }) {
  const { angle, distance, rotateFrom, rotateTo } = spec
  const style = useAnimatedStyle(() => {
    const ms = elapsed.value
    const expand = EASE_EXPAND(Math.min(1, ms / EXPAND_MS))
    const life = ms / BURST_LIFETIME_MS
    const fadeIn = Math.min(1, ms / FADE_IN_MS)
    const fadeOut = ms <= FADE_START_MS ? 1 : 1 - EASE_FADE(Math.min(1, (ms - FADE_START_MS) / (BURST_LIFETIME_MS - FADE_START_MS)))
    const pop = 0.5 + 0.5 * EASE_POP(Math.min(1, ms / POP_MS))
    return {
      opacity: fadeIn * fadeOut,
      transform: [{ translateX: Math.cos(angle) * distance * expand }, { translateY: Math.sin(angle) * distance * expand + DROOP_PX * life * life }, { rotate: `${rotateFrom + (rotateTo - rotateFrom) * life}deg` }, { scale: pop * (1 - 0.2 * life) }]
    }
  })
  return (
    <Animated.View style={[styles.pip, { left: burst.originX - PIP_BOX / 2, top: burst.originY - PIP_BOX / 2 }, style]}>
      <SuitPip suit={burst.suit} color={look.inks[burst.suit]} size={PIP_SIZE} theme={look.deck} outline={{ color: look.outline, width: PIP_OUTLINE_WIDTH }} />
    </Animated.View>
  )
}

function Burst({ burst, look }: { burst: BurstSpec; look: PipLook }) {
  // One clock per burst, read by every pip's style on the UI thread.
  const elapsed = useSharedValue(0)
  useEffect(() => {
    elapsed.value = withTiming(BURST_LIFETIME_MS, { duration: BURST_LIFETIME_MS, easing: Easing.linear })
  }, [elapsed])
  return (
    <>
      {burst.pips.map((p) => (
        <Pip key={p.key} spec={p} elapsed={elapsed} burst={burst} look={look} />
      ))}
    </>
  )
}

/** Bursts of suit pips, one suit per burst, for as long as it's mounted, drawn the way `look` says. Same cadence as @tastic/sprites' Fireworks, which
 * the win used to show (a burst every 180-420ms, anywhere in the frame). */
export function PipBursts({ look, onBurst }: { look: PipLook; onBurst?: () => void }) {
  const deck = look.deck
  const [size, setSize] = useState({ height: 0, width: 0 })
  const [bursts, setBursts] = useState<BurstSpec[]>([])
  const nextIdRef = useRef(0)
  const onBurstRef = useRef(onBurst)
  useEffect(() => {
    onBurstRef.current = onBurst
  }, [onBurst])

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    setSize({ height, width })
  }

  useEffect(() => {
    if (size.width === 0) return
    let cancelled = false
    let spawnTimer: ReturnType<typeof setTimeout>
    const cleanupTimers = new Set<ReturnType<typeof setTimeout>>()
    // A shuffled bag of the four suits, so two bursts in a row are rarely the same suit and every suit gets its turn.
    let bag: Suit[] = []
    const nextSuit = (): Suit => {
      if (bag.length === 0) bag = [...SUITS].sort(() => Math.random() - 0.5)
      return bag.pop() as Suit
    }

    const spawnBurst = () => {
      const id = nextIdRef.current++
      const originX = size.width * (0.08 + Math.random() * 0.84)
      const originY = size.height * (0.1 + Math.random() * 0.8)
      const suit = nextSuit()
      setBursts((prev) => [...prev, { id, originX, originY, pips: rollPips(deck, suit), suit }])
      onBurstRef.current?.()
      const cleanupTimer = setTimeout(() => {
        cleanupTimers.delete(cleanupTimer)
        setBursts((prev) => prev.filter((b) => b.id !== id))
      }, BURST_LIFETIME_MS + 50)
      cleanupTimers.add(cleanupTimer)
      if (!cancelled) spawnTimer = setTimeout(spawnBurst, MIN_BURST_INTERVAL_MS + Math.random() * (MAX_BURST_INTERVAL_MS - MIN_BURST_INTERVAL_MS))
    }
    spawnBurst()

    return () => {
      cancelled = true
      clearTimeout(spawnTimer)
      cleanupTimers.forEach(clearTimeout)
    }
  }, [size.width, size.height, deck])

  return (
    <View style={[StyleSheet.absoluteFill, styles.inert]} onLayout={handleLayout} testID='pip-fireworks'>
      {bursts.map((b) => (
        <Burst key={b.id} burst={b} look={look} />
      ))}
    </View>
  )
}

/** The win's fireworks: bursts of the pips on the player's own cards. Tarot suits with the tarot deck, the standard four otherwise; each pip in the ink
 * its card draws it in, ringed in that card's face color, both through @tastic/cards' own rule. So the black suits are black with a white ring,
 * and with Invert Dark Mode Colors on in dark mode they turn light with a dark ring, as the cards do. */
export function PipFireworks() {
  const { settings } = useSettings()
  // Under Reduce Motion (see reducedMotion.tsx) the win has no fireworks: the win dialog says it.
  const reduced = useMotionReduced()
  const { dark } = useTheme()
  const colors = useTableColors()
  const cardStyle = settings.cardStyle
  const invertDarkModeColors = settings.invertDarkModeColors && dark
  const look = useMemo<PipLook>(() => {
    const options = { cardStyle, invertDarkModeColors }
    const inks = Object.fromEntries(SUITS.map((suit) => [suit, suitInk(suit, colors, options)])) as Record<Suit, string>
    return { deck: cardStyle === 'tarot' ? 'tarot' : 'standard', inks, outline: cardFaceColor(colors, invertDarkModeColors) }
  }, [cardStyle, colors, invertDarkModeColors])
  if (reduced) return null
  return <PipBursts look={look} />
}

const styles = StyleSheet.create({
  inert: { pointerEvents: 'none' },
  // Sized, never a zero frame: see CLAUDE.md on Fabric recycling a zero-frame view at its previous life's position.
  pip: { alignItems: 'center', height: PIP_BOX, justifyContent: 'center', position: 'absolute', width: PIP_BOX }
})
