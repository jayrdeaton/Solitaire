// Canfield solitaire screen: 4 foundations (variable starting rank, wrapping King -> Ace), one
// 4-column tableau with cyclic alternating-color runs (a King may land on an Ace), a 13-card
// reserve (a second, passive single-card-at-a-time source alongside waste), and a draw-3/unlimited
// -recycle stock+waste pair - see rules.ts for the full rules. Architecturally closest to Klondike
// (same imperative checkWin-after-applyMove flow, same tap-to-move/drag/undo/auto-play shape) -
// see this file's own comments for exactly where Canfield's rules force real deviations.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { CANFIELD_RULES } from '@/constants/gameRules'
import { isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { CanfieldSettingsSection } from './CanfieldSettingsSection'
import { buildCanfieldDealSequence } from './dealSequence'
import { CanfieldState, createCanfieldController, findSafeAutoPlay, isDescendingAltColorCyclic } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 460
// LAYOUT DECISION: the top row needs 7 card-slots (4 foundations + 1 reserve + stock/waste), but
// the tableau below is only 4 columns wide - the opposite of every other game here, where the top
// row and tableau are similar widths. Sizing cardWidth off the tableau's own 4 columns (Klondike's
// approach - see its own TABLEAU_COLUMNS-based cardLayoutForRow call) would let the top row's 7
// slots overflow the screen on anything narrower than a very wide window. Instead, cardWidth is
// sized off this TOP row's own 7 slots - the widest row on screen - the same "widest row sets the
// scale, narrower rows center underneath" idiom Pyramid already uses (its 7-card triangle base
// sets cardWidth via its own TRIANGLE_WIDTH_UNITS, while the narrower stock/discard control row
// centers under it - see PyramidScreen.tsx). The 4-column tableau then renders smaller and centers
// underneath the top row (see `board`'s alignItems: 'center' below).
//
// The `gap` returned alongside cardWidth by the one cardLayoutForRow call below is deliberately
// reused as EVERY real gap inside the top row (its own inter-group `gap`, foundationsGroup's
// internal `gap`, and StockWaste's own internal CARD_GAP_MIN gap all stay equal), which makes this
// reservation pixel-exact rather than a rough guess: 4 foundations + 1 reserve + 2 (stock/waste) =
// 7 card-widths, with 6 gaps between them (2 between the 3 groups + 3 inside foundationsGroup + 1
// inside StockWaste) - exactly matching cardLayoutForRow's own `7*cardWidth + gap*6` reservation
// formula, so the top row's real rendered width never exceeds (or falls meaningfully short of)
// what was reserved for it. The narrower 4-column tableau row underneath breathes by that same
// `gap` too (see TABLEAU_GAP's old declaration, now gone - it and TOP_ROW_GAP have collapsed into
// this one shared runtime value), so the two rows always match even once cards hit CARD_WIDTH_MAX
// and cardLayoutForRow starts growing the gap past CARD_GAP_MIN.
const TOP_ROW_UNITS = 7

/** The one card that seeds every foundation's starting rank - rules.ts's newGame cuts it from the
 * very top of the deck and pushes it onto its own suit's foundation pile before anything else, so
 * it's the only non-empty (length-1) foundation pile immediately after a fresh deal. Needed here
 * (not just inside rules.ts) to rebuild the same 6-step sequence buildCanfieldDealSequence expects
 * - both for the initial dealHiddenIds set (startNewGame) and the real flight (runDeal). */
function foundationStarter(s: CanfieldState): Card | undefined {
  return s.foundation.find((pile) => pile.length > 0)?.[0]
}

/** The reserve pile's own single-slot display - a second, passive single-card source alongside
 * waste (see rules.ts's own doc comment on the reserve field). Mirrors Klondike's own waste-top
 * card exactly: a loose DraggableCard inside a DropZone, no PileView/multi-card drag config needed
 * (the reserve only ever moves 1 card at a time, like waste) - not FoundationCell/FreecellCell's
 * shape, even though the "hide while flying, show a frozen copy of whatever was on top before"
 * need is identical to those two: the reserve is a SOURCE the player drags/taps away from, the
 * same as waste, not a destination slot a move lands into from elsewhere.
 *
 * `dealHidden` is a SEPARATE flag from `isFlyingHere`, deliberately kept out of
 * useFrozenWhileHidden's frozen-overlay branch below: this cell's very first-ever render (state
 * goes from null to the freshly dealt game in one commit - see the `if (!state)` early return
 * above) already has the reserve's top card present AND hidden at once, with no earlier "what was
 * there before" render for useFrozenWhileHidden to have captured - its `frozen` state would
 * initialize to that same incoming card (not an empty slot), so folding `dealHidden` into
 * `isFlyingHere` would show that frozen copy at full opacity behind the real (opacity-0) card,
 * defeating the hide entirely. `isFlyingHere` (real moves onto the reserve, i.e. only ever an
 * undo - see its own doc comment below) is never true on a component's first render, so it has a
 * genuine prior frame for useFrozenWhileHidden to freeze and keeps using that overlay untouched. */
function ReserveCell({ card, isFlyingHere, dealHidden, shakeToken, highlighted, onPress, onDrop }: { card: Card | undefined; isFlyingHere: boolean; dealHidden?: boolean; shakeToken?: number; highlighted?: boolean; onPress: (measure: () => Promise<{ x: number; y: number }>) => void; onDrop: (x: number, y: number) => Promise<boolean> | boolean }) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
  return (
    <View>
      {card ? <DraggableCard card={card} hidden={isFlyingHere || dealHidden} shakeToken={shakeToken} hinted={highlighted} emptyFallback={<EmptySlot />} onPress={onPress} onDrop={onDrop} testID='reserve-top' /> : <EmptySlot testID='reserve-top' hinted={highlighted} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <EmptySlot />}
        </View>
      )}
    </View>
  )
}

export default withGameProviders(CanfieldScreenInner)

function CanfieldScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The draw count the in-progress deal was actually dealt with - deliberately not re-derived from
  // `settings` every render, same reasoning KlondikeScreen's own `klondikeDraw` state has: a
  // mid-game settings change must never mutate the current deal's own rules.
  const controllerRef = useRef(createCanfieldController(settings.canfieldDraw))
  const [canfieldDraw, setCanfieldDraw] = useState<1 | 3>(settings.canfieldDraw)
  const [state, setState] = useState<CanfieldState | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry<CanfieldState>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: CanfieldState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset alongside
  // the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TOP_ROW_UNITS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // controllerRef.current, not a plain const - Canfield's draw count is now a per-deal config (see
  // controllerRef's own doc comment above), the same reasoning KlondikeScreen's own controllerRef
  // exists for.
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(controllerRef.current, 'canfield', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real top card has been hidden (won-gated, see the foundation row below), at which
   * point that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), drawing from the stock (handleDrawStock), undo, and auto-play (fireAutoMove) -
   * only one is ever in flight at a time, since all four drive the same single-flight ghost.
   * `viaStock` measures via stockViewRef (a plain View, not per-card) instead of CardRegistry -
   * only undoing a stock draw flies back toward the stock; every other destination (including the
   * reserve, on an undo) is a real per-card-registered pile. `fast` marks a fireAutoMove-triggered
   * flight. `gen` is the dealTokenRef value at the moment this flight was queued - see
   * KlondikeScreen's identical field for the full race-guard reasoning. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; fast?: boolean; gen: number } | null>(null)
  /** A draw-3 stock draw awaiting its post-commit measurement + deal.start(), analogous to
   * pendingFlightRef above but for the multi-card deal-style flight - drawnCards is oldest-first,
   * ending with the new top/frontmost card. `gen` guards the same New-Game-mid-flight race
   * pendingFlightRef's does, above. */
  const pendingDealDrawRef = useRef<{ topCardId: string; drawnCards: Card[]; gen: number } | null>(null)
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  // Mirrors `state` synchronously so fireAutoMove - which has an await gap before it applies its
  // move, unlike every other mutator here - can tell if some other action already changed state
  // underneath it and bail instead of applying against a stale snapshot.
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
    controllerRef.current = createCanfieldController(settings.canfieldDraw)
    setCanfieldDraw(settings.canfieldDraw)
    const s = controllerRef.current.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const starter = foundationStarter(s)
    const sequence = starter ? buildCanfieldDealSequence(starter, s.tableau, s.reserve) : []
    setDealHiddenIds(new Set(sequence.map((step) => step.cardId)))
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal). Also restores the saved undo stack (falling back to empty for an older save written
  // before undo persistence existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<CanfieldState>) {
    ++dealTokenRef.current
    const draw = saved.config === 1 || saved.config === 3 ? saved.config : settings.canfieldDraw
    controllerRef.current = createCanfieldController(draw)
    setCanfieldDraw(draw)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
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
    if (session.moves > 0 && !won) recordDealAbandoned('canfield')
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Unlike Klondike's runDeal, the
  // flying cards aren't forced face-down: the foundation starter, each tableau column's single
  // starting card, and the reserve's own top card are genuinely dealt face up in real Canfield
  // (rules.ts's newGame already sets faceUp: true on all three) - same reasoning FreeCellScreen's
  // own runDeal documents for its own all-face-up deal. The 34-card stock is deliberately excluded
  // from the sequence entirely (see dealSequence.ts) and just appears as a pile, the same treatment
  // every other game's own leftover stock gets. The reserve's other 12 (face-down) cards DO fly too
  // - own step, own delayMs, own landed callback, same as any other dealt card - but since
  // ReserveCell never registers a view for them (it only ever renders the pile's top card), there's
  // nothing for CardRegistry to measure a destination from: ownDestinations below only asks it for
  // the steps that have a real view (reserveTop, foundation, tableau), and every hidden reserve
  // card's entry reuses the reserve top's own measured destination instead - they land stacked
  // exactly where it does, a beat before it arrives on top of them, matching how a real dealer lays
  // a pile down before flipping its top card. This also means dealHiddenIds correctly covers the
  // whole 13-card pile from the start (see dealSequence.ts's reserveTop doc comment), not just its
  // visible top card, so a future depth visual for the reserve pile can't skip past this animation.
  async function runDeal(s: CanfieldState, token: number) {
    const starter = foundationStarter(s)
    const sequence = starter ? buildCanfieldDealSequence(starter, s.tableau, s.reserve) : []
    const [origin, ownDestinations] = await Promise.all([measureView(stockViewRef.current), Promise.all(sequence.map((step) => (step.zone !== 'reserve' || step.reserveTop ? ghost.cardRegistry.measure(step.cardId) : Promise.resolve(null))))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      return
    }

    const reserveTopIndex = sequence.findIndex((step) => step.reserveTop)
    const reserveTopDest = reserveTopIndex >= 0 ? ownDestinations[reserveTopIndex] : null

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = ownDestinations[i] ?? (step.zone === 'reserve' && !step.reserveTop ? reserveTopDest : null)
      if (!dest) return
      entries.push({
        cardId: step.cardId,
        card: step.card,
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

  // Foundation piles are guaranteed full (13 cards each, starting at foundationRank and wrapping
  // all the way back around through a full cycle) the instant isWon() is true - measures each
  // pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), not the top card
  // via CardRegistry, since the real top card is hidden (and therefore unregistered) the instant
  // `won` flips true, in the same commit this effect reacts to. Chains that whole pile top-first
  // down to bottom-last (foundation arrays are built bottom-up, foundationRank's card pushed
  // first, so reversing gives the right order - true regardless of which rank a given pile
  // actually started/ended at). Same dealTokenRef guard as every other async measurement here.
  async function runWinCascade(s: CanfieldState, gen: number) {
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
          setFlying((f) => (f && f.to.zone === 'waste' ? { ...f, count: Math.max(0, f.count - 1) } : f))
        },
        () => setFlying(null)
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Drives the auto-play-to-foundation cascade: re-checks maybeAutoPlay every time the board
  // settles with nothing else animating. `session.moves === 0` guards against firing on a
  // freshly dealt (or resumed-but-untouched) board before the player has made a single real move
  // - auto-played moves are always `silent` and never bump session.moves (see applyMove below),
  // so this can only ever be satisfied by a genuine tap/drag/stock-draw, not by the cascade
  // re-triggering itself.
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
  // the instant the player actually backs out.
  useEffect(() => {
    loadGameInProgress<CanfieldState>('canfield').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('canfield')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin above just cleared it. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), so a
  // save made at the last real move is never stale even once the player just sits looking at the
  // board afterward - resuming always recomputes the exact right value instead of depending on
  // whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('canfield', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: canfieldDraw })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, canfieldDraw, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('canfield', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: canfieldDraw })
  })

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
    recordHintUsed('canfield')
  }

  function pushUndo(prev: CanfieldState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse - see KlondikeScreen's identical
  // function for the full reasoning. Canfield's stock draw behaves exactly like Klondike's draw-3
  // (fixed at 3, unlimited recycling - rules.ts's DRAW_COUNT), so the multi-card-draw-undo branch
  // below applies here the same way it does there.
  async function handleUndo() {
    if (undoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
    justUndidRef.current = true
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
    // independently, staggered newest-first.
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
  // auto-played card isn't a player decision, so it skips the undo stack entirely and doesn't
  // count toward the moves/score the player is judged on.
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
  // the anchor card id for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean; fast?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false
    setFlying({ to, count })
    pendingFlightRef.current = { cardId: anchorCardId, fast: opts?.fast, gen: dealTokenRef.current }
    return true
  }

  // Auto-play-to-foundation: see engine/autoFoundation.ts for the two mechanisms this composes.
  //
  // Mechanism B (isFullyAutoCompletable/nextAutoCompleteMove) is reused as-is from the SHARED
  // engine/autoFoundation.ts: both functions operate purely through the generic GameController
  // interface (they call controller.tryMove themselves, never touching raw rank comparisons), so
  // Canfield's own cyclic tryMove generalizes correctly there with zero changes needed.
  //
  // Mechanism A (findSafeAutoPlay) is Canfield's OWN reimplementation, imported from ./rules (NOT
  // engine/autoFoundation.ts) - the shared version hardcodes an Ace-starting, linearly-building
  // foundation via raw rank comparisons (card.rank - 1), which is simply wrong for Canfield's
  // variable-starting-rank, wrapping foundations: it would silently misjudge which cards are safe
  // to auto-play. rules.ts's own findSafeAutoPlay is a cyclic-position-aware reimplementation of
  // the identical idea, scoped to this game only (see its own doc comment there). Note the
  // argument order is reversed from the shared version: rules.ts's findSafeAutoPlay takes
  // (state, accessible), not engine/autoFoundation.ts's (accessible, foundation).
  function maybeAutoPlay() {
    if (!settings.autoMoveToFoundation) return
    if (!state || !controllerRef.current.accessibleCards) return
    const entry = isFullyAutoCompletable(controllerRef.current, state) ? nextAutoCompleteMove(controllerRef.current, state) : findSafeAutoPlay(state, controllerRef.current.accessibleCards(state))
    if (entry) fireAutoMove(entry)
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move. Guard against something else changing state during that gap by
  // snapshotting stateRef before the await and bailing if it no longer matches after.
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
    return runCountFrom(state.tableau[colIndex], indexFromTop, isDescendingAltColorCyclic)
  }

  // Mirrors KlondikeScreen's own draw-3 handleDrawStock exactly (both the >1 deal-style-flight
  // branch and the ===1 single-ghost branch, for when the stock has fewer than 3 cards left) -
  // Canfield's own draw count is settings.canfieldDraw (see controllerRef above), the same
  // per-deal-config shape Klondike's own draw setting already has.
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
      case 'reserve':
        return state.reserve
      case 'waste':
        return state.waste
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination - a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards. Works identically for a reserve-top
  // tap and a waste-top tap (both resolve via resolvePile's 'reserve'/'waste' cases above) - the
  // reserve's own empty-tableau-column priority rule is enforced entirely inside rules.ts's
  // tryMove/autoMoveHint, so this handler never needs to special-case which of the two a card came
  // from.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !controllerRef.current.autoMoveHint) return
    const move = controllerRef.current.autoMoveHint(state, ref, cardId)
    if (!move) {
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
  // Fixed draw-3, so the waste always fans up to the last 3 drawn cards, same as Klondike's own
  // draw-3 mode. wasteBehind excludes wasteTop itself and is ordered nearest-to-top first (see
  // StockWaste), so the slice below (oldest-visible -> wasteTop) is reversed.
  const visibleWasteCount = Math.min(3, state.waste.length)
  const wasteBehind = state.waste.slice(Math.max(0, state.waste.length - visibleWasteCount), state.waste.length - 1).reverse()
  const reserveTop = top(state.reserve)
  // The reserve can only ever be a flight DESTINATION on an undo (tryMove itself never sends a
  // card back onto the reserve - see rules.ts) - mirrors the foundation/waste/tableau `isFlyingHere`
  // checks below exactly.
  const reserveFlyingHere = !!flying && flying.to.zone === 'reserve'
  // The reserve's own top (13th) card is part of the initial deal sequence now (see
  // dealSequence.ts) - kept as its own separate flag rather than folded into reserveFlyingHere,
  // since ReserveCell needs to tell the two hidden-reasons apart (see its own doc comment).
  const reserveDealHidden = !!reserveTop && dealHiddenIds.has(reserveTop.id)

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='Canfield' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} settingsContent={<CanfieldSettingsSection />} rules={CANFIELD_RULES}>
        <View style={styles.board}>
          <View style={[styles.topRow, { gap }]}>
            <View style={[styles.foundationsGroup, { gap }]}>
              {state.foundation.map((pile, i) => {
                const t = top(pile)
                // The foundation-starter card is part of the initial deal sequence too (see
                // dealSequence.ts's 'foundation' step) - widen the regular flying.to check with the
                // same dealHiddenIds membership the reserve's own top card uses, so the starter stays
                // hidden until its own deal flight lands instead of showing at full opacity from the
                // very first frame of a fresh deal.
                const isFlyingHere = (!!flying && flying.to.zone === 'foundation' && flying.to.index === i) || (!!t && dealHiddenIds.has(t.id))
                return (
                  <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                    <FoundationCell
                      card={won ? undefined : t}
                      isFlyingHere={isFlyingHere}
                      suit={SUITS[i]}
                      rank={state.foundationRank}
                      highlighted={hintCountFor(activeHint, { zone: 'foundation', index: i }) > 0}
                      slotRef={(el) => {
                        foundationSlotRefs.current[i] = el
                      }}
                    />
                  </DropZone>
                )
              })}
            </View>

            <DropZone registry={dropZones} pileRef={{ zone: 'reserve', index: 0 }} style={[styles.reserveSlot, { width: cardWidth }]}>
              <ReserveCell card={reserveTop} isFlyingHere={reserveFlyingHere} dealHidden={reserveDealHidden} shakeToken={reserveTop && shake?.cardId === reserveTop.id ? shake.token : undefined} highlighted={hintCountFor(activeHint, { zone: 'reserve', index: 0 }) > 0} onPress={(measure) => handleCardTap({ zone: 'reserve', index: 0 }, reserveTop!.id, measure)} onDrop={(x, y) => attemptDrop({ zone: 'reserve', index: 0 }, 1, x, y, reserveTop!.id)} />
            </DropZone>

            <StockWaste dropZones={dropZones} stockTopCard={top(state.stock)} wasteTop={wasteTop} wasteBehind={wasteBehind} wasteHiddenCount={flying && flying.to.zone === 'waste' ? flying.count : 0} wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined} wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0} stockHinted={activeHint?.kind === 'drawStock'} cardWidth={cardWidth} gap={gap} onDrawStock={handleDrawStock} onWastePress={(measure) => handleCardTap({ zone: 'waste', index: 0 }, wasteTop!.id, measure)} onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, 1, x, y, wasteTop!.id)} stockRef={stockViewRef} />
          </View>

          <View style={[styles.tableauRow, { gap }]}>
            {state.tableau.map((col, colIndex) => {
              const dragConfig: PileDragConfig = {
                registry: dropZones,
                getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
                onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId)
              }
              const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0
              return (
                <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                  {/* dimUnplayable: unlike Klondike (genuine face-down burial reads as unavailable
                  via the card back alone), Canfield's tableau - like FreeCell's - is always
                  entirely face-up (every card that ever lands here, from waste/reserve/another
                  tableau run, is already face-up per rules.ts), so a face-up card that isn't
                  currently the head of a movable run needs its own dimmed cue to read as
                  temporarily stuck rather than pickable. */}
                  <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
                </DropZone>
              )
            })}
          </View>
        </View>
      </GameChrome>
      {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
      (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
      banner comes last of all three so it's the one thing guaranteed to sit on top of the
      animation, not buried under it. */}
      {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
    </CardSizeProvider>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    // Centers the narrower 4-column tableauRow underneath the wider 7-slot topRow - see this
    // file's own LAYOUT DECISION comment near TOP_ROW_UNITS above.
    board: {
      alignItems: 'center'
    },
    container: {
      backgroundColor: colors.tableFelt,
      flex: 1,
      padding: 12
    },
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
    },
    loadingText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginTop: 40,
      textAlign: 'center'
    },
    reserveSlot: {},
    tableauColumn: {},
    tableauRow: {
      flexDirection: 'row',
      paddingBottom: 20
    },
    topRow: {
      flexDirection: 'row',
      marginBottom: 16
    }
  })
}
