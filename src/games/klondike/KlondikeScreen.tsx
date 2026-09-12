import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, cardWidthForRow, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { KLONDIKE_RULES } from '@/constants/gameRules'
import { findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildKlondikeDealSequence } from './dealSequence'
import { KlondikeSettingsSection } from './KlondikeSettingsSection'
import { createKlondikeController, KlondikeState } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 420
const TABLEAU_COLUMNS = 7
const TABLEAU_GAP = 10

/** This game's own undo-move shape (see undoTypes.ts's TMove generic): `primary` is the move that
 * produced the very next state (same as every other game's plain MoveInfo|null), and `cascaded`
 * collects any silent auto-play-to-foundation moves (see applyMove's `opts.silent`) that happened
 * afterward, before the player's next real action - so one Undo press reverses the whole burst,
 * animating every card it touched instead of only the primary one. */
interface KlondikeUndoMove {
  primary: MoveInfo | null
  cascaded: MoveInfo[]
}
type KlondikeUndoEntry = UndoEntry<KlondikeState, KlondikeUndoMove>
// A save written before this shape existed stored `move` as a bare MoveInfo | null (see
// normalizeUndoEntry below) - restoreGame accepts either shape from disk.
type LegacyKlondikeUndoEntry = UndoEntry<KlondikeState>

function normalizeUndoEntry(e: KlondikeUndoEntry | LegacyKlondikeUndoEntry): KlondikeUndoEntry {
  const m = e.move as KlondikeUndoMove | MoveInfo | null
  if (m && typeof m === 'object' && 'cascaded' in m) return { state: e.state, move: m }
  return { state: e.state, move: { primary: m, cascaded: [] } }
}

export default withGameProviders(KlondikeScreenInner)

function KlondikeScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  const controllerRef = useRef(createKlondikeController(settings.klondikeDraw))
  // The draw count of the game currently in progress - only updated when a new game actually
  // starts (mount, or the New Game button below), always reading the live `settings.klondikeDraw`
  // at that moment. Deliberately NOT derived directly from `settings.klondikeDraw` on every
  // render: the in-progress game's own controller/rules must stay fixed to whatever draw count it
  // was dealt with, even if the player changes the setting mid-game without starting a new deal.
  const [klondikeDraw, setKlondikeDraw] = useState<1 | 3>(settings.klondikeDraw)
  const [state, setState] = useState<KlondikeState | null>(null)
  const [undoStack, setUndoStack] = useState<KlondikeUndoEntry[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: KlondikeState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param),
  // to decide whether this win counts toward the "wins without hint" stat/achievement. Reset
  // alongside the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  /** Waste slot's own wrapping View, for measuring its screen position as a group-ghost flight's
   * shared origin/destination - a stock recycle moves the whole waste back to stock (or, on undo,
   * back the other way) as one clump, not per-card (see PATTERN_RECYCLE in this fix batch's
   * notes). */
  const wasteViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // True while the stock slot's own real content is mid-recycle-flight elsewhere and should stay
  // frozen on its outgoing look rather than reveal the incoming one early - see StockWaste's own
  // `stockHidden` prop doc comment.
  const [stockHidden, setStockHidden] = useState(false)
  // Extra waste-slot hidden count contributed by cascaded auto-play cards flying back onto the
  // waste during an undo (see PATTERN_CASCADE_UNDO) - added on top of `flying`'s own waste count
  // in the StockWaste wasteHiddenCount prop below, since the two can be simultaneously true (the
  // primary move undoing back to a foundation/tableau slot while a cascaded card independently
  // returns to waste).
  const [cascadeWasteHiddenCount, setCascadeWasteHiddenCount] = useState(0)
  // Suits whose win-cascade origin measurement failed (see runWinCascade) - that suit's real
  // foundation card un-hides immediately instead of staying hidden forever with no ghost ever
  // covering for it (mirrors Pyramid's own fallback for the same rare failure mode).
  const [winCascadeFallbackSuits, setWinCascadeFallbackSuits] = useState<Set<number>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Reads controllerRef.current live inside isWon (rather than passing controllerRef.current
  // directly, which would freeze this render's controller into checkWin's closure) - matches the
  // original inline checkWin, which re-dereferenced controllerRef.current at call time so a
  // straggling call from a stale render's closure chain still checks against the CURRENT
  // controller, same as every other controllerRef.current read in this file.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck({ isWon: (s: KlondikeState) => controllerRef.current.isWon(s) }, 'klondike', session, dealTokenRef, recordDealWon, hintsUsedRef)
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
  /** A cascade-return flight (see PATTERN_CASCADE_UNDO) awaiting its post-commit destination
   * measurement + deal.start(), analogous to pendingDealDrawRef above - `origins` is each
   * foundation slot's own measured position (index-aligned with foundationSlotRefs/SUITS),
   * captured synchronously in handleUndo (a container ref, content-independent, safe to measure
   * before the state revert commits) since the cascaded cards themselves have no CardRegistry
   * entry once buried under a later foundation arrival. */
  const pendingCascadeUndoRef = useRef<{ moves: MoveInfo[]; origins: ({ x: number; y: number } | null)[]; gen: number } | null>(null)
  /** Synchronous "is a flight currently in the air" guard, checked at the very top of every entry
   * point that can start one (handleCardTap, handleDrawStock, fireAutoMove, handleUndo, and the
   * drag-and-drop path's own attemptDrop/dragConfig.onDrop below) - see PATTERN_OVERLAP_GATE.
   * Unlike `flying` (a state, which only reflects reality once its setState has actually committed
   * and re-rendered), this ref is true/false immediately, closing the gap where a rapid second tap
   * could sneak in during the async measurement window before the first flight's
   * `setFlying`/`setState` calls have even happened. The drag-and-drop entry points are the one
   * exception to "checked at the very top": a drag gesture's pointer is already down (and its own
   * ghost already visibly tracking, via PileView's handleDragStart) well before either callback
   * runs, so the claim there only needs to guard the POST-drop flight resolution, not the drag's
   * start - see attemptDrop's own doc comment. */
  const flightBusyRef = useRef(false)
  /** How many independent async completions the current flight must wait for before
   * flightBusyRef/undoBusyRef actually clear (see settleFlight below) - normally 1 (the one
   * flight an action starts), but 2 for an undo whose entry also carries cascaded moves: the
   * primary move's own DragGhostLayer flight and the cascaded cards' independent DealLayer flight
   * are two genuinely concurrent completions, and clearing busy the instant either one lands
   * (rather than both) would let a new action interrupt whichever is still in the air. */
  const flightCompletionsRef = useRef(0)
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

  // Shared completion tail for every flight-starting action (see flightBusyRef/flightCompletionsRef
  // above) - call once per independent completion (a landed ghost flight, a landed deal, or a
  // "nothing to animate" bail); only actually clears the busy flags once every completion this
  // action claimed up front has reported in.
  function settleFlight() {
    flightCompletionsRef.current = Math.max(0, flightCompletionsRef.current - 1)
    if (flightCompletionsRef.current === 0) {
      flightBusyRef.current = false
      undoBusyRef.current = false
    }
  }

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    controllerRef.current = createKlondikeController(settings.klondikeDraw)
    setKlondikeDraw(settings.klondikeDraw)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    flightBusyRef.current = false
    flightCompletionsRef.current = 0
    pendingCascadeUndoRef.current = null
    setStockHidden(false)
    setCascadeWasteHiddenCount(0)
    setWinCascadeFallbackSuits(new Set())
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
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment). `saved.config` is the draw
  // count the game was actually dealt under (see settings.klondikeDraw's own doc comment above for
  // why that can differ from the live setting) - falls back to the live setting only if the saved
  // value is somehow missing/invalid.
  function restoreGame(saved: SavedGame<KlondikeState, KlondikeUndoEntry | LegacyKlondikeUndoEntry>) {
    ++dealTokenRef.current
    const draw = saved.config === 1 || saved.config === 3 ? saved.config : settings.klondikeDraw
    controllerRef.current = createKlondikeController(draw)
    setKlondikeDraw(draw)
    // A save written before the cascade-undo fix stored `move` as a bare MoveInfo | null, not this
    // game's now-richer { primary, cascaded } shape - normalize rather than crash the first time
    // handleUndo reads `.primary`/`.cascaded` off something that's actually just a MoveInfo.
    setUndoStack((saved.undoStack ?? []).map(normalizeUndoEntry))
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    flightBusyRef.current = false
    flightCompletionsRef.current = 0
    pendingCascadeUndoRef.current = null
    setStockHidden(false)
    setCascadeWasteHiddenCount(0)
    setWinCascadeFallbackSuits(new Set())
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
    // A suit whose slot measurement failed (rare) can't get a bounce chain at all - rather than
    // silently omit it (leaving a bare empty placeholder for the rest of the win screen, since
    // `won` otherwise hides every foundation's real card unconditionally below), un-hide that
    // suit's real top card immediately, mirroring Pyramid's own "unhide on failed measurement"
    // fallback for the same rare failure mode.
    const fallbackSuits = new Set<number>()
    s.foundation.forEach((pile, suit) => {
      if (pile.length === 0) return
      const origin = origins[suit]
      if (!origin) {
        fallbackSuits.add(suit)
        return
      }
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS })
    })
    if (fallbackSuits.size > 0) setWinCascadeFallbackSuits(fallbackSuits)
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
        settleFlight()
        return
      }
      ghost.flyTo(
        landed.x,
        landed.y,
        () => {
          setFlying(null)
          settleFlight()
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
        settleFlight()
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
        () => {
          setFlying(null)
          settleFlight()
        }
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Cascade-return effect (see PATTERN_CASCADE_UNDO): once an undo's revert has committed, fly
  // every cascaded (silently auto-played) card back from the foundation slot it left to wherever
  // it now really sits (a tableau column or the waste), independently and concurrently with the
  // primary move's own DragGhostLayer flight (see the pendingFlightRef effect above - independent
  // providers, so both animating at once is correct). Deferred to [state] for the same
  // registration-race reason as every other post-commit measurement in this file.
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    runCascadeReturn(pending.moves, pending.origins, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Drives the auto-play-to-foundation cascade: re-checks maybeAutoPlay every time the board
  // settles with nothing else animating. `flying !== null` guards against overlapping the
  // single-ghost system (an auto-play's own landing sets it back to null, which re-triggers this
  // effect - the cascade is self-sustaining with no explicit recursion); `dealHiddenIds.size > 0`
  // guards against firing mid-deal, since the deal animation never touches `flying` at all.
  // `session.moves === 0` guards against firing on a freshly dealt (or resumed-but-untouched)
  // board before the player has made a single real move - auto-played moves are always `silent`
  // and never bump session.moves (see applyMove below), so this can only ever be satisfied by a
  // genuine tap/drag/stock-draw, not by the cascade re-triggering itself.
  useEffect(() => {
    if (!state || flying !== null || dealHiddenIds.size > 0 || session.moves === 0) return
    if (justUndidRef.current) {
      justUndidRef.current = false
      return
    }
    maybeAutoPlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, flying, dealHiddenIds, session.moves])

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<KlondikeState, KlondikeUndoEntry | LegacyKlondikeUndoEntry>('klondike').then((saved) => {
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
  // deal right after checkWin below just cleared it. `session.elapsed` is also a dependency, not
  // just `state` - it ticks up once a second on its own timer (see useGameSession.ts), independent
  // of any move, so a save made at the last real move goes stale the moment the player just sits
  // looking at the board and then leaves; resuming would silently roll the clock back to whatever
  // it read at that last move instead of how long they actually had the deal open.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress<KlondikeState, KlondikeUndoEntry>('klondike', { state, undoStack, moves: session.moves, elapsedSeconds: session.elapsed, config: klondikeDraw })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, klondikeDraw, session.elapsed, undoStack])

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controllerRef.current, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('klondike')
  }

  function pushUndo(prev: KlondikeState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move: { primary: move, cascaded: [] } }])
  }

  // Appends a silently-auto-played move (see applyMove's `opts.silent`) to the CURRENT
  // top-of-stack entry's own cascade list instead of pushing a new stack entry - see
  // PATTERN_CASCADE_UNDO. A cascaded move arriving with an empty stack is dropped (shouldn't
  // happen - a silent move only ever follows a real player move, which always pushes an entry
  // first), matching this game's pre-fix behavior for that edge case rather than inventing new
  // behavior for it.
  function pushCascadedMove(move: MoveInfo) {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack
      const last = stack[stack.length - 1]
      return [...stack.slice(0, -1), { state: last.state, move: { primary: last.move.primary, cascaded: [...last.move.cascaded, move] } }]
    })
  }

  // Marks cascaded cards hidden at their real (about-to-be-revealed-by-revert) destination -
  // reuses dealHiddenIds for a tableau destination (conceptually identical to the initial deal:
  // a card mid-flight into a pile) and a dedicated counter for a waste destination (StockWaste has
  // no per-id hide, only a frontmost-N-slots count - see cascadeWasteHiddenCount above). Must be
  // called in the SAME commit as the setState that reverts to prevState (see PATTERN_CASCADE_UNDO)
  // so the returning cards never flash fully visible before their ghosts arrive to cover them.
  function hideCascadeCards(moves: MoveInfo[]) {
    if (moves.length === 0) return
    const tableauIds = moves.filter((m) => m.from.zone === 'tableau').map((m) => m.anchorCardId)
    const wasteCount = moves.filter((m) => m.from.zone === 'waste').length
    if (tableauIds.length > 0) setDealHiddenIds((ids) => new Set([...ids, ...tableauIds]))
    if (wasteCount > 0) setCascadeWasteHiddenCount((n) => n + wasteCount)
  }

  // Flies every cascaded card back from the foundation slot it left (`origins`, index-aligned with
  // foundationSlotRefs/SUITS - a container ref, measured once up front in handleUndo, since the
  // cards themselves have no CardRegistry entry once buried under a later foundation arrival) to
  // wherever it now really sits, once that position is actually measurable - called either from
  // the pendingCascadeUndoRef effect (the common case, running concurrently with the primary
  // move's own flight) or directly after a primary flight that itself needed the `deal` provider
  // (the draw-3-undo branch below can't run both at once - see its own comment). Always ends in
  // exactly one settleFlight() call, matching the one completion this cascade was counted as in
  // flightCompletionsRef.
  async function runCascadeReturn(moves: MoveInfo[], origins: ({ x: number; y: number } | null)[], gen: number) {
    const destinations = await Promise.all(moves.map((m) => ghost.cardRegistry.measure(m.anchorCardId)))
    if (dealTokenRef.current !== gen) {
      settleFlight()
      return
    }
    const s = stateRef.current
    const entries: DealCardSpec[] = []
    const strandedTableauIds: string[] = []
    let strandedWasteCount = 0
    moves.forEach((m, i) => {
      const dest = destinations[i]
      const origin = origins[m.to.index]
      const card = s ? resolvePile(m.from, s)?.find((c) => c.id === m.anchorCardId) : undefined
      if (dest && origin && card) {
        entries.push({ cardId: m.anchorCardId, card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: i * DEAL_STAGGER_MS })
      } else if (m.from.zone === 'tableau') {
        strandedTableauIds.push(m.anchorCardId)
      } else if (m.from.zone === 'waste') {
        strandedWasteCount += 1
      }
    })
    // A card whose destination measurement failed (a rare edge case) un-hides immediately rather
    // than staying stuck invisible forever - mirrors runDeal's/runWinCascade's own fallback for
    // the same failure mode.
    if (strandedTableauIds.length > 0) {
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        strandedTableauIds.forEach((id) => next.delete(id))
        return next
      })
    }
    if (strandedWasteCount > 0) setCascadeWasteHiddenCount((n) => Math.max(0, n - strandedWasteCount))

    if (entries.length === 0) {
      settleFlight()
      return
    }
    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        const m = moves.find((mv) => mv.anchorCardId === cardId)
        if (m?.from.zone === 'tableau') {
          setDealHiddenIds((ids) => {
            if (!ids.has(cardId)) return ids
            const next = new Set(ids)
            next.delete(cardId)
            return next
          })
        } else if (m?.from.zone === 'waste') {
          setCascadeWasteHiddenCount((n) => Math.max(0, n - 1))
        }
      },
      () => settleFlight()
    )
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would. Undoing a stock draw flies back toward the stock instead of a
  // per-card pile - see pendingFlightRef's `viaStock`. A recorded cascade (see PATTERN_CASCADE_UNDO)
  // rides along, animating back to its own origins concurrently with whichever branch below
  // handles the primary move.
  async function handleUndo() {
    if (undoBusyRef.current || flightBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    flightBusyRef.current = true
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
      setWinCascadeFallbackSuits(new Set())
    }
    const entry = undoStack[undoStack.length - 1]
    const { move: moveWrap, state: prevState } = entry
    const move = moveWrap.primary
    const cascaded = moveWrap.cascaded
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights
    // rather than some using a token read before the race and some after.
    const gen = dealTokenRef.current
    flightCompletionsRef.current = cascaded.length > 0 ? 2 : 1

    // Foundation slot origins for the cascade (a container ref, content-independent - safe to
    // measure now, before anything reverts) - measured up front regardless of which branch below
    // ends up handling the primary move.
    const cascadeOrigins = cascaded.length > 0 ? await Promise.all(foundationSlotRefs.current.map((view) => measureView(view))) : null

    if (!move) {
      hideCascadeCards(cascaded)
      setUndoStack((stack) => stack.slice(0, -1))
      setState(prevState)
      settleFlight() // primary: nothing to fly, settles immediately
      // Deferred via pendingCascadeUndoRef (resolved by the [state]-effect above), not called
      // directly - the reverted state hasn't committed/re-rendered yet at this point, so a
      // cascaded card's NEW position wouldn't be CardRegistry-registered until after that commit.
      if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      return
    }

    // Reverse of the forward stock-recycle flight (see PATTERN_RECYCLE): the whole reverted waste
    // flies back as one clump from the stock slot to the waste slot - both slots are
    // content-independent container refs, so no post-commit deferral is needed for either end.
    if (move.from.zone === 'waste' && move.to.zone === 'stock') {
      const stockOrigin = await measureView(stockViewRef.current)
      const wasteDest = await measureView(wasteViewRef.current)
      const recycledCards = prevState.waste.slice()

      setUndoStack((stack) => stack.slice(0, -1))
      hideCascadeCards(cascaded)

      if (stockOrigin && wasteDest && recycledCards.length > 0) {
        ghost.originX.value = stockOrigin.x
        ghost.originY.value = stockOrigin.y
        ghost.dx.value = 0
        ghost.dy.value = 0
        playCardSound()
        hapticCard()
        ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth })
        setFlying({ to: { zone: 'waste', index: 0 }, count: recycledCards.length })
        setStockHidden(true)
        setState(prevState)
        ghost.flyTo(wasteDest.x, wasteDest.y, () => {
          setFlying(null)
          setStockHidden(false)
          settleFlight()
        })
      } else {
        setState(prevState)
        settleFlight()
      }
      // Deferred (not called directly) for the same registration-race reason as the `!move`
      // branch above - the primary flight here uses `ghost` (a container-ref-to-container-ref
      // flight, needing no deferral of its own), but the cascade's own destinations are per-card
      // CardRegistry lookups that only resolve once this commit's registration effects have run.
      if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      return
    }

    // Reverse of the deal-style draw-3 flight above: fly each drawn card back toward the stock
    // independently, staggered newest-first (the last one dealt is the first one un-dealt) - no
    // hide/freeze needed on the waste side (unlike the forward draw), since the state reverting
    // instantly underneath just reveals whatever was already there before this draw, which is
    // exactly what a card lifting off should uncover. Any cascade rides the SAME `deal` provider
    // as this primary flight (only one can be active at a time), so it's sequenced to start once
    // this one fully lands rather than run concurrently with it - the cascaded cards are hidden
    // immediately either way (hideCascadeCards, below), so there's no visible gap.
    if (move.from.zone === 'stock' && move.to.zone === 'waste' && move.count > 1) {
      const sourcePile = resolvePile(move.to)
      const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [] // oldest -> newest/top
      const topPos = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null
      const stockDest = topPos ? await measureView(stockViewRef.current) : null

      setUndoStack((stack) => stack.slice(0, -1))
      hideCascadeCards(cascaded)

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
            settleFlight()
            // Called directly here (not deferred via pendingCascadeUndoRef) - this callback fires
            // well after the revert's own render already committed (the whole primary flight's
            // duration has elapsed), so every cascaded card's new-position registration effect has
            // long since run. Safe, and necessary: this primary flight already occupies the shared
            // `deal` provider, so the cascade can't start until it's fully landed anyway.
            if (cascadeOrigins) runCascadeReturn(cascaded, cascadeOrigins, gen)
          }
        )
      } else {
        // No primary flight actually started (measurement failed) - settles immediately. The
        // cascade (if any) still needs the normal post-commit deferral, since the revert commits
        // this tick.
        setState(prevState)
        settleFlight()
        if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }
      }
      return
    }

    const sourcePile = resolvePile(move.to)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : []
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))
    hideCascadeCards(cascaded)

    // Deferred via pendingCascadeUndoRef when present (not called directly) - the primary flight
    // here (via pendingFlightRef, `ghost`) and the cascade flight (via `deal`) are independent
    // providers that can run concurrently, but both need the SAME post-commit deferral: neither
    // the primary's own destination nor a cascaded card's new position is CardRegistry-registered
    // until after this revert's render actually commits. The primary's own completion (below) is
    // entirely independent of whether a cascade exists.
    if (cascadeOrigins) pendingCascadeUndoRef.current = { moves: cascaded, origins: cascadeOrigins, gen }

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
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen }
    } else {
      setState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so instead of pushing its own undo entry, it's
  // appended to the CURRENT top entry's own cascade list (see PATTERN_CASCADE_UNDO/pushCascadedMove)
  // - one Undo press reverts the whole triggering move plus any cascade it set off, animating every
  // card it touched - and it doesn't count toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    if (!state) return false
    const result = controllerRef.current.tryMove(state, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      if (opts?.silent) pushCascadedMove(moveInfo)
      else pushUndo(state, moveInfo)
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
    if (!settings.autoMoveToFoundation) return
    if (!state) return
    if (flightBusyRef.current) return // see PATTERN_OVERLAP_GATE - never start a new flight over one still in the air
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
  // await and bailing if it no longer matches after. Also claims flightBusyRef synchronously up
  // front (see PATTERN_OVERLAP_GATE) - maybeAutoPlay's own check above can't close the gap alone,
  // since `flying` (what that check ultimately depends on, via the watcher effect) only reflects
  // reality once a previous flight's setState has actually committed.
  async function fireAutoMove(entry: AccessibleCard) {
    if (flightBusyRef.current) return
    flightBusyRef.current = true
    flightCompletionsRef.current = 1
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart) {
      settleFlight()
      return
    }
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
      settleFlight()
    }
  }

  // Drag-and-drop's own entry point into the same PATTERN_OVERLAP_GATE every tap/auto-play/
  // stock-draw/undo entry point already uses (see flightBusyRef's doc comment above) - claimed
  // synchronously here, before the `hitTest` await, so a tap/auto-play/stock-draw flight can't
  // sneak in during that gap, and so this drop's own resulting flight (once completeMove lands
  // one) blocks THEM in turn until it settles. This only guards the POST-drop flight resolution,
  // never the drag gesture's start (the pointer is already down by the time this runs - see
  // PileView's own handleDragStart, which shows the shared ghost immediately, well before
  // attemptDrop/onDrop below ever get a chance to run). A rejected claim (already busy) returns
  // false immediately, same as "no legal target" - the caller (DraggableCard/PileView's own
  // handleDragEnd) reads that as a failed drop and snaps the ghost back on its own.
  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string): Promise<boolean> {
    if (flightBusyRef.current) return false // see PATTERN_OVERLAP_GATE
    flightBusyRef.current = true
    flightCompletionsRef.current = 1
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target) {
      settleFlight()
      return false
    }
    if (!completeMove(from, target, count, anchorCardId)) {
      settleFlight()
      return false
    }
    return true
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
    if (flightBusyRef.current) return // see PATTERN_OVERLAP_GATE
    const result = controllerRef.current.drawStock(state)
    if (!result) return
    flightBusyRef.current = true
    flightCompletionsRef.current = 1
    session.registerMove()

    const drawnCard = top(result.waste)
    if (!drawnCard) {
      // Recycling the waste back into the stock (see PATTERN_RECYCLE) - the whole waste flies as
      // one clump, from the waste slot to the stock slot, both content-independent container refs
      // measurable synchronously (no post-commit deferral needed for either end).
      const wasteOrigin = await measureView(wasteViewRef.current)
      const stockDest = await measureView(stockViewRef.current)
      const recycledCards = state.waste.slice()
      const move: MoveInfo = { from: { zone: 'waste', index: 0 }, to: { zone: 'stock', index: 0 }, count: recycledCards.length, anchorCardId: recycledCards[0]?.id ?? '' }
      pushUndo(state, move)

      if (wasteOrigin && stockDest && recycledCards.length > 0) {
        ghost.originX.value = wasteOrigin.x
        ghost.originY.value = wasteOrigin.y
        ghost.dx.value = 0
        ghost.dy.value = 0
        playCardSound()
        hapticCard()
        ghost.show({ cards: recycledCards, offsetStep: 0, cardWidth })
        setFlying({ to: { zone: 'waste', index: 0 }, count: recycledCards.length })
        setStockHidden(true)
        setState(result)
        ghost.flyTo(stockDest.x, stockDest.y, () => {
          setFlying(null)
          setStockHidden(false)
          settleFlight()
        })
      } else {
        setState(result)
        settleFlight()
      }
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
      settleFlight()
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

  // `s` defaults to the closure's own live `state` (every pre-existing call site) - runCascadeReturn
  // passes an explicit state (the just-reverted board, read off stateRef inside an effect) instead,
  // since that call doesn't want "whatever render this function happens to close over" but "the
  // exact state the cascade is returning cards into".
  function resolvePile(ref: PileRef, s: KlondikeState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'waste':
        return s.waste
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
    if (flightBusyRef.current) return // see PATTERN_OVERLAP_GATE
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

    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - a second rapid tap
    // arriving during this measurement gap sees flightBusyRef already true, rather than racing this
    // call to start its own flight before `flying`'s setState has even committed.
    flightBusyRef.current = true
    flightCompletionsRef.current = 1
    const origin = await measure()
    const sourcePile = resolvePile(move.from)
    if (!sourcePile) {
      settleFlight()
      return
    }
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
      settleFlight()
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
      <GameChrome title='Klondike' subtitle={`Draw ${klondikeDraw}`} onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} hasProgress={session.moves > 0} elapsedSeconds={session.elapsed} movesCount={session.moves} settingsContent={<KlondikeSettingsSection />} rules={KLONDIKE_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + TABLEAU_GAP * (TABLEAU_COLUMNS - 1) }]}>
          <View style={styles.foundationsGroup}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = !!flying && flying.to.zone === 'foundation' && flying.to.index === i
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={won && !winCascadeFallbackSuits.has(i) ? undefined : t}
                    isFlyingHere={isFlyingHere}
                    suit={SUITS[i]}
                    highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                    slotRef={(el) => {
                      foundationSlotRefs.current[i] = el
                    }}
                  />
                </DropZone>
              )
            })}
          </View>

          <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteHiddenCount={(flying && flying.to.zone === 'waste' ? flying.count : 0) + cascadeWasteHiddenCount} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id)} stockRef={stockViewRef} wasteRef={wasteViewRef} stockHidden={stockHidden} />
        </View>

        <View style={styles.tableauRow}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Same PATTERN_OVERLAP_GATE claim as attemptDrop above - PileView.tsx (shared, not
              // ours to edit) already ran its own hitTest await before invoking this callback, so
              // this is the earliest point KlondikeScreen gets a look-in; claiming here still closes
              // the gap for every purpose that matters (blocking a subsequent tap/auto-play/
              // stock-draw, and being blocked by one already in the air), since nothing here reads
              // or mutates board state before this point. A rejected claim (already busy) returns
              // false, which PileView's handleDragEnd reads as a failed drop and snaps the ghost
              // back on its own.
              onDrop: (to, count, anchorCardId) => {
                if (flightBusyRef.current) return false // see PATTERN_OVERLAP_GATE
                flightBusyRef.current = true
                flightCompletionsRef.current = 1
                if (!completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)) {
                  settleFlight()
                  return false
                }
                return true
              }
            }
            const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
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
