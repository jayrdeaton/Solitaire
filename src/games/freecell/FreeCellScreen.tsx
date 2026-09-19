import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CardSizeProvider, faceUpFanOffset, type TableColors } from '@tastic/cards'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useFittedCardWidth, useFittedGap, useGameLayout } from '@/components/gameLayout'
import { PileDragConfig, PileView } from '@/components/PileView'
import { EmptySlot, PlayingCard } from '@/components/PlayingCard'
import { fireworksColors } from '@/components/theme'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useGameSession } from '@/components/useGameSession'
import { ChainSpec, useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion'
import { FREECELL_RULES } from '@/constants/gameRules'
import { AutoCompleteStep, findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { isDescendingAltColor, runCountFrom, top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card, SUITS } from '@/engine/types'
import { useCascadeFeedback } from '@/games/shared/cascadeFeedback'
import { FoundationCell } from '@/games/shared/FoundationCell'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useAutoFoundationCascade } from '@/games/shared/useAutoFoundationCascade'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useFoundationWinCheck } from '@/games/shared/useFoundationWinCheck'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { BOARD_MODEL } from './boardModel'
import { buildFreeCellDealSequence } from './dealSequence'
import { countEmptyFreecells, countEmptyTableauColumns, FreeCellController, FreeCellState, maxSupermoveCount } from './rules'

// Floor for useTableauMaxHeight below, not a fixed height anymore - a short screen never fans out
// less generously than this, but a screen with real headroom to spare now gets more of it.
const TABLEAU_MIN_HEIGHT = 460
const TABLEAU_COLUMNS = 8
// FreeCell has no stock pile of its own to visually deal from (rules.ts's newGame deals straight
// into the tableau; freecells start, and stay, empty throughout the deal) - the far-right freecell
// doubles as the deck the deal animation flies out of instead, showing this face-down placeholder
// only while dealing (see the freecells row below). Never a real card - just needs to be
// Card-shaped, since a face-down PlayingCard never reads rank/suit.
const DECK_PLACEHOLDER_CARD: Card = { id: 'freecell-deck-origin', suit: 'spades', rank: 1, faceUp: false }

/** FreeCell's own undo-move shape: `primary` is the player's actual move (kept nullable only for
 * parity with the shared MoveInfo | null shape - every real FreeCell move has a card to fly, so
 * this is never actually null in practice), and `cascaded` collects every SILENT auto-play-to-
 * foundation move (see applyMove's `opts.silent`) that fired as a direct consequence of it, in the
 * order they happened. These used to just be dropped from the undo stack entirely - the state
 * revert still included them, but nothing ever flew them back, so they silently snapped instead
 * (see handleUndo's own doc comment below). */
interface FreeCellUndoMove {
  primary: MoveInfo | null
  cascaded: MoveInfo[]
}

/** A freecell's display - same reasoning as FoundationCell above: the real `card` stays mounted
 * and registered (via DraggableCard, just hidden by opacity) so the flight has something to
 * measure, while a frozen, decorative copy of whatever was there before (always empty, for a
 * freecell - see useFrozenWhileHidden) covers it while flying. */
function FreecellCell({
  card,
  isFlyingHere,
  shakeToken,
  highlighted,
  onPress,
  onDrop
}: {
  card: Card | undefined
  isFlyingHere: boolean
  shakeToken?: number
  /** Highlight this cell as the Hint feature's suggested source/destination - see PlayingCard's
   * own `hinted` prop. */
  highlighted?: boolean
  /** Lazy measure function - see DraggableCard.tsx's onPress doc comment for why (this is a
   * straight pass-through to that same prop). */
  onPress: (measure: () => Promise<{ x: number; y: number }>) => void
  onDrop: (x: number, y: number, flight: DragFlightHandle) => Promise<boolean> | boolean
}) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere)
  return (
    <View>
      {card ? <DraggableCard card={card} hidden={isFlyingHere} shakeToken={shakeToken} hinted={highlighted} emptyFallback={<EmptySlot />} onPress={onPress} onDrop={onDrop} /> : <EmptySlot hinted={highlighted} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <EmptySlot />}
        </View>
      )}
    </View>
  )
}

export default withGameProviders(FreeCellScreenInner)

function FreeCellScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // Owns state/stateRef/commitState, the `flying` array, activeFlightCount, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/auto-play can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`, `commitState`,
  // `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working unchanged.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, activeFlightCountRef, startFlights, settleFlight, undoBusyRef, reset: resetFlightConcurrency } = useFlightConcurrency<FreeCellState>()
  const [undoStack, setUndoStack] = useState<UndoEntry<FreeCellState, FreeCellUndoMove>[]>([])
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: FreeCellState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useFoundationWinCheck's own hintsUsedRef param),
  // to decide whether this win counts toward the "wins without hint" stat/achievement. Reset
  // alongside the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth } = useGameLayout()
  const { cardWidth: widthCardWidth, gap: widthGap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  // The width-derived size in portrait (unchanged); in the wide layout also shrunk until the whole board
  // (top row + the tallest starting column) fits the window's short axis - see boardModel.ts.
  const cardWidth = useFittedCardWidth(widthCardWidth, BOARD_MODEL)
  const gap = useFittedGap(widthGap, widthCardWidth, cardWidth, contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS)
  const tableauMaxHeight = useTableauMaxHeight(cardWidth, TABLEAU_MIN_HEIGHT)
  const ghost = useDragGhost()
  // `fast` marks a fireAutoMove-triggered flight, so the effect below passes it on to the flight's
  // own flyTo for the quicker auto-play-to-foundation timing (see dragSpring.ts's autoPlaySpringFor). `gen`
  // is the `dealTokenRef` value at the moment this flight was queued - re-checked once the async
  // measurement below resolves, so a flight queued against a game that's since been replaced by
  // "New Game" doesn't measure/land against the new deal's DOM (card ids are shuffle-independent
  // and reused across deals - see deck.ts). Mirrors exactly how runDeal below already guards itself
  // with dealTokenRef/pendingDealTokenRef. A list (not a single slot) since concurrent flights (see
  // PATTERN_OVERLAP_GATE) can now genuinely overlap - two entries queued in the same commit would
  // otherwise clobber each other in a single ref slot, permanently stranding whichever one lost.
  // `flyingId` is this entry's own beginFlying-issued id, removed via endFlying once it lands.
  // `isUndo` (Klondike has no equivalent - see its own `viaStock`) no longer distinguishes anything
  // here: the old finishOneUndoAnimation-vs-undoBusyRef split this flag used to pick between has
  // collapsed into a single settleFlight() call for every flight, undo or not.
  const pendingAutoMoveCardIdRef = useRef<{ cardId: string; fast?: boolean; sweep?: boolean; gen: number; flight: DragFlightHandle; flyingId: number }[]>([])
  // A silently auto-played cascade being reversed by handleUndo (see FreeCellUndoMove above) -
  // measured/flown by its own [state]-effect below, independently of and concurrently with the
  // primary move's own flight(s) (pendingAutoMoveCardIdRef's effect). Stays a single nullable slot
  // (not a list, unlike pendingAutoMoveCardIdRef above) - undo itself is still fully serialized (see
  // useFlightConcurrency's undoBusyRef/activeFlightCountRef: handleUndo refuses to start while
  // either is nonzero, and every other flight-starting entry point refuses to start while
  // undoBusyRef is true), so at most one cascade-undo is ever pending at a time, same reasoning
  // Klondike's own pendingCascadeUndoRef documents.
  const pendingCascadeUndoRef = useRef<{ moves: MoveInfo[]; gen: number } | null>(null)
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
  const { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin } = useFoundationWinCheck(FreeCellController, 'freecell', session, dealTokenRef, recordDealWon, hintsUsedRef)
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real King has been hidden (won-gated, see the foundation row below), at which point
   * that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null))
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  const cascadeFeedback = useCascadeFeedback(playCardSound, hapticCard)
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<FreeCellState, UndoEntry<FreeCellState, FreeCellUndoMove>>('freecell').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame()
      setLastActiveGame('freecell')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/autoplay/fresh-deal (all flow through commitState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin below just cleared it. Deliberately NOT also keyed on a ticking
  // elapsed-seconds value the way an earlier version of this effect was: `session.getElapsed()`
  // computes the true current elapsed from wall-clock time on demand (see useGameSession.ts), so a
  // save made at the last real move is never stale even once the player just sits looking at the
  // board afterward - resuming always recomputes the exact right value instead of depending on
  // whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won) saveGameInProgress('freecell', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, undoStack])
  useSaveInProgressBackstop(!!state && !won, () => {
    if (state && !won) saveGameInProgress('freecell', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed() })
  })

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Origin is the far-right
  // freecell's placeholder (see dealOriginRef/DECK_PLACEHOLDER_CARD above) rather than a real
  // stock pile - FreeCell has none. Unlike Klondike's runDeal, the flying card isn't forced
  // face-down: real FreeCell deals every card face up from the start (rules.ts's newGame already
  // sets faceUp: true on the whole deck), so step.card's own faceUp is left as-is.
  async function runDeal(s: FreeCellState, token: number) {
    const sequence = buildFreeCellDealSequence(s.tableau)
    const [origin, destinations] = await Promise.all([measureView(dealOriginRef.current), Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId)))])
    if (dealTokenRef.current !== token) return
    if (!origin) {
      setDealHiddenIds(new Set())
      setDeckVisible(false)
      return
    }

    const entries: DealCardSpec[] = []
    // A card whose destination measurement comes back null (while its siblings in the same batch
    // resolve fine) can't be flown - but it must still be unhidden right away instead of staying
    // in dealHiddenIds forever, which would otherwise soft-lock it out of play permanently (and
    // keep dealHiddenIds.size from ever reaching 0, which also permanently disables the
    // moves===0-gated auto-play effect above). Mirrors the same fallback this file's own
    // runWinCascade/handleUndo use for an equivalent measurement failure.
    const unresolvedIds: string[] = []
    sequence.forEach((step, i) => {
      const dest = destinations[i]
      if (!dest) {
        unresolvedIds.push(step.cardId)
        return
      }
      entries.push({
        cardId: step.cardId,
        card: step.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * DEAL_STAGGER_MS
      })
    })
    if (unresolvedIds.length > 0) {
      setDealHiddenIds((ids) => {
        if (unresolvedIds.every((id) => !ids.has(id))) return ids
        const next = new Set(ids)
        unresolvedIds.forEach((id) => next.delete(id))
        return next
      })
    }
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
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef),
  // not the King via CardRegistry, since the real King is hidden (and therefore unregistered) the
  // instant `won` flips true, in the same commit this effect reacts to. Chains that whole pile
  // King-first/head down to Ace-last/tail (foundation arrays are built bottom-up, Ace pushed
  // first, so reversing gives the right order). Same dealTokenRef guard as every other async
  // measurement here, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: FreeCellState, gen: number) {
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

  // Measuring CardRegistry synchronously right after the commitState in applyMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    if (pendingAutoMoveCardIdRef.current.length === 0 || !state) return
    const pending = pendingAutoMoveCardIdRef.current
    pendingAutoMoveCardIdRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        const landed = await ghost.cardRegistry.measure(p.cardId)
        // A new game can start while the measurement above is in flight (e.g. tapping "New Game"
        // mid auto-play-cascade - see maybeAutoPlay). `landed`, if it resolved at all, would then be
        // measuring an unrelated card in the NEW deal (ids are shuffle-independent and reused across
        // deals - see deck.ts), so drop this flight instead of landing on a nonsensical position.
        if (dealTokenRef.current !== p.gen || !landed) {
          p.flight.hide()
          endFlying(p.flyingId)
          settleFlight()
          return
        }
        p.flight.flyTo(
          landed.x,
          landed.y,
          () => {
            endFlying(p.flyingId)
            settleFlight()
          },
          { fast: p.fast, sweep: p.sweep }
        )
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Reverses a silently auto-played cascade's own flight (see FreeCellUndoMove/handleUndo below) -
  // independent of, and running concurrently with, the primary move's own flight(s) above.
  // Deferred the same way (a [state]-effect) since these cards' own registration effects, back in
  // their now-reverted tableau/freecell homes, haven't necessarily run yet in the same commit as
  // handleUndo's commitState(prevState). Every cascaded move's shared origin is its FOUNDATION pile's
  // own container ref (foundationSlotRefs) rather than CardRegistry - a buried, no-longer-topmost
  // foundation card has no registry entry of its own (see foundationSlotRefs' doc comment above).
  useEffect(() => {
    const pending = pendingCascadeUndoRef.current
    if (!pending || !state) return
    pendingCascadeUndoRef.current = null
    ;(async () => {
      const foundationIndices = Array.from(new Set(pending.moves.map((m) => m.to.index)))
      const [origins, destinations] = await Promise.all([Promise.all(foundationIndices.map((idx) => measureView(foundationSlotRefs.current[idx]))), Promise.all(pending.moves.map((m) => ghost.cardRegistry.measure(m.anchorCardId)))])
      // A new game can start while these measurements are in flight (e.g. tapping "New Game" right
      // after an Undo) - same dealTokenRef guard every other async step here uses.
      if (dealTokenRef.current !== pending.gen) {
        settleFlight()
        return
      }
      const originByIndex = new Map(foundationIndices.map((idx, i) => [idx, origins[i]]))

      const entries: DealCardSpec[] = []
      // A card whose own origin/destination/self-lookup fails can't be flown - unhide it
      // immediately instead of leaving it stuck invisible forever (same fallback runDeal's own
      // unresolvedIds handling above uses).
      const unresolvedIds: string[] = []
      const n = pending.moves.length
      pending.moves.forEach((m, i) => {
        const origin = originByIndex.get(m.to.index)
        const dest = destinations[i]
        const pile = resolvePile(m.from)
        const card = pile?.find((c) => c.id === m.anchorCardId)
        if (!origin || !dest || !card) {
          unresolvedIds.push(m.anchorCardId)
          return
        }
        // Staggered newest-cascaded-first, same convention as Klondike's own stock-draw undo - the
        // last card auto-played is the first one un-played.
        entries.push({ cardId: m.anchorCardId, card, from: origin, to: { x: dest.x, y: dest.y }, delayMs: (n - 1 - i) * DEAL_STAGGER_MS })
      })

      if (unresolvedIds.length > 0) {
        setDealHiddenIds((ids) => {
          if (unresolvedIds.every((id) => !ids.has(id))) return ids
          const next = new Set(ids)
          unresolvedIds.forEach((id) => next.delete(id))
          return next
        })
      }

      if (entries.length === 0) {
        settleFlight()
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
        () => settleFlight()
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

  // Auto-play-to-foundation: only ever fires as a direct consequence of the player's own move -
  // see useAutoFoundationCascade for the trigger model (armFromForwardMove/armFromAceEvent, called
  // from applyMove below), and engine/autoFoundation.ts for the two mechanisms computeNextStep
  // composes. FreeCell has no stock, so armFromAceEvent is never called here at all - there's no
  // draw/reveal moment to reward, only the player's own foundation moves ever start a cascade.
  const cascade = useAutoFoundationCascade<FreeCellState>({
    state,
    settled: activeFlightCount === 0 && dealHiddenIds.size === 0,
    enabled: () => settings.autoMoveToFoundation,
    isBusy: () => undoBusyRef.current,
    computeNextStep,
    firePlay
  })

  function startNewGame() {
    const myToken = ++dealTokenRef.current
    const s = FreeCellController.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingAutoMoveCardIdRef.current = []
    pendingCascadeUndoRef.current = null
    session.reset()
    setWon(false)
    recordedWinRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id))
    setDealHiddenIds(dealtIds)
    setDeckVisible(true)
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal) and no deck placeholder (deckVisible stays false - nothing is dealing). Also restores the
  // saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<FreeCellState, UndoEntry<FreeCellState, FreeCellUndoMove>>) {
    ++dealTokenRef.current
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingAutoMoveCardIdRef.current = []
    pendingCascadeUndoRef.current = null
    session.restore(saved.moves, saved.elapsedSeconds)
    setWon(false)
    recordedWinRef.current = false
    setDealHiddenIds(new Set())
    setDeckVisible(false)
    commitState(saved.state)
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('freecell')
    startNewGame()
  }

  // Finds one legal move (or a stock-draw suggestion) to highlight - see engine/hint.ts's
  // findHint, which reuses the same legalMoves() every game already implements. Only highlights;
  // the player still taps/drags the suggested card through the normal tap-to-move/drag flow.
  function handleHint() {
    if (!state) return
    const skip = hint && hint.forState === state ? hint.skip + 1 : 0
    const result = findHint(FreeCellController, state, skip)
    if (result.kind === 'none') {
      infoToast('No moves available right now.')
      return
    }
    setHint({ result, forState: state, skip })
    hintsUsedRef.current = true
    recordHintUsed('freecell')
  }

  function pushUndo(prev: FreeCellState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move: { primary: move, cascaded: [] } }])
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingAutoMoveCardIdRef effect below can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  //
  // applyMove never pushes a new undo entry for a SILENT auto-played move (see its own doc comment)
  // - instead it folds that move into THIS entry's own `cascaded` list, so undoing the one recorded
  // `primary` move also reverse-animates every card the auto-play cascade silently played on top of
  // it, in one Undo press (see FreeCellUndoMove above and the pendingCascadeUndoRef effect above).
  async function handleUndo() {
    if (undoBusyRef.current || activeFlightCountRef.current > 0 || undoStack.length === 0 || !state) return
    undoBusyRef.current = true
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
    const { move: undoMove, state: prevState } = entry
    const { primary, cascaded } = undoMove
    // Captured once, up front - every stash this call makes uses this same token, so a "New Game"
    // that fires mid-await consistently invalidates every one of this undo's pending flights rather
    // than some using a token read before the race and some after (mirrors Klondike's own handleUndo).
    const gen = dealTokenRef.current
    startFlights(cascaded.length > 0 ? 2 : 1)

    if (!primary) {
      setUndoStack((stack) => stack.slice(0, -1))
      commitState(prevState)
      settleFlight() // primary: nothing to fly, settles immediately
      return
    }

    const sourcePile = resolvePile(primary.to)
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - primary.count) : []
    const offsetStep = primary.count > 1 ? faceUpFanOffset(cardWidth) : 0
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(primary.anchorCardId) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (cascaded.length > 0) {
      const cascadeIds = new Set(cascaded.map((m) => m.anchorCardId))
      // Same "hide before reverting" ordering as Pyramid's own removal-undo (see this repo's own
      // CLAUDE.md) - set the hide flags in the SAME synchronous stretch as commitState(prevState)
      // below, so React batches them into one commit with no frame where the restored cards flash
      // fully visible before their ghosts arrive to cover them.
      setDealHiddenIds((ids) => {
        const next = new Set(ids)
        cascadeIds.forEach((id) => next.add(id))
        return next
      })
      pendingCascadeUndoRef.current = { moves: cascaded, gen }
    }

    if (origin) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(primary.from, primary.count)
      commitState(prevState)
      pendingAutoMoveCardIdRef.current.push({ cardId: primary.anchorCardId, gen, flight, flyingId })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it skips the undo stack entirely (one Undo press
  // reverts the whole triggering move plus any cascade it set off, in one step) and doesn't count
  // toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
    // closure's `state` - two actions can now be triggered back-to-back before React re-renders
    // (see PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
    // commitState just did, not the same stale board both closures captured.
    const current = stateRef.current
    if (!current) return false
    const result = FreeCellController.tryMove(current, { from, to, count })
    if (result) {
      const moveInfo: MoveInfo = { from, to, count, anchorCardId }
      if (opts?.silent) {
        // An auto-played move isn't a player decision (see maybeAutoPlay/fireAutoMove below) - fold
        // it into the LAST undo entry's own cascade list instead of dropping it, so a later Undo
        // can reverse-animate it too (see handleUndo/FreeCellUndoMove). No-op if the stack happens
        // to be empty - matches this move's prior behavior of not being recorded at all.
        setUndoStack((stack) => {
          if (stack.length === 0) return stack
          const last = stack[stack.length - 1]
          const updated = { ...last, move: { ...last.move, cascaded: [...last.move.cascaded, moveInfo] } }
          return [...stack.slice(0, -1), updated]
        })
      } else {
        pushUndo(current, moveInfo)
      }
      commitState(result)
      const movesSoFar = opts?.silent ? session.moves : session.registerMove()
      checkWin(result, movesSoFar)
      if (!opts?.silent && to.zone === 'foundation') cascade.armFromForwardMove()
      return true
    }
    return false
  }

  // `s` defaults to the closure's own live `state` (every pre-existing call site) - handleCardTap
  // passes an explicit stateRef.current instead (see its own call site below), since that call has
  // an await gap before it and wants the board as of right now, not whatever render handleCardTap's
  // own closure was created against (mirrors Klondike's resolvePile).
  function resolvePile(ref: PileRef, s: FreeCellState | null = state): Card[] | null {
    if (!s) return null
    switch (ref.zone) {
      case 'tableau':
        return s.tableau[ref.index] ?? null
      case 'foundation':
        return s.foundation[ref.index] ?? null
      case 'freecell': {
        const c = s.freecells[ref.index]
        return c ? [c] : null
      }
      default:
        return null
    }
  }

  // Tapping any movable card sends it to its best legal destination: a foundation if one exists,
  // otherwise the tableau pile that buries the fewest cards (see engine/autoMove.ts), otherwise an
  // empty freecell as a last resort (see rules.ts's autoMoveHint). Tapping the same card again
  // re-evaluates from its new position, so a card cycles through its alternatives one tap at a
  // time rather than needing a separate destination tap.
  //
  // The move applies immediately (so game logic/undo never wait on an animation), but the card
  // that just moved stays hidden at its destination until a ghost copy - shown at the tapped
  // origin - flies there and lands. cardRegistry.measure() finds that destination position by
  // measuring the real (already re-rendered) card rather than recomputing pile fan math here, so
  // the ghost always lands exactly on top of it with no seam.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>, indexFromTop?: number) {
    if (!state || !FreeCellController.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = FreeCellController.autoMoveHint(state, ref, cardId)
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

    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - so undo (the only
    // thing that still waits on activeFlightCountRef) sees this tap as in-flight for its whole
    // duration, not just once completeMove lands one.
    startFlights(1)
    const origin = await measure()
    // Reads via stateRef.current (not the render closure's `state` - see resolvePile's own doc
    // comment) - this runs after an await gap, during which some other concurrent action may
    // already have committed a newer board.
    const sourcePile = resolvePile(move.from, stateRef.current)
    if (!sourcePile || undoBusyRef.current) {
      settleFlight()
      return
    }
    const movingCards = sourcePile.slice(sourcePile.length - move.count)
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: movingCards, offsetStep, cardWidth }, { x: origin.x, y: origin.y })

    if (!completeMove(move.from, move.to, move.count, cardId, flight)) {
      flight.hide()
      settleFlight()
    }
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the [state]-effect above to measure and fly the ghost onto, instead of it
  // just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, flight: DragFlightHandle, opts?: { silent?: boolean; fast?: boolean; sweep?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) {
      // tableauRunCount's dimming only rules out a run that could NEVER move anywhere (the
      // best-case cap, assuming a non-empty destination - see its own comment). A run that passed
      // that check can still fail here specifically when the player aims it at an empty column:
      // that column can't double as its own intermediate storage, so its real cap is one factor of
      // 2 smaller than the best case. Since any card may start an empty column regardless of rank
      // (canPlaceOnTableau), this capacity check is the ONLY way a >1-count move to an empty column
      // can fail - so surface it, rather than leaving the player to guess why it silently bounced.
      // Reads stateRef.current (not the render closure's `state`), same reasoning as applyMove's
      // own doc comment - applyMove itself already rejected this move against the true current
      // board, so this diagnostic should explain that same board, not a possibly-stale render.
      const current = stateRef.current
      if (current && to.zone === 'tableau' && count > 1) {
        const cap = maxSupermoveCount(current, to.index)
        if (count > cap) {
          const freecells = countEmptyFreecells(current)
          // Excludes `to` itself, matching what actually fed `cap` above - the destination can't
          // double as its own intermediate storage, so this is the count of OTHER empty columns
          // that could help, not the board's total (which would be one higher here).
          const otherEmptyCols = countEmptyTableauColumns(current, to.index)
          infoToast(`Only ${cap} card${cap === 1 ? '' : 's'} can move to an empty column with ${freecells} free cell${freecells === 1 ? '' : 's'} and ${otherEmptyCols} other empty column${otherEmptyCols === 1 ? '' : 's'}.`)
        }
      }
      return false
    }
    const flyingId = beginFlying(to, count)
    pendingAutoMoveCardIdRef.current.push({ cardId: anchorCardId, fast: opts?.fast, sweep: opts?.sweep, gen: dealTokenRef.current, flight, flyingId })
    return true
  }

  // Composes engine/autoFoundation.ts's two mechanisms into the shared cascade hook's step shape -
  // mechanism B (a guaranteed full clear) takes priority and, once true, ignores mechanism A's
  // caution entirely since there's no longer any player decision left to protect. FreeCell has no
  // stock, so there's no draws-aware variant to reach for and every step here is always 'play'.
  function computeNextStep(s: FreeCellState): AutoCompleteStep | null {
    if (!FreeCellController.accessibleCards) return null
    const entry = isFullyAutoCompletable(FreeCellController, s) ? nextAutoCompleteMove(FreeCellController, s) : findSafeAutoPlay(FreeCellController.accessibleCards(s), s.foundation)
    return entry ? { kind: 'play', entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } } : null
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after.
  async function firePlay(entry: AccessibleCard, to: PileRef, opts: { sweep: boolean }) {
    startFlights(1)
    const stateAtStart = stateRef.current
    const origin = await ghost.cardRegistry.measure(entry.card.id)
    if (!origin || stateRef.current !== stateAtStart || undoBusyRef.current) {
      settleFlight()
      return
    }
    cascadeFeedback()
    const flight = ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    if (!completeMove(entry.ref, to, 1, entry.card.id, flight, { silent: true, fast: !opts.sweep, sweep: opts.sweep })) {
      flight.hide()
      settleFlight()
    }
  }

  // Drag-and-drop's own entry point into flight bookkeeping (see activeFlightCountRef's doc
  // comment above) - claimed synchronously here, before the `hitTest` await, purely so undo (the
  // only thing that still waits for activeFlightCountRef to hit 0 - see PATTERN_OVERLAP_GATE) sees
  // this drop as in-flight for its whole duration, not just once completeMove lands one. Also
  // rejects outright if undo is currently running (undo holds full mutual exclusion, not just a
  // one-way wait - see undoBusyRef's own doc comment) - the drag's own ghost (already shown by
  // PileView/DraggableCard well before this runs) just snaps back, same as "no legal target".
  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string, flight: DragFlightHandle): Promise<boolean> {
    if (undoBusyRef.current) return false
    startFlights(1)
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target || undoBusyRef.current) {
      settleFlight()
      return false
    }
    if (!completeMove(from, target, count, anchorCardId, flight)) {
      settleFlight()
      return false
    }
    return true
  }

  // A card whose own coherent run (indexFromTop + 1 cards) is longer than what the current
  // freecells/empty columns can actually carry is not draggable from here, even though the run
  // itself is well-formed - grabbing it would always bounce back (see rules.ts's tryMove, which
  // rejects any count over maxSupermoveCount). -1 as the destIndex asks for the best-case cap
  // (not knowing the eventual destination yet), same as tryMove would apply for a non-empty
  // destination column - the common case, and consistent with this dimming already being a
  // coarse "would this always fail" check rather than a full destination-aware oracle. Reads
  // stateRef.current (not the render closure's `state`) - this can be queried mid-drag-gesture,
  // right after some other concurrent action just committed a newer board but before this
  // component has re-rendered, and a stale read here could dim/undim a run against the wrong
  // freecell/column occupancy.
  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    const current = stateRef.current
    if (!current) return 0
    const runLen = runCountFrom(current.tableau[colIndex], indexFromTop, isDescendingAltColor)
    if (runLen > 1 && runLen > maxSupermoveCount(current, -1)) return 0
    return runLen
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
      <GameChrome title='FreeCell' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won} movesCount={session.moves} rules={FREECELL_RULES}>
        <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1) }]}>
          <View style={[styles.foundationsGroup, { gap }]}>
            {state.foundation.map((pile, i) => {
              const t = top(pile)
              const isFlyingHere = flying.some((f) => f.to.zone === 'foundation' && f.to.index === i)
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

          <View style={[styles.freecellsGroup, { gap }]}>
            {state.freecells.map((card, i) => {
              const ref: PileRef = { zone: 'freecell', index: i }
              // dealHiddenIds also covers a cascaded card returning HERE via handleUndo's own
              // cascade-undo flight (see pendingCascadeUndoRef's effect above) - it's not just the
              // initial deal's own hidden-until-landed set. PileView already consumes the same set
              // for a tableau destination (its own hiddenCardIds prop below); FreecellCell has no
              // such prop of its own, so this folds it into the same isFlyingHere-driven hide/freeze
              // this cell already does for the single-ghost `flying` case.
              const isFlyingHere = flying.some((f) => f.to.zone === 'freecell' && f.to.index === i) || (!!card && dealHiddenIds.has(card.id))
              // The far-right freecell doubles as the deal's flight origin while dealing (see
              // dealOriginRef/DECK_PLACEHOLDER_CARD above) - freecells are never touched by the
              // initial deal itself, so `card` is guaranteed still null underneath for the whole
              // time this placeholder shows, and it reverts to the plain FreecellCell below as soon
              // as deckVisible goes false (see runDeal - deliberately timed to the last card
              // LEAVING, not landing, so the deck doesn't linger after it's already been emptied).
              const isDealOrigin = i === state.freecells.length - 1 && deckVisible
              return (
                <DropZone key={i} registry={dropZones} pileRef={ref} style={[styles.freecellSlot, { width: cardWidth }]}>
                  {isDealOrigin ? (
                    <View ref={dealOriginRef} collapsable={false}>
                      <PlayingCard card={DECK_PLACEHOLDER_CARD} testID='freecell-deck-origin' />
                    </View>
                  ) : (
                    <FreecellCell card={card ?? undefined} isFlyingHere={isFlyingHere} shakeToken={card && shake?.cardId === card.id ? shake.token : undefined} highlighted={hintCountFor(activeHint, ref) > 0} onPress={(measure) => handleCardTap(ref, card!.id, measure)} onDrop={(x, y, flight) => attemptDrop(ref, 1, x, y, card!.id, flight)} />
                  )}
                </DropZone>
              )
            })}
          </View>
        </View>

        <View style={[styles.tableauRow, { gap }]}>
          {state.tableau.map((col, colIndex) => {
            const dragConfig: PileDragConfig = {
              registry: dropZones,
              getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
              // Claims a flight slot (see activeFlightCountRef's doc comment above) purely so undo
              // sees this drop as in-flight for its whole duration, not just once completeMove
              // lands one - PileView.tsx (shared, not ours to edit) already ran its own hitTest
              // await before invoking this callback, so this is the earliest point FreeCellScreen
              // gets a look-in. Rejects outright if undo is running (see attemptDrop's identical
              // comment on why undo holds full mutual exclusion, not just a one-way wait).
              onDrop: (to, count, anchorCardId, flight) => {
                if (undoBusyRef.current) return false
                startFlights(1)
                if (!completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId, flight)) {
                  settleFlight()
                  return false
                }
                return true
              }
            }
            const hiddenCount = flying.filter((f) => f.to.zone === 'tableau' && f.to.index === colIndex).reduce((sum, f) => sum + f.count, 0)
            return (
              <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
                <PileView cards={col} onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)} maxHeight={tableauMaxHeight} drag={dragConfig} hiddenCount={hiddenCount} hiddenCardIds={dealHiddenIds} dimUnplayable={settings.dimUnplayable} shakeCardId={shake?.cardId} shakeCount={shake?.count} shakeToken={shake?.token} hintCount={hintCountFor(activeHint, { zone: 'tableau', index: colIndex })} />
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
    foundationSlot: {},
    foundationsGroup: {
      flexDirection: 'row'
    },
    freecellSlot: {},
    freecellsGroup: {
      flexDirection: 'row'
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
