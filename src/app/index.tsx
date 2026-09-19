import { IconButton, Pressable } from '@rific/feedback-press'
import { type TableColors } from '@tastic/cards'
import { PressAwayOverlay, usePopoverHost } from '@tastic/hud'
import { Link, Redirect, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon, MD3Theme, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { GamePreview, type PreviewCardPlacement } from '@/components/GamePreview'
import { HeroCards } from '@/components/HeroCards'
import { ProfilePanel } from '@/components/ProfilePanel'
import { RulesDialog } from '@/components/RulesDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { TableBackground } from '@/components/TableBackground'
import { CHROME_FG, useTableColors } from '@/components/theme'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
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
import { preloadGameInProgress } from '@/stores/gameInProgress'
import { useLastActiveGame } from '@/stores/lastActiveGame'
import { SolitaireGameId } from '@/stores/statsTypes'

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
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const colors = useTableColors()
  const { dark, colors: paperColors } = useTheme()
  const styles = useMemo(() => makeStyles(colors, dark, paperColors), [colors, dark, paperColors])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesFor, setRulesFor] = useState<GameEntry | null>(null)
  const { consumeResumeGame } = useLastActiveGame()
  // A one-shot cold-launch decision, read exactly once at this instance's mount (see
  // stores/lastActiveGame.tsx) - never a live value this screen re-renders from. Reading it live made
  // every Home in the stack swap its whole menu for a Redirect while a game was on top and rebuild it
  // (all ~370 preview cards) the moment Home was tapped, which is what made going Home take seconds.
  const [resumeGame] = useState(consumeResumeGame)
  // Owns the profile row's popover state so a full-screen @tastic/hud PressAwayOverlay can be
  // rendered here, at the screen root, below (see the early-sibling render order right after
  // TableBackground) every real control - Solitaire has just the one, unscoped zone (no
  // split-screen sibling to shield from), so unlike the fleet's split-screen loadout/lobby
  // screens this needs neither a style rect nor a second host to shield against.
  const profileHost = usePopoverHost()
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

  // A cold launch/relaunch while a game was in progress drops the player straight back onto it,
  // skipping this menu entirely - it only reappears once they explicitly back out of that game
  // (see stores/lastActiveGame.tsx). Redirects as soon as this mounts, before the menu below ever
  // paints, since the persisted value is already resolved by _layout.tsx's splash-gate pre-load.
  if (resumeGame) return <Redirect href={`/${resumeGame}`} />

  return (
    <View style={styles.screen}>
      <TableBackground />
      {/* Unlike the fleet's non-scrolling split-screen HUDs (where PressAwayOverlay's own "plain
      paint order, later sibling wins" doc comment is enough on its own), this screen's real
      content is a ScrollView full of plain, unpositioned Views (HeroCards, headings, the game
      grid) - on web, those still capture a tap even with no handler of their own (RN Web resolves
      hit-testing via real DOM stacking, not native's "walk up looking for a responder, fall
      through if none" model), so paint order alone would never let a tap on blank ScrollView
      space reach this overlay. styles.pressAway's zIndex fixes that: above the ScrollView's own
      (unset/0) stacking so blank space actually dismisses, but still below cornerButton/
      profilePanelWrap's zIndex:10 so those stay directly tappable, same idea as their own
      "wins pointer-event hit-testing on web" comments below. */}
      <PressAwayOverlay active={profileHost.openId !== null} onPress={profileHost.close} style={styles.pressAway} />
      <IconButton icon='trophy' iconColor={CHROME_FG} size={24} style={[styles.cornerButton, { top: 8 + insets.top, left: 8 + insets.left }]} onPress={() => router.push('/achievements')} accessibilityLabel='Stats & Achievements' />
      <IconButton icon='cog' iconColor={CHROME_FG} size={24} style={[styles.cornerButton, { top: 8 + insets.top, right: 8 + insets.right }]} onPress={() => setSettingsOpen(true)} accessibilityLabel='Settings' />

      <ScrollView contentContainerStyle={[styles.container, { paddingTop: 56 + insets.top }]}>
        <HeroCards />
        <Text style={styles.heading}>Solitaire Suite</Text>
        <Text style={styles.subheading}>No ads. No accounts. No network. Just cards.</Text>

        <View style={styles.profilePanelWrap}>
          <ProfilePanel host={profileHost} />
        </View>

        <View style={styles.grid}>
          {GAMES.map((g) => (
            <Link key={g.href} href={g.href} asChild>
              <Pressable style={styles.card} onPressIn={() => preloadGameInProgress(g.href.slice(1) as SolitaireGameId)}>
                <GamePreview placements={previewsRevealed ? g.placements : []} colors={colors} style={styles.preview} />
                <View style={styles.cardText}>
                  <Text style={styles.cardTitle}>{g.title}</Text>
                  <Text style={styles.cardBlurb}>{g.blurb}</Text>
                </View>
                <Pressable
                  onPress={(e) => {
                    // Both calls are needed on web: Link asChild renders a real <a href>, so
                    // stopPropagation alone leaves the anchor's own native navigation still
                    // armed - only preventDefault actually stops that. Checking the rules is a
                    // diversion from tapping the row to go play, not a step toward it.
                    e.preventDefault()
                    e.stopPropagation()
                    setRulesFor(g)
                  }}
                  style={styles.infoButton}
                  accessibilityLabel={`${g.title} rules`}
                  hitSlop={12}
                >
                  <Icon source='information-outline' size={22} color={dark ? paperColors.onSurfaceVariant : '#888'} />
                </Pressable>
              </Pressable>
            </Link>
          ))}
        </View>
      </ScrollView>

      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} />

      <RulesDialog visible={!!rulesFor} onDismiss={() => setRulesFor(null)} title={rulesFor?.title ?? ''} rules={rulesFor?.rules ?? []} />
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
    cornerButton: {
      position: 'absolute',
      // The ScrollView below is a later sibling whose own outer wrapper spans the full screen
      // (transparent above its own top-padded content) - on web, that positioned sibling wins
      // pointer-event hit-testing over these by DOM order alone unless elevated explicitly.
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
    }
  })
}
