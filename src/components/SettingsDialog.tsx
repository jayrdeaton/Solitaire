import { useAutoPaperTheme } from '@rific/auto-paper'
import { TouchableRipple } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { CardFace } from '@tastic/cards'
import { type ViewRotation } from '@tastic/core'
import { BaseSettingsDialog } from '@tastic/hud/chrome'
import { useGuide } from '@tastic/hud/guide'
import { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Icon, Text } from 'react-native-paper'

import { CardBackArt } from '@/components/CardBackArt'
import { useSystemReduceMotion } from '@/components/reducedMotion'
import { SettingsSection } from '@/components/SettingsSection'
import { useTableColors } from '@/components/theme'
import { release } from '@/constants/release'
import { useSettings } from '@/hooks/useSettings'
import { useProfiles } from '@/stores/profiles'
import { AUTO_HINT_CHOICES, type AutoHintSeconds, type Settings } from '@/types'

const PREVIEW_WIDTH = 44
const PREVIEW_HEIGHT = 64

const BACK_STYLE_OPTIONS: { value: Settings['cardBackStyle']; label: string }[] = [
  { value: 'geometric', label: 'Geometric' },
  { value: 'ornate', label: 'Ornate' },
  { value: 'plain', label: 'Plain' },
  { value: 'monogram', label: 'Monogram' }
]

const FACE_STYLE_OPTIONS: { value: Settings['cardStyle']; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'decorated', label: 'Decorated' },
  { value: 'tarot', label: 'Tarot' }
]

// Ace of Hearts, not a court card - decorated's full illustration vs. compact/numeric/tarot's
// corner-index-plus-big-center layout is visible either way, but a court card can't show
// numeric's own distinguishing feature at all (its big center numeral vs. compact's big center
// pip only differs on non-court ranks - see CardFace's own doc comment). Ace over some other
// number: it's the more iconic/recognizable card of the two, and renders through 'numeric' with no
// quirks of its own (a single glyph, 'A' - unlike '10', the one rank numeric renders at a
// noticeably smaller scale - see CardFace's own bigRankFontScale).
const PREVIEW_CARD = { id: 'preview', suit: 'hearts' as const, rank: 1 as const, faceUp: true }

/** One selectable style swatch - an actual small render of that style, not a text label, so
 * picking one means seeing what it looks like rather than reading its name. */
function PreviewOption({ active, onPress, accessibilityLabel, children }: { active: boolean; onPress: () => void; accessibilityLabel: string; children: ReactNode }) {
  const { colors: paperColors } = useAutoPaperTheme()
  const tableColors = useTableColors()

  return (
    <TouchableRipple onPress={onPress} style={styles.previewOption} accessibilityLabel={accessibilityLabel}>
      {/* borderColor genuinely can't live in the static StyleSheet below - it's a function of both
      `active` (this instance's own prop) and the live Paper theme's secondary color, neither of
      which a module-level StyleSheet.create can see. */}
      {/* eslint-disable-next-line react-native/no-inline-styles */}
      <View style={[styles.previewFrame, { borderColor: active ? paperColors.secondary : 'transparent' }]}>
        {/* Card-back previews always paint their own full backdrop, so this only actually shows
        through for compact-style card faces, which (unlike decorated, whose sheet-derived art
        bakes in its own white #base) rely on a caller-supplied backdrop the same way a real
        PlayingCard's own `face` style does - without it this render as bare ink on the dialog's
        own background, invisible in dark mode. */}
        <View style={[styles.previewClip, { backgroundColor: tableColors.cardFace }]}>{children}</View>
      </View>
    </TouchableRipple>
  )
}

/** The Auto Hint row's next choice: Off, 15s, 30s, then Off again. */
function nextAutoHint(current: AutoHintSeconds): AutoHintSeconds {
  return AUTO_HINT_CHOICES[(AUTO_HINT_CHOICES.indexOf(current) + 1) % AUTO_HINT_CHOICES.length]
}

/** The Auto Hint row's caption: Off, After 15 seconds, After 30 seconds. */
function autoHintCaption(seconds: AutoHintSeconds): string {
  return seconds === 0 ? 'Off' : `After ${seconds} seconds`
}

interface SettingsDialogProps {
  visible: boolean
  onDismiss: () => void
  // Per-game settings (Klondike draw, Spider suits, ...), rendered above the global Solitaire
  // section below. Omitted entirely by the home screen and by FreeCell/Pyramid, which have no
  // game-specific settings today.
  children?: ReactNode
  // Forwarded to BaseSettingsDialog's own `rotation` override. GameChrome and the home screen both pass 0
  // because they render this inside a Portal.Host that sits INSIDE the rotated frame (see
  // withGameProviders / app/index.tsx), so the dialog is already turned with it; omitting it would apply the
  // ambient live rotation on top of that and turn the dialog twice.
  rotation?: ViewRotation
  // Shows the "How to Play" row that replays the how-to-play guide (see GuideHost). Off by default and
  // turned on ONLY by Home: GameChrome leaves it off, since the score counts elapsed seconds and a
  // guide opened mid-deal would cost the player score.
  showHowToPlay?: boolean
}

// Thin adapter over @tastic/hud's shared settings shell, matching the rest of the fleet's own
// SettingsDialog.tsx convention. No deferBottomEdgeGestures - Solitaire has no edge-anchored swipe
// controls, so there's nothing for that one to guard against (unlike lockOrientation, wired up below
// - see _layout.tsx's OrientationBridge, OrientationProvider's freezeWhileLocked, for how the lock actually takes effect). Check for Updates is left showing (its own Platform.OS check
// already hides it on web) - the root layout's UpdateDialog handles the autoCheck/autoPrompt flow,
// this just adds the manual "Check for Updates" button/version row.
export function SettingsDialog({ visible, onDismiss, children, rotation, showHowToPlay = false }: SettingsDialogProps) {
  const { open: openGuide } = useGuide()
  const { settings, setSettings } = useSettings()
  const systemReduceMotion = useSystemReduceMotion()
  const reduceMotionOn = settings.reduceMotion || systemReduceMotion
  const colors = useTableColors()
  const { colors: paperColors } = useAutoPaperTheme()
  const { error } = useToast()
  const { activeProfile } = useProfiles()

  return (
    <BaseSettingsDialog visible={visible} onDismiss={onDismiss} rotation={rotation} version={release.otaVersion} onUpdateError={(message) => error('Update check failed', message)} lockOrientation={settings.lockOrientation} onLockOrientationChange={(value) => setSettings({ lockOrientation: value })} onShowHowToPlay={showHowToPlay ? openGuide : undefined}>
      {children}
      {/* Two labeled sections, like hud's APPEARANCE above them (Jay, 2026-10-15: an unlabeled
      section left a bare 24pt gap after the Blur row). Toggle rows sit 4pt apart, hud's own
      toggle-group spacing. */}
      <SettingsSection label='GAMEPLAY'>
        <View style={styles.rows}>
          {/* Same bare-row shape as BaseSettingsDialog's own Sound/Haptics rows (an icon badge whose
          color/glyph flips with state, plus a single-line label, no separate Switch) - that
          component doesn't export its SettingIcon helper, so the small badge is replicated here
          rather than imported. Global (not per-game), since it's one play-style preference that
          applies identically to every foundation-building game rather than a rule variant any single
          game owns - see types/index.ts's own doc comment on autoMoveToFoundation. */}
          <TouchableRipple onPress={() => setSettings({ autoMoveToFoundation: !settings.autoMoveToFoundation })} style={styles.toggleButton} accessibilityLabel={`Auto-move to foundation ${settings.autoMoveToFoundation ? 'on' : 'off'}`}>
            <View style={styles.toggleContent}>
              <View style={[styles.iconBadge, { backgroundColor: settings.autoMoveToFoundation ? paperColors.tertiaryContainer : paperColors.surfaceVariant }]}>
                <Icon source={settings.autoMoveToFoundation ? 'arrow-up-bold-circle' : 'arrow-up-bold-circle-outline'} size={18} color={settings.autoMoveToFoundation ? paperColors.tertiary : paperColors.onSurfaceVariant} />
              </View>
              <Text variant='bodyLarge' style={{ color: paperColors.onSurface }}>
                Auto-Move to Foundation
              </Text>
            </View>
          </TouchableRipple>
          {/* Same bare-row shape as the toggle above - a second gameplay-assist preference, not a
          rule variant (see types/index.ts's own doc comment on dimUnplayable). Only
          FreeCell/Canfield/Golf/Spider ever have a face-up-but-unplayable card to dim in the first
          place; a no-op everywhere else. */}
          <TouchableRipple onPress={() => setSettings({ dimUnplayable: !settings.dimUnplayable })} style={styles.toggleButton} accessibilityLabel={`Dim unplayable cards ${settings.dimUnplayable ? 'on' : 'off'}`}>
            <View style={styles.toggleContent}>
              <View style={[styles.iconBadge, { backgroundColor: settings.dimUnplayable ? paperColors.tertiaryContainer : paperColors.surfaceVariant }]}>
                <Icon source={settings.dimUnplayable ? 'card-off-outline' : 'card-outline'} size={18} color={settings.dimUnplayable ? paperColors.tertiary : paperColors.onSurfaceVariant} />
              </View>
              <Text variant='bodyLarge' style={{ color: paperColors.onSurface }}>
                Dim Unplayable Cards
              </Text>
            </View>
          </TouchableRipple>
          {/* Same bare-row shape as the toggles above, but three-way: each tap steps to the next choice
          (Off, 15s, 30s, then Off again), and the choice is the row's caption, in the same spot as
          the other rows' captions (Jay, 2026-10-15: it used to sit on the right, the only row that
          did). See types/index.ts's own doc comment on autoHintSeconds. */}
          <TouchableRipple onPress={() => setSettings({ autoHintSeconds: nextAutoHint(settings.autoHintSeconds) })} style={styles.toggleButton} accessibilityLabel={`Auto hint ${autoHintCaption(settings.autoHintSeconds).toLowerCase()}`}>
            <View style={styles.toggleContent}>
              <View style={[styles.iconBadge, { backgroundColor: settings.autoHintSeconds > 0 ? paperColors.tertiaryContainer : paperColors.surfaceVariant }]}>
                <Icon source={settings.autoHintSeconds > 0 ? 'lightbulb-auto' : 'lightbulb-off-outline'} size={18} color={settings.autoHintSeconds > 0 ? paperColors.tertiary : paperColors.onSurfaceVariant} />
              </View>
              <View style={styles.flexShrink}>
                <Text variant='bodyLarge' style={{ color: paperColors.onSurface }}>
                  Auto Hint
                </Text>
                <Text variant='bodySmall' numberOfLines={1} style={{ color: paperColors.onSurfaceVariant }}>
                  {autoHintCaption(settings.autoHintSeconds)}
                </Text>
              </View>
            </View>
          </TouchableRipple>
          {/* Same bare-row shape as the toggles above (see components/reducedMotion.tsx for what it does). It shows Reduce Motion
          as the app applies it: on while the device's own setting is, with no tap (the device's setting wins) and a caption saying
          where it comes from. */}
          <TouchableRipple onPress={() => setSettings({ reduceMotion: !settings.reduceMotion })} disabled={systemReduceMotion} style={styles.toggleButton} accessibilityLabel={`Reduce motion ${reduceMotionOn ? 'on' : 'off'}${systemReduceMotion ? ', on in device settings' : ''}`}>
            <View style={styles.toggleContent}>
              <View style={[styles.iconBadge, { backgroundColor: reduceMotionOn ? paperColors.tertiaryContainer : paperColors.surfaceVariant }]}>
                <Icon source={reduceMotionOn ? 'motion-pause-outline' : 'motion-play-outline'} size={18} color={reduceMotionOn ? paperColors.tertiary : paperColors.onSurfaceVariant} />
              </View>
              <View style={styles.flexShrink}>
                <Text variant='bodyLarge' style={{ color: paperColors.onSurface }}>
                  Reduce Motion
                </Text>
                {systemReduceMotion && (
                  <Text variant='bodySmall' numberOfLines={1} style={{ color: paperColors.onSurfaceVariant }}>
                    On in device settings
                  </Text>
                )}
              </View>
            </View>
          </TouchableRipple>
        </View>
      </SettingsSection>
      <SettingsSection label='CARDS'>
        {/* Same bare-row shape as BaseSettingsDialog's own Sound/Haptics rows (an icon badge whose
        color/glyph flips with state, plus a single-line label, no separate Switch) - that
        component doesn't export its SettingIcon helper, so the small badge is replicated here
        rather than imported. */}
        <TouchableRipple onPress={() => setSettings({ invertDarkModeColors: !settings.invertDarkModeColors })} style={styles.toggleButton} accessibilityLabel={`Invert dark mode colors ${settings.invertDarkModeColors ? 'on' : 'off'}`}>
          <View style={styles.toggleContent}>
            <View style={[styles.iconBadge, { backgroundColor: settings.invertDarkModeColors ? paperColors.tertiaryContainer : paperColors.surfaceVariant }]}>
              <Icon source={settings.invertDarkModeColors ? 'invert-colors' : 'invert-colors-off'} size={18} color={settings.invertDarkModeColors ? paperColors.tertiary : paperColors.onSurfaceVariant} />
            </View>
            <Text variant='bodyLarge' style={{ color: paperColors.onSurface }}>
              Invert Dark Mode Colors
            </Text>
          </View>
        </TouchableRipple>
        <View style={styles.row}>
          {FACE_STYLE_OPTIONS.map(({ value, label }) => (
            <PreviewOption key={value} active={settings.cardStyle === value} onPress={() => setSettings({ cardStyle: value })} accessibilityLabel={label}>
              <CardFace card={PREVIEW_CARD} colors={colors} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} cardStyle={value} invertDarkModeColors={settings.invertDarkModeColors} />
            </PreviewOption>
          ))}
        </View>
        <View style={styles.row}>
          {BACK_STYLE_OPTIONS.map(({ value, label }) => (
            <PreviewOption key={value} active={settings.cardBackStyle === value} onPress={() => setSettings({ cardBackStyle: value })} accessibilityLabel={label}>
              {/* The Monogram preview shows the selected player's own tag (or S), so it is what they'll get. */}
              <CardBackArt backStyle={value} colors={colors} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} tag={activeProfile?.tag} invertDarkModeColors={settings.invertDarkModeColors} />
            </PreviewOption>
          ))}
        </View>
        <Text variant='bodySmall' style={{ color: paperColors.onSurfaceVariant }}>
          Card artwork based on SVG-cards by David Bellot and Huub de Beer, licensed under LGPL-2.1. Card numerals set in DejaVu Serif, © Bitstream, Inc.
        </Text>
      </SettingsSection>
    </BaseSettingsDialog>
  )
}

const styles = StyleSheet.create({
  // A row's label and caption, as in BaseSettingsDialog's captioned rows.
  flexShrink: {
    flexShrink: 1
  },
  // Matches BaseSettingsDialog's own iconBadge/toggleButton/toggleContent values exactly, so this
  // row reads as one of that same family rather than a visually distinct one-off.
  iconBadge: {
    alignItems: 'center',
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36
  },
  previewClip: {
    borderRadius: 3,
    height: PREVIEW_HEIGHT,
    overflow: 'hidden',
    width: PREVIEW_WIDTH
  },
  previewFrame: {
    borderRadius: 8,
    borderWidth: 2,
    padding: 4
  },
  previewOption: {
    borderRadius: 10,
    padding: 4
  },
  row: {
    flexDirection: 'row',
    gap: 10
  },
  // BaseSettingsDialog's toggleGroup spacing between bare toggle rows.
  rows: {
    gap: 4
  },
  toggleButton: {
    borderRadius: 12,
    overflow: 'hidden',
    paddingVertical: 10
  },
  toggleContent: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12
  }
})
