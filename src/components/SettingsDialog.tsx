import { useAutoPaperTheme } from '@rific/auto-paper';
import { BaseSettingsDialog } from '@tastic/hud';
import { TouchableRipple } from '@rific/feedback-press';
import { useToast } from '@rific/toaster';
import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { CardBack } from '@/components/cards/CardBack';
import { CardFace } from '@/components/cards/CardFace';
import { DecoratedCardBack } from '@/components/cards/DecoratedCardBack';
import { SettingsSection } from '@/components/SettingsSection';
import { useTableColors } from '@/components/theme';
import { release } from '@/constants/release';
import { Settings, useSettings } from '@/stores/settings';

const PREVIEW_WIDTH = 44;
const PREVIEW_HEIGHT = 64;

const BACK_STYLE_OPTIONS: { value: Settings['cardBackStyle']; label: string }[] = [
  { value: 'geometric', label: 'Geometric' },
  { value: 'ornate', label: 'Ornate' },
  { value: 'plain', label: 'Plain' },
];

const FACE_STYLE_OPTIONS: { value: Settings['cardStyle']; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'decorated', label: 'Decorated' },
];

// King of Hearts - a court card shows compact-vs-decorated's difference most clearly (a plain
// silhouette vs. a fully illustrated figure), more than a number card would.
const PREVIEW_CARD = { id: 'preview', suit: 'hearts' as const, rank: 13 as const, faceUp: true };

/** One selectable style swatch - an actual small render of that style, not a text label, so
 * picking one means seeing what it looks like rather than reading its name. */
function PreviewOption({ active, onPress, accessibilityLabel, children }: { active: boolean; onPress: () => void; accessibilityLabel: string; children: ReactNode }) {
  const { colors: paperColors } = useAutoPaperTheme();
  const tableColors = useTableColors();

  return (
    <TouchableRipple onPress={onPress} style={styles.previewOption} accessibilityLabel={accessibilityLabel}>
      <View style={[styles.previewFrame, { borderColor: active ? paperColors.secondary : 'transparent' }]}>
        {/* Card-back previews always paint their own full backdrop, so this only actually shows
        through for compact-style card faces, which (unlike decorated, whose sheet-derived art
        bakes in its own white #base) rely on a caller-supplied backdrop the same way a real
        PlayingCard's own `face` style does - without it this render as bare ink on the dialog's
        own background, invisible in dark mode. */}
        <View style={[styles.previewClip, { backgroundColor: tableColors.cardFace }]}>{children}</View>
      </View>
    </TouchableRipple>
  );
}

interface SettingsDialogProps {
  visible: boolean;
  onDismiss: () => void;
  // Per-game settings (Klondike draw, Spider suits, ...), rendered above the global Solitaire
  // section below. Omitted entirely by the home screen and by FreeCell/Pyramid, which have no
  // game-specific settings today.
  children?: ReactNode;
}

// Thin adapter over @tastic/hud's shared settings shell, matching the rest of the fleet's own
// SettingsDialog.tsx convention. No rotation/lockOrientation/deferBottomEdgeGestures - Solitaire is
// portrait-only with no split-screen or edge-anchored swipe controls, so there's nothing for any of
// those three to lock/guard against. Check for Updates is left showing (its own Platform.OS check
// already hides it on web) - the root layout's UpdateDialog handles the autoCheck/autoPrompt flow,
// this just adds the manual "Check for Updates" button/version row.
export function SettingsDialog({ visible, onDismiss, children }: SettingsDialogProps) {
  const { settings, updateSettings } = useSettings();
  const colors = useTableColors();
  const { error } = useToast();

  return (
    <BaseSettingsDialog visible={visible} onDismiss={onDismiss} version={release.otaVersion} onUpdateError={(message) => error('Update check failed', message)}>
      {children}
      <SettingsSection>
        <View style={styles.row}>
          {FACE_STYLE_OPTIONS.map(({ value, label }) => (
            <PreviewOption key={value} active={settings.cardStyle === value} onPress={() => updateSettings({ cardStyle: value })} accessibilityLabel={label}>
              <CardFace card={PREVIEW_CARD} colors={colors} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} cardStyle={value} />
            </PreviewOption>
          ))}
        </View>
        <View style={styles.row}>
          {BACK_STYLE_OPTIONS.map(({ value, label }) => (
            <PreviewOption key={value} active={settings.cardBackStyle === value} onPress={() => updateSettings({ cardBackStyle: value })} accessibilityLabel={label}>
              {value === 'geometric' ? (
                <CardBack colors={colors} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} />
              ) : (
                <DecoratedCardBack style={value} colors={colors} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} />
              )}
            </PreviewOption>
          ))}
        </View>
        <Text variant="bodySmall" style={styles.credit}>
          Card artwork based on SVG-cards by David Bellot and Huub de Beer, licensed under LGPL-2.1. Card
          numerals set in DejaVu Serif, © Bitstream, Inc.
        </Text>
      </SettingsSection>
    </BaseSettingsDialog>
  );
}

const styles = StyleSheet.create({
  credit: {
    opacity: 0.7,
  },
  previewClip: {
    borderRadius: 3,
    height: PREVIEW_HEIGHT,
    overflow: 'hidden',
    width: PREVIEW_WIDTH,
  },
  previewFrame: {
    borderRadius: 8,
    borderWidth: 2,
    padding: 4,
  },
  previewOption: {
    borderRadius: 10,
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
});
