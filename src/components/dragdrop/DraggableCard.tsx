import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { measure, runOnJS, useAnimatedRef, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Card } from '@/engine/types';
import { useCardSize } from '../CardSizeContext';
import { PlayingCard } from '../PlayingCard';
import { playShake } from '../shakeAnimation';
import { useCardSoundEffects } from '../useCardSounds';
import { useDragGhost } from './DragGhostLayer';

interface DraggableCardProps {
  card: Card;
  selected?: boolean;
  disabled?: boolean;
  /** Called with a lazy measure function - only call it if a move actually applies, to kick off a
   * tap-to-move fly animation from exactly where the card was. Lazy rather than an already-
   * resolved origin because measuring is a real async cost on web (measureInWindow is implemented
   * as a setTimeout(0) there - see DragGhostLayer.tsx's comment on the identical cost inside
   * triggerPlayback), measured live at ~50ms from tap to the handler actually running - paid by
   * every tap regardless of whether the caller ends up using the position. A "nowhere to go"
   * shake never touches it, so deferring the call lets that path skip the cost entirely. */
  onPress?: (measure: () => Promise<{ x: number; y: number }>) => void;
  /** Attempt to drop at this screen point. Return true if a move was applied (skips the snap-back). */
  onDrop?: (absoluteX: number, absoluteY: number) => Promise<boolean> | boolean;
  /** Hide this card - it's mid-flight in the screen-level ghost layer after a tap-to-move landed
   * here (see DragGhostLayer's flyTo). Distinct from the internal drag-hiding below, since this
   * card isn't the one driving the gesture. */
  hidden?: boolean;
  /** Shown as a decorative overlay for as long as this card is invisible for ANY reason - mid-drag
   * (this card's own gesture, held as long as the user likes) or `hidden` above. A caller that
   * only renders <DraggableCard> when its data says a card is present (e.g. a freecell/waste slot
   * that falls back to an empty-slot placeholder otherwise) has nothing to show for that whole
   * span without this: the underlying data doesn't change until a drag actually drops, so the slot
   * would just go blank instead of reverting to its placeholder while the card is lifted. */
  emptyFallback?: ReactNode;
  /** Bumped (to any new value) to play a shake - see shakeAnimation.ts. A counter rather than a
   * boolean so tapping the same stuck card twice in a row re-triggers the shake both times,
   * instead of the second tap being a no-op state transition. */
  shakeToken?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A single loose draggable card (waste top, foundation top, freecell). Taps still reach the
 * underlying PlayingCard's own Pressable untouched (haptics/sound/double-tap all keep working)
 * since the pan gesture only activates past a small movement threshold.
 *
 * While dragging, the real card here goes invisible and a floating copy renders in a screen-level
 * DragGhostLayer instead - a plain zIndex here can't paint above unrelated sibling branches of the
 * screen (e.g. dragging a freecell card down over the tableau), since z-index only wins within the
 * same stacking context.
 *
 * Position is tracked via e.absoluteX/Y (screen-space pointer position) minus its value at gesture
 * start, rather than Gesture.Pan()'s own translationX/Y - instrumented testing showed translationX/Y
 * can report a stale 0 for an entire gesture on web while absoluteX/Y keeps updating correctly, so
 * deriving our own delta from the value that's actually reliable avoids depending on that.
 *
 * The Gesture.Pan() is memoized (stable identity) and reads live props through a ref instead of
 * closing over them directly. Parent screens here re-render every second (a timer drives the
 * elapsed-time display) - recreating the gesture on every render would tear down and rebuild the
 * underlying native handler, which can orphan a drag that's still in progress mid-gesture and
 * leave the card frozen wherever it was when that happened, since onEnd would never fire.
 */
export function DraggableCard({ card, selected, disabled, onPress, onDrop, hidden, emptyFallback, shakeToken, style, testID }: DraggableCardProps) {
  const viewRef = useAnimatedRef<Animated.View>();
  const ghost = useDragGhost();
  const { playCardSound } = useCardSoundEffects();
  const { width: cardWidth } = useCardSize();
  const [dragging, setDragging] = useState(false);
  const startAbsX = useSharedValue(0);
  const startAbsY = useSharedValue(0);
  const shakeX = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }));
  useEffect(() => {
    if (!shakeToken) return;
    playShake(shakeX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shakeToken]);
  const cardRegistry = ghost.cardRegistry;
  // Destructured to plain local SharedValue bindings rather than read as `ghost.originX` etc.
  // inside the worklet below - referencing `ghost` itself inside a worklet closure makes Reanimated
  // capture the *whole* controller object (see DragGhostController), including `cardRegistry` (a
  // plain class instance, not a serializable value), which throws "[Worklets] Cannot copy value of
  // type `CardRegistry`" the moment the gesture is built.
  const { originX, originY, dx, dy } = ghost;

  const latest = useRef({ onDrop, disabled, card, cardWidth });
  latest.current = { onDrop, disabled, card, cardWidth };
  // React Native Web's Pressable can still fire its own native click on the same release a Pan
  // gesture above it already claimed as a drag (see the identical guard and its longer comment in
  // PileView.tsx's DraggableTableauCard, where this was confirmed live) - a completed drag that
  // released over an invalid drop point would otherwise still trigger handlePress's tap-to-move
  // right after, sending the card wherever autoMoveHint computed instead of leaving it snapped
  // back where the drag itself correctly decided nothing applied.
  const wasDraggingRef = useRef(false);

  useEffect(() => {
    cardRegistry.register(card.id, viewRef);
    return () => cardRegistry.unregister(card.id, viewRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, cardRegistry]);

  const handleStart = useCallback(() => {
    wasDraggingRef.current = true;
    ghost.show({ cards: [latest.current.card], offsetStep: 0, cardWidth: latest.current.cardWidth });
    playCardSound();
    setDragging(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRelease = useCallback(
    (absoluteX: number, absoluteY: number) => {
      (async () => {
        const dropFn = latest.current.onDrop;
        const applied = dropFn ? await dropFn(absoluteX, absoluteY) : false;
        if (applied) {
          // Don't hide the ghost here - the caller's onDrop (mirroring handleCardTap) has already
          // marked this card's destination "incoming" and will measure its real landed position
          // and fly the ghost the rest of the way there, instead of it just vanishing mid-air.
          setDragging(false);
        } else {
          ghost.snapBack(() => setDragging(false));
        }
      })();
      setTimeout(() => {
        wasDraggingRef.current = false;
      }, 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(8)
        .onStart((e) => {
          const frame = measure(viewRef);
          if (frame) {
            originX.value = frame.pageX;
            originY.value = frame.pageY;
          }
          dx.value = 0;
          dy.value = 0;
          startAbsX.value = e.absoluteX;
          startAbsY.value = e.absoluteY;
          runOnJS(handleStart)();
        })
        .onUpdate((e) => {
          dx.value = e.absoluteX - startAbsX.value;
          dy.value = e.absoluteY - startAbsY.value;
        })
        .onEnd((e) => {
          runOnJS(handleRelease)(e.absoluteX, e.absoluteY);
        }),
    [handleStart, handleRelease, originX, originY, dx, dy, startAbsX, startAbsY, viewRef]
  );

  pan.enabled(!disabled && !!onDrop);

  function handlePress() {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    if (!onPress) return;
    const view = viewRef.current;
    if (!view) return;
    // A plain measureInWindow (rather than the worklet-synchronous measure() used for drag-start
    // above) is fine here - there's no continuously-firing pointer stream racing it the way a real
    // drag's onUpdate does, so the small async gap doesn't create the "jump" bug that fix targeted.
    // Deferred until the caller actually calls measure() - see onPress's doc comment above.
    onPress(() => new Promise((resolve) => view.measureInWindow((x, y) => resolve({ x, y }))));
  }

  return (
    <View style={style}>
      <GestureDetector gesture={pan}>
        <Animated.View ref={viewRef} style={[(dragging || hidden) && { opacity: 0 }, shakeStyle]}>
          <PlayingCard card={card} selected={selected} disabled={disabled} onPress={onPress ? handlePress : undefined} testID={testID} />
        </Animated.View>
      </GestureDetector>
      {/* Only for `dragging` (this card's own gesture), not the caller-supplied `hidden` - a caller
      passing `hidden` (e.g. a tap-to-move flight landing here) already has its own "what was here
      before" overlay for that case (see FreecellCell/StockWaste), so showing this too would double
      up two overlays at once. */}
      {dragging && emptyFallback && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {emptyFallback}
        </View>
      )}
    </View>
  );
}
