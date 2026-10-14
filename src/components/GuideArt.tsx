import { getTonalColor, useAutoPaperTheme } from '@rific/auto-paper'
import type { SwipePointer } from '@tastic/hud/guide'
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import { Icon, Text } from 'react-native-paper'

import { HINT_RING_TONE } from '@/constants/theme'

// Solitaire's illustrations for the how-to-play cards (see constants/guideSteps.tsx). None of
// @tastic/hud/guide's shared pictures (a swipe, key caps, a split phone) fits a card game, so these
// are drawn here. Plain Views, Paper Icons and Text only: no Skia, no SVG, and deliberately not the
// in-game PlayingCard/pile components or @tastic/cards, so mounting them over Home costs nothing and
// they can't drift with the card art. Every color comes from the live Paper theme.

// Card size in the pictures, and how far a card fanned onto another sits below it (about the game's
// own face-up fan step for a card this wide, which keeps the covered card's rank and suit showing).
const CARD_WIDTH = 40
const CARD_HEIGHT = 56
const FAN_STEP = 18

type Suit = 'heart' | 'spade'

const SUIT_ICON: Record<Suit, string> = { heart: 'cards-heart', spade: 'cards-spade' }

// The dotted path from what's pressed to where the move goes, faint to strong like SwipeHint's.
const PATH_DOTS = [0, 1, 2, 3]
const PATH_DOT = 5
const PATH_GAP = 5
const PATH_WIDTH = PATH_DOTS.length * PATH_DOT + (PATH_DOTS.length - 1) * PATH_GAP

// A face-up card: rank and suit in the top strip (the part that stays visible when another card is
// fanned over it) and a big suit in the middle. Red suits use the theme's error red, black suits its
// on-surface ink, so the card reads right in light and dark mode alike.
function MiniCard({ rank, suit, style }: { rank: string; suit: Suit; style?: StyleProp<ViewStyle> }) {
  const { colors } = useAutoPaperTheme()
  const ink = suit === 'heart' ? colors.error : colors.onSurface

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.outline }, style]}>
      <View style={styles.cardIndex}>
        <Text style={[styles.cardRank, { color: ink }]}>{rank}</Text>
        <Icon source={SUIT_ICON[suit]} size={11} color={ink} />
      </View>
      <View style={styles.cardPip}>
        <Icon source={SUIT_ICON[suit]} size={20} color={ink} />
      </View>
    </View>
  )
}

// A row of PATH_DOTS in the theme's primary. `style` places it (both pictures position it absolutely).
function PathDots({ style }: { style: StyleProp<ViewStyle> }) {
  const { colors } = useAutoPaperTheme()

  return (
    <View style={[styles.pathRow, style]}>
      {PATH_DOTS.map((i) => (
        <View key={i} style={[styles.dot, { backgroundColor: colors.primary, opacity: 0.35 + (0.65 * i) / (PATH_DOTS.length - 1) }]} />
      ))}
    </View>
  )
}

// "Tap a card for its best move": a red seven with a fingertip (or, on desktop, a mouse
// pointer) on it, a dotted path, and the same seven landing fanned onto a black eight. `pointer`
// also picks the screen-reader verb, so a desktop player is never told to tap.
export function GuideCardPlay({ pointer }: { pointer: SwipePointer }) {
  const { colors } = useAutoPaperTheme()
  const verb = pointer === 'mouse' ? 'Clicking' : 'Tapping'

  return (
    <View accessible accessibilityLabel={`${verb} a red seven sends it onto a black eight`} style={styles.playStage}>
      <MiniCard rank='8' suit='spade' style={styles.target} />
      <MiniCard rank='7' suit='heart' style={[styles.landed, styles.landedGhost]} />
      <MiniCard rank='7' suit='heart' style={styles.source} />
      <PathDots style={styles.path} />
      <View style={styles.arrow}>
        <Icon source='chevron-right' size={20} color={colors.primary} />
      </View>
      {pointer === 'mouse' ? (
        <View style={styles.mouse}>
          <Icon source='cursor-default-click' size={28} color={colors.primary} />
        </View>
      ) : (
        <View style={[styles.finger, { borderColor: colors.primary }]} />
      )}
    </View>
  )
}

// One labelled number in the score picture, captioned the way the game's own readout captions it.
function ScoreTerm({ caption, value, highlight }: { caption: string; value: string; highlight?: boolean }) {
  const { colors } = useAutoPaperTheme()
  const color = highlight ? colors.primary : colors.onSurface

  return (
    <View style={styles.term}>
      <Text variant='labelSmall' style={{ color: colors.onSurfaceVariant }}>
        {caption}
      </Text>
      <View style={styles.termValue}>
        <Text variant='headlineSmall' style={[styles.termNumber, { color }]}>
          {value}
        </Text>
        {highlight && <Icon source='arrow-down-bold' size={18} color={color} />}
      </View>
    </View>
  )
}

// "Your score is moves plus seconds": 12 moves + 33 seconds = a score of 45 (engine/score.ts's
// computeScore), with a down arrow on the score for "lower is better".
export function GuideScore() {
  const { colors } = useAutoPaperTheme()
  const operator = [styles.operator, { color: colors.onSurfaceVariant }]

  return (
    <View accessible accessibilityLabel='12 moves plus 33 seconds is a score of 45' style={styles.scoreRow}>
      <ScoreTerm caption='Moves' value='12' />
      <Text variant='titleLarge' style={operator}>
        +
      </Text>
      <ScoreTerm caption='Seconds' value='33' />
      <Text variant='titleLarge' style={operator}>
        =
      </Text>
      <ScoreTerm caption='Score' value='45' highlight />
    </View>
  )
}

// "Tap the light bulb to see a move you can make": GameChrome's Hint button (its exact
// lightbulb-on-outline icon), a dotted path, and the move it points out: a red seven, ringed and
// glowing the way a hinted card is in a game (PlayingCard's HintRing), and the black eight it can go
// on. Only the card to move is ringed, as in a game (the game's glide shows where it goes).
export function GuideHint() {
  const { colors } = useAutoPaperTheme()
  // The game's hint ring color (theme.ts's hintGreen): the theme's tertiary, lifted.
  const ringColor = getTonalColor(colors.tertiary, HINT_RING_TONE)
  const ring = [styles.hintRing, { borderColor: ringColor, boxShadow: `0 0 8px 1px ${ringColor}` }]

  return (
    <View accessible accessibilityLabel='The light bulb button, and a red seven ringed as the card to move onto a black eight' style={styles.hintStage}>
      <View style={[styles.hintButton, { backgroundColor: colors.surfaceVariant }]}>
        <Icon source='lightbulb-on-outline' size={30} color={colors.primary} />
      </View>
      <PathDots style={styles.hintPath} />
      <View style={[ring, { left: HINT_SEVEN_LEFT - HINT_RING_GAP }]} />
      <MiniCard rank='7' suit='heart' style={[styles.hintCard, { left: HINT_SEVEN_LEFT }]} />
      <MiniCard rank='8' suit='spade' style={[styles.hintCard, { left: HINT_EIGHT_LEFT }]} />
    </View>
  )
}

const FINGER = 30
const MOUSE = 28

// The play picture's layout: the source card on the left, the target on the right with the landed
// seven fanned one step below its top, and the path running between the two sevens' centres.
const SOURCE_LEFT = 16
const TARGET_LEFT = 120
const TARGET_TOP = 12
const ROW_TOP = TARGET_TOP + FAN_STEP
const ROW_CENTER = ROW_TOP + CARD_HEIGHT / 2

// The hint picture's layout, left to right: the round button, the dotted path, then the ringed seven
// and the eight. The ring sits HINT_RING_GAP outside its card, so its 3px stroke never covers the
// card's own edge; the eight keeps the same spacing so the picture's width is unchanged.
const HINT_BUTTON = 56
const HINT_TOP = 8
const HINT_RING_GAP = 4
const HINT_PATH_LEFT = HINT_BUTTON + 8
const HINT_SEVEN_LEFT = HINT_PATH_LEFT + PATH_WIDTH + 8 + HINT_RING_GAP
const HINT_EIGHT_LEFT = HINT_SEVEN_LEFT + CARD_WIDTH + HINT_RING_GAP * 2 + 8

const styles = StyleSheet.create({
  arrow: {
    left: 96,
    position: 'absolute',
    top: ROW_CENTER - 10
  },
  card: {
    borderRadius: 5,
    borderWidth: 1,
    height: CARD_HEIGHT,
    padding: 3,
    position: 'absolute',
    width: CARD_WIDTH
  },
  cardIndex: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 1
  },
  cardPip: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center'
  },
  cardRank: {
    fontSize: 12,
    fontWeight: 'bold',
    lineHeight: 14
  },
  dot: {
    borderRadius: PATH_DOT / 2,
    height: PATH_DOT,
    width: PATH_DOT
  },
  // Centred on the source card, like a fingertip resting on it.
  finger: {
    borderRadius: FINGER / 2,
    borderWidth: 3,
    height: FINGER,
    left: SOURCE_LEFT + CARD_WIDTH / 2 - FINGER / 2,
    position: 'absolute',
    top: ROW_CENTER - FINGER / 2,
    width: FINGER
  },
  hintButton: {
    alignItems: 'center',
    borderRadius: HINT_BUTTON / 2,
    height: HINT_BUTTON,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: HINT_TOP,
    width: HINT_BUTTON
  },
  hintCard: {
    top: HINT_TOP
  },
  hintPath: {
    left: HINT_PATH_LEFT,
    top: HINT_TOP + CARD_HEIGHT / 2 - PATH_DOT / 2
  },
  hintRing: {
    borderRadius: 8,
    borderWidth: 3,
    height: CARD_HEIGHT + HINT_RING_GAP * 2,
    position: 'absolute',
    top: HINT_TOP - HINT_RING_GAP,
    width: CARD_WIDTH + HINT_RING_GAP * 2
  },
  hintStage: {
    height: HINT_TOP * 2 + CARD_HEIGHT,
    width: HINT_EIGHT_LEFT + CARD_WIDTH + HINT_RING_GAP
  },
  landed: {
    left: TARGET_LEFT,
    top: ROW_TOP
  },
  // Where the tapped card is headed, drawn faint: it hasn't landed yet.
  landedGhost: {
    opacity: 0.45
  },
  // The pointer's tip sits on the source card's centre.
  mouse: {
    left: SOURCE_LEFT + CARD_WIDTH / 2 - MOUSE / 4,
    position: 'absolute',
    top: ROW_CENTER - MOUSE / 6
  },
  operator: {
    marginBottom: 4
  },
  path: {
    left: SOURCE_LEFT + CARD_WIDTH + 6,
    top: ROW_CENTER - PATH_DOT / 2
  },
  pathRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: PATH_GAP,
    position: 'absolute'
  },
  playStage: {
    height: ROW_TOP + CARD_HEIGHT + 12,
    width: TARGET_LEFT + CARD_WIDTH + 16
  },
  scoreRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 6
  },
  source: {
    left: SOURCE_LEFT,
    top: ROW_TOP
  },
  target: {
    left: TARGET_LEFT,
    top: TARGET_TOP
  },
  term: {
    alignItems: 'center',
    minWidth: 48
  },
  termNumber: {
    fontWeight: 'bold'
  },
  termValue: {
    alignItems: 'center',
    flexDirection: 'row'
  }
})
