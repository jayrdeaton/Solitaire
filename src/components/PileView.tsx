import { faceUpFanOffset, useCardSize } from '@tastic/cards'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { measure, runOnJS, SharedValue, useAnimatedRef, useSharedValue } from 'react-native-reanimated'

import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'

import { isGhostPending, useGhostPendingAmong } from './cardFacePaint'
import { DragFlightHandle, useDragGhost } from './dragdrop/DragGhostLayer'
import { DropZoneRegistry } from './dragdrop/DropZoneRegistry'
import { EmptySlot, PlayingCard } from './PlayingCard'
import { useShakeStyle } from './shakeAnimation'
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
  /** Anything `drag.getRunCount`'s answers depend on besides this pile's own `cards` - e.g. FreeCell's supermove capacity,
   * which comes from the freecells and empty columns ELSEWHERE on the board. PileView is memoized (see
   * pileViewPropsEqual), so without this a column whose own cards did not change keeps its old run counts: a run that
   * just became movable stays dimmed and undraggable, or one that no longer fits stays lit. Only needed by a screen
   * whose `drag` object is stable across renders; a fresh `drag` every render already re-renders the pile. */
  runCountKey?: number
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
  /** This card's dim scrim should fade in rather than pop on: it became dimmed after this pile's very first render (its
   * flight just landed, or dimming was just switched on for the board - see PileView's `mountedRef`). Forwarded to
   * PlayingCard as `dimFadeIn` - see its own doc comment. */
  dimFadeIn: boolean
  /** A card that has already left this column, drawn only until its ghost is on screen (PileView's take-off hold): it
   * takes no touch (a tap meant for the card it uncovered goes through) and is not registered in CardRegistry (the card
   * is measured where it went, never here). */
  held?: boolean
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
const DraggableTableauCard = memo(function DraggableTableauCard({ card, selected, hinted, dimmed, top, zIndex, runCount, indexFromTop, isHidden, dimFadeIn, held = false, shakeToken, onPress, onDragStart, onDragEnd, originX, originY, dx, dy, startAbsX, startAbsY }: DraggableTableauCardProps) {
  const cardStyle = useMemo(() => ({ position: 'absolute' as const, top, left: 0, zIndex }), [top, zIndex])
  const viewRef = useAnimatedRef<Animated.View>()
  const ghost = useDragGhost()
  const shakeStyle = useShakeStyle(shakeToken, card.id)
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
    if (held) return
    cardRegistry.register(card.id, viewRef)
    return () => cardRegistry.unregister(card.id, viewRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, cardRegistry, held])

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

  // hidden while isHidden: by the time this component renders, a hidden card is the one being dragged (a card whose flight
  // has not landed is a FlyingCardSlot instead - see PileView). It stays mounted, invisible (styles.hidden), with its art
  // skipped (PlayingCard's `hidden`), and keeps its GestureDetector attached throughout: the native recognizer is tracking
  // the player's live touch, and tearing it down mid-gesture cancels it (dragGhostLayer.test.tsx).
  // dimHold/dimFadeIn: see PlayingCard - a hidden card is never dimmed (PileView's isDimmed), so a dimmed card's scrim
  // mounts when it is revealed or when dimming turns on, and dimFadeIn makes that a fade rather than a pop.
  return (
    <GestureDetector gesture={pan}>
      <Animated.View ref={viewRef} style={[cardStyle, isHidden && styles.hidden, held && styles.noTouch, shakeStyle]}>
        <PlayingCard card={card} selected={selected} hinted={hinted} dimmed={dimmed} dimHold={isHidden} dimFadeIn={dimFadeIn} hidden={isHidden} onPress={onPress ? handlePress : undefined} />
      </Animated.View>
    </GestureDetector>
  )
})

/**
 * Stands in for a card whose flight (a deal's ghost, a tap-to-move, a drop) has not landed yet: one bare, card-sized View
 * at the card's own spot, registered in CardRegistry under the card's id - and nothing else. Every game's deal and every
 * tableau-bound flight finds where to fly by measuring that registration (CardRegistry.measure -> measureInWindow, which
 * needs a laid-out, non-zero-size view), so the card must be SOMEWHERE in the tree; but mounting the real
 * DraggableTableauCard hidden (its GestureDetector, two animated views, shared values, a PlayingCard) for every one of a
 * deal's ~52 cards made the deal start later (0.85-1.25s from tap to first landing, against ~0.6s) and fall further
 * behind its own ghosts (the last landing reported 3.1-3.4s in, against 2.2-2.5s), measured on the Simulator. The real card
 * mounts in this one's place when its flight lands.
 */
const FlyingCardSlot = memo(function FlyingCardSlot({ cardId, top, width, height }: { cardId: string; top: number; width: number; height: number }) {
  const ref = useRef<View>(null)
  const { cardRegistry } = useDragGhost()
  useEffect(() => {
    cardRegistry.register(cardId, ref)
    return () => cardRegistry.unregister(cardId, ref)
  }, [cardId, cardRegistry])
  const style = useMemo(() => ({ position: 'absolute' as const, left: 0, top, width, height }), [top, width, height])
  return <View ref={ref} collapsable={false} pointerEvents='none' style={style} />
})

/** A card that has just left this column while its ghost is not on screen yet, drawn where it was (see PileViewImpl). */
interface DepartingCard {
  card: Card
  /** Where it was drawn when it left, kept as it is for as long as it is held (it never moves while it is on screen). */
  top: number
  /** Its slot in the column when it left (its index there) - also its paint order, as every card's index is. */
  zIndex: number
  /** How many slots the fan it was drawn in had (columnTops' `slots` for that layout): `top` is its place in THAT fan, so the
   * column keeps that fan under it for as long as it is held (see columnTops). */
  slots: number
}
const NO_DEPARTING: readonly DepartingCard[] = []

/**
 * Each card's top (already compressed) in a column of `cards`: the fan, scaled down to fit `maxHeight` if it must be, and
 * how many slots that fan has (`slots`).
 *
 * `held` are the cards that have left the column but are still drawn over it (PileViewImpl's `departing`), each in the
 * slot it left, frozen at its top in the fan it was drawn in (its own `slots`). While any is held, the column is laid out
 * in the largest of those fans - so a compressed column doesn't re-spread under a card still drawn there - and no larger:
 *   - A card ARRIVING while one is held takes the slot that card left (the slot is the newcomer's now; the held card is
 *     only drawn over it until its ghost shows). Counting the held card on top of the newcomer squeezed every card under
 *     them one card tighter for a frame or two, then spread them back out when the hold ended - and a flight into the
 *     column that measured its slot in between aimed a few points off.
 *   - It is the fan each held card was DRAWN in, not one only as tall as the highest slot still held. Two cards leaving
 *     one after the other (the next card of an auto-play stream going while the first's ghost still waits for its face)
 *     are both drawn in the fan from before either left, and the first one's ghost shows first; sized by the highest slot
 *     left, the column then re-spread to one card fewer under the second card, still frozen in the old fan - the card
 *     under it slid ~12pt up beneath it, its corner index mostly covered, until the second ghost showed too.
 * The cost of the second: a card arriving after the first of two such holds ends but before the second does lands in the
 * older, tighter fan and moves once the second ends. That needs an arrival inside what is left of the second card's hold
 * (a frame or two: its ghost shows once its face paints, GHOST_PAINT_MAX_MS after it mounts at most), where the case it
 * fixes follows every overlap of two holds. A slot above the top that no held card is in counts as face-up, as whatever is
 * above a column's top is: it is a held card's that has gone (only a face-up card's ghost waits for its face, so that card
 * was face-up too), or - practically unreachable - one that left without a hold from under one that has one.
 */
function columnTops(cards: readonly Card[], held: readonly DepartingCard[], faceUpOffset: number, faceDownOffset: number, cardHeight: number, maxHeight: number | undefined) {
  const offsets: number[] = []
  let y = 0
  for (const card of cards) {
    offsets.push(y)
    y += card.faceUp ? faceUpOffset : faceDownOffset
  }
  const slots = held.reduce((most, d) => Math.max(most, d.slots), cards.length)
  for (let slot = cards.length; slot < slots; slot++) y += held.find((d) => d.zIndex === slot)?.card.faceUp === false ? faceDownOffset : faceUpOffset
  const totalHeight = y + cardHeight
  const scale = maxHeight && totalHeight > maxHeight ? (maxHeight - cardHeight) / (y || 1) : 1
  return { tops: offsets.map((offset) => offset * scale), totalHeight, slots }
}

/** A vertical fanned stack, used for tableau/reserve columns across every game. */
function PileViewImpl({ cards, selectedCount = 0, hintCount = 0, onPressCard, onPressEmpty, faceDownOffset, faceUpOffset, maxHeight, style, drag, hiddenCount = 0, hiddenCardIds, dimUnplayable = false, shakeCardId, shakeCount = 1, shakeToken }: PileViewProps) {
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
  // Take-off hold (cardFacePaint.ts's ghost pending): a card's ghost is a fresh Image, invisible until its face has
  // painted, so a card that has just LEFT this column keeps being drawn where it was - the same DraggableTableauCard
  // instance, its face already painted - until its ghost is on screen; and a card being picked up by a drag stays
  // un-hidden until its drag ghost is. Without it the card flashed blank (or vanished) at its source as it took off.
  // Only a card this column last DREW can be held - one that was still a FlyingCardSlot (its own flight in had not landed)
  // has no painted face here to keep - so the hidden-flight props of the last render are remembered with its cards.
  const [last, setLast] = useState({ cards, hiddenCount, hiddenCardIds })
  const [departing, setDeparting] = useState<readonly DepartingCard[]>(NO_DEPARTING)
  let nextDeparting = departing
  if (cards !== last.cards || hiddenCount !== last.hiddenCount || hiddenCardIds !== last.hiddenCardIds) {
    setLast({ cards, hiddenCount, hiddenCardIds })
    if (cards !== last.cards) {
      const stillHere = new Set(cards.map((card) => card.id))
      // Where each card that is leaving now was DRAWN: the layout the last render laid out, with whatever it still held
      // (`departing` is exactly that render's `held`) - not `last.cards` alone. In a compressed column that is a looser fan,
      // so a second card leaving while the first was still held (the next card of an auto-play stream, its ghost's face
      // slow to paint) was held several points lower than it had been painted, half over the first, then reappeared as
      // its ghost back where it had been.
      const was = columnTops(last.cards, departing, resolvedFaceUpOffset, resolvedFaceDownOffset, cardHeight, maxHeight)
      const wasDrawn = (card: Card, i: number) => !(last.cards.length - 1 - i < last.hiddenCount || last.hiddenCardIds?.has(card.id))
      const leaving = last.cards.flatMap((card, i) => (!stillHere.has(card.id) && wasDrawn(card, i) && isGhostPending(card.id) ? [{ card, top: was.tops[i], zIndex: i, slots: was.slots }] : []))
      nextDeparting = [...departing.filter((d) => !stillHere.has(d.card.id)), ...leaving]
    }
  }
  const pendingKey = useGhostPendingAmong(useMemo(() => [...cards.map((card) => card.id), ...nextDeparting.map((d) => d.card.id)], [cards, nextDeparting]))
  const pendingIds = useMemo(() => new Set(pendingKey ? pendingKey.split('|') : []), [pendingKey])
  // An entry goes for good the moment its hold ends: kept, it would come back - as a fresh, blank mount at its old spot -
  // when the same card later takes off again from wherever it went.
  const held = nextDeparting.filter((d) => pendingIds.has(d.card.id))
  if (held.length !== departing.length || held.some((d, i) => d !== departing[i])) setDeparting(held.length === 0 ? NO_DEPARTING : held)
  const ghost = useDragGhost()
  const { playCardSound } = useCardSoundEffects()
  // The cards a drag in progress has picked up, by id (not by position: the commit that moves them and the one that ends
  // the drag are not always the same, and a stale position range would hide whatever cards slid into it).
  const [activeDrag, setActiveDrag] = useState<ReadonlySet<string> | null>(null)
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
  // False only for this PileView's very first render (a resumed save) - every card dimmed on THAT render keeps the
  // plain, instant scrim. A card that only becomes dimmed on a LATER render (its flight just landed - a hidden card is
  // never dimmed - or the board's dimming was just switched on, see useDimAfterDeal) fades its scrim in instead - see
  // the `dimFadeIn` prop passed below and PlayingCard's own doc comment on it. Flips via an effect (after the first
  // commit), not during render, so it is already true by the time any later render reads it.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
  }, [])

  // Read through a ref (refreshed after every render, like DraggableTableauCard's own `latest`) so the three
  // callbacks handed to every card are STABLE - closing over `cards`/`drag`/`onPressCard` directly would give them a
  // new identity every render and defeat DraggableTableauCard's React.memo. They only ever run later, from a
  // gesture or press, never during render, so they always see the committed values.
  const latest = useRef({ cards, drag, onPressCard, resolvedFaceUpOffset, cardWidth })
  useEffect(() => {
    latest.current = { cards, drag, onPressCard, resolvedFaceUpOffset, cardWidth }
  })

  const handleDragStart = useCallback(
    (_indexFromTop: number, runCount: number) => {
      const { cards: current, resolvedFaceUpOffset: offsetStep, cardWidth: width } = latest.current
      const runCards = current.slice(current.length - runCount)
      dragTokenRef.current += 1
      flightRef.current = ghost.showLive({ cards: runCards, offsetStep, cardWidth: width }, { originX, originY, dx, dy })
      playCardSound()
      setActiveDrag(new Set(runCards.map((c) => c.id)))
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

  if (cards.length === 0 && held.length === 0) {
    return (
      <View style={[styles.container, { width: cardWidth }, style]}>
        <EmptySlot onPress={onPressEmpty} hinted={hintCount > 0} />
      </View>
    )
  }

  // Each card's top, compressing the fan if the column would exceed maxHeight - laid out as tall as it was drawn while any
  // card is still taking off from the top of it, so a compressed column doesn't re-spread under that card while it is
  // still drawn here (see columnTops).
  const { tops, totalHeight } = columnTops(cards, held, resolvedFaceUpOffset, resolvedFaceDownOffset, cardHeight, maxHeight)

  // Split out from isCardHidden below so the runCount-skip optimization in the render loop can tell
  // "hidden because some OTHER flight (a deal, a tap-to-move) owns it, can't be interacted with at
  // all" apart from "hidden because THIS card is the one currently being dragged" - the latter still
  // needs its own runCount computed correctly every render, since `pan.enabled(runCount > 0)` reads
  // it and toggling that mid-gesture (a card whose own drag is already in progress dropping to
  // runCount 0 for a render or two) cancels the native gesture recognizer out from under the
  // player's own still-active touch. Confirmed live: dragGhostLayer.test.tsx's re-grab-mid-hit-test
  // scenario failed the instant the skip below used the combined isCardHidden instead of this alone.
  function isFlying(card: Card, indexFromTop: number): boolean {
    return indexFromTop < hiddenCount || !!hiddenCardIds?.has(card.id)
  }

  function isCardHidden(card: Card, indexFromTop: number): boolean {
    // Not until its drag ghost is on screen (take-off hold - see `departing` above).
    const isPartOfActiveDrag = !!activeDrag?.has(card.id) && !pendingIds.has(card.id)
    return isPartOfActiveDrag || isFlying(card, indexFromTop)
  }

  // Every card this column currently holds is mid-flight - it was empty before whatever's
  // arriving now lands, so without this the column would just look like blank space for the
  // whole flight instead of still showing the empty-slot placeholder it had a moment ago (same
  // "keep showing what was there before" treatment as foundation/freecell/waste - see
  // useFrozenWhileHidden). The real (hidden) cards still render underneath so the flight has
  // something to measure/land on; this is purely a decorative overlay.
  const allCardsHidden = cards.length > 0 && cards.every((card, i) => isCardHidden(card, cards.length - 1 - i))

  // shakeCardId names the card that was actually tapped, at the TOP of the shaking run (closest
  // to the top of the column) - shakeCount cards from it downward (toward the bottom/exposed end)
  // shake together, same "contiguous range counted from one card's indexFromTop" shape as
  // isPartOfActiveDrag above. shakeCardId may not be in this column at all (the tap that set it
  // could belong to any column on the board), in which case shakeStartIndexFromTop stays null and
  // nothing here matches.
  const shakeCardArrayIndex = shakeCardId ? cards.findIndex((c) => c.id === shakeCardId) : -1
  const shakeStartIndexFromTop = shakeCardArrayIndex === -1 ? null : cards.length - 1 - shakeCardArrayIndex

  // react-hooks/refs flags reading a ref's `.current` during render (a component could in principle
  // render speculatively more than once for one commit under React's concurrent features), and - since
  // it traces data flow, not just the literal `.current` syntax - flags this WHOLE `cards.map(...)`
  // below too, for closing over `wasAlreadyMounted` (itself read from `mountedRef.current` here). Both
  // are safe: `mountedRef` is only ever WRITTEN from an effect (never during render, never from an
  // event), so a discarded speculative render can only ever read a value at least as fresh as the last
  // real commit - and the one place this value feeds (dimFadeIn, a cosmetic fade-vs-pop choice for a
  // dimmed card's scrim on reveal) already has that exact instant-pop fallback as its documented
  // behavior for a card present on the very first render, so a theoretical stale read here has no
  // worse an outcome than a case this feature already handles on purpose.
  /* eslint-disable react-hooks/refs */
  const wasAlreadyMounted = mountedRef.current

  return (
    <View style={[styles.container, { width: cardWidth, height: maxHeight ?? totalHeight }, style]}>
      {/* The column's own empty slot under a card that is still taking off from it (the last one out). */}
      {cards.length === 0 && <EmptySlot onPress={onPressEmpty} hinted={hintCount > 0} />}
      {[...cards, ...held.map((d) => d.card)].map((card, i) => {
        // A card still taking off from this column (see `departing`): the same component and key as when it was in the
        // column, so React keeps the very instance (and its painted face); inert - no press, no drag, no hint or selection -
        // until its ghost takes over.
        if (i >= cards.length) {
          const d = held[i - cards.length]
          return <DraggableTableauCard key={d.card.id} card={d.card} selected={false} hinted={false} dimmed={false} top={d.top} zIndex={d.zIndex} runCount={0} indexFromTop={-1} isHidden={false} dimFadeIn={false} held onDragStart={handleDragStart} onDragEnd={handleDragEnd} originX={originX} originY={originY} dx={dx} dy={dy} startAbsX={startAbsX} startAbsY={startAbsY} />
        }
        const indexFromTop = cards.length - 1 - i
        const isSelected = indexFromTop < selectedCount
        const isHinted = indexFromTop < hintCount
        const isHidden = isCardHidden(card, indexFromTop)
        // getRunCount (tableauRunCount -> maxSupermoveCount -> an 8-column scan, plus a
        // descending-alt-color walk back down the column) is real, non-trivial computation, run
        // for EVERY card on EVERY render of this pile regardless of whether that card can even be
        // touched right now. A card hidden because some OTHER flight owns it (a deal, a tap-to-move)
        // can't be interacted with at all (it is only a FlyingCardSlot - see below), so computing
        // its runCount is pure waste - but a
        // card hidden because it's the one CURRENTLY BEING DRAGGED still needs its own runCount
        // computed for real every render: `pan.enabled(runCount > 0)` reads it, and skipping to 0
        // mid-gesture cancels the native recognizer out from under the player's still-active touch
        // (confirmed live: dragGhostLayer.test.tsx's re-grab-mid-hit-test scenario broke the instant
        // this used the broader isHidden instead of isFlying alone). `isDimmed` has no such
        // constraint - nothing reads it during a drag, and it's provably unobserved while hidden for
        // ANY reason too (HeldDimScrim already returns null whenever `dimHold` - fed `isHidden` - is
        // true, whatever `dimmed` says) - so it skips on the full isHidden. Confirmed live as a real,
        // previously-unaccounted contributor: a fresh FreeCell deal has most of its 52 cards hidden
        // for most of the deal, so this ran the full scan+walk for the vast majority of cards on
        // every one of the ~52 renders a deal's landings drive - real per-render JS-thread cost, not
        // a one-time mount cost, unlike the fixes above it. Skipped values are corrected the instant
        // a card is actually revealed (the very next render, driven by that same landing).
        const runCount = !isFlying(card, indexFromTop) && drag && card.faceUp ? drag.getRunCount(indexFromTop) : 0
        const isDimmed = !isHidden && dimUnplayable && !!drag && card.faceUp && runCount === 0
        // A card only responds to taps if it's actually a legal move source - the same signal
        // drag already uses to decide whether a gesture may pick it up (runCount > 0 for a
        // face-up card that's either the true top or the head of a fully-valid run beneath it).
        // Without this, every card in the column - face-down, or face-up but buried under a
        // run-breaking card - forwarded taps straight to the screen's own onPressCard, which
        // can't tell "not a legal move source" apart from "legal but stuck" and shook both the
        // same way; only the latter should ever shake (or react to a tap) at all.
        const isPressable = runCount > 0

        // A card whose flight has not landed yet is a FlyingCardSlot (see its doc comment): measurable, and nothing more.
        // Never skip it from the tree outright - that once dropped eight games' deal animations and every tableau-bound
        // flight (nothing left to measure, so the card just appeared).
        if (isFlying(card, indexFromTop)) return <FlyingCardSlot key={card.id} cardId={card.id} top={tops[i]} width={cardWidth} height={cardHeight} />

        return (
          <DraggableTableauCard
            key={card.id}
            card={card}
            selected={isSelected}
            hinted={isHinted}
            dimmed={isDimmed}
            top={tops[i]}
            zIndex={i}
            runCount={runCount}
            indexFromTop={indexFromTop}
            isHidden={isHidden}
            // Gated on isDimmed, not just wasAlreadyMounted alone - dimFadeIn only ever affects a
            // DIMMED card's own rendering (PlayingCard reads it inside `dimmed ? ... : null`), so an
            // undimmed card should never see its value change (wasAlreadyMounted flips exactly once,
            // shortly after this pile's own first commit) and lose its memoization over a prop that
            // was never going to affect what it draws anyway - confirmed live: pileViewMemo.test.tsx's
            // "no unrelated card re-renders" cases failed the instant this was un-gated.
            dimFadeIn={isDimmed && wasAlreadyMounted}
            shakeToken={shakeStartIndexFromTop !== null && indexFromTop <= shakeStartIndexFromTop && indexFromTop > shakeStartIndexFromTop - shakeCount ? shakeToken : undefined}
            onPress={isPressable ? pressHandler : undefined}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            originX={originX}
            originY={originY}
            dx={dx}
            dy={dy}
            startAbsX={startAbsX}
            startAbsY={startAbsY}
          />
        )
      })}
      {/* eslint-enable react-hooks/refs */}
      {allCardsHidden && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          <EmptySlot />
        </View>
      )}
    </View>
  )
}

// A custom comparator, not a plain memo(PileViewImpl) - every call site shares ONE hiddenCardIds Set
// across every column (the deal, and undo's cascade-hide, both track "every id hidden anywhere on the
// board" in one place, not per-column - see FreeCellScreen.tsx's own dealHiddenIds), so a single card
// landing anywhere replaces that Set's identity and would otherwise invalidate a plain reference-equality
// memo for all 8 columns on every one of a deal's ~52 landings, not just the one column that actually
// changed. Once `cards` itself is confirmed identical (same reference - i.e. this pile's own content
// genuinely didn't change, which structural-sharing cloneState guarantees for every untouched pile on
// every move/landing), only a genuine membership difference over THIS pile's own cards can change what
// it renders - checking that is a handful of Set.has() calls, far cheaper than the full render this
// bails out of (offsets/scale/isFlying/runCount for every card, building N element descriptors, and
// everything DraggableTableauCard's own memo would otherwise have to individually re-confirm unchanged).
// Every other prop is compared normally (by reference for objects/functions, by value for primitives) -
// see FreeCellScreen.tsx's dragConfigs/onPressCardConfigs for why `drag`/`onPressCard` must themselves
// be stable per column for that reference comparison to ever actually pass.
function pileViewPropsEqual(prev: Readonly<PileViewProps>, next: Readonly<PileViewProps>): boolean {
  if (prev.cards !== next.cards) return false
  if (prev.selectedCount !== next.selectedCount) return false
  if (prev.hintCount !== next.hintCount) return false
  if (prev.onPressCard !== next.onPressCard) return false
  if (prev.onPressEmpty !== next.onPressEmpty) return false
  if (prev.faceDownOffset !== next.faceDownOffset) return false
  if (prev.faceUpOffset !== next.faceUpOffset) return false
  if (prev.maxHeight !== next.maxHeight) return false
  if (prev.style !== next.style) return false
  if (prev.drag !== next.drag) return false
  if (prev.hiddenCount !== next.hiddenCount) return false
  if (prev.dimUnplayable !== next.dimUnplayable) return false
  if (prev.shakeCardId !== next.shakeCardId) return false
  if (prev.shakeCount !== next.shakeCount) return false
  if (prev.shakeToken !== next.shakeToken) return false
  if (prev.runCountKey !== next.runCountKey) return false
  if (prev.hiddenCardIds !== next.hiddenCardIds) {
    for (const card of next.cards) {
      if (!!prev.hiddenCardIds?.has(card.id) !== !!next.hiddenCardIds?.has(card.id)) return false
    }
  }
  return true
}

export const PileView = memo(PileViewImpl, pileViewPropsEqual)

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
  },
  noTouch: {
    pointerEvents: 'none'
  }
})
