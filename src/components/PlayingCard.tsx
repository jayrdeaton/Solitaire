import { Pressable } from '@rific/feedback-press'
import { CardFace, rankLabel, type TableColors, useCardSize } from '@tastic/cards'
import React from 'react'
import { Image, ImageSourcePropType, ImageStyle, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { useTheme } from 'react-native-paper'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

import { Card, Rank, Suit } from '@/engine/types'
import { useSettings } from '@/hooks/useSettings'
import { useProfiles } from '@/stores/profiles'

import { CardBackArt } from './CardBackArt'
import { CARD_FACE_BITMAPS } from './cardFaceBitmaps'
import { FaceLoadTrackingContext, trackFaceLoad } from './cardFacePaint'
import { DIM_FADE_BACKSTOP_MS, fadeInDimScrim } from './dimScrimAnimation'
import { startHintPulse } from './hintAnimation'
import { CARD_RADIUS, cardRadiusForWidth, useTableColors } from './theme'

const SHEEN_SOURCE = require('../../assets/card-sheen.png')
/** How long a card turned face-up in place may keep showing its back while its new face loads (see `backUntilPainted`) -
 * normally a frame or two; this only bounds a load that never reports. */
const FLIP_BACK_MAX_MS = 250
const sheenStyles = StyleSheet.create({ sheen: { bottom: 0, left: 0, pointerEvents: 'none', position: 'absolute', right: 0, top: 0 }, subtle: { opacity: 0.35 } })

interface PlayingCardProps {
  card: Card
  /** Highlight this card as part of the current selection. */
  selected?: boolean
  /** Highlight this card as the one the Hint feature suggests moving - a breathing, glowing ring in
   * `colors.hintGreen`, distinct from `selected`'s static gold ring since Pyramid already uses
   * `selected` for its own real tap-to-pair-selection state. */
  hinted?: boolean
  /** Disable pressing (e.g. cards buried under others). */
  disabled?: boolean
  /** Not yet playable (e.g. a buried Pyramid card) - draws a translucent scrim on top of the
   * still-full-opacity face instead of fading the card itself, so its rank/suit stay legible. */
  dimmed?: boolean
  /** Opt in to a seamless hand-off from a flying ghost (a deal, an undo, a tap-to-move - all drawn undimmed) to this card.
   * `true` while the real card is held back hidden waiting for its ghost to land: the scrim starts fully transparent, so
   * the card that appears at the landing frame is pixel-identical to the ghost, and when it flips to `false` the scrim
   * fades in (dimScrimAnimation.ts) instead of darkening the card in a single frame. Only meaningful with `dimmed`;
   * omitted (the default) draws today's plain, instant scrim, and a card that was never held pays nothing extra. */
  dimHold?: boolean
  /** Makes a scrim that appears on THIS render fade in, as if the card had been held (see `dimHold`) until now - for a
   * caller whose card becomes dimmed without a true->false `dimHold` transition on this instance: PileView, whose hidden
   * cards are never dimmed (so a buried card's scrim first appears when its flight lands), and whose whole board turns
   * dimming on at once after a deal (useDimAfterDeal). Only read when the scrim first mounts; the caller passes false
   * for a scrim that should just be there (a resumed board's first render - see PileView's `mountedRef`). Only
   * meaningful alongside `dimHold`. */
  dimFadeIn?: boolean
  /** This card is fully invisible (opacity 0) at its OWN call site - a tableau card being dragged, whose floating copy is
   * the drag ghost (see PileView's DraggableTableauCard). Skips a face-down card's CardBack/CardSheen (an empty box stands
   * in for them) since nothing painted here is visible anyway, while the card itself stays mounted - its gesture is still
   * tracking the player's touch; `dimOverlay`/`borderOverlay` still render normally. Only the expensive part is skipped (a
   * back's SVG pattern); a face-up card keeps its one face Image, so it is already loaded when the card is shown again. */
  hidden?: boolean
  /** Called when this card's face bitmap has loaded (its Image's onLoad) - React Native delivers a new Image's bitmap a
   * frame or two after the view appears (cardFacePaint.ts). A ghost waits for it before it shows. Never called for a
   * face-down card. */
  onFacePainted?: () => void
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  testID?: string
}

// The border is drawn as an absolutely-positioned overlay rather than a Pressable borderWidth so
// that toggling `selected`/`hinted` (a thicker, different-colored border) never changes the box's
// content area - RN sizes borders inward from a fixed width/height, so swapping 1px for 3px would
// nudge the card's own SVG content by a couple pixels every time it's (de)selected/(un)hinted.
export function PlayingCard({ card, selected, hinted, disabled, dimmed, dimHold, dimFadeIn, hidden, onFacePainted, onPress, style, testID }: PlayingCardProps) {
  const colors = useTableColors()
  const { dark } = useTheme()
  const { activeProfile } = useProfiles()
  const { settings } = useSettings()
  const { width, height } = useCardSize()
  const cardRadius = cardRadiusForWidth(width)
  const styles = stylesFor(colors, settings.invertDarkModeColors, cardRadius)
  const cardSize = { width, height }
  // The pulsing hint ring is its own component, mounted only while this card is actually hinted: it owns a shared
  // value, an animated-style mapper and a looping animation, none of which ~every card on the board (almost never
  // hinted) should pay for at mount.
  const borderOverlay = selected ? <View pointerEvents='none' style={styles.selectedRing} /> : hinted ? <HintRing style={styles.hintRing} /> : <View pointerEvents='none' style={styles.border} />
  const dimOverlay = dimmed ? dimHold === undefined ? <View pointerEvents='none' style={styles.dim} /> : <HeldDimScrim hold={dimHold} initialWasHeld={dimFadeIn} style={styles.dim} /> : null
  // A card turned face-up in place (the card a move exposes in its column) mounts a brand-new face Image, which React
  // Native fills in a frame or two later (cardFacePaint.ts) - a blank face in the meantime, with no ghost over it. So the
  // back stays drawn over the new face until that face has painted (its onLoad), then the card turns.
  // Board cards only: a ghost (a reused deal slot showing a face-up card after a face-down one) is not turning over.
  const onBoard = React.useContext(FaceLoadTrackingContext)
  const [prevFaceUp, setPrevFaceUp] = React.useState(card.faceUp)
  const [backUntilPainted, setBackUntilPainted] = React.useState(false)
  if (card.faceUp !== prevFaceUp) {
    setPrevFaceUp(card.faceUp)
    setBackUntilPainted(card.faceUp && onBoard)
  }
  const handleFacePainted = React.useCallback(() => setBackUntilPainted(false), [])
  const handleFaceLoaded = React.useCallback(() => {
    setBackUntilPainted(false)
    onFacePainted?.()
  }, [onFacePainted])
  React.useEffect(() => {
    if (!backUntilPainted) return
    const backstop = setTimeout(handleFacePainted, FLIP_BACK_MAX_MS)
    return () => clearTimeout(backstop)
  }, [backUntilPainted, handleFacePainted])
  const backArt = () => <CardBackArt backStyle={settings.cardBackStyle} colors={colors} width={width} height={height} tag={activeProfile?.tag} invertDarkModeColors={settings.invertDarkModeColors} />

  if (!card.faceUp) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled || !onPress}
        // Cards have their own precise sound logic (fired the instant a move is confirmed rather
        // than when it lands, plus an explicit invalid sound on a rejected one - see
        // useCardSounds.ts/DragGhostLayer.tsx) - the provider's generic onPressIn "selection" blip
        // would otherwise ALSO fire the instant any card is touched, playing alongside (and ahead
        // of) that logic on every tap. Haptics are deliberately left untouched here - only sound
        // doubled up, since it's the only one of the two this app is wiring for the first time.
        soundDisabled
        style={[styles.card, styles.shadow, cardSize, style]}
      >
        <View style={[styles.clip, styles.back]}>
          {hidden ? null : backArt()}
          {hidden ? null : <CardSheen />}
        </View>
        {dimOverlay}
        {borderOverlay}
      </Pressable>
    )
  }

  // The face is ONE pre-rasterized Image of CardFace (cardFaceBitmaps.ts, scripts/generate-card-face-bitmaps.mjs) - a live
  // CardFace is ~14-17 native views (a court card's vector figure alone ~100), and the board's mount cost is its view
  // count. Every style x (normal, dark-mode invert) is baked in; invert in LIGHT mode draws the normal face - theme.ts's
  // lightColors mirror the *Inverted tokens so it is meant to be a no-op there.
  const faceVariant = settings.invertDarkModeColors && dark ? 'invert' : 'normal'
  const faceSource = CARD_FACE_BITMAPS[settings.cardStyle][faceVariant][card.suit][card.rank - 1]
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled} soundDisabled style={[styles.card, styles.shadow, cardSize, style]}>
      <View style={[styles.clip, styles.face]}>
        {/* Kept mounted while `hidden` (one Image, unlike the back's SVG): a dragged card that is revealed again then
        already has its bitmap, instead of loading it in the frame it reappears (see cardFacePaint.ts). */}
        <CardFaceImage cardId={card.id} source={faceSource} style={cardSize} label={`${rankLabel(card.rank)} of ${card.suit}`} onPainted={backUntilPainted || onFacePainted ? handleFaceLoaded : undefined} />
        <CardSheen subtle={faceVariant === 'invert'} />
        {backUntilPainted && !hidden ? (
          <View style={[StyleSheet.absoluteFill, styles.back]}>
            {backArt()}
            <CardSheen />
          </View>
        ) : null}
      </View>
      {dimOverlay}
      {borderOverlay}
    </Pressable>
  )
}

/** The hint feature's pulsing ring (see hintAnimation.ts) - mounted only while a card is hinted, so it starts each pulse
 * at full opacity and its shared value/animated style/animation are torn down with it when the hint ends. */
function HintRing({ style }: { style: StyleProp<ViewStyle> }) {
  const opacity = useSharedValue(1)
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))
  React.useEffect(() => {
    startHintPulse(opacity)
    return () => cancelAnimation(opacity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <Animated.View pointerEvents='none' style={[style, animatedStyle]} />
}

/** One ring around a whole run of cards (a column's hinted or selected run, see PileView): the same ring a single card
 * draws (`hinted`/`selected`), only as tall as the run. Each card of the run ringing itself drew a ladder of lines across
 * the run, and every card's hint glow spilled over the face of the card above it. Fills its parent, which places and
 * sizes it. */
export function RunOutline({ kind }: { kind: 'hint' | 'selected' }) {
  const colors = useTableColors()
  const { settings } = useSettings()
  const { width } = useCardSize()
  const styles = stylesFor(colors, settings.invertDarkModeColors, cardRadiusForWidth(width))
  return kind === 'hint' ? <HintRing style={styles.hintRing} /> : <View pointerEvents='none' style={styles.selectedRing} />
}

/** The dim scrim of a card that takes part in a ghost hand-off (`dimHold` set). While `hold` is true - the real card is
 * still hidden, waiting for its ghost - it draws NOTHING: a transparent scrim looks the same, and drawing none means the
 * ~30-44 dimmed cards of a fresh deal mount no shared value or animated-style mapper in the (already heavy) deal-start
 * commit; each one's mapper mounts in the small commit of its own landing instead. When `hold` drops on a card that WAS
 * held, the animated FadingDimScrim mounts (from transparent) and fades in. A card that was never held (a resumed save, a
 * card that only becomes dimmed later in play) keeps today's plain, instant scrim and pays for no animation at all.
 * `initialWasHeld` (PlayingCard's own `dimFadeIn` - see its doc comment) seeds this as already-having-been-held on a
 * FRESH mount that already knows, from outside, that it stands in for a card that was conceptually held a moment ago
 * (a flight just landed it) even though no earlier mounted instance of THIS component ever actually held it - without
 * this, such a mount looks identical to "never held" and silently keeps the plain, instant scrim instead of fading. */
function HeldDimScrim({ hold, initialWasHeld, style }: { hold: boolean; initialWasHeld?: boolean; style: StyleProp<ViewStyle> }) {
  const [held, setHeld] = React.useState(hold || !!initialWasHeld)
  // Once the fade has finished, the scrim is the plain View again (see FadingDimScrim for why). Reset whenever the card is
  // held again, so its next release fades in again rather than popping.
  const [faded, setFaded] = React.useState(false)
  if (hold && !held) setHeld(true)
  if (hold && faded) setFaded(false)
  const handleFaded = React.useCallback(() => setFaded(true), [])
  if (hold) return null
  return held && !faded ? <FadingDimScrim style={style} onDone={handleFaded} /> : <View pointerEvents='none' style={style} />
}

/** The animated scrim itself: mounts fully transparent (so the frame it first appears in is still the ghost's look) and
 * fades to opaque (fadeInDimScrim). Only ever mounted at the moment a held card is released, and only until its fade has
 * finished: `onDone` then swaps it for the plain scrim in one commit (same colour, same frame, so nothing visibly
 * changes). The finished, fully-dim state must be React's own prop, not a value Reanimated last wrote: on iOS this
 * build commits animated props through the shadow tree (IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS is off), where they race
 * React's own commits, and the final opacity was measurably lost - a whole deal's first row of buried cards stayed
 * undimmed (pixel-checked on the Simulator) while JS had rendered them dimmed and every fade reported `finished`. The
 * plain scrim is what a resumed board draws, and that never failed. `DIM_FADE_BACKSTOP_MS` hands over even if the
 * completion callback never arrives. */
function FadingDimScrim({ style, onDone }: { style: StyleProp<ViewStyle>; onDone: () => void }) {
  const opacity = useSharedValue(0)
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))
  React.useEffect(() => {
    fadeInDimScrim(opacity, onDone)
    const backstop = setTimeout(onDone, DIM_FADE_BACKSTOP_MS)
    return () => clearTimeout(backstop)
  }, [opacity, onDone])
  return <Animated.View pointerEvents='none' style={[style, animatedStyle]} />
}

/** The face bitmap. Reports itself as loading (cardFacePaint.ts) from the commit its bitmap starts loading until its own
 * onLoad, so a ghost that has just landed on this card stays over it until the face can really be seen - React Native
 * delivers a new Image's bitmap asynchronously, often a frame or two after the view appears (see cardFacePaint.ts).
 * Only a real reload counts: a source it has already painted (the same bitmap shown for a different card - twin cards
 * in a two-deck game - or an effect re-run by Fast Refresh) gets no new native request and so no onLoad, and must not
 * open a tracker nothing would close. Ghosts don't report (FaceLoadTrackingContext). `onPainted` fires on every load. */
function CardFaceImage({ cardId, source, style, label, onPainted }: { cardId: string; source: ImageSourcePropType; style: StyleProp<ImageStyle>; label: string; onPainted?: () => void }) {
  const tracking = React.useContext(FaceLoadTrackingContext)
  const doneRef = React.useRef<(() => void) | null>(null)
  const paintedSourceRef = React.useRef<ImageSourcePropType | null>(null)
  React.useLayoutEffect(() => {
    if (!tracking || source === paintedSourceRef.current) return
    const done = trackFaceLoad(cardId)
    doneRef.current = done
    return () => {
      if (doneRef.current === done) doneRef.current = null
      done()
    }
  }, [tracking, cardId, source])
  const handleLoad = React.useCallback(() => {
    paintedSourceRef.current = source
    doneRef.current?.()
    onPainted?.()
  }, [source, onPainted])
  return <Image source={source} style={style} resizeMode='stretch' accessibilityLabel={label} onLoad={handleLoad} />
}

/** A faint diagonal gloss over the card's own flat face/back fill, like light catching glossy
 * cardstock - the same static gradient for every card regardless of suit/rank/colors (no props).
 * Lives inside `clip` (see both call sites above), which already clips its children to the card's own
 * rounded radius, so this doesn't need its own corner rounding.
 *
 * A single Image of a pre-baked 64x64 gradient (assets/card-sheen.png), stretched over the card, rather
 * than the per-card react-native-svg tree it used to be (Svg + Defs + LinearGradient + 3 Stops + Rect,
 * ~7 native views on EVERY card). The PNG is the exact same gradient the SVG drew (objectBoundingBox
 * vector (0,0)->(0.65,0.85), white at 24% -> 7% at 28% -> 0% at 50%), so a non-uniform stretch of it
 * reproduces the SVG's look; every card shares the one decoded bitmap. That's roughly a quarter of a
 * card's view count gone, times every card on the board (and again for each ghost during a deal).
 *
 * `subtle` is for the inverted (near-black) face: white on #1A1A1A shows far more than on a white face or a mid-grey
 * back, and at full strength it turned the top-left corner a muddy grey right behind the rank. */
const CardSheen = React.memo(function CardSheen({ subtle = false }: { subtle?: boolean }) {
  return <Image source={SHEEN_SOURCE} style={subtle ? [sheenStyles.sheen, sheenStyles.subtle] : sheenStyles.sheen} resizeMode='stretch' />
})

export function EmptySlot({ onPress, hinted, style, children, testID }: { onPress?: () => void; hinted?: boolean; style?: StyleProp<ViewStyle>; children?: React.ReactNode; testID?: string }) {
  const colors = useTableColors()
  const { width, height } = useCardSize()
  const styles = stylesFor(colors)
  return (
    // disabled when there's nothing to press - otherwise this Pressable still claims the tap (just
    // does nothing with it), silently blocking taps meant for whatever's behind it (e.g. GameChrome's
    // table-tap-to-hide-footer catcher) from ever reaching them.
    <Pressable testID={testID} onPress={onPress} disabled={!onPress} soundDisabled style={[styles.card, { width, height }, hinted ? styles.emptyHinted : styles.empty, style]}>
      {children}
    </Pressable>
  )
}

/** An empty foundation slot, ghosted with the ace it's waiting for. Foundation piles are
 * suit-locked by position (see games/*\/rules.ts's `suitIndex`), but that lock was otherwise
 * invisible until a drop silently failed - this shows which suit belongs here up front. Uses
 * EmptySlot's own plain transparent/dashed styling unmodified - CardFace's `muted` rendering is
 * already just faint linework (see its own MUTED_OPACITY), so a tinted backdrop here would put a
 * card-shaped block back behind it, which is exactly what muted is meant to avoid. */
interface FoundationSlotProps {
  suit: Suit
  /** The rank an empty foundation actually needs first - defaults to Ace, true for every game
   * except Canfield, whose foundations start at a variable "Canfield rank" instead (see
   * CanfieldScreen.tsx, the only caller that ever passes something other than the default). */
  rank?: Rank
  onPress?: () => void
  /** Highlight this empty slot as the Hint feature's suggested destination - see PlayingCard's own
   * `hinted` prop. */
  hinted?: boolean
  style?: StyleProp<ViewStyle>
}

export function FoundationSlot({ suit, rank = 1, onPress, hinted, style }: FoundationSlotProps) {
  const colors = useTableColors()
  const { settings } = useSettings()
  const { width, height } = useCardSize()
  return (
    <EmptySlot onPress={onPress} hinted={hinted} style={style}>
      <CardFace card={{ id: 'foundation-hint', suit, rank, faceUp: true }} colors={colors} width={width} height={height} muted cardStyle={settings.cardStyle} invertDarkModeColors={settings.invertDarkModeColors} />
    </EmptySlot>
  )
}

// Every card on a board (and every ghost during a deal) resolves to the same handful of styles - one per theme colors
// object, invert setting and radius - so build each set once and share it, instead of running StyleSheet.create in
// every card instance (~50 of them per board mount). `colors` is a stable reference until the theme itself changes.
const stylesCache = new WeakMap<TableColors, Map<string, ReturnType<typeof makeStyles>>>()
function stylesFor(colors: TableColors, invertDarkModeColors?: boolean, radius: number = CARD_RADIUS) {
  let byKey = stylesCache.get(colors)
  if (!byKey) {
    byKey = new Map()
    stylesCache.set(colors, byKey)
  }
  const key = `${invertDarkModeColors ? 1 : 0}-${radius}`
  let styles = byKey.get(key)
  if (!styles) {
    styles = makeStyles(colors, invertDarkModeColors, radius)
    byKey.set(key, styles)
  }
  return styles
}

function makeStyles(colors: TableColors, invertDarkModeColors?: boolean, radius: number = CARD_RADIUS) {
  return StyleSheet.create({
    back: {
      backgroundColor: colors.cardBack
    },
    border: {
      borderColor: colors.cardBorder,
      borderRadius: radius,
      borderWidth: 1,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    card: {
      borderRadius: radius
    },
    clip: {
      borderRadius: radius,
      bottom: 0,
      left: 0,
      overflow: 'hidden',
      position: 'absolute',
      right: 0,
      top: 0
    },
    dim: {
      backgroundColor: invertDarkModeColors ? colors.dimOverlayInverted : colors.dimOverlay,
      borderRadius: radius,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    empty: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      borderColor: colors.emptySlot,
      borderStyle: 'dashed',
      borderWidth: 2,
      justifyContent: 'center'
    },
    emptyHinted: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      borderColor: colors.hintGreen,
      borderStyle: 'dashed',
      borderWidth: 2,
      justifyContent: 'center'
    },
    face: {
      backgroundColor: colors.cardFace
    },
    // A ring with a soft glow around it (boxShadow, drawn outside the ring on every platform); HintRing's breathing
    // opacity takes the glow with it.
    hintRing: {
      borderColor: colors.hintGreen,
      borderRadius: radius,
      borderWidth: 2.5,
      bottom: 0,
      boxShadow: `0 0 10px 2px ${colors.hintGreen}`,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    selectedRing: {
      borderColor: colors.selectedGlow,
      borderRadius: radius,
      borderWidth: 3,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    // Shadow lives on the outer Pressable, never on the same node as `clip`'s overflow: 'hidden' -
    // iOS draws a view's shadow and its overflow clip on the same layer, so a masked layer clips
    // away its own shadow rather than just its content.
    shadow: {
      elevation: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3
    }
  })
}
