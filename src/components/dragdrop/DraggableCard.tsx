import { callWorkletCallback, useWorkletCallback } from '@rific/core'
import { useCardSize } from '@tastic/cards'
import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { measure, useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import { Card } from '@/engine/types'

import { REVEAL_MAX_MS, useGhostPendingAmong, whenFacesPainted } from '../cardFacePaint'
import { PlayingCard } from '../PlayingCard'
import { useShakeStyle } from '../shakeAnimation'
import { useCardSoundEffects } from '../useCardSounds'
import { useFrozenWhileHidden } from '../useFrozenWhileHidden'
import { DragFlightHandle, useDragGhost } from './DragGhostLayer'
import { useHoldGuard } from './holdGuard'

interface DraggableCardProps {
  card: Card
  selected?: boolean
  /** Highlight this card as the Hint feature's suggested source/destination - see PlayingCard's
   * own `hinted` prop. */
  hinted?: boolean
  disabled?: boolean
  /** Passed straight through to PlayingCard (see its doc comments) - for a cell drawn the same way whether or not it can
   * be played yet (Pyramid's covered cards). */
  dimmed?: boolean
  dimHold?: boolean
  /** Called with a lazy measure function - only call it if a move actually applies, to kick off a
   * tap-to-move fly animation from exactly where the card was. Lazy rather than an already-
   * resolved origin because measuring is a real async cost on web (measureInWindow is implemented
   * as a setTimeout(0) there - see DragGhostLayer.tsx's comment on the identical cost inside
   * triggerPlayback), measured live at ~50ms from tap to the handler actually running - paid by
   * every tap regardless of whether the caller ends up using the position. A "nowhere to go"
   * shake never touches it, so deferring the call lets that path skip the cost entirely. */
  onPress?: (measure: () => Promise<{ x: number; y: number }>) => void
  /** Attempt to drop at this screen point. `flight` is this drag's own independent ghost flight -
   * a caller whose move applies should hold onto it and fly/hide it itself once the real
   * destination is measurable (see DragFlightHandle), instead of it just vanishing. Return true if
   * a move was applied (skips the snap-back). `dragged` is the card this drag picked up, which the
   * pile's top may no longer be by the drop (a card auto-played onto a foundation while its top was
   * lifted) - a caller moving "the top card" should anchor its move on it, so a stale drop is refused
   * instead of moving a card the player never touched. */
  onDrop?: (absoluteX: number, absoluteY: number, flight: DragFlightHandle, dragged: Card) => Promise<boolean> | boolean
  /** Hide this card - it's mid-flight in the screen-level ghost layer after a tap-to-move landed
   * here (see DragGhostLayer's flyTo). Distinct from the internal drag-hiding below, since this
   * card isn't the one driving the gesture. */
  hidden?: boolean
  /** Shown as a decorative overlay for as long as this card is invisible for ANY reason - mid-drag
   * (this card's own gesture, held as long as the user likes) or `hidden` above. A caller that
   * only renders <DraggableCard> when its data says a card is present (e.g. a freecell/waste slot
   * that falls back to an empty-slot placeholder otherwise) has nothing to show for that whole
   * span without this: the underlying data doesn't change until a drag actually drops, so the slot
   * would just go blank instead of reverting to its placeholder while the card is lifted. */
  emptyFallback?: ReactNode
  /** The card under this one in its pile, shown in its place (instead of `emptyFallback`) while this card is lifted for a
   * drag - lifting the waste's top card shows the next one, as with a real pile. For a card a slot is still drawing after
   * it has left (useTakeOffHold), that is the pile's top. Not while the caller hides the card (`hidden`): its own overlay
   * is in charge then. Kept mounted and invisible the rest of the time, so its face has painted long before a drag shows
   * it (a face mounted as the drag starts is blank for a frame or two - see cardFacePaint.ts). It keeps the card it showed
   * when the card was lifted until the card is shown again: an applied drop changes the pile under a slot that stays
   * hidden until its next card's face paints (see revealToken), and the card under THAT one would otherwise flash there
   * first. */
  underCard?: Card | null
  /** Bumped (to any new value) to play a shake - see shakeAnimation.ts. A counter rather than a
   * boolean so tapping the same stuck card twice in a row re-triggers the shake both times,
   * instead of the second tap being a no-op state transition. */
  shakeToken?: number
  /** The card id this view registers in CardRegistry: `card.id` by default. A slot drawing a card that has already left
   * (useTakeOffHold) registers the card that is really on top there now instead (null: none), so a flight measuring
   * that card finds it. */
  registryId?: string | null
  style?: StyleProp<ViewStyle>
  testID?: string
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
export function DraggableCard({ card, selected, hinted, disabled, dimmed, dimHold, onPress, onDrop, hidden, emptyFallback, underCard, shakeToken, registryId, style, testID }: DraggableCardProps) {
  const viewRef = useAnimatedRef<Animated.View>()
  const ghost = useDragGhost()
  const { playCardSound, hapticCard } = useCardSoundEffects()
  const { width: cardWidth } = useCardSize()
  const [dragging, setDragging] = useState(false)
  // The drag (by its token) whose applied drop is waiting to reveal the slot again - see the effect below.
  const [revealToken, setRevealToken] = useState<number | null>(null)
  const startAbsX = useSharedValue(0)
  const startAbsY = useSharedValue(0)
  const shakeStyle = useShakeStyle(shakeToken, card.id)
  const cardRegistry = ghost.cardRegistry
  // Owned locally (not sourced from `ghost`) so this card's own gesture worklet always has a
  // stable SharedValue to write to, decided once at mount - see showLive's doc comment in
  // DragGhostLayer.tsx. Referencing `ghost` itself inside a worklet closure would also make
  // Reanimated try to capture the *whole* controller object (see DragGhostController), including
  // `cardRegistry` (a plain class instance, not a serializable value), which throws "[Worklets]
  // Cannot copy value of type `CardRegistry`" the moment the gesture is built.
  const originX = useSharedValue(0)
  const originY = useSharedValue(0)
  const dx = useSharedValue(0)
  const dy = useSharedValue(0)
  // This card's own current flight, if any - set at drag-start, read at drag-end (to snap back or
  // hand off to the caller's onDrop) and by nothing else, since only one drag can ever be in
  // progress on this card at a time.
  const flightRef = useRef<DragFlightHandle | null>(null)
  // The card that flight carries - handed to onDrop (see its `dragged`), since `card` may have moved on by the drop.
  const draggedRef = useRef<Card | null>(null)
  // Bumped at every drag start. A drag's late outcome (its drop resolving, its snap-back landing)
  // only clears `dragging` if no NEWER drag has begun in the meantime - otherwise it would reveal
  // the card under the new drag's own ghost.
  const dragTokenRef = useRef(0)

  const latest = useRef({ onDrop, disabled, card, cardWidth })
  // Updated in an effect rather than directly during render (mutating a ref during render isn't
  // allowed) - still fresh well before handleStart/handleRelease below can actually run, since
  // those only ever fire from a later gesture callback, never synchronously during this render.
  useEffect(() => {
    latest.current = { onDrop, disabled, card, cardWidth }
  })
  // React Native Web's Pressable can still fire its own native click on the same release a Pan
  // gesture above it already claimed as a drag (see the identical guard and its longer comment in
  // PileView.tsx's DraggableTableauCard, where this was confirmed live) - a completed drag that
  // released over an invalid drop point would otherwise still trigger handlePress's tap-to-move
  // right after, sending the card wherever autoMoveHint computed instead of leaving it snapped
  // back where the drag itself correctly decided nothing applied.
  const wasDraggingRef = useRef(false)
  const holdGuard = useHoldGuard()

  const registeredId = registryId === undefined ? card.id : registryId
  useEffect(() => {
    if (!registeredId) return
    cardRegistry.register(registeredId, viewRef)
    return () => cardRegistry.unregister(registeredId, viewRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registeredId, cardRegistry])

  const handleStart = useCallback(() => {
    wasDraggingRef.current = true
    dragTokenRef.current += 1
    draggedRef.current = latest.current.card
    flightRef.current = ghost.showLive({ cards: [latest.current.card], offsetStep: 0, cardWidth: latest.current.cardWidth }, { originX, originY, dx, dy })
    playCardSound()
    setDragging(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRelease = useCallback(
    (absoluteX: number, absoluteY: number) => {
      ;(async () => {
        const dropFn = latest.current.onDrop
        const flight = flightRef.current
        const dragged = draggedRef.current
        const token = dragTokenRef.current
        // Before anything awaits: from the moment the drag ends this ghost runs on values of its own,
        // so a quick next drag from this same card can never hijack it while the drop is still being
        // resolved (see DragFlightHandle.release).
        flight?.release()
        const applied = dropFn && flight && dragged ? await dropFn(absoluteX, absoluteY, flight, dragged) : false
        if (applied) {
          // The release is when a dragged card is played: its buzz is here (the pickup's was the press's, at touch-down), once the
          // drop is known to stand. A refused one buzzes as invalid instead (snapBack).
          hapticCard()
          // Don't hide the ghost here - the caller's onDrop (mirroring handleCardTap) has already
          // marked this card's destination "incoming" and will measure its real landed position
          // and fly this same flight the rest of the way there, instead of it just vanishing
          // mid-air. The slot shows the next card now, but not until its face has painted (see revealToken).
          if (dragTokenRef.current === token) setRevealToken(token)
        } else {
          flight?.snapBack(() => {
            if (dragTokenRef.current === token) setDragging(false)
          })
        }
      })()
      setTimeout(() => {
        wasDraggingRef.current = false
      }, 0)
    },
    [hapticCard]
  )
  // The worklets below reach these through @rific/core's key registry, never `scheduleOnRN(handleStart)`: handing them over directly
  // kept every card ever mounted in memory (see that file).
  const startKey = useWorkletCallback(handleStart)
  const releaseKey = useWorkletCallback(handleRelease)

  // react-hooks/refs and react-hooks/immutability both assume ordinary render-time JS: a ref
  // "passed into a function" or a value "returned from a hook" might get read/written synchronously
  // during render. Neither rule knows about Reanimated worklets or react-native-gesture-handler's
  // builder API - .onStart/.onUpdate/.onEnd merely REGISTER these callbacks; none of them, or the
  // measure()/`.value=` calls inside them, ever run during React's render phase. They run later, on
  // the UI thread, driven by the native gesture recognizer - which is the entire point of this
  // pattern (60fps-capable dragging with zero React re-renders). There's no alternative shape here:
  // building a Gesture.Pan() at all means calling .onStart/.onUpdate/.onEnd with callbacks that
  // close over the SharedValues/refs they need to drive, exactly as Reanimated's and gesture-
  // handler's own docs recommend. (Confirmed this isn't fixable via config: explicitly enabling the
  // compiler's own `enableCustomTypeDefinitionForReanimated` environment flag for these two rules
  // didn't change this file's warning count at all - it only special-cases the literal return value
  // of a useSharedValue()/useDerivedValue() call, not a value mutated from inside a nested worklet
  // closure like the ones below. See PileView.tsx's DraggableTableauCard for the identical pattern.)
  /* eslint-disable react-hooks/refs, react-hooks/immutability */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(8)
        .onStart((e) => {
          const frame = measure(viewRef)
          if (frame) {
            originX.value = frame.pageX
            originY.value = frame.pageY
          }
          dx.value = 0
          dy.value = 0
          startAbsX.value = e.absoluteX
          startAbsY.value = e.absoluteY
          scheduleOnRN(callWorkletCallback, startKey)
        })
        .onUpdate((e) => {
          dx.value = e.absoluteX - startAbsX.value
          dy.value = e.absoluteY - startAbsY.value
        })
        .onEnd((e) => {
          scheduleOnRN(callWorkletCallback, releaseKey, e.absoluteX, e.absoluteY)
        }),
    [startKey, releaseKey, originX, originY, dx, dy, startAbsX, startAbsY, viewRef]
  )
  /* eslint-enable react-hooks/refs, react-hooks/immutability */

  pan.enabled(!disabled && !!onDrop)

  // Take-off hold (cardFacePaint.ts): a drag's ghost is invisible until its face has painted, so the card stays drawn
  // here until then - hidden (with its empty-slot fallback) only once the ghost is on screen.
  const dragGhostPending = useGhostPendingAmong(dragging ? [card.id] : NO_IDS) !== ''
  const hiddenForDrag = dragging && !dragGhostPending
  const shownUnder = useFrozenWhileHidden(underCard, hiddenForDrag)
  const underVisible = hiddenForDrag && !hidden

  // After an applied drop the slot shows its next card (or unmounts): the same Image re-sourced, which on iOS keeps the
  // DRAGGED card's bitmap until the next one arrives - the dragged card back at its source for a frame or two while its
  // ghost flies on. So the slot stays as it looked during the drag (hidden, its empty fallback showing) until the next
  // card's face has painted. A layout effect: the commit that re-sourced it has reported the load by then.
  //
  // Not while this slot is still drawing the dragged card because its ghost has not shown yet (dragGhostPending): a drop
  // can be applied before the drag ghost has painted (a quick flick, a busy JS thread), and a slot wrapped in
  // useTakeOffHold then keeps `card` on the dragged (already painted) card until the ghost shows - waiting on that card
  // resolved at once, revealed the slot, and the hold's end then re-sourced the VISIBLE Image to the next card, still
  // showing the dragged card's bitmap. Armed once the ghost shows instead: the commit that ends the hold swaps in the next
  // card (whose face has reported loading by this layout effect), and if the slot is still drawing the dragged card then
  // (the drop left it in place) that card is painted and the slot is revealed at once - never stuck hidden. The pending
  // mark itself is bounded (GHOST_PENDING_MAX_MS).
  useLayoutEffect(() => {
    if (revealToken === null || dragGhostPending) return
    return whenFacesPainted([card.id], REVEAL_MAX_MS, () => {
      if (dragTokenRef.current === revealToken) setDragging(false)
      setRevealToken(null)
    })
  }, [revealToken, card.id, dragGhostPending])

  function handlePress() {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false
      return
    }
    // A press held in place is the card picked up and put back, not a tap (holdGuard.ts).
    if (holdGuard.wasHeld()) return
    if (!onPress) return
    const view = viewRef.current
    if (!view) return
    // A plain measureInWindow (rather than the worklet-synchronous measure() used for drag-start
    // above) is fine here - there's no continuously-firing pointer stream racing it the way a real
    // drag's onUpdate does, so the small async gap doesn't create the "jump" bug that fix targeted.
    // Deferred until the caller actually calls measure() - see onPress's doc comment above.
    onPress(() => new Promise((resolve) => view.measureInWindow((x, y) => resolve({ x, y }))))
  }

  return (
    <View style={style}>
      {/* Beneath the card, so the card covers it until it is lifted. Never touchable (its card is `disabled` too: on web a
      Pressable inside still takes clicks and Tab focus), and hidden from assistive tech while invisible - as PileOverlay. */}
      {shownUnder && (
        <View style={[StyleSheet.absoluteFill, styles.under, !underVisible && styles.hiddenWhileFlying]} aria-hidden={!underVisible}>
          <PlayingCard card={shownUnder} disabled />
        </View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View ref={viewRef} style={[(hiddenForDrag || hidden) && styles.hiddenWhileFlying, shakeStyle]}>
          <PlayingCard card={card} selected={selected} hinted={hinted} disabled={disabled} dimmed={dimmed} dimHold={dimHold} onPress={onPress ? handlePress : undefined} onPressIn={holdGuard.onPressIn} testID={testID} />
        </Animated.View>
      </GestureDetector>
      {/* Only for `dragging` (this card's own gesture), not the caller-supplied `hidden` - a caller
      passing `hidden` (e.g. a tap-to-move flight landing here) already has its own "what was here
      before" overlay for that case (see FreecellCell/StockWaste), so showing this too would double
      up two overlays at once. */}
      {hiddenForDrag && !shownUnder && emptyFallback && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {emptyFallback}
        </View>
      )}
    </View>
  )
}

const NO_IDS: readonly string[] = []

const styles = StyleSheet.create({
  hiddenWhileFlying: {
    opacity: 0
  },
  under: {
    pointerEvents: 'none'
  }
})
