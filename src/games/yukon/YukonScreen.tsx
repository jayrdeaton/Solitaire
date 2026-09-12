import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { computeContentBounds } from '@tastic/core'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { YUKON_RULES } from '@/constants/gameRules'
import { findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { alwaysValidRun, runCountFrom, top } from '@/engine/pile'
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

import { buildYukonDealSequence } from './dealSequence'
import { createYukonController, YukonState } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 420
const TABLEAU_COLUMNS = 7
// Yukon has no stock pile of its own to visually deal from (rules.ts's newGame deals straight into
// the tableau) and no freecells or other permanent zone to repurpose as one either (unlike
// FreeCell, which borrows its far-right freecell). This standalone slot exists only for the deal -
// shown near the foundations while dealing (see the top row below), gone from the layout entirely
// once it's not. Never a real card - just needs to be Card-shaped, since a face-down PlayingCard
// never reads rank/suit.
const DECK_PLACEHOLDER_CARD: Card = { id: 'yukon-deck-origin', suit: 'spades', rank: 1, faceUp: false }

// Widens the default MoveInfo|null undo-entry shape (see undoTypes.ts) to additionally carry any
// silently auto-played foundation moves that happened as a direct consequence of `primary` (see
// maybeAutoPlay/applyMove's `opts.silent` branch below) - undoing `primary` must also reverse-
// animate every one of these, or they'd just silently snap back along with the rest of the board.
// Every real Yukon move (unlike Klondike's stock draws) has a genuine card to fly, so - mirroring
// this file's pre-existing non-nullable UndoEntry<YukonState, MoveInfo> choice - `primary` stays
// non-nullable too; only applyMove's own non-silent branch ever calls pushUndo, and it always has
// a real MoveInfo in hand.
interface YukonUndoMove {
  primary: MoveInfo
  cascaded: MoveInfo[]
}

// One returning card, resolved from the pre-revert state (see groupCascadedByFoundation) so the
// deferred cascade-undo effect has the real Card to render on its ghost without needing to re-look
// it up later (once state has reverted, this card may no longer be on that foundation pile at all).
interface CascadeReturnCard {
  anchorCardId: string
  card: Card
}

interface CascadeUndoGroup {
  foundationIndex: number
  cards: CascadeReturnCard[]
}

// Every cascaded move is a single-card tableau->foundation auto-play (the only kind
// engine/autoFoundation.ts ever produces - see maybeAutoPlay) - grouped by which foundation pile
// each landed on, since that's the one shared, content-independent origin (measureView on that
// pile's own slot container) every returning card in the group flies FROM; the cards themselves
// have no CardRegistry entry once buried under a later foundation arrival. `s` must be the state
// from BEFORE the undo reverts it - each move's card is still findable on its foundation pile
// there, matching how handleUndo's own primary-flight measurement above also reads pre-revert
// state.
function groupCascadedByFoundation(s: YukonState, moves: MoveInfo[]): CascadeUndoGroup[] {
  const map = new Map<number, CascadeReturnCard[]>()
  moves.forEach((m) => {
    if (m.to.zone !== 'foundation') return
    const card = s.foundation[m.to.index]?.find((c) => c.id === m.anchorCardId)
    if (!card) return
    const list = map.get(m.to.index) ?? []
    list.push({ anchorCardId: m.anchorCardId, card })
    map.set(m.to.index, list)
  })
  return Array.from(map.entries()).map(([foundationIndex, cards]) => ({ foundationIndex, cards }))
}

export default withGameProviders(YukonScreenInner)

function YukonScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // No draw-count/suit-count-style config to lock at deal time (unlike Klondike/Spider) - a single
  // stable controller for the lifetime of this screen.
  const controller = useMemo(() => createYukonController(), [])
  const [state, setState] = useState<YukonState | null>(null)
  // Every Yukon move (tableau->tableau, tableau->foundation) has a real origin/destination to fly -
  // no stock-draw-shaped move that would need a null MoveInfo, unlike Klondike's undo stack. Mirrors
  // FreeCell's own non-nullable UndoEntry<FreeCellState, MoveInfo>.
  const [undoStack, setUndoStack] = useState<UndoEntry<YukonState, YukonUndoMove>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: YukonState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset alongside
  // the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const { width: winWidth } = useWindowDimensions()
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)
  const { cardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null)
  const deal = useDealAnimator()
  const dealOriginRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  // Separate from dealHiddenIds (which tracks each tableau card's own landing) - the deck
  // placeholder should read as exhausted the moment the LAST card actually leaves it, not once
  // every card has finished landing. See runDeal's setTimeout for the timing.
  const [deckVisible, setDeckVisible] = useState(false)
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(controller, 'yukon', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real King has been hidden (won-gated, see the foundation row below), at which point
   * that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  /** A flight awaiting its post-commit measurement + ghost.flyTo, shared by tap-to-move
   * (handleCardTap), undo, and auto-play (fireAutoMove) - only one is ever in flight at a time.
   * `fast` marks a fireAutoMove-triggered flight, so the effect below passes it on to ghost.flyTo
   * for the quicker auto-play-to-foundation timing. `gen` is the `dealTokenRef` value at the moment
   * this flight was queued - re-checked once the async measurement below resolves, so a flight
   * queued against a game that's since been replaced by "New Game" doesn't measure/land against the
   * new deal's DOM (card ids are shuffle-independent and reused across deals - see deck.ts). */
  const pendingFlightRef = useRef<{ cardId: string; fast?: boolean; gen: number } | null>(null)
  /** A cascade-undo return flight awaiting its post-commit per-card measurement, mirroring
   * pendingFlightRef's own deferral reasoning - see the [state]-effect below and
   * groupCascadedByFoundation's doc comment. Independent of pendingFlightRef: the primary card's
   * flight and any cascaded cards' return flights animate concurrently (separate providers -
   * DragGhostLayer for the primary, DealLayer's N-independent ghosts for the cascade), not
   * sequentially. */
  const pendingCascadeUndoRef = useRef<{ groups: CascadeUndoGroup[]; gen: number } | null>(null)
  // Which foundation piles currently have a card mid-flight back into them via cascade undo -
  // FoundationCell's own isFlyingHere (see the foundation row below) ORs this together with the
  // existing single-slot `flying` state, since a cascade-undo can be returning cards to MULTIPLE
  // foundations at once while `flying` only ever tracks one destination.
  const [cascadeFlyingFoundations, setCascadeFlyingFoundations] = useState<Set<number>>(new Set())
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)
  // Mirrors `state` so fireAutoMove - which has an await gap before it applies its move, unlike
  // every other mutator here - can tell if some other action already changed state underneath it
  // and bail instead of applying against a stale snapshot. Synced from a dedicated effect rather
  // than a direct render-time write (Klondike/FreeCell do write it inline in the render body, but
  // the same line here trips react-hooks/refs - the effect form is both lint-clean and the
  // more conventional way to mirror a prop/state value into a ref anyway) - fireAutoMove only ever
  // reads `.current` from its own later async closure, well after this effect has committed.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  // Set right after handleUndo's guard, consumed (and cleared) by the auto-play watcher effect
  // below - suppresses exactly one auto-play check after an undo, so undo doesn't immediately get
  // replayed by the very mechanism it just reverted.
  const justUndidRef = useRef(false)
  // Guards handleUndo against being called again before its own previous invocation has fully
  // settled (visually, not just in state) - see handleUndo below for why an overlapping call would
  // otherwise desync the undo stack or clobber the shared single-flight ghost/deal animation.
  const undoBusyRef = useRef(false)
  // Separate from undoBusyRef (which tracks the PRIMARY card's own flight, exactly as before this
  // fix): guards handleUndo against being re-entered while a cascade-undo return flight is still
  // using the shared `deal` animator (see pendingCascadeUndoRef's effect below) - deal.start() only
  // ever supports one active batch of ghosts at a time, and the initial deal itself also shares
  // this same `deal` instance, so a second handleUndo call mid-cascade-flight would clobber it.
  const cascadeUndoBusyRef = useRef(false)

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = controller.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    setDeckVisible(true)
    scheduleDeal(myToken)
    setState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal) and no deck placeholder (deckVisible stays false - nothing is dealing). Also restores
  // the saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<YukonState, UndoEntry<YukonState, YukonUndoMove>>) {
    ++dealTokenRef.current
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    undoBusyRef.current = false
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setDeckVisible(false)
    setState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('yukon')
    startNewGame()
  }

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Origin is the standalone deck
  // placeholder (see dealOriginRef/DECK_PLACEHOLDER_CARD above), measured only once it's actually
  // mounted (deckVisible is flipped true synchronously in startNewGame, in the same commit as the
  // state that mounts this deal - see useDeferredDeal's own doc comment for why the destination
  // measurements below must also wait for that same commit's registration effects to run).
  async function runDeal(s: YukonState, token: number) {
    const sequence = buildYukonDealSequence(s.tableau)
    const [origin, destinations] = await Promise.all([measureView(dealOriginRef.current), Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      return
    }

    const entries: DealCardSpec[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) return
      entries.push({
        cardId: step.cardId,
        // Phase 1 (the Klondike-shaped base triangle - rowIndex <= colIndex, see rules.ts's
        // newGame) flies face-down regardless of step.card's real faceUp, same reasoning as
        // Klondike's own runDeal: a real dealer lays these down blind and only turns each column's
        // one true face-up card over after it's placed, not while it's still sliding. Phase 2's 24
        // extra cards (rowIndex > colIndex) are dealt face-up from the start in real Yukon - same
        // as FreeCell's whole deal - so those fly showing their real (already-true) faceUp as-is.
        card: step.rowIndex <= step.colIndex ? { ...step.card, faceUp: false } : step.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * DEAL_STAGGER_MS
      })
    })
    if (entries.length === 0) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      return
    }

    // The deck should look exhausted the instant its last card actually leaves it (starts its own
    // delayed flight), not once every card has finished landing - those are DEAL_SPRING.duration
    // apart, and waiting for the latter would show the placeholder still sitting there with its
    // last card already visibly flying away. Mirrors that card's own delayMs, guarded by the same
    // dealTokenRef check every other async step here uses.
    const lastDelayMs = Math.max(...entries.map((entry) => entry.delayMs))
    setTimeout(() => {
      if (dealTokenRef.current !== token) return
      setDeckVisible(false)
    }, lastDelayMs)

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
      () => {
        // Safety net for a tap-to-skip mid-deal: every card lands at once, including any whose
        // own delay hadn't elapsed yet, so the setTimeout above may not have fired yet - this
        // guarantees the deck disappears exactly when the deal actually finishes either way.
        if (dealTokenRef.current !== token) return
        setDeckVisible(false)
      }
    )
  }

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef), not
  // the King via CardRegistry, since the real King is hidden (and therefore unregistered) the
  // instant `won` flips true, in the same commit this effect reacts to. Chains that whole pile
  // King-first/head down to Ace-last/tail (foundation arrays are built bottom-up, Ace pushed first,
  // so reversing gives the right order). Same dealTokenRef guard as every other async measurement
  // here, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: YukonState, gen: number) {
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
  // setState in applyMove would find the still-mounted SOURCE card (the destination card's own
  // registration effect hasn't run yet), so the ghost would "fly" a near-zero distance back to
  // roughly where it started - indistinguishable from a snap. Deferring to a [state]-keyed effect
  // guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    const pending = pendingFlightRef.current
    if (!pending || !state) return
    pendingFlightRef.current = null
    ;(async () => {
      const landed = await ghost.cardRegistry.measure(pending.cardId)
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

  // Reverse-animates any auto-played cascade that rode along with the move currently being undone
  // (see applyMove's opts.silent branch / groupCascadedByFoundation above) - runs independently of,
  // and concurrently with, the primary flight's own pendingFlightRef effect just above (separate
  // providers/state, so both animating at once is correct - "everything flies back together").
  // Same measure-after-commit reasoning as every other deferred effect in this file: a cascaded
  // card's own CardRegistry entry only exists once its tableau column's registration effect has
  // actually run for the just-reverted state, which this [state]-keyed effect waits for.
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    const allCardIds = pending.groups.flatMap((g) => g.cards.map((c) => c.anchorCardId))
    const foundationIndices = pending.groups.map((g) => g.foundationIndex)
    // Un-hides whichever of the returning cards/foundations are named (all of them, on abandon or
    // failure) rather than leaving any stuck invisible/foundation-frozen forever - mirrors runDeal's
    // own top-level fallback for the same failure mode.
    const clearFlags = (cardIds: string[], indices: number[]) => {
      if (cardIds.length > 0) {
        setDealHiddenIds((ids) => {
          const next = new Set(ids)
          cardIds.forEach((id) => next.delete(id))
          return next
        })
      }
      if (indices.length > 0) {
        setCascadeFlyingFoundations((prev) => {
          const next = new Set(prev)
          indices.forEach((i) => next.delete(i))
          return next
        })
      }
    }
    ;(async () => {
      const origins = await Promise.all(pending.groups.map((g) => measureView(foundationSlotRefs.current[g.foundationIndex])))
      // Same "New Game tapped mid-measurement" guard as every other async measurement here - card
      // ids are shuffle-independent and reused across deals (see deck.ts), so a stale measurement
      // would otherwise land against the NEW deal's unrelated cards.
      if (dealTokenRef.current !== pending.gen) {
        clearFlags(allCardIds, foundationIndices)
        cascadeUndoBusyRef.current = false
        return
      }

      const resolved = await Promise.all(
        pending.groups.flatMap((group, gi) => {
          const origin = origins[gi]
          return group.cards.map(async (c): Promise<DealCardSpec | null> => {
            if (!origin) return null
            const dest = await ghost.cardRegistry.measure(c.anchorCardId)
            if (!dest) return null
            return { cardId: c.anchorCardId, card: c.card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: 0 }
          })
        })
      )
      if (dealTokenRef.current !== pending.gen) {
        clearFlags(allCardIds, foundationIndices)
        cascadeUndoBusyRef.current = false
        return
      }

      const entries = resolved.filter((e): e is DealCardSpec => e !== null)
      const failedIds = allCardIds.filter((id) => !entries.some((e) => e.cardId === id))
      if (failedIds.length > 0) clearFlags(failedIds, [])

      if (entries.length === 0) {
        clearFlags([], foundationIndices)
        cascadeUndoBusyRef.current = false
        return
      }

      deal.start(
        entries,
        cardWidth,
        (cardId) => {
          if (dealTokenRef.current !== pending.gen) return
          setDealHiddenIds((ids) => {
            if (!ids.has(cardId)) return ids
            const next = new Set(ids)
            next.delete(cardId)
            return next
          })
        },
        () => {
          if (dealTokenRef.current !== pending.gen) return
          clearFlags([], foundationIndices)
          cascadeUndoBusyRef.current = false
        }
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

  // Auto-play-to-foundation: see engine/autoFoundation.ts for the two mechanisms this composes.
  // Declared here, just above the watcher effect that calls it, rather than lower in the component
  // (Klondike/FreeCell's equivalent function is declared further down and still lints clean there,
  // but the same forward-reference shape trips react-hooks/immutability in this file specifically -
  // this ordering resolves it cleanly with no behavior change, since function declarations hoist
  // either way). Mechanism B (a guaranteed full clear) takes priority and, once true, ignores
  // mechanism A's caution entirely since there's no longer any player decision left to protect.
  function maybeAutoPlay() {
    if (!settings.autoMoveToFoundation) return
    if (!state || !controller.accessibleCards) return
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
    // Same false-positive opaque-hook-value flag as handleUndo's identical block above - see its
    // comment.
    /* eslint-disable-next-line react-hooks/immutability */
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

  // Drives the auto-play-to-foundation cascade: re-checks maybeAutoPlay every time the board
  // settles with nothing else animating. `flying !== null` guards against overlapping the
  // single-ghost system (an auto-play's own landing sets it back to null, which re-triggers this
  // effect - the cascade is self-sustaining with no explicit recursion); `dealHiddenIds.size > 0`
  // guards against firing mid-deal, since the deal animation never touches `flying` at all.
  // `session.moves === 0` guards against firing on a freshly dealt (or resumed-but-untouched)
  // board before the player has made a single real move - auto-played moves are always `silent`
  // and never bump session.moves (see applyMove below), so this can only ever be satisfied by a
  // genuine tap/drag, not by the cascade re-triggering itself.
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
    loadGameInProgress<YukonState, UndoEntry<YukonState, YukonUndoMove>>('yukon').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('yukon')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin below just cleared it. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), so a
  // save made at the last real move is never stale even once the player just sits looking at the
  // board afterward - resuming always recomputes the exact right value instead of depending on
  // whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won) {
      saveGameInProgress('yukon', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('yukon', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(controller, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('yukon')
  }

  function pushUndo(prev: YukonState, move: YukonUndoMove) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  async function handleUndo() {
    if (undoBusyRef.current || cascadeUndoBusyRef.current || flying !== null || undoStack.length === 0 || !state) return
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
    const { primary, cascaded } = move

    const sourcePile = resolvePile(primary.to)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - primary.count) : []
    const offsetStep = primary.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(primary.anchorCardId) : null
    // Resolved against the still-current (pre-revert) `state`, same reasoning as `origin` above -
    // each cascaded card is still findable on its real foundation pile right now, whereas after
    // the revert below it (may) no longer be there at all.
    const cascadeGroups = groupCascadedByFoundation(state, cascaded)

    setUndoStack((stack) => stack.slice(0, -1))

    if (cascadeGroups.length > 0) {
      cascadeUndoBusyRef.current = true
      // Hidden BEFORE setState(prevState) below, in the same commit - React batches same-tick
      // setState calls, so this avoids a frame where the restored cards flash fully visible before
      // their ghosts arrive to cover them (same reasoning startNewGame's own setDealHiddenIds
      // relies on for the initial deal).
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        cascadeGroups.forEach((g) => g.cards.forEach((c) => next.add(c.anchorCardId)))
        return next
      })
      setCascadeFlyingFoundations((prev) => {
        const next = new Set(prev)
        cascadeGroups.forEach((g) => next.add(g.foundationIndex))
        return next
      })
    }

    if (origin) {
      // react-hooks/immutability treats `ghost` (from useDragGhost(), a custom hook) as an opaque
      // value - it can't see that originX/originY/dx/dy are Reanimated SharedValues, mutable by
      // design, the same way it can't for the identical pattern in
      // PileView.tsx/DraggableCard.tsx's own worklets (see DragGhostLayer.tsx for the full
      // explanation) or SpiderScreen.tsx's own identical handleUndo.
      /* eslint-disable-next-line react-hooks/immutability */
      ghost.originX.value = origin.x
      ghost.originY.value = origin.y
      ghost.dx.value = 0
      ghost.dy.value = 0
      playCardSound()
      hapticCard()
      ghost.show({ cards: movingCards, offsetStep, cardWidth })
      setFlying({ to: primary.from, count: primary.count })
      setState(prevState)
      pendingFlightRef.current = { cardId: primary.anchorCardId, gen: dealTokenRef.current }
    } else {
      setState(prevState)
      undoBusyRef.current = false
    }

    if (cascadeGroups.length > 0) {
      pendingCascadeUndoRef.current = { groups: cascadeGroups, gen: dealTokenRef.current }
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it skips the undo stack entirely (one Undo press
  // reverts the whole triggering move plus any cascade it set off, in one step) and doesn't count
  // toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    if (!state) return false
    const result = controller.tryMove(state, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      if (opts?.silent) {
        // A silently auto-played move (see maybeAutoPlay) isn't its own undo-stack entry - it's
        // folded into the cascade of whichever real move most recently triggered it, so one Undo
        // press reverses the whole chain (and reverse-animates every card in it - see
        // groupCascadedByFoundation/pendingCascadeUndoRef's effect) in one step. Dropped (matching
        // today's behavior) if the stack happens to be empty - shouldn't happen, since a silent
        // move only ever fires as a reaction to a just-applied real move, which always pushes an
        // entry first.
        setUndoStack((stack) => {
          if (stack.length === 0) return stack
          const last = stack[stack.length - 1]
          return [...stack.slice(0, -1), { ...last, move: { ...last.move, cascaded: [...last.move.cascaded, moveInfo] } }]
        })
      } else {
        pushUndo(state, { primary: moveInfo, cascaded: [] })
      }
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

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0
    // Unlike Klondike/FreeCell (isDescendingAltColor) - Yukon has no run-validity requirement at
    // all: any face-up card, plus everything stacked above it, is always a legal group to move
    // together (see engine/pile.ts's alwaysValidRun).
    return runCountFrom(state.tableau[colIndex], indexFromTop, alwaysValidRun)
  }

  function resolvePile(ref: PileRef): Card[] | null {
    if (!state) return null
    switch (ref.zone) {
      case 'tableau':
        return state.tableau[ref.index] ?? null
      case 'foundation':
        return state.foundation[ref.index] ?? null
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
    if (!state || !controller.autoMoveHint) return
    const move = controller.autoMoveHint(state, ref, cardId)
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

    // Same false-positive opaque-hook-value flag as handleUndo's identical block above - see its
    // comment.
    /* eslint-disable-next-line react-hooks/immutability */
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

  return (
    <CardSizeProvider width={cardWidth}>
      {/* onUndo={handleUndo} closes over handleUndo, which has its own disabled, justified
      react-hooks/immutability false positive (see handleUndo's own `ghost.originX.value=` block
      above) - the compiler flags this element too since it (indirectly) passes that same closure
      down, same as SpiderScreen.tsx's identical GameChrome usage. */}
      {/* eslint-disable-next-line react-hooks/immutability */}
      <GameChrome title='Yukon' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} rules={YUKON_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={styles.foundationsGroup}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = (!!flying && flying.to.zone === 'foundation' && flying.to.index === i) || cascadeFlyingFoundations.has(i)
              return (
                <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                  <FoundationCell
                    card={won ? undefined : t}
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

          {deckVisible && (
            <View ref={dealOriginRef} collapsable={false} style={[styles.dealOriginSlot, { width: cardWidth }]}>
              <PlayingCard card={DECK_PLACEHOLDER_CARD} testID='yukon-deck-origin' />
            </View>
          )}
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
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} />
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
      {won && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={startNewGame} />}
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
    dealOriginSlot: {},
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
      paddingBottom: 20
    },
    topRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16
    }
  })
}
