import { useVibration } from '@rific/feedback-press'
import { Fireworks } from '@tastic/animations/fireworks'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { faceUpFanOffset } from '@/components/cards/CardFace'
import { CardSizeProvider, cardWidthForRow } from '@/components/CardSizeContext'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors, TableColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildKlondikeDealSequence } from './dealSequence'
import { KlondikeSettingsSection } from './KlondikeSettingsSection'
import { createKlondikeController, KlondikeState } from './rules'

const TABLEAU_MAX_HEIGHT = 420
const TABLEAU_COLUMNS = 7
const TABLEAU_GAP = 10

export default withGameProviders(KlondikeScreenInner)

function KlondikeScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { settings } = useSettings()
  const controllerRef = useRef(createKlondikeController(settings.klondikeDraw))
  // The draw count of the game currently in progress - only updated when a new game actually
  // starts (mount, or the New Game button below), always reading the live `settings.klondikeDraw`
  // at that moment. Deliberately NOT derived directly from `settings.klondikeDraw` on every
  // render: the in-progress game's own controller/rules must stay fixed to whatever draw count it
  // was dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [klondikeDraw, setKlondikeDraw] = useState<1 | 3>(settings.klondikeDraw)
  const [state, setState] = useState<KlondikeState | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry<KlondikeState>[]>([])
  const session = useGameSession()
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches the
  // original inline checkWin, which re-dereferenced controllerRef.current at call time so a
  // straggling call from a stale render's closure chain still checks against the CURRENT
  // controller, same as every other controllerRef.current read in this file.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: KlondikeState) => controllerRef.current.isWon(s) }, 'klondike', session, dealTokenRef, recordDealWon)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real King has been hidden (won-gated, see the foundation row below), at which point
   * that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (fireAutoMove)
   * - only one is ever in flight at a time, since all four drive the same single-flight ghost.
   * `viaStock` measures via stockViewRef (a plain View, not per-card) instead of CardRegistry -
   * only undoing a stock draw flies back toward the stock; every other destination is a real
   * per-card-registered pile. `fast` marks a fireAutoMove-triggered flight, so the effect below
   * passes it on to ghost.flyTo for the quicker auto-play-to-foundation timing (see
   * dragSpring.ts's autoPlaySpringFor). `gen` is the `dealTokenRef` value at the moment this
   * flight was queued - re-checked once the async measurement below resolves, so a flight queued
   * against a game that's since been replaced by "New Game" doesn't measure/land against the new
   * deal's DOM (card ids are shuffle-independent and reused across deals - see deck.ts). Mirrors
   * exactly how runDeal below already guards itself with dealTokenRef/pendingDealTokenRef. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; fast?: boolean; gen: number } | null>(null)
  /** A draw-3 stock draw awaiting its post-commit measurement + deal.start(), analogous to
   * pendingFlightRef above but for the multi-card deal-style flight (see the [state]-effect below
   * and handleDrawStock) - drawnCards is oldest-first, ending with the new top/frontmost card.
   * `gen` guards the same New-Game-mid-flight race pendingFlightRef's does, above. */
  const pendingDealDrawRef = useRef<{ topCardId: string; drawnCards: Card[]; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  // Mirrors `state` synchronously (assigned directly in the render body, same pattern PileView.tsx
  // uses) so fireAutoMove - which has an await gap before it applies its move, unlike every other
  // mutator here - can tell if some other action already changed state underneath it and bail
  // instead of applying against a stale snapshot.
  const stateRef = useRef(state)
  stateRef.current = state
  // Set right after handleUndo's guard, consumed (and cleared) by the auto-play watcher effect
  // below - suppresses exactly one auto-play check after an undo, so undo doesn't immediately get
  // replayed by the very mechanism it just reverted.
  const justUndidRef = useRef(false)
  // Guards handleUndo against being called again before its own previous invocation has fully
  // settled (visually, not just in state) - see handleUndo below for why an overlapping call would
  // otherwise desync the undo stack or clobber the shared single-flight ghost/deal animation.
  const undoBusyRef = useRef(false)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    controllerRef.current = createKlondikeController(settings.klondikeDraw)
    setKlondikeDraw(settings.klondikeDraw)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    undoBusyRef.current = false
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal), no fresh undo history. `saved.config` is the draw count the game was actually dealt
  // under (see settings.klondikeDraw's own doc comment above for why that can differ from the live
  // setting) - falls back to the live setting only if the saved value is somehow missing/invalid.
  function restoreGame(saved: SavedGame<KlondikeState>) {
    ++dealTokenRef.current
    const draw = saved.config === 1 || saved.config === 3 ? saved.config : settings.klondikeDraw
    controllerRef.current = createKlondikeController(draw)
    setKlondikeDraw(draw)
    setUndoStack([])
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('klondike')
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using.
  async function runDeal(s: KlondikeState, token: number) {
    const sequence = buildKlondikeDealSequence(s.tableau)
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
      entries.push({
        cardId: step.cardId,
        // Flies face-down regardless of step.card's real faceUp - a real dealer lays every card
        // down blind and only turns the top one face-up after it's placed, not while it's still
        // sliding across the table. The real card underneath (revealed the instant this ghost
        // lands - see dealHiddenIds above) already carries the correct true faceUp, so forcing it
        // here only affects this flight's own appearance, never the card actually dealt.
        card: { ...step.card, faceUp: false },
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * DEAL_STAGGER_MS
      })
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

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef),
  // not the King via CardRegistry, since the real King is hidden (and therefore unregistered) the
  // instant `won` flips true, in the same commit this effect reacts to. Chains that whole pile
  // King-first/head down to Ace-last/tail (foundation arrays are built bottom-up, Ace pushed
  // first, so reversing gives the right order). Same dealTokenRef guard as every other async
  // measurement here, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: KlondikeState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)))
    if (dealTokenRef.current !== gen) return
    const chains: ChainSpec[] = []
    s.foundation.forEach((pile, suit) => {
      const origin = origins[suit]
      if (!origin || pile.length === 0) return
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
    })
    winCascade.startChains(chains, cardWidth)
  }

  // Same race as the deal effect above: measuring CardRegistry synchronously right after the
  // setState in applyMove/handleDrawStock would find the still-mounted SOURCE card (the
  // destination card's own registration effect hasn't run yet), so the ghost would "fly" a
  // near-zero distance back to roughly where it started - indistinguishable from a snap. Deferring
  // to a [state]-keyed effect guarantees the destination card has already registered by the time
  // this runs.
  useEffect(() => {
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = pending.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(pending.cardId)
      // A new game can start while the measurement above is in flight (e.g. tapping "New Game"
      // mid auto-play-cascade - see maybeAutoPlay). `landed`, if it resolved at all, would then be
      // measuring an unrelated card in the NEW deal (ids are shuffle-independent and reused across
      // deals - see deck.ts), so drop this flight instead of landing on a nonsensical position.
      if (dealTokenRef.current !== pending.gen || !landed) {
        ghost.hide()
        setFlying(null)
        undoBusyRef.current = false
        return
      }
      ghost.flyTo(
        landed.x,
        landed.y,
        () => {
          setFlying(null)
          undoBusyRef.current = false
        },
        { fast: pending.fast }
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Draw-3's own version of the deal effect above: handleDrawStock already committed the new
  // state (so the real top waste card is mounted/registered) but kept the whole fan hidden via
  // `flying`, so this measures where that top card actually landed once it's really there, derives
  // the other drawn cards' fan positions from it (only the true top registers in CardRegistry - see
  // StockWaste), and kicks off a real multi-card deal flight - each newly drawn card flies
  // independently in quick staggered succession, like a mini re-run of the initial deal, instead of
  // one card flying while the rest silently popped in behind it.
  useEffect(() => {
    const pending = pendingDealDrawRef.current
    if (!pending || !state) return
    pendingDealDrawRef.current = null
    ;(async () => {
      const [origin, topPos] = await Promise.all([measureView(stockViewRef.current), ghost.cardRegistry.measure(pending.topCardId)])
      // Same New-Game-mid-flight race as the pendingFlightRef effect above - a game that's since
      // been replaced makes `topPos` (if it resolves at all) measure an unrelated card in the new
      // deal, so bail out rather than fly a deal-style flight toward it.
      if (dealTokenRef.current !== pending.gen || !origin || !topPos) {
        setFlying(null)
        return
      }
      const fanOffset = faceUpFanOffset(cardWidth)
      const n = pending.drawnCards.length
      const entries: DealCardSpec[] = pending.drawnCards.map((card, i) => {
        const distanceFromTop = n - 1 - i // i=0 is the oldest/farthest card, i=n-1 is the new top
        return {
          cardId: card.id,
          card: { ...card, faceUp: true },
          from: origin,
          to: { x: topPos.x - fanOffset * distanceFromTop, y: topPos.y },
          delayMs: i * DEAL_STAGGER_MS
        }
      })
      deal.start(
        entries,
        cardWidth,
        () => {
          // Each landed ghost reveals its own slot immediately (see StockWaste's per-slot
          // freezing) - farthest-from-top lands first (smallest delay), so the count shrinks
          // outside-in, front slot last.
          setFlying((f) => (f && f.to.zone === 'waste' ? { ...f, count: Math.max(0, f.count - 1) } : f))
        },
        () => setFlying(null)
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Drives the auto-play-to-foundation cascade: re-checks maybeAutoPlay every time the board
  // settles with nothing else animating. `flying !== null` guards against overlapping the
  // single-ghost system (an auto-play's own landing sets it back to null, which re-triggers this
  // effect - the cascade is self-sustaining with no explicit recursion); `dealHiddenIds.size > 0`
  // guards against firing mid-deal, since the deal animation never touches `flying` at all.
  useEffect(() => {
    if (!state || flying !== null || dealHiddenIds.size > 0) return
    if (justUndidRef.current) {
      justUndidRef.current = false
      return
    }
    maybeAutoPlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, flying, dealHiddenIds])

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<KlondikeState>('klondike').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('klondike')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin below just cleared it.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress('klondike', { state, moves: session.moves, elapsedSeconds: session.elapsed, config: klondikeDraw })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, klondikeDraw])

  function pushUndo(prev: KlondikeState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would. Undoing a stock draw flies back toward the stock instead of a
  // per-card pile - see pendingFlightRef's `viaStock`.
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    justUndidRef.current = true
    // Undo only ever moves backward into an earlier, necessarily-not-won state (won is a terminal
    // condition - the only move available once it's true is New Game), so any undo reachable while
    // won must be undoing the winning move itself. Clears the "You Won!" banner and stops the
    // bouncing win cascade immediately instead of leaving both stuck on screen over a board that's
    // already reverted underneath them. Deliberately does NOT reset recordedWinRef - this deal was
    // genuinely won at some point, and recordedWinRef staying true is what stops both a later re-win
    // in this same deal from double-recording the stat, and a later "New Game" (without re-winning)
    // from wrongly recording this already-won deal as abandoned too (see handleNewGame's own !won
    // guard on recordDealAbandoned).
    if (won) {
      setWon(false)
      winCascade.clear()
    }
    const entry = undoStack[undoStack.length - 1]
    const { move, state: prevState } = entry

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1))
      setState(prevState)
      undoBusyRef.current = false
      return
    }

    // Reverse of the deal-style draw-3 flight above: fly each drawn card back toward the stock
    // independently, staggered newest-first (the last one dealt is the first one un-dealt) - no
    // hide/freeze needed on the waste side (unlike the forward draw), since the state reverting
    // instantly underneath just reveals whatever was already there before this draw, which is
    // exactly what a card lifting off should uncover.
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) {
      const sourcePile = resolvePile(move.to)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))

      if (topPos && stockDest) {
        const fanOffset = faceUpFanOffset(cardWidth)
        const entries: DealCardSpec[] = movingCards
          .slice()
          .reverse() // newest/top (last dealt) first
          .map((card, i) => ({
            cardId: card.id,
            card: { ...card, faceUp: true },
            from: { x: topPos.x - fanOffset * i, y: topPos.y },
            to: stockDest,
            delayMs: i * DEAL_STAGGER_MS
          }))
        setState(prevState)
        deal.start(
          entries,
          cardWidth,
          () => {},
          () => {
            undoBusyRef.current = false
          }
        )
      } else {
        setState(prevState)
        undoBusyRef.current = false
      }
      return
    }

    const sourcePile = resolvePile(move.to)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin) {
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: movingCards, offsetStep, cardWidth })
      setFlying({ to: move.from, count: move.count })
      setState(prevState)
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it skips the undo stack entirely (one Undo press
  // reverts the whole triggering move plus any cascade it set off, in one step) and doesn't count
  // toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    if (!state) return false
    const result = controllerRef.current.tryMove(state, { from, to, count })
    if (result) {
      if (!opts?.silent) pushUndo(state, { from, to, count, anchorCardId })
      setState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      return true
    }
    return false
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move, a manual drag's
  // drop, or an auto-play) - applies the move, then marks the destination "incoming" and stashes
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto,
  // instead of it just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean; fast?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    setFlying({ to, count })
    pendingFlightRef.current = { cardId: anchorCardId, fast: opts?.fast, gen: dealTokenRef.current }
    return true
  }

  // Auto-play-to-foundation: see engine/autoFoundation.ts for the two mechanisms this composes.
  // Re-run after every settled state change by the watcher effect above - mechanism B (a
  // guaranteed full clear) takes priority and, once true, ignores mechanism A's caution entirely
  // since there's no longer any player decision left to protect.
  function maybeAutoPlay() {
    if (!state) return
    const controller = controllerRef.current
    if (!controller.accessibleCards) return
    const entry = isFullyAutoCompletable(controller, state) ? nextAutoCompleteMove(controller, state) : findSafeAutoPlay(controller.accessibleCards(state), state.foundation)
    if (entry) fireAutoMove(entry)
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after.
  async function fireAutoMove(entry: AccessibleCard) {
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart) return
    const to: PileRef = { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) }
    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth })
    if (!completeMove(entry.ref, to, 1, entry.card.id, { silent: true, fast: true })) {
      ghost.hide()
    }
  }

  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string): Promise<boolean> {
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) return false
    return completeMove(from, target, count, anchorCardId)
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingAltColor)
  }

  // Draw-1 mirrors handleCardTap's single-ghost flight (see the pendingFlightRef effect above),
  // just with a fixed origin (the stock pile) instead of a tapped card's position. Draw-3 instead
  // hands off to the deal-style multi-card flight (see the [state]-effect above) - every newly
  // drawn card flies, not just the new top one.
  async function handleDrawStock() {
    if (!state || !controllerRef.current.drawStock) return
    const result = controllerRef.current.drawStock(state)
    if (!result) return
    session.registerMove()

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      // Recycling the waste back into the stock, not a single card being drawn - nothing
      // card-shaped to fly, so undo just reverts this instantly (see MoveInfo | null above).
      pushUndo(state, null)
      setState(result)
      return
    }

    // How many cards this draw actually added - normally klondikeDraw, but fewer once the stock
    // runs low (rules.ts's drawStock clamps to what's left).
    const drawnCount = result.waste.length - state.waste.length
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: drawnCount, anchorCardId: drawnCard.id }

    if (drawnCount > 1) {
      const drawnCards = result.waste.slice(result.waste.length - drawnCount) // oldest -> newest/top
      pushUndo(state, move)
      setFlying({ to: { zone: 'waste', index: 0 }, count: drawnCount })
      pendingDealDrawRef.current = { topCardId: drawnCard.id, drawnCards, gen: dealTokenRef.current }
      setState(result)
      return
    }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(state, move)
      setState(result)
      return
    }

    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth })
    setFlying({ to: { zone: 'waste', index: 0 }, count: 1 })

    pushUndo(state, move)
    setState(result)
    pendingFlightRef.current = { cardId: drawnCard.id, gen: dealTokenRef.current }
  }

  function resolvePile(ref: PileRef): Card[] | null {
    if (!state) return null
    switch (ref.zone) {
      case 'tableau':
        return state.tableau[ref.index] ?? null
      case 'foundation':
        return state.foundation[ref.index] ?? null
      case 'waste':
        return state.waste
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination: a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards (see engine/autoMove.ts). Tapping the
  // same card again re-evaluates from its new position, so a card cycles through its alternatives
  // one tap at a time rather than needing a separate destination tap.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card
  // that just moved stays hidden at its destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here,
  // so the ghost always lands exactly on top of it with no seam.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !controllerRef.current.autoMoveHint) return
    const move = controllerRef.current.autoMoveHint(state, ref, cardId)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather
      // than a dead press, with a short haptic tap alongside (see shakeAnimation.ts). Tapping mid-
      // stack (indexFromTop > 0) with a valid run below shakes that whole run, not just the one
      // card under the finger - it's the same "stuck" outcome for all of them. Deliberately never
      // calls measure() - this branch has no use for the tapped card's position, so it skips
      // paying for the measurement at all (see PileView.tsx's onPress doc comment).
      const count = ref.zone === 'tableau' && indexFromTop !== undefined ? Math.max(1, tableauRunCount(ref.index, indexFromTop)) : 1
      setShake({ cardId, count, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const origin = await measure()
    const sourcePile = resolvePile(move.from)
    if (!sourcePile) return
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    ghost.originX.value = origin.x
    ghost.originY.value = origin.y
    ghost.dx.value = 0
    ghost.dy.value = 0
    playCardSound()
    hapticCard()
    ghost.show({ cards: movingCards, offsetStep, cardWidth })

    if (!completeMove(move.from, move.to, move.count, cardId)) {
      ghost.hide()
    }
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    )
  }

  const wasteTop = top(state.waste)
  // Draw-3 keeps the last 3 drawn cards visible, fanned - draw-1 never shows more than the one
  // real top card. wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see
  // StockWaste), so the slice below (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = klondikeDraw === 3 ? Math.min(3, state.waste.length) : Math.min(1, state.waste.length)
  const wasteBehind = state.waste.slice(Math.max(0, state.waste.length - visibleWasteCount), state.waste.length - 1).reverse()

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title={`Klondike · Draw ${klondikeDraw}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<KlondikeSettingsSection />}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + TABLEAU_GAP * (TABLEAU_COLUMNS - 1) }]}>
          <View style={styles.foundationsGroup}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = !!flying && flying.to.zone === 'foundation' && flying.to.index === i
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={won ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    suit={SUITS[i]}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteHiddenCount={flying && flying.to.zone === 'waste' ? flying.count : 0} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} cardWidth={cardWidth} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id)} stockRef={stockViewRef} />
        </View>

        <View style={styles.tableauRow}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={TABLEAU_MAX_HEIGHT} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} />
              </DropZone>
            )
          })}
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it. */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.elapsed} moves={session.moves} score={computeScore(session.moves, session.elapsed)} onNewGame={startNewGame} />}
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
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row',
      gap: 10
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginTop: 40,
      textAlign: 'center'
    },
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      gap: TABLEAU_GAP,
      paddingBottom: 20
    },
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
