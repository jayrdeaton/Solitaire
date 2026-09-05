import React from 'react';
import { Pressable } from '@rific/feedback-press';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Card, Suit } from '@/engine/types';
import { useProfiles } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';
import { useCardSize } from './CardSizeContext';
import { CardBack } from './cards/CardBack';
import { CardFace } from './cards/CardFace';
import { DecoratedCardBack } from './cards/DecoratedCardBack';
import { CARD_RADIUS, TableColors, useTableColors } from './theme';

interface PlayingCardProps {
  card: Card;
  /** Highlight this card as part of the current selection. */
  selected?: boolean;
  /** Disable pressing (e.g. cards buried under others). */
  disabled?: boolean;
  /** Not yet playable (e.g. a buried Pyramid card) - draws a translucent scrim on top of the
   * still-full-opacity face instead of fading the card itself, so its rank/suit stay legible. */
  dimmed?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

// The border is drawn as an absolutely-positioned overlay rather than a Pressable borderWidth so
// that toggling `selected` (a thicker, different-colored border) never changes the box's content
// area - RN sizes borders inward from a fixed width/height, so swapping 1px for 3px would nudge
// the card's own SVG content by a couple pixels every time it's (de)selected.
export function PlayingCard({ card, selected, disabled, dimmed, onPress, style, testID }: PlayingCardProps) {
  const colors = useTableColors();
  const { activeProfile } = useProfiles();
  const { settings } = useSettings();
  const { width, height } = useCardSize();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  const cardSize = { width, height };
  const borderOverlay = <View pointerEvents="none" style={selected ? styles.selectedRing : styles.border} />;
  const dimOverlay = dimmed ? <View pointerEvents="none" style={styles.dim} /> : null;

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
          {settings.cardBackStyle === 'geometric' ? (
            <CardBack colors={colors} width={width} height={height} tag={activeProfile?.tag} />
          ) : (
            <DecoratedCardBack style={settings.cardBackStyle} colors={colors} width={width} height={height} />
          )}
        </View>
        {dimOverlay}
        {borderOverlay}
      </Pressable>
    );
  }

  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled} soundDisabled style={[styles.card, styles.shadow, cardSize, style]}>
      <View style={[styles.clip, styles.face]}>
        <CardFace card={card} colors={colors} width={width} height={height} cardStyle={settings.cardStyle} />
      </View>
      {dimOverlay}
      {borderOverlay}
    </Pressable>
  );
}

export function EmptySlot({
  onPress,
  style,
  children,
  testID,
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
}) {
  const colors = useTableColors();
  const { width, height } = useCardSize();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable testID={testID} onPress={onPress} soundDisabled style={[styles.card, { width, height }, styles.empty, style]}>
      {children}
    </Pressable>
  );
}

/** An empty foundation slot, ghosted with the ace it's waiting for. Foundation piles are
 * suit-locked by position (see games/*\/rules.ts's `suitIndex`), but that lock was otherwise
 * invisible until a drop silently failed - this shows which suit belongs here up front. Uses
 * EmptySlot's own plain transparent/dashed styling unmodified - CardFace's `muted` rendering is
 * already just faint linework (see its own MUTED_OPACITY), so a tinted backdrop here would put a
 * card-shaped block back behind it, which is exactly what muted is meant to avoid. */
export function FoundationSlot({ suit, onPress, style }: { suit: Suit; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  const colors = useTableColors();
  const { settings } = useSettings();
  const { width, height } = useCardSize();
  return (
    <EmptySlot onPress={onPress} style={style}>
      <CardFace
        card={{ id: 'foundation-hint', suit, rank: 1, faceUp: true }}
        colors={colors}
        width={width}
        height={height}
        muted
        cardStyle={settings.cardStyle}
      />
    </EmptySlot>
  );
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    card: {
      borderRadius: CARD_RADIUS,
    },
    // Shadow lives on the outer Pressable, never on the same node as `clip`'s overflow: 'hidden' -
    // iOS draws a view's shadow and its overflow clip on the same layer, so a masked layer clips
    // away its own shadow rather than just its content.
    shadow: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3,
      elevation: 4,
    },
    clip: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: CARD_RADIUS,
      overflow: 'hidden',
    },
    face: {
      backgroundColor: colors.cardFace,
    },
    back: {
      backgroundColor: colors.cardBack,
    },
    empty: {
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderColor: colors.emptySlot,
      borderStyle: 'dashed',
      justifyContent: 'center',
      alignItems: 'center',
    },
    border: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: CARD_RADIUS,
    },
    selectedRing: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderWidth: 3,
      borderColor: colors.selectedGlow,
      borderRadius: CARD_RADIUS,
    },
    dim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.dimOverlay,
      borderRadius: CARD_RADIUS,
    },
  });
}
