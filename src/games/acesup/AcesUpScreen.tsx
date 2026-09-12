// Aces Up solitaire screen: 4 piles, tap OR drag (PileView only treats a card as tappable at all
// once drag.getRunCount reports it as a legal move source - see this file's own hasLegalMove - so
// every game here needs a real drag config even where dragging itself is secondary to tapping), a
// single stock pile dealt in rounds of 4. The one screen in this app with a genuine loss condition
// (see games/shared/useStuckLossCheck.ts) alongside the usual win check.
//
// Dragging only ever resolves to "move onto an empty pile" (the only real drop target that
// exists) - dragging a discard-only card and releasing it over nothing just snaps back, same as
// any other illegal drop elsewhere in this app; tapping still handles the discard case via
// autoMoveHint's own priority (see rules.ts).
//
// A discard now has a real destination: rules.ts's `discard` field, displayed via the shared
// DiscardCell (see games/shared/DiscardCell.tsx - the same component Pyramid uses for its own
// discard pile). A tapped card flies there exactly like a tap-to-move-to-empty-pile does -
// handleCardTap shows a ghost at the tapped origin, applies the move immediately, then the
// pendingFlightRef effect below measures the discard pile's real position (a plain view ref,
// same idiom as stockViewRef - there's only ever one discard pile, not a per-card registration)
// and flies the ghost the rest of the way. Undoing a discard is the mirror image: fly a ghost
// from the discard pile back to the tapped card's original pile.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { ACESUP_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { DiscardCell } from '@/games/shared/DiscardCell'
import { LossBanner } from '@/games/shared/LossBanner'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'

import { buildAcesUpDealSequence } from './dealSequence'
import { AcesUpController, AcesUpState } from './rules'

const NUM_PILES = 4
const PILE_MAX_HEIGHT = 320

// A plain face-down placeholder for the stock pile display - id/suit/rank are never shown
// (faceUp: false always renders CardBack instead), so any valid values work here.
const STOCK_DISPLAY_CARD: Card = { id: 'acesup-stock', suit: 'spades', rank: 1, faceUp: false }

export default withGameProviders(AcesUpScreenInner)

function AcesUpScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, NUM_PILES)
  // Spans the same width as pilesRow below (4 piles + 3 gaps) so topRow's own space-between can
  // put the discard pile and stock at its two ends, mirroring Pyramid's controlRow/triangle.
  const pilesWidth = cardWidth * NUM_PILES + gap * (NUM_PILES - 1)
  const [state, setState] = useState<AcesUpState | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry<AcesUpState>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: AcesUpState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button was pressed (and actually produced a hint) at any point during the
  // CURRENT deal - read once, at the exact instant a win is recorded (see useDerivedWinCheck's own
  // hintsUsedRef param), to decide whether this win counts toward the "wins without hint"
  // stat/achievement. Reset alongside the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const discardViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // No suit-based foundation, no separate "completed sequence" slot - won is a pure function of
  // state (every pile down to a single Ace, stock empty), same shape Golf/Spider/Scorpion use.
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(AcesUpController, state, 'acesup', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // The one screen in this app with a genuine loss condition - see useStuckLossCheck's own doc
  // comment for why this must be called (and therefore have its own internal effect fire) BEFORE
  // useDerivedWinCheck's effect above ever could race it; AcesUpController.isStuck's own
  // `!isWon(state)` guard is what actually keeps the two from double-firing on the same commit.
  const { stuck, recordedRef: recordedLossRef } = useStuckLossCheck(AcesUpController, state, 'acesup', recordDealAbandoned)
  /** One ref per pile's own plain container - measured independently of CardRegistry so the win
   * cascade can still find each pile's screen position after its real card has been hidden
   * (won-gated, see the piles row below), at which point it's no longer CardRegistry-registered
   * at all. Mirrors Canfield's own foundationSlotRefs/Scorpion's own tableauColumnRefs. */
  const pileViewRefs = useRef<(View | null)[]>(new Array(NUM_PILES).fill(null))
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move-to-empty,
   * tap-to-discard, and undo of either - only one is ever in flight at a time. `viaStock` measures
   * via stockViewRef (a plain View, not per-card) instead of CardRegistry - only undoing a round
   * deal flies back toward the stock. `viaDiscard` similarly measures via discardViewRef - a
   * forward discard's card is no longer registered anywhere once it lands (DiscardCell doesn't
   * register in CardRegistry - see its own doc comment), so its destination has to be the pile's
   * own fixed position, not a per-card lookup. `gen` guards against a "New Game" tapped mid-flight
   * replacing the deal this flight was measuring against (card ids are shuffle-independent and
   * reused across deals - see engine/deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; viaDiscard?: boolean; gen: number } | null>(null)
  /** A round deal (4 cards, one per pile) awaiting its post-commit measurement + deal.start() -
   * mirrors Spider's/Scorpion's own stock-deal pattern, fixed at exactly NUM_PILES destinations. */
  const pendingRoundDealRef = useRef<{ dealt: { card: Card; pileIndex: number }[]; origin: { x: number; y: number } | null; token: number } | null>(null)
  /** An undone round deal awaiting its post-commit measurement + deal.start() - the mirror image
   * of pendingRoundDealRef, same idea as Scorpion's own runUndoStockDeal. */
  const pendingUndoRoundDealRef = useRef<{ entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[]; token: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  const undoBusyRef = useRef(false)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = AcesUpController.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.reset()
    recordedWinRef.current = false
    recordedLossRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    setDealHiddenIds(new Set(s.piles.flat().map((c) => c.id)))
    scheduleDeal(myToken)
    setState(s)
  }

  function restoreGame(saved: SavedGame<AcesUpState>) {
    ++dealTokenRef.current
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    recordedLossRef.current = false
    setDealHiddenIds(new Set())
    // Optional for backward compatibility: a save written before the discard pile existed has no
    // `discard` field at all - same reasoning as SavedGame's own optional undoStack.
    setState({ ...saved.state, discard: saved.state.discard ?? [] })
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss, same as every
  // other game's own "left mid-game" path) - GameChrome only ever calls this after the player has
  // confirmed that, or immediately when there's nothing to lose. A genuine stuck-loss already
  // recorded itself the instant it was reached (see useStuckLossCheck above), so this only ever
  // double-records if session.moves > 0 while NEITHER won NOR already-recorded-stuck, which is
  // exactly "the player is walking away mid-game" - the same condition every other game already
  // uses.
  function handleNewGame() {
    if (session.moves > 0 && !won && !stuck) recordDealAbandoned('acesup')
    startNewGame()
  }

  async function runDeal(s: AcesUpState, token: number) {
    const sequence = buildAcesUpDealSequence(s.piles)
    const [origin, destinations] = await Promise.all([measureView(stockViewRef.current), Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({ cardId: step.cardId, card: step.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: step.visitOrder * DEAL_STAGGER_MS })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      return
    }

    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (dealTokenRef.current !== token) return
        setDealHiddenIds((ids) => {
          if (!ids.has(cardId)) return ids
          const next = new Set(ids)
          next.delete(cardId)
          return next
        })
      },
      () => {}
    )
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    // The win cascade needs a real chain of cards - the 4 remaining Aces, one per pile. Each pile
    // flies independently from its own plain view ref (see pileViewRefs above), not CardRegistry -
    // the real Ace is hidden the instant `won` flips true (see the piles row below) and therefore
    // unregistered by the time this runs.
    ;(async () => {
      const origins = await Promise.all(pileViewRefs.current.map((view) => measureView(view)))
      if (dealTokenRef.current !== pending.gen) return
      const chains = state.piles
        .map((pile, i) => ({ pile, origin: origins[i] }))
        .filter((entry) => entry.pile.length > 0 && entry.origin)
        .map((entry) => ({ cards: entry.pile, origin: entry.origin!, entranceDelayMs: 0 }))
      winCascade.startChains(chains, cardWidth)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = pending.viaStock ? await measureView(stockViewRef.current) : pending.viaDiscard ? await measureView(discardViewRef.current) : await ghost.cardRegistry.measure(pending.cardId)
      if (dealTokenRef.current !== pending.gen || !landed) {
        ghost.hide()
        setFlying(null)
        undoBusyRef.current = false
        return
      }
      ghost.flyTo(landed.x, landed.y, () => {
        setFlying(null)
        undoBusyRef.current = false
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  async function runRoundDeal(dealt: { card: Card; pileIndex: number }[], origin: { x: number; y: number } | null, token: number) {
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }
    const destinations = await Promise.all(dealt.map((d) => ghost.cardRegistry.measure(d.card.id)))
    if (dealTokenRef.current !== token) return

    const entries: DealCardSpec[] = []
    dealt.forEach((d, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({ cardId: d.card.id, card: d.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: i * DEAL_STAGGER_MS })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      return
    }

    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (dealTokenRef.current !== token) return
        setDealHiddenIds((ids) => {
          if (!ids.has(cardId)) return ids
          const next = new Set(ids)
          next.delete(cardId)
          return next
        })
      },
      () => {}
    )
  }

  useEffect(() => {
    const pending = pendingRoundDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingRoundDealRef.current = null
    runRoundDeal(pending.dealt, pending.origin, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  async function runUndoRoundDeal(entries: { card: Card; delayMs: number; origin: { x: number; y: number } | null }[], token: number) {
    const destination = await measureView(stockViewRef.current)
    if (dealTokenRef.current !== token || !destination) {
      undoBusyRef.current = false
      return
    }
    const dealEntries: DealCardSpec[] = []
    entries.forEach((e) => {
      if (!e.origin) return
      dealEntries.push({ cardId: e.card.id, card: e.card, from: e.origin, to: destination, delayMs: e.delayMs })
    })
    if (dealEntries.length === 0) {
      undoBusyRef.current = false
      return
    }
    deal.start(
      dealEntries,
      cardWidth,
      () => {},
      () => {
        undoBusyRef.current = false
      }
    )
  }

  useEffect(() => {
    const pending = pendingUndoRoundDealRef.current
    if (!pending || pending.token !== dealTokenRef.current || !state) return
    pendingUndoRoundDealRef.current = null
    runUndoRoundDeal(pending.entries, pending.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    loadGameInProgress<AcesUpState>('acesup').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('acesup')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deliberately not keyed on a ticking elapsed-seconds value the way an earlier version of this
  // effect was: `session.getElapsed()` computes the true current elapsed from wall-clock time on
  // demand (see useGameSession.ts), so a save made at the last real move is never stale even once
  // the player just sits looking at the board afterward - resuming always recomputes the exact
  // right value instead of depending on whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('acesup', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('acesup', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() rules.ts already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(AcesUpController, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('acesup')
  }

  function pushUndo(prev: AcesUpState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    if (won) winCascade.clear()
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry

    if (!move) {
      const myToken = ++dealTokenRef.current
      const dealtCards = state.piles.map((pile) => top(pile)!)
      const origins = await Promise.all(dealtCards.map((c) => ghost.cardRegistry.measure(c.id)))

      setUndoStack((stack) => stack.slice(0, -1))
      pendingUndoRoundDealRef.current = {
        entries: dealtCards.map((c, i) => ({ card: c, delayMs: i * DEAL_STAGGER_MS, origin: origins[i] })),
        token: myToken
      }
      setState(prevState)
      return
    }

    // Undoing a discard: the mirror image of the forward flight - a ghost shown at the discard
    // pile's own (fixed) position flies back to the card's original pile, landing via the same
    // pendingFlightRef effect every other "fly to a tableau destination" flight already uses
    // (CardRegistry, keyed on the card's id, since prevState's own re-render re-registers it there).
    if (move.to.zone === 'discard') {
      const discardCard = state.discard[state.discard.length - 1]
      const origin = discardCard && discardCard.id === move.anchorCardId ? await measureView(discardViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))

      if (origin && discardCard) {
        /* eslint-disable-next-line react-hooks/immutability */
        ghost.originX.value = origin.x
        ghost.originY.value = origin.y
        ghost.dx.value = 0
        ghost.dy.value = 0
        playCardSound()
        hapticCard()
        ghost.show({ cards: [discardCard], offsetStep: 0, cardWidth })
        setFlying({ to: move.from, count: 1 })
        setState(prevState)
        pendingFlightRef.current = { cardId: move.anchorCardId, gen: dealTokenRef.current }
      } else {
        setState(prevState)
        undoBusyRef.current = false
      }
      return
    }

    const movingCard = top(state.piles[move.to.index])
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth })
      setFlying({ to: move.from, count: 1 })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, gen: dealTokenRef.current }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  // Shared tail for both tap-to-move (handleCardTap) and a manual drag's drop (handleDrop below) -
  // applies the move, pushes undo, and sets up the post-commit flight measurement. The ghost is
  // already showing by the time this runs (handleCardTap's own ghost.show() for a tap, or the drag
  // gesture's own pickup-time ghost.show() for a drop) - this only ever decides where it flies to:
  // a discard lands via discardViewRef's fixed position (see pendingFlightRef's viaDiscard), a move
  // to an empty pile via the destination pile's own CardRegistry registration, same as every other
  // tap-to-move flight in this app.
  function applyMove(from: PileRef, to: PileRef, card: Card): boolean {
    if (!state) return false
    const result = AcesUpController.tryMove(state, { from, to, count: 1 })
    if (!result) return false
    pushUndo(state, { from, to, count: 1, anchorCardId: card.id })
    setState(result)
    session.registerMove()
    setFlying({ to, count: 1 })
    pendingFlightRef.current = { cardId: card.id, viaDiscard: to.zone === 'discard', gen: dealTokenRef.current }
    return true
  }

  // True if `pileIndex`'s own top card has ANY legal move (discard or move-to-empty) - the signal
  // PileView needs (via drag.getRunCount below) to treat a card as tappable/draggable at all; see
  // this file's own header comment for why even a tap-only interaction still needs a real drag
  // config wired up.
  function hasLegalMove(pileIndex: number): boolean {
    if (!state || !AcesUpController.autoMoveHint) return false
    const card = top(state.piles[pileIndex])
    if (!card) return false
    return !!AcesUpController.autoMoveHint(state, { zone: 'tableau', index: pileIndex }, card.id)
  }

  // Tapping a pile's top card discards it if legal, otherwise moves it to fill an empty pile if
  // one exists, otherwise shakes to say "nowhere to go" - see rules.ts's autoMoveHint for the
  // exact priority. The move applies immediately (game logic never waits on an animation); a
  // ghost copy shown at the tapped origin then flies to wherever it actually landed, mirroring
  // every other tap-to-move handler in this app (e.g. KlondikeScreen's own handleCardTap).
  async function handleCardTap(pileIndex: number, card: Card, measure: () => Promise<{ x: number; y: number }>) {
    if (won || stuck || !state) return
    const move = AcesUpController.autoMoveHint!(state, { zone: 'tableau', index: pileIndex }, card.id)
    if (!move) {
      setShake({ cardId: card.id, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }
    const origin = await measure()
    /* eslint-disable-next-line react-hooks/immutability */
    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [card], offsetStep: 0, cardWidth })
    if (!applyMove(move.from, move.to, card)) ghost.hide()
  }

  // A manual drag's drop - PileView's own handleDragEnd already resolves the drop target via
  // dropZones.hitTest before calling this (see PileDragConfig's own doc comment), so this only
  // ever needs to apply the move. Only ever resolves for "move onto an empty pile" in practice -
  // there's no registered drop zone for a discard (see this file's header comment).
  function handleDrop(pileIndex: number, to: PileRef, anchorCardId: string): boolean {
    if (won || stuck || !state) return false
    const card = top(state.piles[pileIndex])
    if (!card || card.id !== anchorCardId) return false
    return applyMove({ zone: 'tableau', index: pileIndex }, to, card)
  }

  async function handleDrawStock() {
    if (won || stuck || !state || !AcesUpController.drawStock) return
    const result = AcesUpController.drawStock(state)
    if (!result) return
    // Read the dealt cards off the POST-deal state (rules.ts's drawStock already sets faceUp:
    // true on each) rather than the pre-deal stock, so the flight below shows each card's real,
    // revealed face throughout - the same "a stock draw flies showing what it really is" precedent
    // Golf/Klondike's own single-card stock draws already establish, not a face-down mystery card.
    const dealt = result.piles.map((pile, pileIndex) => ({ card: top(pile)!, pileIndex }))
    session.registerMove()
    pushUndo(state, null)

    const myToken = ++dealTokenRef.current
    const origin = await measureView(stockViewRef.current)

    setDealHiddenIds(new Set(dealt.map((d) => d.card.id)))
    pendingRoundDealRef.current = { dealt, origin, token: myToken }
    setState(result)
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  return (
    <CardSizeProvider width={cardWidth}>
      {/* eslint-disable-next-line react-hooks/immutability */}
      <GameChrome title='Aces Up' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won || stuck} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} rules={ACESUP_RULES}>
        <View style={[styles.topRow, { width: pilesWidth }]}>
          <DiscardCell card={state.discard[state.discard.length - 1]} isFlyingHere={!!flying && flying.to.zone === 'discard'} viewRef={discardViewRef} />
          <View ref={stockViewRef} collapsable={false}>
            <PlayingCard card={STOCK_DISPLAY_CARD} onPress={handleDrawStock} disabled={state.stock.length === 0} hinted={activeHint?.kind === 'drawStock'} />
          </View>
        </View>

        <View style={[styles.pilesRow, { gap }]}>
          {state.piles.map((pile, pileIndex) => {
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === pileIndex ? flying.count : 0
            // Hidden entirely once won - the win cascade owns displaying these cards now (see the
            // pendingWinCascadeRef effect above), the same way every other game's own final pile
            // display goes blank once its cascade takes over.
            const cards = won ? [] : pile
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              // Only ever the true top card (indexFromTop === 0) - Aces Up never moves more than
              // one card at a time. Gated on hasLegalMove so PileView only treats this card as
              // tappable/draggable when rules.ts's autoMoveHint would actually find it a move (see
              // this file's own header comment on why a real drag config is required either way).
              getRunCount: (indexFromTop) => (indexFromTop === 0 && hasLegalMove(pileIndex) ? 1 : 0),
              onDrop: (to, _count, anchorCardId) => handleDrop(pileIndex, to, anchorCardId)
            }
            return (
              <DropZone key={pileIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: pileIndex }} style={[styles.pile, { width: cardWidth }]}>
                <View
                  ref={(el) => {
                    pileViewRefs.current[pileIndex] = el
                  }}
                  collapsable={false}
                >
                  <PileView cards={cards} onPressCard={(card, _indexFromTop, measure) => handleCardTap(pileIndex, card, measure)} maxHeight={PILE_MAX_HEIGHT} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: pileIndex })} />
                </View>
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
      {stuck && !won && <LossBanner colors={colors} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginTop: 40,
      textAlign: 'center'
    },
    pile: {},
    pilesRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      // Spans pilesRow's own width (set inline via pilesWidth) and spaces its two children apart -
      // discard on the left, stock on the right - mirroring Pyramid's controlRow.
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
