import { IconButton, Pressable } from '@rific/feedback-press'
import { type TableColors } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { PressAwayOverlay, usePopoverHost } from '@tastic/hud'
import { useAutoShowGuide } from '@tastic/hud/guide'
import { Link, Redirect, useIsFocused, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native'
import { Icon, MD3Theme, useTheme } from 'react-native-paper'

import { GamePreview, type PreviewCardPlacement } from '@/components/GamePreview'
import { HeroCards } from '@/components/HeroCards'
import { HOME_GRID_GAP, HOME_TILE_PADDING, HOME_TOP_BAND, HOME_WIDE_MAX_FONT_SCALE, HOME_WIDE_PANE_GAP, useHomeLayout } from '@/components/homeLayout'
import type { PreviewGame } from '@/components/previewFaceBitmaps'
import { ProfilePanel } from '@/components/ProfilePanel'
import { RotatedScreen } from '@/components/RotatedScreen'
import { RulesDialog } from '@/components/RulesDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { CHROME_FG, useTableColors } from '@/components/theme'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { ACESUP_RULES, CANFIELD_RULES, FORTYTHIEVES_RULES, FREECELL_RULES, GOLF_RULES, KLONDIKE_RULES, PYRAMID_RULES, SCORPION_RULES, SPIDER_RULES, TRIPEAKS_RULES, YUKON_RULES } from '@/constants/gameRules'
import { buildAcesUpPreview } from '@/games/acesup/previewLayout'
import { buildCanfieldPreview } from '@/games/canfield/previewLayout'
import { buildFortyThievesPreview } from '@/games/fortythieves/previewLayout'
import { buildFreeCellPreview } from '@/games/freecell/previewLayout'
import { buildGolfPreview } from '@/games/golf/previewLayout'
import { buildKlondikePreview } from '@/games/klondike/previewLayout'
import { buildPyramidPreview } from '@/games/pyramid/previewLayout'
import { buildScorpionPreview } from '@/games/scorpion/previewLayout'
import { buildSpiderPreview } from '@/games/spider/previewLayout'
import { buildTriPeaksPreview } from '@/games/tripeaks/previewLayout'
import { buildYukonPreview } from '@/games/yukon/previewLayout'
import { useLastActiveGame } from '@/stores/lastActiveGame'

interface GameEntry {
  href: '/klondike' | '/spider' | '/freecell' | '/pyramid' | '/yukon' | '/golf' | '/tripeaks' | '/canfield' | '/scorpion' | '/fortythieves' | '/acesup'
  title: string
  blurb: string
  // Every game's starting deal is fully determined by its own fixed PREVIEW_SEED, so this is built
  // once here at module load rather than recomputed on every Home render.
  placements: PreviewCardPlacement[]
  rules: string[]
}

// Grouped by mechanic rather than insertion order: build-down-to-foundations games first
// (Klondike/FreeCell/Yukon/Canfield/Forty Thieves all end with ascending same-suit foundations),
// then Spider/Scorpion (tableau sequence-building, but no foundations at all), then the
// clear-the-tableau games (Pyramid/Golf/TriPeaks discard cards outright instead of building
// anything up), then Aces Up last (its own odd-one-out shape - no tableau building at all).
const GAMES: GameEntry[] = [
  { href: '/klondike', title: 'Klondike', blurb: 'The classic. Draw 1 or draw 3.', placements: buildKlondikePreview(), rules: KLONDIKE_RULES },
  { href: '/freecell', title: 'FreeCell', blurb: 'Nearly every deal is winnable.', placements: buildFreeCellPreview(), rules: FREECELL_RULES },
  { href: '/yukon', title: 'Yukon', blurb: 'No stock. Move any stack, anywhere.', placements: buildYukonPreview(), rules: YUKON_RULES },
  { href: '/canfield', title: 'Canfield', blurb: 'Foundations start wherever the deck says.', placements: buildCanfieldPreview(), rules: CANFIELD_RULES },
  { href: '/fortythieves', title: 'Forty Thieves', blurb: 'Two decks, eight foundations, no mercy.', placements: buildFortyThievesPreview(), rules: FORTYTHIEVES_RULES },
  { href: '/spider', title: 'Spider', blurb: '1, 2, or 4 suit difficulty.', placements: buildSpiderPreview(), rules: SPIDER_RULES },
  { href: '/scorpion', title: 'Scorpion', blurb: 'Build same-suit runs, any group moves.', placements: buildScorpionPreview(), rules: SCORPION_RULES },
  { href: '/pyramid', title: 'Pyramid', blurb: 'Pair up cards that sum to 13.', placements: buildPyramidPreview(), rules: PYRAMID_RULES },
  { href: '/golf', title: 'Golf', blurb: 'Clear the tableau, one rank up or down.', placements: buildGolfPreview(), rules: GOLF_RULES },
  { href: '/tripeaks', title: 'TriPeaks', blurb: 'Clear three peaks, one rank up or down.', placements: buildTriPeaksPreview(), rules: TRIPEAKS_RULES },
  { href: '/acesup', title: 'Aces Up', blurb: 'Discard down to just the 4 Aces.', placements: buildAcesUpPreview(), rules: ACESUP_RULES }
]

export default function Home() {
  const { consumeResumeGame } = useLastActiveGame()
  // A one-shot cold-launch decision, read exactly once at this instance's mount (see
  // stores/lastActiveGame.tsx) - never a live value this screen re-renders from. Reading it live made
  // every Home in the stack swap its whole menu for a Redirect while a game was on top and rebuild it
  // (all ~370 preview cards) the moment Home was tapped, which is what made going Home take seconds.
  const [resumeGame] = useState(consumeResumeGame)
  // First launch only (and once per session): opens the how-to-play cards over this screen (see
  // GuideHost). Held back while this Home is about to redirect into a saved game, so the guide can
  // never open over a live deal, whose clock is running. Called before the early return: hooks run
  // unconditionally.
  useAutoShowGuide(!resumeGame)

  // A cold launch/relaunch while a game was in progress drops the player straight back onto it,
  // skipping this menu entirely - it only reappears once they explicitly back out of that game
  // (see stores/lastActiveGame.tsx). Redirects as soon as this mounts, before the menu below ever
  // paints, since the persisted value is already resolved by _layout.tsx's splash-gate pre-load.
  if (resumeGame) return <Redirect href={`/${resumeGame}`} />

  return <HomeMenu />
}

/** The menu inside the same rotated frame every game screen gets (see RotatedScreen and withGameProviders): the OS
 * stays portrait-locked and the screen is visually turned to follow the phone, so Home is upright however it is
 * held, and its dialogs portal into a Portal.Host INSIDE that frame. */
function HomeMenu() {
  return (
    <RotatedScreen>
      <HomeContent />
    </RotatedScreen>
  )
}

function HomeContent() {
  const router = useRouter()
  const layout = useHomeLayout()
  const { insets } = layout
  const rotation = useRotation()
  // Home stays mounted beneath a game/Achievements/Profiles and nothing freezes it, so it keeps following the
  // rotation while covered - and crossing the portrait/wide threshold swaps its whole tree (11 tiles, the
  // hero, the profile panel), invisible work landing in the same commit as the covering game's own rotation
  // update. While unfocused the branch is held where it was; it re-syncs (one swap, visible) when Home is
  // shown again. The pane numbers are not frozen - the branch they belong to isn't rendered while it is held.
  const focused = useIsFocused()
  const isWide = useFrozenWhileHidden(layout.isWide, !focused)
  const colors = useTableColors()
  const { dark, colors: paperColors } = useTheme()
  const styles = useMemo(() => makeStyles(colors, dark, paperColors), [colors, dark, paperColors])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesFor, setRulesFor] = useState<GameEntry | null>(null)
  // Owns the profile row's popover state so a full-screen @tastic/hud PressAwayOverlay can be
  // rendered here, at the screen root, below (see the early-sibling render order at the top of
  // the screen's own View) every real control - Solitaire has just the one, unscoped zone (no
  // split-screen sibling to shield from), so unlike the fleet's split-screen loadout/lobby
  // screens this needs neither a style rect nor a second host to shield against.
  const profileHost = usePopoverHost()
  // A popover is placed once, when it opens, from measurements of the frame it opens in. Rotating (or any
  // resize) moves that frame under it, and switching between the portrait column and the two panes unmounts
  // the very trigger it hangs off - which would leave the press-away overlay up with nothing to dismiss. So
  // every layout change closes it.
  const closeProfilePopover = profileHost.close
  useEffect(() => {
    closeProfilePopover()
  }, [rotation, layout.isWide, layout.windowWidth, layout.windowHeight, closeProfilePopover])
  // Every tile's card art is deferred by one frame rather than rendered eagerly - mounting all
  // eleven tiles' full starting deals (~400+ SVG/View nodes) synchronously in the very same commit
  // that a navigation lands on is real, noticeable native-bridge work (confirmed live on-device:
  // it was enough to make the whole screen transition itself stall for a beat, reading as "pressing
  // Home hangs" rather than a quick, responsive tap - far worse than the tile briefly showing no
  // card art). Deferring unconditionally, with no eagerly-rendered exception for the above-the-fold
  // tiles, keeps Home's own first commit to just its cheap chrome (title/blurb/borders, no card
  // SVGs at all) - by far the more responsive tradeoff, even though it means every tile (not just
  // the below-the-fold ones) shows empty for one frame.
  const [previewsRevealed, setPreviewsRevealed] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setPreviewsRevealed(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const infoIconColor = dark ? paperColors.onSurfaceVariant : '#888'

  // One rules button per tile, shared by both layouts' tile shapes. Both calls are needed on web: Link
  // asChild renders a real <a href>, so stopPropagation alone leaves the anchor's own native navigation
  // still armed - only preventDefault actually stops that. Checking the rules is a diversion from tapping
  // the row to go play, not a step toward it.
  const renderRulesButton = (g: GameEntry, style: StyleProp<ViewStyle>, iconColor: string) => (
    <Pressable
      onPress={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setRulesFor(g)
      }}
      style={style}
      accessibilityLabel={`${g.title} rules`}
      hitSlop={12}
    >
      <Icon source='information-outline' size={22} color={iconColor} />
    </Pressable>
  )

  // Flattened, not `[styles.tile, { width }]`: <Link asChild> hands its child to expo-router's Slot, which
  // throws on a child whose `style` is an array.
  const wideTileStyle = StyleSheet.flatten([styles.tile, { width: layout.tileWidth }])
  const tiles = GAMES.map((g) => (
    <Link key={g.href} href={g.href} asChild>
      {isWide ? (
        // Wide: a vertical tile (preview on top, text under it) - a horizontal row needs ~290pt, which two
        // columns beside the left pane can't give it. The rules button floats over the preview's corner.
        <Pressable style={wideTileStyle}>
          <View>
            <GamePreview game={g.href.slice(1) as PreviewGame} placements={previewsRevealed ? g.placements : []} colors={colors} style={styles.tilePreview} />
            {renderRulesButton(g, styles.tileInfoButton, '#fff')}
          </View>
          <Text style={styles.tileTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {g.title}
          </Text>
          <Text style={styles.tileBlurb} numberOfLines={3}>
            {g.blurb}
          </Text>
        </Pressable>
      ) : (
        <Pressable style={styles.card}>
          <GamePreview game={g.href.slice(1) as PreviewGame} placements={previewsRevealed ? g.placements : []} colors={colors} style={styles.preview} />
          <View style={styles.cardText}>
            <Text style={styles.cardTitle}>{g.title}</Text>
            <Text style={styles.cardBlurb}>{g.blurb}</Text>
          </View>
          {renderRulesButton(g, styles.infoButton, infoIconColor)}
        </Pressable>
      )}
    </Link>
  ))

  // Invisible full-bleed "press away to close" catcher for the profile popover. Unlike the fleet's
  // non-scrolling split-screen HUDs (where PressAwayOverlay's own "plain paint order, later sibling wins"
  // doc comment is enough), this screen's real content is full of plain, unpositioned Views (HeroCards,
  // headings, the game grid) - on web those still capture a tap even with no handler of their own (RN Web
  // resolves hit-testing via real DOM stacking, not native's "walk up looking for a responder, fall through
  // if none" model), so paint order alone would never let a tap on blank space reach it. styles.pressAway's
  // zIndex fixes that: above the plain content's own (unset/0) stacking so blank space actually dismisses,
  // but below the panel that owns the popover so its rows stay tappable.
  //
  // WHERE it is mounted matters on native, where zIndex only orders siblings of ONE parent: a
  // screen-level overlay sits above a whole ScrollView, popover rows included, so tapping "Manage" or a
  // swatch just closed the popover. In portrait the popover lives inside the scroll content, so the overlay
  // goes there too (first child - a sibling of profilePanelWrap, which outranks it); in the wide layout the
  // left pane is itself a screen-level sibling, so the overlay stays at screen level beneath it.
  const pressAway = <PressAwayOverlay active={profileHost.openId !== null} onPress={profileHost.close} style={styles.pressAway} />

  return (
    <View style={styles.screen}>
      {isWide ? (
        <>
          {pressAway}
          {/* Right pane: the game grid, scrolling on its own between the left pane and the cog's gutter. */}
          <ScrollView style={[styles.wideRightPane, { left: layout.paddingLeft + layout.leftPaneWidth + HOME_WIDE_PANE_GAP, right: layout.paddingRight }]} contentContainerStyle={[styles.wideGrid, { paddingTop: 16 + insets.top, paddingBottom: 16 + insets.bottom }]}>
            {tiles}
          </ScrollView>
          {/* Left pane: the hero, title and subtitle, then the player chip - the same order as portrait - centred as
          one group in the space under the corner-button band.
          A screen-level sibling of the overlay (not something inside a scroller) so its zIndex really does
          lift the profile popover above the overlay - zIndex only orders siblings of one parent on native.
          box-none: only the chip claims taps (the hero/title are pointerEvents none), the rest falls through to
          whatever is beneath. The chip sits LOW in the frame, so its popover has little room below it - which is
          why its placement is frame-aware (ProfilePanel's `alignOverride`: it flips above when there is more room
          there) instead of @tastic/hud's, which measures along the wrong axes under a fake rotation. */}
          <View style={[styles.wideLeftPane, { left: layout.paddingLeft, width: layout.leftPaneWidth, paddingTop: HOME_TOP_BAND + insets.top, paddingBottom: 16 + insets.bottom }]} pointerEvents='box-none'>
            <View style={styles.wideHeader} pointerEvents='none'>
              <HeroCards scale={layout.heroScale} />
              <Text style={[styles.heading, { fontSize: layout.titleFontSize }]} maxFontSizeMultiplier={HOME_WIDE_MAX_FONT_SCALE}>
                Solitaire
              </Text>
              <Text style={[styles.subheading, styles.wideSubheading]} maxFontSizeMultiplier={HOME_WIDE_MAX_FONT_SCALE}>
                No ads. No accounts. Plays offline. Just cards.
              </Text>
            </View>
            <View style={styles.wideProfileWrap}>
              <ProfilePanel host={profileHost} />
            </View>
          </View>
        </>
      ) : (
        <ScrollView contentContainerStyle={[styles.container, { paddingTop: 56 + insets.top }]}>
          {pressAway}
          <HeroCards />
          <Text style={styles.heading}>Solitaire</Text>
          <Text style={styles.subheading}>No ads. No accounts. Plays offline. Just cards.</Text>

          <View style={styles.profilePanelWrap}>
            <ProfilePanel host={profileHost} />
          </View>

          <View style={styles.grid}>{tiles}</View>
        </ScrollView>
      )}

      {/* Trophy (top-left) and cog (top-right), inside ONE plain View that carries the stacking.
      The buttons can't carry it themselves: a Paper IconButton is a Surface, and on iOS Surface moves only
      position/top/left/... onto its OUTERMOST view and leaves zIndex on an inner layer - so an IconButton with
      `style={{ zIndex: 10 }}` is still stacked at 0 on native, below the full-screen ScrollView that is its
      later sibling, and never receives a touch (it looked fine because the ScrollView is transparent there).
      Same wrapper GameChrome puts round its corner buttons. It fills the frame (rather than being a
      zero-height strip) with box-none, so only the two buttons claim taps and everything else falls through
      to the pane underneath; on web the same zIndex wins DOM-order hit-testing over the later ScrollView. */}
      <View style={styles.cornerButtons} pointerEvents='box-none'>
        <IconButton icon='trophy' iconColor={CHROME_FG} size={24} style={[styles.cornerButton, { top: 8 + insets.top, left: 8 + insets.left }]} onPress={() => router.push('/achievements')} accessibilityLabel='Stats & Achievements' />
        <IconButton icon='cog' iconColor={CHROME_FG} size={24} style={[styles.cornerButton, { top: 8 + insets.top, right: 8 + insets.right }]} onPress={() => setSettingsOpen(true)} accessibilityLabel='Settings' />
      </View>

      {/* rotation={0}: these portal into the Portal.Host HomeMenu mounts INSIDE the rotated frame, so they are
      already turned with it - the dialog's own ambient rotation on top would turn them twice. */}
      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} rotation={0} showHowToPlay />

      <RulesDialog visible={!!rulesFor} onDismiss={() => setRulesFor(null)} title={rulesFor?.title ?? ''} rules={rulesFor?.rules ?? []} compact={isWide} />
    </View>
  )
}

function makeStyles(colors: TableColors, dark: boolean, paperColors: MD3Theme['colors']) {
  return StyleSheet.create({
    card: {
      alignItems: 'center',
      // The opaque near-white "index card" look is deliberate in light mode (bright, readable
      // against the felt) - but the same fixed light color in dark mode read as a light-mode
      // island stranded in an otherwise dark UI, so dark mode switches to Paper's own surface
      // color instead (matching the achievements screen / settings dialog's dark surfaces).
      backgroundColor: dark ? paperColors.surface : '#ffffffee',
      borderRadius: 12,
      flexDirection: 'row',
      gap: 14,
      padding: 14
    },
    cardBlurb: {
      color: dark ? paperColors.onSurfaceVariant : '#444',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 13,
      marginTop: 4
    },
    cardText: {
      flex: 1
    },
    cardTitle: {
      color: dark ? paperColors.onSurface : colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 20,
      fontWeight: '700'
    },
    container: {
      alignItems: 'center',
      flexGrow: 1,
      padding: 20
    },
    // Just the position - the stacking lives on cornerButtons below (see where it's rendered for why the
    // buttons can't carry a zIndex themselves).
    cornerButton: {
      position: 'absolute'
    },
    // The full-frame carrier of the two corner buttons' stacking. The ScrollView is a later sibling whose
    // own outer wrapper spans the whole screen, so on web it wins pointer-event hit-testing over an
    // unelevated earlier sibling by DOM order alone, and on iOS an IconButton's own zIndex never reaches its
    // outer view.
    cornerButtons: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 10
    },
    grid: {
      gap: 14,
      maxWidth: 480,
      width: '100%'
    },
    heading: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 32,
      fontWeight: '800'
    },
    infoButton: {
      padding: 4
    },
    // See this style's render-site comment - above the ScrollView's own unset/0 stacking (so a
    // tap on its blank space actually reaches this overlay on web) but below cornerButton/
    // profilePanelWrap's zIndex:10 (so those stay directly tappable through it).
    pressAway: {
      zIndex: 5
    },
    preview: {
      backgroundColor: colors.tableFelt,
      borderRadius: 8,
      width: 92
    },
    profilePanelWrap: {
      alignItems: 'center',
      marginBottom: 16,
      // The game grid below is a later sibling of equal-or-higher effective stacking on web -
      // without this, its <Link> cards win pointer-event hit-testing over this panel's own
      // popovers (profile picker, color swatches) wherever the two visually overlap, even though
      // the popovers paint on top. See the game screens' identical cornerButtons comment.
      position: 'relative',
      zIndex: 10
    },
    screen: {
      flex: 1
    },
    subheading: {
      color: '#E6F4EA',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 14,
      marginBottom: 24,
      marginTop: 4
    },
    // Wide layout tile: the portrait row turned on its side - preview on top, text under it. Same surface
    // as `card` (opaque near-white in light mode, Paper's surface in dark).
    tile: {
      backgroundColor: dark ? paperColors.surface : '#ffffffee',
      borderRadius: 12,
      gap: 6,
      padding: HOME_TILE_PADDING
    },
    tileBlurb: {
      color: dark ? paperColors.onSurfaceVariant : '#444',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 12
    },
    // The rules button floats over the preview's top-right corner: a small translucent disc so the white
    // icon reads on both the felt and the card art. hitSlop (on the Pressable) grows its touch area.
    tileInfoButton: {
      alignItems: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.35)',
      borderRadius: 14,
      height: 28,
      justifyContent: 'center',
      position: 'absolute',
      right: 4,
      top: 4,
      width: 28
    },
    // Fills the tile's inner width (the tile's own padding is the margin), unlike portrait's fixed 92pt.
    tilePreview: {
      backgroundColor: colors.tableFelt,
      borderRadius: 8
    },
    tileTitle: {
      color: dark ? paperColors.onSurface : colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 18,
      fontWeight: '700'
    },
    // The wide layout's two panes are absolutely positioned siblings of the press-away overlay (see the
    // render site), so each is placed by the screen-level offsets computed in homeLayout.ts.
    wideGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: HOME_GRID_GAP
    },
    wideHeader: {
      alignItems: 'center'
    },
    // Same lift as profilePanelWrap in portrait, for the same reason (the popover must beat later siblings).
    // The hero/title/subtitle and the chip are one group, centred vertically in the pane.
    wideLeftPane: {
      alignItems: 'center',
      bottom: 0,
      justifyContent: 'center',
      position: 'absolute',
      top: 0,
      zIndex: 10
    },
    // alignSelf: shrinks to the chip row (portrait's wrapper does, inside an alignItems:'center' container) -
    // stretched across the pane it would sit above the press-away overlay and swallow taps beside the chip.
    wideProfileWrap: {
      alignItems: 'center',
      alignSelf: 'center',
      marginTop: 12,
      position: 'relative',
      zIndex: 10
    },
    wideRightPane: {
      bottom: 0,
      position: 'absolute',
      top: 0
    },
    wideSubheading: {
      marginBottom: 0,
      textAlign: 'center'
    }
  })
}
