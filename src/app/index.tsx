import { IconButton, Pressable } from '@rific/feedback-press';
import { Link, Redirect, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeroCards } from '@/components/HeroCards';
import { ProfilePanel } from '@/components/ProfilePanel';
import { SettingsDialog } from '@/components/SettingsDialog';
import { CHROME_FG, TableColors, useTableColors } from '@/components/theme';
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload';
import { useLastActiveGame } from '@/stores/lastActiveGame';

interface GameEntry {
  href: '/klondike' | '/spider' | '/freecell' | '/pyramid';
  title: string;
  blurb: string;
}

const GAMES: GameEntry[] = [
  { href: '/klondike', title: 'Klondike', blurb: 'The classic. Draw 1 or draw 3.' },
  { href: '/spider', title: 'Spider', blurb: '1, 2, or 4 suit difficulty.' },
  { href: '/freecell', title: 'FreeCell', blurb: 'Nearly every deal is winnable.' },
  { href: '/pyramid', title: 'Pyramid', blurb: 'Pair up cards that sum to 13.' },
];

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useTableColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { lastActiveGame } = useLastActiveGame();

  // A cold launch/relaunch while a game was in progress drops the player straight back onto it,
  // skipping this menu entirely - it only reappears once they explicitly back out of that game
  // (see stores/lastActiveGame.ts). Redirects as soon as this mounts, before the menu below ever
  // paints, since lastActiveGame is already resolved by _layout.tsx's splash-gate pre-load.
  if (lastActiveGame) return <Redirect href={`/${lastActiveGame}`} />;

  return (
    <View style={[styles.screen, { backgroundColor: colors.tableFelt }]}>
      <IconButton
        icon="trophy"
        iconColor={CHROME_FG}
        size={24}
        style={[styles.cornerButton, { top: 8 + insets.top, left: 8 + insets.left }]}
        onPress={() => router.push('/achievements')}
        accessibilityLabel="Stats & Achievements"
      />
      <IconButton
        icon="cog"
        iconColor={CHROME_FG}
        size={24}
        style={[styles.cornerButton, { top: 8 + insets.top, right: 8 + insets.right }]}
        onPress={() => setSettingsOpen(true)}
        accessibilityLabel="Settings"
      />

      <ScrollView contentContainerStyle={[styles.container, { paddingTop: 56 + insets.top }]}>
        <HeroCards />
        <Text style={styles.heading}>Solitaire Suite</Text>
        <Text style={styles.subheading}>No ads. No accounts. No network. Just cards.</Text>

        <View style={styles.profilePanelWrap}>
          <ProfilePanel />
        </View>

        <View style={styles.grid}>
          {GAMES.map((g) => (
            <Link key={g.href} href={g.href} asChild>
              <Pressable style={styles.card}>
                <Text style={styles.cardTitle}>{g.title}</Text>
                <Text style={styles.cardBlurb}>{g.blurb}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      </ScrollView>

      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} />
    </View>
  );
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: '#ffffffee',
      borderRadius: 12,
      padding: 18,
    },
    cardBlurb: {
      color: '#444',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 13,
      marginTop: 4,
    },
    cardTitle: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 20,
      fontWeight: '700',
    },
    container: {
      alignItems: 'center',
      flexGrow: 1,
      padding: 20,
    },
    cornerButton: {
      position: 'absolute',
      // The ScrollView below is a later sibling whose own outer wrapper spans the full screen
      // (transparent above its own top-padded content) - on web, that positioned sibling wins
      // pointer-event hit-testing over these by DOM order alone unless elevated explicitly.
      zIndex: 10,
    },
    grid: {
      gap: 14,
      maxWidth: 480,
      width: '100%',
    },
    heading: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 32,
      fontWeight: '800',
    },
    profilePanelWrap: {
      alignItems: 'center',
      marginBottom: 16,
      // The game grid below is a later sibling of equal-or-higher effective stacking on web -
      // without this, its <Link> cards win pointer-event hit-testing over this panel's own
      // popovers (profile picker, color swatches) wherever the two visually overlap, even though
      // the popovers paint on top. See the game screens' identical cornerButtons comment.
      position: 'relative',
      zIndex: 10,
    },
    screen: {
      flex: 1,
    },
    subheading: {
      color: '#E6F4EA',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 14,
      marginBottom: 24,
      marginTop: 4,
    },
  });
}
