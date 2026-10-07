// TriPeaks solitaire screen: 3 peaks sharing one 10-wide base row, tap/drag single cards onto a
// Golf-style build pile, dealt from a real stock. Combines two things this app already has
// separately - Golf's move mechanic (single exposed card onto the one build pile, draw-1 no
// recycle, no suit foundation) and Pyramid's triangle-tap-to-select rendering shape (28
// individually-positioned board cells rather than PileView's linear columns) - but TriPeaks' own
// board is 3 separate peaks, not one uniform triangle, so its own card-position math (below) is
// derived fresh from rules.ts's childIndices adjacency rather than reusing Pyramid's cardPosition.

import { useVibration } from '@rific/feedback-press'
import { useToast } from '@rific/toaster'
import { Fireworks } from '@tastic/animations/fireworks'
import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { useRotation } from '@tastic/core'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { cardLayoutForRow } from '@/components/cardLayout'
import { DealCardSpec, useDealAnimator } from '@/components/dealing/DealLayer'
import { dealStaggerMs } from '@/components/dealing/dealSpring'
import { measureView } from '@/components/dealing/measureView'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { DropZone } from '@/components/dragdrop/DropZone'
import { DropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry'
import { GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome'
import { useGameLayout } from '@/components/gameLayout'
import { GameLoading } from '@/components/GameLoading'
import { StockWaste } from '@/components/StockWaste'
import { fireworksColors } from '@/components/theme'
import type { UndoRequestOptions } from '@/components/undoHold'
import { useCardSoundEffects } from '@/components/useCardSounds'
import { useGameSession } from '@/components/useGameSession'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import { useWinCascade, WinCascadeGhosts } from '@/components/winning/WinCascadeLayer'
import { TRIPEAKS_RULES } from '@/constants/gameRules'
import { PileRef } from '@/engine/gameTypes'
import { findHint, hintCountFor, HintResult } from '@/engine/hint'
import { top } from '@/engine/pile'
import { randomSeed } from '@/engine/rng'
import { computeScore } from '@/engine/score'
import { Card } from '@/engine/types'
import { LossBanner } from '@/games/shared/LossBanner'
import { MoveInfo, UndoEntry } from '@/games/shared/undoTypes'
import { useDeferredDeal } from '@/games/shared/useDeferredDeal'
import { useDerivedWinCheck } from '@/games/shared/useDerivedWinCheck'
import { UndoGate, useFlightConcurrency } from '@/games/shared/useFlightConcurrency'
import { useGameScreenBasics } from '@/games/shared/useGameScreenBasics'
import { useSaveInProgressBackstop } from '@/games/shared/useSaveInProgress'
import { useStuckLossCheck } from '@/games/shared/useStuckLossCheck'
import { useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'
import { useUndoStack } from '@/games/shared/useUndoStack'
import { useWinReveal } from '@/games/shared/useWinReveal'
import { WinBanner } from '@/games/shared/WinBanner'
import { withGameProviders } from '@/games/shared/withGameProviders'
import { loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress'
import { useSettings } from '@/stores/settings'

import { buildTriPeaksDealSequence } from './dealSequence'
import { BASE_WIDTH, boardHeight, boardWidth, buildCardPositions, CONTROL_ROW_MARGIN_BOTTOM, peaksCardScreenPoint, tripeaksCardWidth } from './geometry'
import { cardAt, createTriPeaksController, isExposed, rowColOf, TriPeaksState } from './rules'
import { TriPeaksSettingsSection } from './TriPeaksSettingsSection'

export default withGameProviders(TriPeaksScreenInner)

type MeasureOrigin = () => Promise<{ x: number; y: number }>

interface TriPeaksCellProps {
  index: number
  /** The cell's card on the current board (null once removed). */
  card: Card | null
  /** Whether `card` is exposed on the current board (rules.ts's isExposed). */
  exposed: boolean
  /** `card` is hidden: its deal ghost, or an undo's ghost restoring it here, has not landed yet. */
  hidden: boolean
  hinted: boolean
  /** The screen's last shake's token when it is `card`'s, WHETHER OR NOT the card is exposed - see the cell's comment. */
  shakeToken: number | undefined
  left: number
  top: number
  zIndex: number
  dropZones: DropZoneRegistry
  /** Stable for the screen's lifetime (they read the latest handlers through a ref - see TriPeaksScreenInner's cellHandlersRef). */
  onTap: (index: number, cardId: string, measure: MeasureOrigin) => void
  onDrop: (index: number, absoluteX: number, absoluteY: number, flight: DragFlightHandle) => Promise<boolean>
}

/**
 * One peaks cell. Keyed by cell (one card ever occupies a cell), and the same element tree whether its card is covered,
 * exposed or has just taken off (useTakeOffHold: drawn until its ghost is on screen), so a card that is uncovered is the
 * same PlayingCard turning face-up (which keeps its back up until the new face has painted) - it used to be a separate
 * face-down PlayingCard that REMOUNTED as the face, blank for a frame or two (cardFacePaint.ts). Genuinely covered, not
 * just "not yet playable": drawn face-down (rules.ts keeps `faceUp: true` on the stored card for game logic, so the
 * override is purely visual), not a drop target, not playable, never registered.
 *
 * Memoized, with only primitive props and stable callbacks, so a screen render re-renders just the cells whose own props
 * changed: every cell - covered ones too - is a DraggableCard with a GestureDetector, whose effect re-sends its gesture
 * config to the native side (findNodeHandle + updateGestureHandler) on EVERY render, and the screen re-renders several
 * times per move (see PyramidScreen's PyramidCell, and PileView's DraggableTableauCard, for the same reasoning).
 *
 * A held cell (its card has just taken off and its ghost is not on screen yet) is inert AND not a touch target
 * (pointerEvents none, as PileView's held cards are): it overlaps the cards its leaving uncovered, which are playable in
 * the very commit the move made, and a disabled Pressable still catches the touch (the responder only bubbles to
 * ancestors, never to the sibling cell underneath).
 *
 * `shakeToken` is passed whether or not the card is exposed: a covered card can never be tapped, so it can never get a NEW
 * token while covered - the one it carries is a shake that is over (the last shake of the board before a New Game dealt
 * the card here), and useShakeStyle records the token a card arrives with as played. Masking it while covered made the
 * card record "no token" for itself (on the mount or the re-seed a New Game gives it) and then play the stale one the
 * moment a move uncovered it, as it turned face-up. Not while held, though: `shakeToken` is computed for the cell's
 * CURRENT card, which is then not the one drawn.
 */
export const TriPeaksCell = memo(function TriPeaksCell({ index, card, exposed: exposedOnBoard, hidden, hinted, shakeToken, left, top, zIndex, dropZones, onTap, onDrop }: TriPeaksCellProps) {
  const { shown, holding } = useTakeOffHold(card)
  const exposed = !holding && exposedOnBoard
  const shownId = shown?.id
  // The covered look, built once per card rather than on every render of the cell - a stable value like every other prop
  // the card is handed here.
  const faceDown = useMemo(() => (shown ? { ...shown, faceUp: false } : null), [shown])
  const pileRef = useMemo<PileRef>(() => ({ zone: 'tableau', index }), [index])
  const style = useMemo(() => [cellStyles.card, { left, top, zIndex }, holding && cellStyles.noTouch], [left, top, zIndex, holding])
  const handlePress = useCallback((measure: MeasureOrigin) => (shownId ? onTap(index, shownId, measure) : undefined), [onTap, index, shownId])
  const handleDrop = useCallback((absoluteX: number, absoluteY: number, flight: DragFlightHandle) => onDrop(index, absoluteX, absoluteY, flight), [onDrop, index])
  if (!shown || !faceDown) return null
  return (
    <DropZone registry={dropZones} pileRef={pileRef} style={style} enabled={exposed}>
      <DraggableCard card={exposed || holding ? shown : faceDown} hidden={!holding && hidden} disabled={!exposed} registryId={exposed ? undefined : null} hinted={exposed && hinted} onPress={exposed ? handlePress : undefined} onDrop={exposed ? handleDrop : undefined} shakeToken={holding ? undefined : shakeToken} testID={`tripeaks-${index}`} />
    </DropZone>
  )
})

const WASTE: PileRef = { zone: 'waste', index: 0 }

// Module-level and theme-free, so a memoized cell never sees a new style object from a screen render. The zIndex each cell
// adds (its row) stays scoped to the peaks container - see makeStyles' `peaks`.
const cellStyles = StyleSheet.create({
  card: {
    position: 'absolute'
  },
  noTouch: {
    pointerEvents: 'none'
  }
})

function TriPeaksScreenInner() {
  const { colors, dark, styles, dropZones, recordDealWon, recordDealAbandoned, recordHintUsed, setLastActiveGame, clearLastActiveGame } = useGameScreenBasics(makeStyles)
  const { info: infoToast } = useToast()
  const { settings } = useSettings()
  // The rank-wrap rule the in-progress deal was actually dealt with - deliberately not re-derived
  // from `settings` every render, same reasoning SpiderScreen's own `numSuits` state has: a
  // mid-game settings change must never mutate the current deal's own rules. A useMemo (not a
  // useRef the way Klondike/Canfield's own draw-count settings use) - useDerivedWinCheck below
  // calls controller.isWon(state) synchronously during render, which react-hooks/refs correctly
  // flags for a ref-sourced controller but not for a memoized one, same as Spider's own identical
  // setup already proves lint-clean.
  const [tripeaksRankWrap, setTripeaksRankWrap] = useState(settings.tripeaksRankWrap)
  const controller = useMemo(() => createTriPeaksController(tripeaksRankWrap), [tripeaksRankWrap])
  // Width the board may occupy - rotation-aware, and net of the side-chrome gutters in the wide (landscape)
  // layout; the plain window width (capped) in portrait. See gameLayout.ts.
  const { contentWidth, isWide, availableHeight: layoutAvailableHeight } = useGameLayout()
  const rotation = useRotation()
  const { cardWidth: widthCardWidth, gap } = cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, BASE_WIDTH)
  // Portrait: the same two-axis clamp as Pyramid's own (see clampCardWidthForHeight's doc comment) fed
  // by the column-game height budget, exactly as before. Wide: the real board (stock row + peaks) fitted
  // to the layout's height - see geometry.ts's tripeaksCardWidth.
  const tableauMaxHeight = useTableauMaxHeight(widthCardWidth, 0)
  const cardWidth = tripeaksCardWidth(widthCardWidth, isWide, layoutAvailableHeight, tableauMaxHeight)
  const cardHeight = cardWidth / CARD_ASPECT
  // Owns state/stateRef/commitState, the `flying` array, and undoBusyRef - see
  // useFlightConcurrency's own doc comment for the invariant this protects (undo needs full mutual
  // exclusion with everything else; tap/drag/stock-draw can all run concurrently with each other -
  // PATTERN_OVERLAP_GATE). Destructured below so every existing reference to `state`, `commitState`,
  // `flying`, `startFlights`, `settleFlight`, `undoBusyRef`, etc. keeps working unchanged.
  // `shrinkFlying` (the hook's multi-card-fan support) is deliberately left un-destructured -
  // TriPeaks has no recycle/multi-card fan draw, so nothing here would ever call it, and this repo's
  // tsconfig treats an unused local as a real compile error (noUnusedLocals). `activeFlightCount` is
  // read only for the win reveal's settled signal below.
  const { state, stateRef, commitState, flying, beginFlying, endFlying, activeFlightCount, startFlights, settleFlight, undoBusyRef, runUndo, reset: resetFlightConcurrency } = useFlightConcurrency<TriPeaksState>()
  // Every TriPeaks move (a tableau card onto the waste, or a stock draw) always has a real
  // origin/destination and a real card to fly - same reasoning as Golf's own non-nullable
  // UndoEntry<TState, MoveInfo> instantiation (unlike Klondike's/Pyramid's nullable default).
  const [undoStack, setUndoStack, undoStackRef] = useUndoStack<UndoEntry<TriPeaksState, MoveInfo>>()
  // Paired with the exact state it was computed against, rather than cleared via a [state]-effect
  // - state is always replaced wholesale on every real change (never mutated in place - see
  // tryMove), so comparing references during render is enough to auto-dismiss a stale hint the
  // instant the board actually changes, with no separate effect/setState needed.
  const [hint, setHint] = useState<{ result: HintResult; forState: TriPeaksState; skip: number } | null>(null)
  const activeHint = hint && hint.forState === state ? hint.result : null
  // Whether the Hint button has produced a hint at any point during the CURRENT deal - read once,
  // at the exact instant a win is recorded (see useDerivedWinCheck's own hintsUsedRef param), to
  // decide whether this win counts toward the "wins without hint" stat/achievement. Reset alongside
  // the undo stack in startNewGame/restoreGame below.
  const hintsUsedRef = useRef(false)
  const session = useGameSession()
  const ghost = useDragGhost()
  const deal = useDealAnimator()
  const stockViewRef = useRef<View>(null)
  // The waste slot itself (StockWaste's wasteRef) - exactly card-sized, so its measured bounding box is
  // the card's own footprint at any rotation. (Measuring the whole StockWaste wrapper instead, as this
  // once did, is wider than a card: fine at 0deg where the top-left coincides, wrong once rotated.) Used
  // as the win cascade's single chain origin, since the waste/build pile is TriPeaks' only "foundation-equivalent" pile, same as
  // Golf - the real waste top card is hidden once won (wasteTopCard below).
  const wasteViewRef = useRef<View>(null)
  // The 28-cell board container - tableau destinations resolve as pure math against this origin
  // (see buildCardPositions), not per-card CardRegistry measurement, since most of the 28 slots
  // start covered and therefore never register into CardRegistry at all (a covered cell registers
  // nothing - see TriPeaksCell). Same reasoning Pyramid's own triangleViewRef/cardPosition
  // combination uses for its own deal, generalized here to 3 peaks instead of 1 uniform triangle.
  const peaksViewRef = useRef<View>(null)
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set())
  const dealTokenRef = useRef(0)
  const scheduleDeal = useDeferredDeal(state, dealTokenRef, runDeal)
  const winCascade = useWinCascade()
  // Before the win check (see useStuckLossCheck). A dead board - no move left and no stock to deal - is a loss here, as in Aces Up:
  // it used to just sit there with the clock running.
  const { stuck, recordedRef: recordedLossRef } = useStuckLossCheck(controller, state, 'tripeaks', recordDealAbandoned)
  const { won, recordedRef: recordedWinRef, pendingWinCascadeRef } = useDerivedWinCheck(controller, state, 'tripeaks', session, dealTokenRef, recordDealWon, hintsUsedRef)
  // Nothing animating and the initial deal finished - what the win celebration waits for (see
  // useWinReveal). activeFlightCount covers every ghost flight (tap, drag, stock draw, undo all
  // claim one via startFlights before their first await), dealHiddenIds the initial deal.
  const settled = activeFlightCount === 0 && dealHiddenIds.size === 0
  // `won` is game state (clock, stat, save, undo/hint gating) and flips with the winning move; the
  // celebration - the waste pile giving way to the win cascade, fireworks, banner - waits until the
  // last card has flown onto the waste and landed. Hiding the waste top on `won` used to unregister
  // the very card the winning flight was measuring to land on, so that flight could not fly at all
  // and the card simply appeared (see the [state] flight effect below).
  const winRevealed = useWinReveal(won, settled)
  // The loss banner waits for the last card to land too.
  const lossRevealed = useWinReveal(stuck, settled)
  // The board the win cascade has taken over from (set once its ghosts are on screen - startChains' onShown, see
  // runWinCascade): once it IS the current state, and the win is revealed, the real waste top blanks - not a moment
  // earlier. Blanking on winRevealed alone left the waste slot EMPTY for the few frames it takes runWinCascade to measure
  // and mount the ghosts (the pile teleported away, then the ghosts appeared). Compared by identity (state is replaced
  // wholesale on every change) so an undo or a New Game un-blanks the pile with no reset to remember.
  const [cascadeHandoffFor, setCascadeHandoffFor] = useState<TriPeaksState | null>(null)
  /** Flights awaiting their post-commit measurement + ghost.flyTo, queued by tap-to-move
   * (handleCardTap), a drag drop (handleDrop), drawing from the stock (handleDrawStock), and undo -
   * a list (not a single slot), since these can now genuinely overlap (see PATTERN_OVERLAP_GATE):
   * two entries queued in the same commit would otherwise clobber each other in a single ref slot,
   * permanently stranding whichever one lost. `viaStock` measures via stockViewRef (a plain View,
   * not per-card) instead of CardRegistry - only undoing a stock draw flies back toward the stock;
   * every other flight targets the waste (CardRegistry-backed via StockWaste's DraggableCard
   * wasteTop, with `viaWaste` falling back to wasteViewRef when the card has no registry entry of
   * its own - see the [state]-effect below) or a tableau slot an undo is restoring a card into
   * (always exposed once restored - see handleUndo - so it's freshly CardRegistry-registered too).
   * `gen` guards against a "New Game" tapped mid-flight replacing the deal this flight was
   * measuring against (card ids are shuffle-independent and reused across deals - see
   * engine/deck.ts). `flyingId` removes exactly this entry's own `flying` array entry once it
   * lands - see the [state]-effect below. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean; viaWaste?: boolean; gen: number; flyingId: number; flight: DragFlightHandle }[]>([])
  const vibration = useVibration()
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects()
  // Which card (if any) should play its "nowhere to go" shake right now - always exactly one card,
  // same as Golf (TriPeaks never drags/taps more than a single card at a time).
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null)
  const shakeTokenRef = useRef(0)

  // Takes the controller to deal with explicitly, rather than reading the outer `controller`
  // memo directly - `setTripeaksRankWrap` below only takes effect on the NEXT render, so a caller
  // whose own setting just changed (handleNewGame) must build and pass the new controller itself
  // instead of dealing with the current render's now-stale memoized one. Same shape Spider's own
  // startNewGame uses for its identical numSuits setting.
  function startNewGame(ctrl: ReturnType<typeof createTriPeaksController>) {
    const myToken = ++dealTokenRef.current
    const s = ctrl.newGame(randomSeed())
    setUndoStack([])
    setHint(null)
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.reset()
    recordedWinRef.current = false
    recordedLossRef.current = false
    winCascade.clear()
    pendingWinCascadeRef.current = null
    // The last shake belongs to the old board: card ids are reused by the next deal, so a cell dealt the shaken card must
    // not be handed its token at all (TriPeaksCell records whatever token its card arrives with as already played, so
    // this is a second line of defence, not the fix).
    setShake(null)

    const dealtIds = new Set([...s.tableau.filter((c): c is Card => !!c).map((c) => c.id), ...s.waste.map((c) => c.id)])
    setDealHiddenIds(dealtIds)
    scheduleDeal(myToken)
    commitState(s)
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation. Also restores
  // the saved undo stack (falling back to empty for an older save written before undo persistence
  // existed - see SavedGame's own doc comment).
  function restoreGame(saved: SavedGame<TriPeaksState, UndoEntry<TriPeaksState, MoveInfo>>) {
    ++dealTokenRef.current
    // config is persisted as 0/1 (see the save effect below) since SavedGame.config is a plain
    // number - narrowed back to a boolean here, falling back to the live setting only if missing.
    const wrap = saved.config === 1 || saved.config === 0 ? saved.config === 1 : settings.tripeaksRankWrap
    // Setting tripeaksRankWrap here is enough to bring `controller` (a useMemo keyed on it) back
    // in sync by the same render that commits `state` below - both setters run inside the same
    // batch, same reasoning SpiderScreen's own restoreGame documents for its identical numSuits
    // setting.
    setTripeaksRankWrap(wrap)
    setUndoStack(saved.undoStack ?? [])
    setHint(null)
    setShake(null) // see startNewGame
    hintsUsedRef.current = false
    resetFlightConcurrency()
    pendingFlightRef.current = []
    session.restore(saved.moves, saved.elapsedSeconds)
    recordedWinRef.current = false
    recordedLossRef.current = false
    setDealHiddenIds(new Set())
    commitState(saved.state)
  }

  function handleNewGame() {
    if (session.moves > 0 && !won && !stuck) recordDealAbandoned('tripeaks')
    setTripeaksRankWrap(settings.tripeaksRankWrap)
    startNewGame(createTriPeaksController(settings.tripeaksRankWrap))
  }

  // Deals from a real stock pile (stockViewRef), same as Golf/Klondike. The 28 tableau destinations
  // resolve as pure math (buildCardPositions against peaksViewRef's own origin) rather than
  // CardRegistry, since most start covered and never register at all - only the one starter card
  // (index === -1, destined for the waste) resolves via CardRegistry, exactly like Golf's own
  // starter: StockWaste renders wasteTop through DraggableCard, which registers on mount just like
  // any other draggable card. Same dealTokenRef guard as every other async measurement here.
  async function runDeal(s: TriPeaksState, token: number) {
    const starter = s.waste[0]
    const sequence = buildTriPeaksDealSequence(s.tableau, starter)
    const [stockOrigin, boardOrigin, starterDest] = await Promise.all([measureView(stockViewRef.current), measureView(peaksViewRef.current), ghost.cardRegistry.measure(starter.id)])
    if (dealTokenRef.current !== token) return
    if (!stockOrigin || !boardOrigin) {
      setDealHiddenIds(new Set())
      return
    }

    const positions = buildCardPositions(cardWidth, cardHeight, gap)
    // The peaks container's own local size - what it renders with (see the JSX below).
    const peaksWidth = boardWidth(cardWidth, gap)
    const peaksHeight = boardHeight(cardHeight)
    const entries: DealCardSpec[] = []
    sequence.forEach((step) => {
      if (step.index === -1) {
        if (!starterDest) {
          // Destination measurement failed - unhide the starter card right away instead of leaving
          // it stuck at opacity:0 for the rest of the hand (it never enters `entries`, so it would
          // otherwise never reach the onCardLanded callback that normally clears it from
          // dealHiddenIds). Mirrors this file's own top-level entries.length===0 fallback and
          // Pyramid's runDeal/undoRemoval fallback for the same failure mode (see this repo's
          // .claude/CLAUDE.md).
          setDealHiddenIds((ids) => {
            if (!ids.has(step.cardId)) return ids
            const next = new Set(ids)
            next.delete(step.cardId)
            return next
          })
          return
        }
        entries.push({ cardId: step.cardId, card: step.card, from: stockOrigin, to: starterDest, delayMs: step.visitOrder * dealStaggerMs(sequence.length) })
        return
      }
      const { row } = rowColOf(step.index)
      const { left, top: cardTop } = positions[step.index]
      // Rows 0-2 aren't genuinely exposed/face-up at deal time (they start covered under the rows
      // below them - see rules.ts) - fly those face-down, matching Klondike/Yukon's forced
      // face-down flight for a card whose real state isn't face-up-from-the-start. Row 3 (the base)
      // is exposed from the start, so it flies showing its real face.
      const card = row === 3 ? step.card : { ...step.card, faceUp: false }
      entries.push({ cardId: step.cardId, card, from: stockOrigin, to: peaksCardScreenPoint(boardOrigin, peaksWidth, peaksHeight, left, cardTop, cardWidth, rotation), delayMs: step.visitOrder * dealStaggerMs(sequence.length) })
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

  // Win cascade: a single chain, every card that ever landed on the waste/build pile (the tableau's
  // whole 28 cards plus the starter, in the order they arrived), reversed so the most-recently-
  // placed (currently on top of the physical pile) leads the chain - same convention as Golf's own
  // waste cascade (TriPeaks has no suit-based foundation either). Origin is wasteViewRef rather than
  // a per-card CardRegistry lookup - the slot is always mounted and card-sized whether or not the real
  // top card is drawn. The measurement runs while the real waste top is STILL on screen and the pile
  // blanks only afterwards, once the ghosts are on screen (cascadeHandoffFor, set from startChains'
  // onShown - in the commit the ghosts appear, which waits for the parked head's face to paint; see
  // WinCascadeLayer's CascadeChains): blanking first left the waste empty until the ghosts arrived,
  // and blanking in the commit that mounted them showed a blank-faced card there for a frame or two.
  // An undo or New Game before then clears the cascade, which drops the callback (and the hand-off is
  // keyed to `s` anyway). If no chain can start (an unmeasurable slot), the pile simply stays up under
  // the banner instead of vanishing.
  async function runWinCascade(s: TriPeaksState, gen: number) {
    const origin = await measureView(wasteViewRef.current)
    if (dealTokenRef.current !== gen || !origin || s.waste.length === 0) return
    winCascade.startChains([{ cards: s.waste.slice().reverse(), origin, entranceDelayMs: 0 }], cardWidth, () => setCascadeHandoffFor(s))
  }

  // Also waits for winRevealed (the last card has landed and the finished board has held a beat) - the
  // cascade replaces the waste pile's real cards, so it must not start while the winning card is in the air.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current
    if (!pending || !state || !winRevealed) return
    pendingWinCascadeRef.current = null
    runWinCascade(state, pending.gen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, winRevealed])

  // Same race documented in this repo's own CLAUDE.md: measuring CardRegistry/a view ref
  // synchronously right after the setState in applyMove/handleDrawStock/handleUndo would find stale
  // pre-commit state. Deferring to a [state]-keyed effect guarantees the destination has already
  // registered by the time this runs.
  useEffect(() => {
    if (pendingFlightRef.current.length === 0 || !state) return
    const pending = pendingFlightRef.current
    pendingFlightRef.current = []
    pending.forEach((p) => {
      ;(async () => {
        // A forward move's/draw's registered waste top card is the usual landing spot, but a card that
        // is no longer the top by the time it is measured (a second move landed on it in the same
        // commit) has no registry entry - the waste slot itself is card-sized and always there, so fly
        // to that rather than hiding the ghost and letting the card simply appear.
        const landed = p.viaStock ? await measureView(stockViewRef.current) : ((await ghost.cardRegistry.measure(p.cardId)) ?? (p.viaWaste ? await measureView(wasteViewRef.current) : null))
        if (dealTokenRef.current !== p.gen || !landed) {
          p.flight.hide()
          endFlying(p.flyingId)
          settleFlight()
          return
        }
        p.flight.flyTo(landed.x, landed.y, () => {
          endFlying(p.flyingId)
          settleFlight()
        })
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes the
  // "last active game" for as long as it stays mounted, and stops being it the instant the player
  // actually backs out.
  useEffect(() => {
    loadGameInProgress<TriPeaksState, UndoEntry<TriPeaksState, MoveInfo>>('tripeaks').then((saved) => {
      if (saved) restoreGame(saved)
      else startNewGame(controller)
      setLastActiveGame('tripeaks')
    })
    return () => clearLastActiveGame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Saves after every move/undo/fresh-deal (all flow through setState). Gated on !won so a
  // just-won deal doesn't get checkpointed as still in-progress. Deliberately NOT also keyed on a
  // ticking elapsed-seconds value the way an earlier version of this effect was:
  // `session.getElapsed()` computes the true current elapsed from wall-clock time on demand (see
  // useGameSession.ts), so a save made at the last real move is never stale even once the player
  // just sits looking at the board afterward - resuming always recomputes the exact right value
  // instead of depending on whenever this effect last happened to run.
  useEffect(() => {
    if (state && !won && !stuck) saveGameInProgress('tripeaks', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: tripeaksRankWrap ? 1 : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won, stuck, tripeaksRankWrap, undoStack])
  useSaveInProgressBackstop(!!state && !won && !stuck, () => {
    if (state && !won && !stuck) saveGameInProgress('tripeaks', { state, undoStack, moves: session.moves, elapsedSeconds: session.getElapsed(), config: tripeaksRankWrap ? 1 : 0 })
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
    recordHintUsed('tripeaks')
  }

  function pushUndo(prev: TriPeaksState, move: MoveInfo) {
    setUndoStack((stack) => [...stack, { state: prev, move }])
  }

  // Mirrors handleCardTap's/handleDrop's/handleDrawStock's forward flight, just in reverse: the
  // card being undone is still sitting on top of the waste pile (every TriPeaks move's `to` is
  // always the waste), so measure that real position before reverting, then fly the ghost back to
  // `move.from` - a tableau slot (always exposed once restored, since its children were already
  // gone before it was ever moved out - see rules.ts's isExposed), or the stock pile for an undone
  // draw (see pendingFlightRef's `viaStock`).
  // One undo per call - see useFlightConcurrency's runUndo.
  function handleUndo(opts?: UndoRequestOptions) {
    return runUndo(undoGate, revertTopUndo, opts)
  }

  // Every TriPeaks undo takes the waste's top card back where it came from, and nothing an undo
  // does lands on the waste - so undos never wait for each other here.
  function undoGate(): UndoGate {
    if (undoStackRef.current.length === 0 || !stateRef.current) return null
    return { takesFrom: [WASTE] }
  }

  async function revertTopUndo() {
    // Reads the stack and the board via their refs, not the closure - there's a real await gap below
    // (the CardRegistry measurement), and undos (like any two actions) can run back-to-back before
    // React re-renders (see PATTERN_OVERLAP_GATE/commitState's own doc comment).
    const current = stateRef.current
    const entry = undoStackRef.current[undoStackRef.current.length - 1]
    if (!current || !entry) return
    startFlights(1)
    if (won) winCascade.clear()
    const { move, state: prevState } = entry
    const movingCard = top(current.waste)
    // Once the win is revealed, the winning card's DraggableCard is unmounted (see wasteTopCard below),
    // so it has no CardRegistry entry - fall back to the waste slot's plain view ref (the same technique
    // runWinCascade above uses for this exact reason), rather than a registry lookup that would return
    // null and skip the flight (the card would just reappear in its slot).
    const origin = movingCard && movingCard.id === move.anchorCardId ? ((await ghost.cardRegistry.measure(move.anchorCardId)) ?? (await measureView(wasteViewRef.current))) : null

    setUndoStack((stack) => stack.slice(0, -1))

    if (origin && movingCard) {
      playCardSound()
      hapticCard()
      const flight = ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
      const flyingId = beginFlying(move.from, 1)
      commitState(prevState)
      pendingFlightRef.current.push({ cardId: move.anchorCardId, viaStock: move.from.zone === 'stock', gen: dealTokenRef.current, flyingId, flight })
    } else {
      commitState(prevState)
      settleFlight()
    }
  }

  // Reads/commits through stateRef.current (see commitState's own doc comment), not the render
  // closure's `state` - two actions can now be triggered back-to-back before React re-renders (see
  // PATTERN_OVERLAP_GATE), and each must build its own tryMove on top of whatever the OTHER's
  // commitState just did, not the same stale board both closures captured.
  function applyMove(from: PileRef, to: PileRef, anchorCardId: string): boolean {
    const current = stateRef.current
    if (!current) return false
    const result = controller.tryMove(current, { from, to, count: 1 })
    if (!result) return false
    pushUndo(current, { from, to, count: 1, anchorCardId })
    commitState(result)
    session.registerMove()
    return true
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual drag's
  // drop) - applies the move, then marks the waste pile "incoming" and stashes the anchor card id
  // for the pendingFlightRef effect above to measure and fly the ghost onto.
  function completeMove(from: PileRef, to: PileRef, anchorCardId: string, flight: DragFlightHandle): boolean {
    if (!applyMove(from, to, anchorCardId)) return false
    const flyingId = beginFlying(to, 1)
    pendingFlightRef.current.push({ cardId: anchorCardId, viaWaste: true, gen: dealTokenRef.current, flyingId, flight })
    return true
  }

  async function handleDrawStock() {
    // Reads via stateRef.current, not the closure `state` - see applyMove's identical comment.
    const current = stateRef.current
    if (won || !current) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const result = controller.drawStock!(current)
    if (!result) return
    startFlights(1)
    session.registerMove()

    // drawStock never returns a result with an unchanged waste - TriPeaks has no recycle case (see
    // rules.ts), so a successful draw always means a real drawn card.
    const drawnCard = top(result.waste)!
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id }

    const origin = await measureView(stockViewRef.current)
    if (!origin) {
      pushUndo(current, move)
      commitState(result)
      settleFlight()
      return
    }

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })
    const flyingId = beginFlying({ zone: 'waste', index: 0 }, 1)

    pushUndo(current, move)
    commitState(result)
    pendingFlightRef.current.push({ cardId: drawnCard.id, viaWaste: true, gen: dealTokenRef.current, flyingId, flight })
  }

  // Tapping an exposed tableau card sends it to the waste pile if legal - TriPeaks has exactly one
  // possible destination (autoMoveHint either finds that one move or returns null), same as Golf.
  async function handleCardTap(ref: PileRef, cardId: string, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state || !controller.autoMoveHint) return
    if (undoBusyRef.current) return // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    const move = controller.autoMoveHint(state, ref, cardId)
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather than
      // a dead press. Deliberately never calls measure() - this branch has no use for the tapped
      // card's position (see PileView.tsx's onPress doc comment).
      setShake({ cardId, token: ++shakeTokenRef.current })
      vibration.short()
      playInvalidSound()
      return
    }

    const card = cardAt(state, ref)
    if (!card) return

    // Claimed synchronously before the await below (see PATTERN_OVERLAP_GATE) - so undo (the only
    // thing that still waits on activeFlightCountRef) sees this tap as in-flight for its whole
    // duration, not just once completeMove lands one.
    startFlights(1)
    const origin = await measure()
    if (undoBusyRef.current) {
      settleFlight()
      return
    }

    playCardSound()
    hapticCard()
    const flight = ghost.show({ cards: [card], offsetStep: 0, cardWidth }, { x: origin.x, y: origin.y })

    if (!completeMove(move.from, move.to, cardId, flight)) {
      flight.hide()
      settleFlight()
    }
  }

  // Drag-completed move: DraggableCard's own pan gesture already showed the flight at drag start,
  // handed in here as `flight` on a successful drop - this only needs to hit-test the release point
  // (the waste is the only registered drop target a tableau card could ever legally land on) and
  // hand off to the same completeMove tail as a tap.
  async function handleDrop(from: PileRef, absoluteX: number, absoluteY: number, flight: DragFlightHandle): Promise<boolean> {
    if (!state) return false
    if (undoBusyRef.current) return false // see PATTERN_OVERLAP_GATE - undo still holds full exclusion
    startFlights(1)
    const target = await dropZones.hitTest(absoluteX, absoluteY)
    if (!target || undoBusyRef.current) {
      settleFlight()
      return false
    }
    // Reads via stateRef.current, not the closure `state` - there's a real await gap above
    // (hitTest), and another action could commit in the meantime (see PATTERN_OVERLAP_GATE).
    const latest = stateRef.current
    const card = latest ? cardAt(latest, from) : null
    if (!card) {
      settleFlight()
      return false
    }
    if (!completeMove(from, target, card.id, flight)) {
      settleFlight()
      return false
    }
    return true
  }

  // The peaks cells' tap and drop handlers: STABLE for the screen's lifetime, so the memoized TriPeaksCell is not
  // re-rendered by every screen render (see its comment), and reading the latest render's handlers through this ref - the
  // way PileView's `latest` does. Refreshed in a layout effect, so a tap or drop arriving right after a commit already runs
  // that commit's handlers, exactly as the inline closures every cell used to be handed did.
  const cellHandlersRef = useRef({ handleCardTap, handleDrop })
  useLayoutEffect(() => {
    cellHandlersRef.current = { handleCardTap, handleDrop }
  })
  const onTapCell = useCallback((index: number, cardId: string, measure: MeasureOrigin) => {
    cellHandlersRef.current.handleCardTap({ zone: 'tableau', index }, cardId, measure)
  }, [])
  const onDropCell = useCallback((index: number, absoluteX: number, absoluteY: number, flight: DragFlightHandle) => cellHandlersRef.current.handleDrop({ zone: 'tableau', index }, absoluteX, absoluteY, flight), [])

  if (!state) return <GameLoading />

  const width = boardWidth(cardWidth, gap)
  const height = boardHeight(cardHeight)
  const positions = buildCardPositions(cardWidth, cardHeight, gap)
  // Hidden only once the win is REVEALED, not the moment it is won - the winning card is still flying
  // onto this pile until then, and its flight measures the registered waste top to land on - AND the
  // cascade has taken over (cascadeHandoffFor === state): its ghosts are on screen by the commit this
  // blanks, so the pile is never seen empty. Not on winRevealed alone: runWinCascade measures first.
  const wasteTopCard = winRevealed && cascadeHandoffFor === state ? undefined : top(state.waste)
  const wasteHiddenByDeal = wasteTopCard && dealHiddenIds.has(wasteTopCard.id) ? 1 : 0
  const wasteHiddenByFlight = flying.filter((f) => f.to.zone === 'waste').reduce((sum, f) => sum + f.count, 0)
  const wasteHiddenCount = Math.max(wasteHiddenByDeal, wasteHiddenByFlight)

  // A tableau slot's card is hidden while its own deal ghost hasn't landed yet, or while an undo's
  // ghost is mid-flight restoring it here - both conditions the same shape Golf/Pyramid already use
  // (dealHiddenIds, and `flying` pointed at this exact destination). Only ever one card at a time
  // (TriPeaks moves are always single-card), so a plain per-slot boolean is enough - no separate
  // hidden-ids set is needed the way Pyramid's pyramidHiddenIds tracks a King/pair's fan-out.
  function isTableauHidden(cardId: string, index: number): boolean {
    if (dealHiddenIds.has(cardId)) return true
    return flying.some((f) => f.to.zone === 'tableau' && f.to.index === index)
  }

  return (
    <CardSizeProvider width={cardWidth}>
      <GameChrome title='TriPeaks' onNewGame={handleNewGame} onUndo={handleUndo} undoDisabled={undoStack.length === 0} onHint={handleHint} hintDisabled={won || stuck} won={won} hasProgress={session.moves > 0} getElapsedSeconds={session.getElapsed} clockRunning={session.started && !won && !stuck} movesCount={session.moves} settingsContent={<TriPeaksSettingsSection />} rules={TRIPEAKS_RULES}>
        <View style={styles.board}>
          <View style={styles.controlRow}>
            <StockWaste
              canRecycle={false}
              dropZones={dropZones}
              stockTopCard={top(state.stock)}
              wasteTop={wasteTopCard}
              wasteHiddenCount={wasteHiddenCount}
              // While the starter card is still being dealt, the waste is really empty: without this the slot painted its frozen
              // 'card from before the flight' under the ghost - the starter itself on a first deal, the last game's top card on New
              // Game - face up beside the stock for the whole deal.
              settledWasteTop={wasteHiddenByDeal ? null : undefined}
              wasteHinted={hintCountFor(activeHint, { zone: 'waste', index: 0 }) > 0}
              stockHinted={activeHint?.kind === 'drawStock'}
              cardWidth={cardWidth}
              gap={gap}
              onDrawStock={handleDrawStock}
              // The waste top card is never draggable or tappable on its own in TriPeaks - it's a
              // passive drop target for exposed tableau cards only, never a move source itself (same
              // reasoning Golf's own StockWaste usage documents).
              onWastePress={() => {}}
              onWasteDrop={() => false}
              stockRef={stockViewRef}
              wasteRef={wasteViewRef}
              // Undoing a stock draw flies a ghost back from the waste toward the stock slot (see
              // handleUndo's `viaStock` branch) - freeze the stock slot's prior look (the
              // empty/recycle-hint placeholder, if the stock was empty) until that ghost actually
              // lands, instead of letting the real face-down card pop in a beat early. Mirrors how
              // wasteHiddenCount above is derived from this same `flying` state.
              stockHidden={flying.some((f) => f.to.zone === 'stock')}
            />
          </View>

          <View ref={peaksViewRef} collapsable={false} style={[styles.peaks, { width, height }]}>
            {/* One memoized cell per index, keyed by the cell - see TriPeaksCell. Every prop is a primitive (or stable),
            so only the cells whose own state changed re-render. */}
            {state.tableau.map((card, index) => {
              const { row, col } = rowColOf(index)
              const { left, top: cardTop } = positions[index]
              return <TriPeaksCell key={index} index={index} card={card} exposed={isExposed(state.tableau, row, col)} hidden={!!card && isTableauHidden(card.id, index)} hinted={hintCountFor(activeHint, { zone: 'tableau', index }) > 0} shakeToken={card && shake?.cardId === card.id ? shake.token : undefined} left={left} top={cardTop} zIndex={row} dropZones={dropZones} onTap={onTapCell} onDrop={onDropCell} />
            })}
          </View>
        </View>
      </GameChrome>
      {winRevealed && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
      <WinCascadeGhosts />
      {winRevealed && <WinBanner colors={colors} elapsedSeconds={session.getElapsed()} moves={session.moves} score={computeScore(session.moves, session.getElapsed())} onNewGame={handleNewGame} />}
      {lossRevealed && !won && <LossBanner colors={colors} onNewGame={handleNewGame} onUndo={handleUndo} />}
    </CardSizeProvider>
  )
}

function makeStyles() {
  return StyleSheet.create({
    board: {
      alignItems: 'center'
    },
    controlRow: {
      // Right-aligned to the peaks' own right edge below, matching where every other game's stock
      // pile lands (Klondike/Spider/Canfield's right edge, Golf's right-aligned topRow, Pyramid's
      // matching controlRow) - this used to sit centered below the peaks instead. Now first in
      // the board (see the JSX above), so the gap is a marginBottom, not marginTop.
      alignSelf: 'flex-end',
      marginBottom: CONTROL_ROW_MARGIN_BOTTOM
    },
    // zIndex below only stays scoped to this container if the container itself establishes a
    // stacking context - position:relative alone doesn't, without its own zIndex (see PileView's/
    // Pyramid's identical fix). Without this, a card's per-row zIndex leaks out to compete with the
    // screen-level drag/deal ghost overlays.
    peaks: {
      position: 'relative',
      zIndex: 0
    }
  })
}
