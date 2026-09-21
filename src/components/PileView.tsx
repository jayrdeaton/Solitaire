import { faceUpFanOffset, useCardSize } from '@tastic/cards'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { measure, runOnJS, SharedValue, useAnimatedRef, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'

import { DragFlightHandle, useDragGhost } from './dragdrop/DragGhostLayer'
import { DropZoneRegistry } from './dragdrop/DropZoneRegistry'
import { EmptySlot, PlayingCard } from './PlayingCard'
import { playShake } from './shakeAnimation'
import { useCardSoundEffects } from './useCardSounds'

export interface PileDragConfig {
  registry: DropZoneRegistry
  /** Given the index-from-top of a face-up card, how many cards (including it) move together if
   * dragged from here. Return 0 if this card can't start a drag (e.g. would break a valid run). */
  getRunCount: (indexFromTop: number) => number
  /** Attempt the move; return true if applied (drops the cards there instead of snapping back).
   * `anchorCardId` is the id of the dragged run's topmost card - the same card a screen's own
   * tap-to-move flight measures to find its exact landing spot, so a caller that applies the move
   * can mark that destination "incoming" and fly the ghost the rest of the way there instead of
   * just snapping it into place (see PileView's own handleDragEnd, which no longer hides the ghost
   * on a successful drop - that's now this callback's job, mirroring handleCardTap). `flight` is
   * this drag's own independent ghost flight - hold onto it and fly/hide it once the real
   * destination is measurable, instead of it just vanishing. */
  onDrop: (to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle) => Promise<boolean> | boolean
}

interface PileViewProps {
  cards: Card[]
  /** How many cards counting from the top are currently selected (for a multi-card drag/move). */
  selectedCount?: number
  /** How many cards counting from the top are the Hint feature's suggested source/destination -
   * same "top N of this pile" shape as selectedCount, rendered as a pulsing green ring instead of
   * selectedCount's static gold one (see PlayingCard's own `hinted` prop). */
  hintCount?: number
  /** `measure` is lazy - call it only if a move actually applies. See DraggableTableauCardProps'
   * onPress below for why. */
  onPressCard?: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void
  onPressEmpty?: () => void
  faceDownOffset?: number
  faceUpOffset?: number
  /** Cap the visible fan height so long columns don't run off screen. */
  maxHeight?: number
  style?: StyleProp<ViewStyle>
  drag?: PileDragConfig
  /** Hide the top N cards - they're mid-flight in the screen-level ghost layer after a tap-to-move
   * landed here (see DragGhostLayer's flyTo). Distinct from the internal drag-hiding below, since
   * this pile isn't the one driving the gesture. */
  hiddenCount?: number
  /** Additionally hide any card whose id is in this set, regardless of its position in the column -
   * unlike hiddenCount ("top N of this column", sized for a run that just landed here), the initial
   * deal (see components/dealing/DealLayer.tsx) can have any card in any column independently
   * mid-flight. */
  hiddenCardIds?: Set<string>
  /** Dim any face-up card that currently can't be picked up (`drag.getRunCount` returns 0 for it) -
   * e.g. a FreeCell tableau card buried under a card that breaks its run. Off by default so it
   * doesn't change the look of games that haven't opted in. */
  dimUnplayable?: boolean
  /** Which card (if any, in this pile) should play its shake, and how many cards counting down
   * from it (inclusive) join in - a tapped card mid-run drags everything fanned below it too, so
   * a "nowhere to go" shake should read as the whole stack being stuck, not just the one card
   * under the finger. Defaults to 1 (just the named card) if omitted. See DraggableTableauCardProps'
   * shakeToken for why this is a counter, not a boolean. */
  shakeCardId?: string
  shakeCount?: number
  shakeToken?: number
}

interface DraggableTableauCardProps {
  card: Card
  selected: boolean
  hinted: boolean
  dimmed: boolean
  /** The card's fan position within its column. Primitives, not a `cardStyle` object built per render: a fresh object
   * every render would defeat this component's React.memo (see below). */
  top: number
  zIndex: number
  runCount: number
  indexFromTop: number
  isHidden: boolean
  /** Bumped (to any new value) to play a shake - see shakeAnimation.ts. A counter rather than a
   * boolean so tapping the same stuck card twice in a row re-triggers the shake both times,
   * instead of the second tap being a no-op state transition. */
  shakeToken?: number
  /** `measure` is lazy (call view.measureInWindow only when actually needed) instead of an
   * already-resolved origin - measureInWindow is a real async cost on web (implemented as a
   * setTimeout(0), same as the one useAudioPool's triggerPlayback pays for the opposite reason -
   * see DragGhostLayer.tsx's comment on that), measured live at ~50ms from tap to the handler
   * actually running, on every tap regardless of whether the caller ends up using the position at
   * all. A "nowhere to go" shake never touches it, so deferring the call lets that path skip the
   * cost entirely instead of paying for a measurement it throws away. */
  onPress?: (card: Card, indexFromTop: number, measure: () => Promise<{ x: number; y: number }>) => void
  onDragStart: (indexFromTop: number, runCount: number) => void
  onDragEnd: (absoluteX: number, absoluteY: number, runCount: number, anchorCardId: string) => void
  /** This column's own persistent position-tracking values (see PileView's own doc comment on
   * originX below) - passed down rather than sourced from useDragGhost() so this card's gesture
   * worklet always writes to a stable SharedValue, decided once per column rather than per card. */
  originX: SharedValue<number>
  originY: SharedValue<number>
  dx: SharedValue<number>
  dy: SharedValue<number>
  /** Pointer position at drag start - per column like the four above, since only one card of a column can be
   * mid-drag at a time (so a card allocating its own pair was pure per-card overhead). */
  startAbsX: SharedValue<number>
  startAbsY: SharedValue<number>
}

/**
 * One card within a pile, wearing a memoized (stable-identity) Gesture.Pan(). Itself React.memo'd, with every
 * prop a primitive or a stable identity (see PileView's `latest`-ref callbacks), so when a screen re-renders -
 * once per card landing during a deal, on every flight, hint or selection - only the cards whose own props
 * actually changed re-render, instead of every card's whole wrapper chain (GestureDetector, Animated.View,
 * PlayingCard, Pressable...) in every column. PileView's parent
 * screens re-render every second (the elapsed-time timer), which would otherwise recreate a fresh
 * Gesture.Pan() on every render; react-native-gesture-handler tears down and rebuilds the native
 * handler whenever the gesture object identity changes, which orphans a drag that's still in
 * progress mid-gesture - onEnd never fires, and the card is left frozen wherever it was. Reading
 * current props through a ref (instead of closing over them) keeps the single memoized gesture
 * both stable and up to date.
 *
 * While part of an active drag (or a tap-to-move flight), this card goes invisible in place - the
 * floating copy lives in the screen-level DragGhostLayer instead, since a plain zIndex bump here
 * can't paint above unrelated sibling branches of the screen (e.g. another tableau column, or the
 * foundations above).
 *
 * Registers itself into the shared CardRegistry by card id so a tap-to-move can measure exactly
 * where this card actually rendered once it lands in its new pile - see handlePress below and the
 * screen-level auto-move handlers that call `ghost.cardRegistry.measure(cardId)` after applying a
 * move.
 */
const DraggableTableauCard = memo(function DraggableTableauCard({ card, selected, hinted, dimmed, top, zIndex, runCount, indexFromTop, isHidden, shakeToken, onPress, onDragStart, onDragEnd, originX, originY, dx, dy, startAbsX, startAbsY }: DraggableTableauCardProps) {
  const cardStyle = useMemo(() => ({ position: 'absolute' as const, top, left: 0, zIndex }), [top, zIndex])
  const viewRef = useAnimatedRef<Animated.View>()
  const ghost = useDragGhost()
  const shakeX = useSharedValue(0)
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }))
  useEffect(() => {
    if (!shakeToken) return
    playShake(shakeX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shakeToken])
  const latest = useRef({ runCount, indexFromTop, onDragStart, onDragEnd, cardId: card.id })
  // Updated in an effect rather than directly during render (mutating a ref during render isn't
  // allowed) - still fresh well before handleStart/handleEnd below can actually run, since those
  // only ever fire from a later gesture callback, never synchronously during this render.
  useEffect(() => {
    latest.current = { runCount, indexFromTop, onDragStart, onDragEnd, cardId: card.id }
  })
  // Position is tracked via e.absoluteX/Y (screen-space pointer position) minus its value at
  // gesture start, rather than Gesture.Pan()'s own translationX/Y - instrumented testing showed
  // translationX/Y can report a stale 0 for an entire gesture on web while absoluteX/Y keeps
  // updating correctly, so deriving our own delta from the value that's actually reliable avoids
  // depending on that.
  const cardRegistry = ghost.cardRegistry
  // React Native Web's Pressable can still fire its own native click on the same release a Pan
  // gesture above it already claimed as a drag (confirmed live: a completed drag - moved past
  // minDistance, released over an invalid drop point - still triggered handlePress's tap-to-move
  // right after, sending the card to whatever autoMoveHint computed instead of leaving it snapped
  // back where the drag itself correctly decided nothing applied). Set the instant the pan
  // activates so it's already true by the time that phantom press can fire; cleared on a deferred
  // timeout (not synchronously in handleEnd, which runs and returns before the phantom press does)
  // so a genuine drag never leaves this card unable to register its next real tap.
  const wasDraggingRef = useRef(false)

  useEffect(() => {
    cardRegistry.register(card.id, viewRef)
    return () => cardRegistry.unregister(card.id, viewRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, cardRegistry])

  const handleStart = useCallback(() => {
    wasDraggingRef.current = true
    latest.current.onDragStart(latest.current.indexFromTop, latest.current.runCount)
  }, [])

  const handleEnd = useCallback((absoluteX: number, absoluteY: number) => {
    latest.current.onDragEnd(absoluteX, absoluteY, latest.current.runCount, latest.current.cardId)
    setTimeout(() => {
      wasDraggingRef.current = false
    }, 0)
  }, [])

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
  // closure like the ones below.)
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
          runOnJS(handleStart)()
        })
        .onUpdate((e) => {
          dx.value = e.absoluteX - startAbsX.value
          dy.value = e.absoluteY - startAbsY.value
        })
        .onEnd((e) => {
          runOnJS(handleEnd)(e.absoluteX, e.absoluteY)
        }),
    [handleStart, handleEnd, originX, originY, dx, dy, startAbsX, startAbsY, viewRef]
  )
  /* eslint-enable react-hooks/refs, react-hooks/immutability */

  pan.enabled(runCount > 0)

  function handlePress() {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false
      return
    }
    if (!onPress) return
    const view = viewRef.current
    if (!view) return
    // A plain measureInWindow (rather than the worklet-synchronous measure() used for drag-start
    // above) is fine here - there's no continuously-firing pointer stream racing it the way a real
    // drag's onUpdate does, so the small async gap doesn't create the "jump" bug that fix targeted.
    // Deferred until the caller actually calls measure() - see onPress's doc comment above.
    onPress(card, indexFromTop, () => new Promise((resolve) => view.measureInWindow((x, y) => resolve({ x, y }))))
  }

  return (
    <GestureDetector gesture={pan}>
      <Animated.View ref={viewRef} style={[cardStyle, isHidden && styles.hidden, shakeStyle]}>
        <PlayingCard card={card} selected={selected} hinted={hinted} dimmed={dimmed} onPress={onPress ? handlePress : undefined} />
      </Animated.View>
    </GestureDetector>
  )
})

/** A vertical fanned stack, used for tableau/reserve columns across every game. */
export function PileView({ cards, selectedCount = 0, hintCount = 0, onPressCard, onPressEmpty, faceDownOffset, faceUpOffset, maxHeight, style, drag, hiddenCount = 0, hiddenCardIds, dimUnplayable = false, shakeCardId, shakeCount = 1, shakeToken }: PileViewProps) {
  const { width: cardWidth, height: cardHeight } = useCardSize()
  // Fan offsets default to a fraction of the current card size, rather than a fixed pixel value,
  // so the fan still looks proportional when the card size scales up/down with the viewport.
  // Face-up offset clears CardFace's own corner row (rank + small pip) with the same margin
  // above it that the row already has below the card's own top edge (CORNER_ROW_TOP_FRACTION,
  // both fractions of card width) - so a covered card reveals an even gap on both sides of its
  // corner content, rather than one side clipping it a couple pixels short (which, since pip
  // glyphs aren't vertically symmetric, read as inconsistently misaligned pips rather than an
  // evenly-clipped edge).
  const resolvedFaceDownOffset = faceDownOffset ?? cardHeight * 0.13
  const resolvedFaceUpOffset = faceUpOffset ?? faceUpFanOffset(cardWidth)
  const ghost = useDragGhost()
  const { playCardSound } = useCardSoundEffects()
  const [activeDrag, setActiveDrag] = useState<{ indexFromTop: number; count: number } | null>(null)
  // This column's own persistent position-tracking values, tied to this PileView instance's own
  // lifetime (it stays mounted across every card the column ever holds - see DraggableTableauCard's
  // own doc comment) rather than sourced dynamically per-drag, so DraggableTableauCard's gesture
  // worklet always has a stable SharedValue to write to (see DragGhostLayer.tsx's showLive).
  const originX = useSharedValue(0)
  const originY = useSharedValue(0)
  const dx = useSharedValue(0)
  const dy = useSharedValue(0)
  const startAbsX = useSharedValue(0)
  const startAbsY = useSharedValue(0)
  // This column's own current flight, if any - set at drag-start, read at drag-end (to snap back
  // or hand off to `drag.onDrop`) and by nothing else, since only one drag can ever be in progress
  // from this column at a time.
  const flightRef = useRef<DragFlightHandle | null>(null)
  // Bumped at every drag start. A drag's late outcome (its drop resolving, its snap-back landing) only
  // clears `activeDrag` if no NEWER drag from this column has begun in the meantime - otherwise it
  // would reveal the cards under the new drag's own ghost.
  const dragTokenRef = useRef(0)

  // Read through a ref (refreshed after every render, like DraggableTableauCard's own `latest`) so the three
  // callbacks handed to every card are STABLE - closing over `cards`/`drag`/`onPressCard` directly would give them a
  // new identity every render and defeat DraggableTableauCard's React.memo. They only ever run later, from a
  // gesture or press, never during render, so they always see the committed values.
  const latest = useRef({ cards, drag, onPressCard, resolvedFaceUpOffset, cardWidth })
  useEffect(() => {
    latest.current = { cards, drag, onPressCard, resolvedFaceUpOffset, cardWidth }
  })

  const handleDragStart = useCallback(
    (indexFromTop: number, runCount: number) => {
      const { cards: current, resolvedFaceUpOffset: offsetStep, cardWidth: width } = latest.current
      const runCards = current.slice(current.length - runCount)
      dragTokenRef.current += 1
      flightRef.current = ghost.showLive({ cards: runCards, offsetStep, cardWidth: width }, { originX, originY, dx, dy })
      playCardSound()
      setActiveDrag({ indexFromTop, count: runCount })
    },
    [ghost, playCardSound, originX, originY, dx, dy]
  )

  const handleDragEnd = useCallback((absoluteX: number, absoluteY: number, count: number, anchorCardId: string) => {
    ;(async () => {
      const { drag: currentDrag } = latest.current
      // Taken BEFORE the hit test awaits: this drag's own flight (a quick next drag from this column
      // replaces flightRef while the hit test is still resolving, and the drop would then be applied
      // with - and fly - the wrong ghost), released at once so that next drag cannot hijack its values
      // either (see DragFlightHandle.release).
      const flight = flightRef.current
      const token = dragTokenRef.current
      flight?.release()
      const target = currentDrag ? await currentDrag.registry.hitTest(absoluteX, absoluteY) : null
      const applied = target && currentDrag && flight ? await currentDrag.onDrop(target, count, anchorCardId, flight) : false
      if (applied) {
        // Don't hide the ghost here - it's still sitting wherever the pointer released it, not
        // yet at the destination's exact fanned position. The caller's onDrop (mirroring
        // handleCardTap) has already marked that destination "incoming" and will measure its real
        // landed position and fly this same flight the rest of the way there, same as a
        // tap-to-move.
        if (dragTokenRef.current === token) setActiveDrag(null)
      } else {
        flight?.snapBack(() => {
          if (dragTokenRef.current === token) setActiveDrag(null)
        })
      }
    })()
  }, [])

  const handleCardPress = useCallback((card: Card, indexFromTop: number, measureOrigin: () => Promise<{ x: number; y: number }>) => latest.current.onPressCard?.(card, indexFromTop, measureOrigin), [])
  // Only pressable at all when the screen gave this column a press handler (a Pressable with none would still
  // swallow taps meant for whatever is behind it) - a boolean, so this stays the same identity across renders.
  const pressHandler = onPressCard ? handleCardPress : undefined

  if (cards.length === 0) {
    return (
      <View style={[styles.container, { width: cardWidth }, style]}>
        <EmptySlot onPress={onPressEmpty} hinted={hintCount > 0} />
      </View>
    )
  }

  // Compute offsets, compressing if the column would exceed maxHeight.
  const offsets: number[] = []
  let y = 0
  for (let i = 0; i < cards.length; i++) {
    offsets.push(y)
    y += cards[i].faceUp ? resolvedFaceUpOffset : resolvedFaceDownOffset
  }
  let scale = 1
  const totalHeight = y + cardHeight
  if (maxHeight && totalHeight > maxHeight) {
    scale = (maxHeight - cardHeight) / (y || 1)
  }

  function isCardHidden(card: Card, indexFromTop: number): boolean {
    const isPartOfActiveDrag = !!activeDrag && indexFromTop <= activeDrag.indexFromTop && indexFromTop > activeDrag.indexFromTop - activeDrag.count
    const isFlying = indexFromTop < hiddenCount || !!hiddenCardIds?.has(card.id)
    return isPartOfActiveDrag || isFlying
  }

  // Every card this column currently holds is mid-flight - it was empty before whatever's
  // arriving now lands, so without this the column would just look like blank space for the
  // whole flight instead of still showing the empty-slot placeholder it had a moment ago (same
  // "keep showing what was there before" treatment as foundation/freecell/waste - see
  // useFrozenWhileHidden). The real (hidden) cards still render underneath so the flight has
  // something to measure/land on; this is purely a decorative overlay.
  const allCardsHidden = cards.every((card, i) => isCardHidden(card, cards.length - 1 - i))

  // shakeCardId names the card that was actually tapped, at the TOP of the shaking run (closest
  // to the top of the column) - shakeCount cards from it downward (toward the bottom/exposed end)
  // shake together, same "contiguous range counted from one card's indexFromTop" shape as
  // isPartOfActiveDrag above. shakeCardId may not be in this column at all (the tap that set it
  // could belong to any column on the board), in which case shakeStartIndexFromTop stays null and
  // nothing here matches.
  const shakeCardArrayIndex = shakeCardId ? cards.findIndex((c) => c.id === shakeCardId) : -1
  const shakeStartIndexFromTop = shakeCardArrayIndex === -1 ? null : cards.length - 1 - shakeCardArrayIndex

  return (
    <View style={[styles.container, { width: cardWidth, height: maxHeight ?? totalHeight }, style]}>
      {cards.map((card, i) => {
        const indexFromTop = cards.length - 1 - i
        const isSelected = indexFromTop < selectedCount
        const isHinted = indexFromTop < hintCount
        const runCount = drag && card.faceUp ? drag.getRunCount(indexFromTop) : 0
        const isDimmed = dimUnplayable && !!drag && card.faceUp && runCount === 0
        // A card only responds to taps if it's actually a legal move source - the same signal
        // drag already uses to decide whether a gesture may pick it up (runCount > 0 for a
        // face-up card that's either the true top or the head of a fully-valid run beneath it).
        // Without this, every card in the column - face-down, or face-up but buried under a
        // run-breaking card - forwarded taps straight to the screen's own onPressCard, which
        // can't tell "not a legal move source" apart from "legal but stuck" and shook both the
        // same way; only the latter should ever shake (or react to a tap) at all.
        const isPressable = runCount > 0

        return <DraggableTableauCard key={card.id} card={card} selected={isSelected} hinted={isHinted} dimmed={isDimmed} top={offsets[i] * scale} zIndex={i} runCount={runCount} indexFromTop={indexFromTop} isHidden={isCardHidden(card, indexFromTop)} shakeToken={shakeStartIndexFromTop !== null && indexFromTop <= shakeStartIndexFromTop && indexFromTop > shakeStartIndexFromTop - shakeCount ? shakeToken : undefined} onPress={isPressable ? pressHandler : undefined} onDragStart={handleDragStart} onDragEnd={handleDragEnd} originX={originX} originY={originY} dx={dx} dy={dy} startAbsX={startAbsX} startAbsY={startAbsY} />
      })}
      {allCardsHidden && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          <EmptySlot />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  // zIndex on a positioned descendant only stays scoped to this container if the container
  // itself establishes a stacking context - which position:relative alone (React Native's
  // default) does not, without a zIndex of its own. Without this, every card's zIndex: i below
  // leaks out to compete directly with sibling branches elsewhere on the screen - including the
  // screen-level drag/deal ghost overlays, which render without their own zIndex and lost that
  // fight to any card here past the very bottom of the pile, rendering "under" it mid-flight.
  container: { zIndex: 0 },
  hidden: {
    opacity: 0
  }
})
