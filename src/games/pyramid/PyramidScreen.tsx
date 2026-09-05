// Pyramid solitaire screen: triangle tap-to-select board + stock/waste row.

import { Fireworks } from '@tastic/animations/fireworks';
import { Pressable, useVibration } from '@rific/feedback-press';
import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from 'react-native-paper';
import { computeContentBounds } from '@tastic/core';

import { EmptySlot, PlayingCard } from '@/components/PlayingCard';
import { CARD_ASPECT, CardSizeProvider, cardWidthForRow, FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext';
import { formatTime, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome';
import { StockWaste } from '@/components/StockWaste';
import { fireworksColors, TableColors, useTableColors } from '@/components/theme';
import { useCardSoundEffects } from '@/components/useCardSounds';
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload';
import { DraggableCard } from '@/components/dragdrop/DraggableCard';
import { DragGhostProvider, useDragGhost } from '@/components/dragdrop/DragGhostLayer';
import { DropZone } from '@/components/dragdrop/DropZone';
import { useDropZoneRegistry } from '@/components/dragdrop/DropZoneRegistry';
import { DealCardSpec, DealProvider, useDealAnimator } from '@/components/dealing/DealLayer';
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring';
import { measureView } from '@/components/dealing/measureView';
import { useWinCascade, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer';
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden';
import { useGameSession } from '@/components/useGameSession';
import { Card } from '@/engine/types';
import { PileRef } from '@/engine/gameTypes';
import { randomSeed } from '@/engine/rng';
import { computeScore } from '@/engine/score';
import { useGameStats } from '@/stores/gameStats';
import { clearGameInProgress, loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress';
import { useLastActiveGame } from '@/stores/lastActiveGame';
import { buildPyramidDealSequence } from './dealSequence';
import { cardAt, PyramidController, PyramidState, isExposed, rowColOf } from './rules';

const ROWS = 7;
const COL_GAP = 6; // horizontal gap between cards within a row - no overlap, so corner pips stay visible

/** Records enough about an applied move to reverse its animation later - only ever a stock draw
 * (stock -> waste) here. A pairing/King move DOES land its cards somewhere now (the discard pile -
 * see attemptMove/attemptDrop), but undo for it is deliberately left unanimated for now (Pyramid's
 * undo model reverts to a whole prior-state snapshot rather than replaying a reverse move, so
 * `discard` already comes back correctly for free - only the forward removal itself flies). */
interface MoveInfo {
  from: PileRef;
  to: PileRef;
  count: number;
  anchorCardId: string;
}

interface UndoEntry {
  state: PyramidState;
  /** Null for a pairing/King move - undo just reverts instantly (see the comment on MoveInfo
   * above). Only a stock draw ever carries a real move. */
  move: MoveInfo | null;
}

// Plain (theme-independent) style for DiscardCell below - it's a module-level component, so it
// can't reach PyramidScreenInner's own theme-derived `styles`.
const HIDDEN_CARD_STYLE = { opacity: 0 };

/** The discard pile's own display - cards removed via a pair or solo King land here (see
 * rules.ts's `discard` field). Always face-up and non-interactive (`disabled`, no DropZone/onPress
 * - tryMove already rejects any `to.zone` other than 'pyramid'/'waste', so it could never be a
 * legal drop target anyway). While `isFlyingHere`, the real (already-updated) top card is hidden
 * and a frozen copy of whatever was on top before is shown instead - same reasoning as Klondike's
 * FoundationCell - so the pile doesn't flash to its new top card before the ghost visually lands.
 * Unlike FoundationCell, this measures its position via a plain view ref (viewRef, passed a stable
 * discardViewRef from the caller), not per-card CardRegistry registration - there's only ever one
 * discard pile, not a slot whose occupant identity keeps changing. */
function DiscardCell({ card, isFlyingHere, viewRef }: { card: Card | undefined; isFlyingHere: boolean; viewRef: RefObject<View | null> }) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere);
  return (
    <View ref={viewRef} collapsable={false}>
      {card ? <PlayingCard card={card} disabled style={isFlyingHere && HIDDEN_CARD_STYLE} testID="discard-top" /> : <EmptySlot testID="discard-empty" />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {frozen ? <PlayingCard card={frozen} disabled /> : <EmptySlot />}
        </View>
      )}
    </View>
  );
}
// The triangle's widest row is the base: ROWS cards laid out with no overlap, so it reuses
// cardWidthForRow's clamping/fit math as a plain "row of ROWS columns" with a real gap.
const TRIANGLE_WIDTH_UNITS = ROWS;

function triangleWidth(cardWidth: number): number {
  return cardWidth * ROWS + COL_GAP * (ROWS - 1);
}

function cardPosition(row: number, col: number, cardWidth: number, cardHeight: number): { left: number; top: number } {
  const width = triangleWidth(cardWidth);
  const rowWidth = cardWidth * (row + 1) + COL_GAP * row;
  const rowLeftStart = (width - rowWidth) / 2;
  const left = rowLeftStart + col * (cardWidth + COL_GAP);
  // Rows cascade vertically like a FreeCell cascade - same offset ratio, so only the row below
  // (drawn on top, per its higher zIndex) overlaps the bottom of the row above.
  const top = row * (cardHeight * FACE_UP_OFFSET_RATIO);
  return { left, top };
}

/** Both DealProvider and DragGhostProvider wrap from outside PyramidScreenInner, the same split
 * Klondike/FreeCell/Spider use - PyramidScreenInner needs useDragGhost() itself now (to drive the
 * stock-draw fly animation), not just the DraggableCard/DropZone children that used to be its only
 * consumers. Moving DragGhostProvider up here doesn't change the rendered tree: neither it nor
 * DealProvider add a wrapping View of their own, so the ghost overlay still ends up as a plain
 * sibling of PyramidScreenInner's returned content, exactly as before. */
export default function PyramidScreen() {
  return (
    <DealProvider>
      <DragGhostProvider>
        <WinCascadeProvider>
          <PyramidScreenInner />
        </WinCascadeProvider>
      </DragGhostProvider>
    </DealProvider>
  );
}

function PyramidScreenInner() {
  const colors = useTableColors();
  const { dark } = useTheme();
  const { recordDealWon, recordDealAbandoned } = useGameStats();
  const { setLastActiveGame, clearLastActiveGame } = useLastActiveGame();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const dropZones = useDropZoneRegistry();
  const { width: winWidth } = useWindowDimensions();
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH);
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TRIANGLE_WIDTH_UNITS, COL_GAP);
  const cardHeight = cardWidth / CARD_ASPECT;
  const [state, setState] = useState<PyramidState | null>(null);
  const [selected, setSelected] = useState<PileRef | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const session = useGameSession();
  const [won, setWon] = useState(false);
  // Which card (if any) should play its "that pairing didn't work" shake right now - bumped
  // (not toggled) so tapping into the same failed pairing twice in a row re-triggers it both
  // times. Always exactly one card (the just-tapped one, `to` in attemptMove) since Pyramid
  // moves are never multi-card runs the way Klondike/Spider tableau moves can be.
  const [shake, setShake] = useState<{ cardId: string; token: number } | null>(null);
  const shakeTokenRef = useRef(0);
  const vibration = useVibration();
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects();
  const deal = useDealAnimator();
  const stockViewRef = useRef<View>(null);
  const triangleViewRef = useRef<View>(null);
  const discardViewRef = useRef<View>(null);
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set());
  const dealTokenRef = useRef(0);
  const pendingDealTokenRef = useRef<number | null>(null);
  const ghost = useDragGhost();
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null);
  /** A flight awaiting its post-commit measurement + ghost.flyTo (see the effect below) - set by
   * handleDrawStock once the drawn card's own render has been committed, or by handleUndo when
   * reversing a draw. `viaStock` measures via stockViewRef (a plain View, not per-card) instead of
   * CardRegistry - only undoing a draw flies back toward the stock; drawing itself flies to the
   * real per-card-registered waste slot. */
  const pendingFlightRef = useRef<{ cardId: string; viaStock?: boolean } | null>(null);
  const winCascade = useWinCascade();
  /** Mirrors pendingDealTokenRef/pendingFlightRef's own shape - set by the win-check effect,
   * consumed by the effect below once the winning discard pile has actually committed (see
   * runWinCascade). */
  const pendingWinCascadeRef = useRef<{ gen: number } | null>(null);

  // Same race documented for Klondike's deal/tap-move fixes: measuring CardRegistry synchronously
  // right after the setState in handleDrawStock would find the still-mounted PREVIOUS waste card
  // (the new one's own registration effect hasn't run yet), so the ghost would "fly" a near-zero
  // distance - indistinguishable from a snap. Deferring to a [state]-keyed effect guarantees the
  // new waste card has already registered by the time this runs.
  useEffect(() => {
    const pending = pendingFlightRef.current;
    if (!pending || !state) return;
    pendingFlightRef.current = null;
    (async () => {
      const landed = pending.viaStock ? await measureView(stockViewRef.current) : await ghost.cardRegistry.measure(pending.cardId);
      if (landed) {
        ghost.flyTo(landed.x, landed.y, () => setFlying(null));
      } else {
        ghost.hide();
        setFlying(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Runs once the just-set state has actually committed - see runDeal's comment above for why this
  // can't be called directly from startNewGame.
  useEffect(() => {
    if (pendingDealTokenRef.current === null || pendingDealTokenRef.current !== dealTokenRef.current || !state) return;
    const token = pendingDealTokenRef.current;
    pendingDealTokenRef.current = null;
    runDeal(state, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (!won && PyramidController.isWon(state)) {
      setWon(true);
      session.stopClock();
      recordDealWon('pyramid', { seconds: session.elapsed, moves: session.moves, score: computeScore(session.moves, session.elapsed) });
      clearGameInProgress('pyramid');
      pendingWinCascadeRef.current = { gen: dealTokenRef.current };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // state.discard always holds all 52 cards by the time isWon() is true (rules.ts's
  // sweepRemainderOnWin folds in whatever was left in stock/waste on the winning move), in true
  // removal order - reversed here so the most-recently-removed (currently on top of the physical
  // pile) leads the chain. Origin reuses discardViewRef, the same plain-view measurement the
  // pair/King fly-to-discard flight above already does. Same dealTokenRef guard as every other
  // async measurement in this file, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: PyramidState, gen: number) {
    const origin = await measureView(discardViewRef.current);
    if (dealTokenRef.current !== gen || !origin) return;
    winCascade.startChains([{ cards: s.discard.slice().reverse(), origin, entranceDelayMs: 0 }], cardWidth);
  }

  useEffect(() => {
    const pending = pendingWinCascadeRef.current;
    if (!pending || !state) return;
    pendingWinCascadeRef.current = null;
    runWinCascade(state, pending.gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function pushUndo(prev: PyramidState, move: MoveInfo | null) {
    setUndoStack((stack) => [...stack, { state: prev, move }]);
  }

  function startNewGame() {
    const myToken = ++dealTokenRef.current;
    const s = PyramidController.newGame(randomSeed());
    setSelected(null);
    setUndoStack([]);
    session.reset();
    setWon(false);
    winCascade.clear();
    pendingWinCascadeRef.current = null;

    const dealtIds = new Set(s.pyramid.filter((c): c is Card => !!c).map((c) => c.id));
    setDealHiddenIds(dealtIds);
    pendingDealTokenRef.current = myToken;
    setState(s);
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal), no fresh undo history.
  function restoreGame(saved: SavedGame<PyramidState>) {
    ++dealTokenRef.current;
    setSelected(null);
    setUndoStack([]);
    session.restore(saved.moves, saved.elapsedSeconds);
    setWon(false);
    setDealHiddenIds(new Set());
    setState(saved.state);
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('pyramid');
    startNewGame();
  }

  // Simpler than Klondike's equivalent: buildPyramidDealSequence has nothing to reorder (pyramid's
  // own flat index order already IS the natural apex-first, row-by-row deal order - see
  // dealSequence.ts), and every destination is analytically computable via cardPosition() - no
  // CardRegistry measurement needed for destinations, only for the stock/triangle origin points.
  // Same dealTokenRef guard as Klondike's runDeal, for the same reason (shuffle-independent card
  // ids - see deck.ts). Still deferred to the [state]-keyed effect below rather than called
  // directly from startNewGame, though: on the very first mount, `state` starts null and the whole
  // board (including stockViewRef/triangleViewRef) is behind the `if (!state)` Loading branch, so
  // those refs aren't attached yet when startNewGame's setState is only queued, not committed - a
  // direct call here would measure two null refs and silently skip the deal (dealHiddenIds reset to
  // empty, cards just appearing with no animation). A later "New Game" from an already-mounted board
  // would happen to work either way, since the container refs are already attached by then - but the
  // very first deal needs the same commit-then-measure sequencing Klondike/FreeCell/Spider use.
  async function runDeal(s: PyramidState, token: number) {
    const [stockOrigin, triangleOrigin] = await Promise.all([measureView(stockViewRef.current), measureView(triangleViewRef.current)]);
    if (dealTokenRef.current !== token) return;
    if (!stockOrigin || !triangleOrigin) {
      setDealHiddenIds(new Set());
      return;
    }

    const sequence = buildPyramidDealSequence(s.pyramid);
    const entries: DealCardSpec[] = sequence.map((step) => {
      const { row, col } = rowColOf(step.index);
      const { left, top } = cardPosition(row, col, cardWidth, cardHeight);
      return {
        cardId: step.cardId,
        card: step.card,
        from: stockOrigin,
        to: { x: triangleOrigin.x + left, y: triangleOrigin.y + top },
        delayMs: step.visitOrder * DEAL_STAGGER_MS,
      };
    });
    if (entries.length === 0) {
      setDealHiddenIds(new Set());
      return;
    }

    deal.start(
      entries,
      cardWidth,
      (cardId) => {
        if (dealTokenRef.current !== token) return;
        setDealHiddenIds((ids) => {
          if (!ids.has(cardId)) return ids;
          const next = new Set(ids);
          next.delete(cardId);
          return next;
        });
      },
      () => {}
    );
  }

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<PyramidState>('pyramid').then((saved) => {
      if (saved) restoreGame(saved);
      else startNewGame();
      setLastActiveGame('pyramid');
    });
    return () => clearLastActiveGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after the win-check effect above just cleared it.
  useEffect(() => {
    if (state && !won) saveGameInProgress('pyramid', { state, moves: session.moves, elapsedSeconds: session.elapsed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won]);

  // Mirrors handleDrawStock's forward flight, just in reverse: the drawn card is still sitting in
  // the waste (`move.to`) - measure its real current position before reverting (the
  // pendingFlightRef effect above can only measure a DESTINATION once it's committed and
  // re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and fly it back toward the stock (see pendingFlightRef's `viaStock`). A
  // pairing/King move (move === null) still reverts instantly, not animated - see the comment on
  // MoveInfo for why that's a deliberate scope choice rather than a leftover gap.
  async function handleUndo() {
    if (undoStack.length === 0 || !state) return;
    const entry = undoStack[undoStack.length - 1];
    const { move, state: prevState } = entry;

    if (!move) {
      setUndoStack((stack) => stack.slice(0, -1));
      setState(prevState);
      setSelected(null);
      return;
    }

    const movingCard = state.waste[state.waste.length - 1];
    const origin = movingCard && movingCard.id === move.anchorCardId ? await ghost.cardRegistry.measure(move.anchorCardId) : null;

    setUndoStack((stack) => stack.slice(0, -1));
    setSelected(null);

    if (origin && movingCard) {
      ghost.originX.value = origin.x;
      ghost.originY.value = origin.y;
      ghost.dx.value = 0;
      ghost.dy.value = 0;
      playCardSound();
      hapticCard();
      ghost.show({ cards: [movingCard], offsetStep: 0, cardWidth });
      setFlying({ to: move.from, count: move.count });
      setState(prevState);
      pendingFlightRef.current = { cardId: move.anchorCardId, viaStock: true };
    } else {
      setState(prevState);
    }
  }

  function refsEqual(a: PileRef, b: PileRef): boolean {
    return a.zone === b.zone && a.index === b.index;
  }

  function handleSelectPyramid(index: number, measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state) return;
    const card = state.pyramid[index];
    if (!card) return;
    const { row, col } = rowColOf(index);
    if (!isExposed(state.pyramid, row, col)) return;

    const ref: PileRef = { zone: 'pyramid', index };

    // Kings never pair with anything (no rank sums to 13 with one), so removing one is always a
    // standalone action - a single tap removes it immediately instead of needing a confirming
    // second tap the way an actual two-card pair does. This also clears/overrides any unrelated
    // card that happened to be selected, since a King tap was never going to complete that pair.
    if (card.rank === 13) {
      attemptMove(ref, ref, measure);
      return;
    }

    if (selected && refsEqual(selected, ref)) {
      // Tapping the same selected card again deselects. Never calls measure() - a plain
      // select/deselect has no use for the tapped card's position (see PileView.tsx's onPress
      // doc comment for why that's worth avoiding).
      setSelected(null);
      return;
    }

    if (!selected) {
      setSelected(ref);
      return;
    }

    attemptMove(selected, ref, measure);
  }

  function handleSelectWaste(measure: () => Promise<{ x: number; y: number }>) {
    if (won || !state) return;
    if (state.waste.length === 0) return;
    const ref: PileRef = { zone: 'waste', index: 0 };
    const card = state.waste[state.waste.length - 1];

    // Kings never pair with anything - a single tap removes one immediately, same as in the
    // pyramid (see handleSelectPyramid).
    if (card.rank === 13) {
      attemptMove(ref, ref, measure);
      return;
    }

    if (selected && refsEqual(selected, ref)) {
      setSelected(null);
      return;
    }

    if (!selected) {
      setSelected(ref);
      return;
    }

    attemptMove(selected, ref, measure);
  }

  // Shared tail for both attemptMove/attemptDrop below, once whichever ghost is currently showing
  // (a single card, mid stage-1 flight) has actually landed on the discard pile's real position.
  async function flyToDiscardPile() {
    const discardPos = await measureView(discardViewRef.current);
    if (discardPos) {
      ghost.flyTo(discardPos.x, discardPos.y, () => setFlying(null));
    } else {
      ghost.hide();
      setFlying(null);
    }
  }

  // Stage 2 of a pair's removal flight: re-shows the ghost as both cards stacked exactly on top
  // of each other (offsetStep 0 - a pyramid pair isn't a fanned run the way a tableau supermove
  // is) at `landingOrigin` (wherever stage 1 just landed - the "second" card's real position), then
  // flies that pair on to the discard pile. Called from stage 1's own onArrived callback, since
  // ghost.flyTo always hides the ghost right before invoking it - a fresh ghost.show() is required
  // to keep flying rather than just continuing the same one.
  function flyPairToDiscard(firstCard: Card, secondCard: Card, landingOrigin: { x: number; y: number }) {
    ghost.originX.value = landingOrigin.x;
    ghost.originY.value = landingOrigin.y;
    ghost.dx.value = 0;
    ghost.dy.value = 0;
    ghost.show({ cards: [{ ...firstCard, faceUp: true }, { ...secondCard, faceUp: true }], offsetStep: 0, cardWidth });
    flyToDiscardPile();
  }

  // Tap-completed pairing/King removal. The real state change applies immediately (game logic
  // never waits on an animation, same as every other move in this app) - the ghost is purely a
  // visual overlay catching up to an already-true reality, hiding the discard pile's real new top
  // card (via `flying`/DiscardCell's isFlyingHere) until it visually arrives.
  async function attemptMove(from: PileRef, to: PileRef, measureOrigin: () => Promise<{ x: number; y: number }>) {
    if (!state) return;
    const isSolo = refsEqual(from, to);
    const fromCard = cardAt(state, from);
    const toCard = isSolo ? fromCard : cardAt(state, to);

    const result = PyramidController.tryMove(state, { from, to, count: 1 });
    if (!result) {
      // Illegal pairing: swap the selection to the newly tapped card instead
      // of just clearing it, so the user doesn't have to tap twice again. Shake the
      // just-tapped card (not the previously-selected one) so the rejection reads as "that
      // one, not this pairing" - same "received, just stuck" feedback the other 3 games give
      // a single stuck card, with a short haptic tap alongside (see shakeAnimation.ts).
      // Deliberately never calls measureOrigin() - an illegal pairing has no use for the
      // tapped card's position, so it skips paying for the measurement at all (see
      // PileView.tsx's onPress doc comment).
      if (toCard) setShake({ cardId: toCard.id, token: ++shakeTokenRef.current });
      vibration.short();
      playInvalidSound();
      setSelected(to);
      return;
    }

    const toOrigin = await measureOrigin();

    if (isSolo) {
      pushUndo(state, null);
      session.registerMove();
      setSelected(null);
      if (!fromCard) {
        setState(result);
        return;
      }
      // toOrigin IS the King's own tap position here (from === to) - no registry measurement
      // needed, unlike the pair case below where "first" was selected on a PREVIOUS tap.
      setFlying({ to: { zone: 'discard', index: 0 }, count: 1 });
      setState(result);
      ghost.originX.value = toOrigin.x;
      ghost.originY.value = toOrigin.y;
      ghost.dx.value = 0;
      ghost.dy.value = 0;
      playCardSound();
      hapticCard();
      ghost.show({ cards: [{ ...fromCard, faceUp: true }], offsetStep: 0, cardWidth });
      await flyToDiscardPile();
      return;
    }

    // Pair: "first" (from) was selected on a previous tap - measure its CURRENT position via the
    // registry (same technique handleUndo uses) before setState unmounts it. "second" (to) is
    // already in hand as toOrigin, from the tap that just completed the pair.
    const fromOrigin = fromCard ? await ghost.cardRegistry.measure(fromCard.id) : null;

    pushUndo(state, null);
    session.registerMove();
    setSelected(null);

    if (!fromCard || !toCard || !fromOrigin) {
      setState(result);
      return;
    }

    setFlying({ to: { zone: 'discard', index: 0 }, count: 2 });
    setState(result);
    ghost.originX.value = fromOrigin.x;
    ghost.originY.value = fromOrigin.y;
    ghost.dx.value = 0;
    ghost.dy.value = 0;
    playCardSound();
    hapticCard();
    ghost.show({ cards: [{ ...fromCard, faceUp: true }], offsetStep: 0, cardWidth });
    ghost.flyTo(toOrigin.x, toOrigin.y, () => flyPairToDiscard(fromCard, toCard, toOrigin));
  }

  // Drag-completed pairing/King removal - same choreography as attemptMove above, just sourced
  // from a drop instead of a second tap. The dragged ("first") card's ghost already exists by drop
  // time (DraggableCard's own pan gesture calls ghost.show() on drag start, against this same
  // shared useDragGhost() context, and deliberately leaves it mounted on a successful drop for the
  // caller to resolve - see handleRelease) - so unlike the tap case, stage 1 never needs its own
  // ghost.show() call, only flyTo.
  async function attemptDrop(from: PileRef, absoluteX: number, absoluteY: number): Promise<boolean> {
    if (!state) return false;
    const target = await dropZones.hitTest(absoluteX, absoluteY);
    if (!target) return false;

    const isSolo = refsEqual(from, target);
    const fromCard = cardAt(state, from);
    const toCard = isSolo ? fromCard : cardAt(state, target);

    const result = PyramidController.tryMove(state, { from, to: target, count: 1 });
    if (!result) return false;

    pushUndo(state, null);
    session.registerMove();
    setSelected(null);

    if (isSolo) {
      if (!fromCard) {
        setState(result);
        ghost.hide();
        return true;
      }
      setFlying({ to: { zone: 'discard', index: 0 }, count: 1 });
      setState(result);
      await flyToDiscardPile();
      return true;
    }

    // "second" (target)'s exact position isn't necessarily where the pointer released (anywhere
    // within its drop-zone hit-box counts) - measure it via the registry before setState unmounts
    // it, same as the tap case measures "first" via registry.
    const toOrigin = toCard ? await ghost.cardRegistry.measure(toCard.id) : null;

    if (!fromCard || !toCard || !toOrigin) {
      setState(result);
      ghost.hide();
      return true;
    }

    setFlying({ to: { zone: 'discard', index: 0 }, count: 2 });
    setState(result);
    ghost.flyTo(toOrigin.x, toOrigin.y, () => flyPairToDiscard(fromCard, toCard, toOrigin));
    return true;
  }

  // Mirrors Klondike's handleDrawStock: a ghost copy of the newly-drawn card flies from the stock
  // pile to the waste slot, landing once the pendingFlightRef effect above measures its real
  // (already re-rendered) position.
  async function handleDrawStock() {
    if (won || !state) return;
    const result = PyramidController.drawStock!(state);
    if (!result) return;
    session.registerMove();

    const drawnCard = result.waste[result.waste.length - 1];
    if (!drawnCard) {
      pushUndo(state, null);
      setState(result);
      setSelected(null);
      return;
    }
    const move: MoveInfo = { from: { zone: 'stock', index: 0 }, to: { zone: 'waste', index: 0 }, count: 1, anchorCardId: drawnCard.id };
    const origin = await measureView(stockViewRef.current);
    if (!origin) {
      pushUndo(state, move);
      setState(result);
      setSelected(null);
      return;
    }

    ghost.originX.value = origin.x;
    ghost.originY.value = origin.y;
    ghost.dx.value = 0;
    ghost.dy.value = 0;
    playCardSound();
    hapticCard();
    ghost.show({ cards: [drawnCard], offsetStep: 0, cardWidth });
    setFlying({ to: { zone: 'waste', index: 0 }, count: 1 });

    pushUndo(state, move);
    setState(result);
    setSelected(null);
    pendingFlightRef.current = { cardId: drawnCard.id };
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.timer}>Loading...</Text>
      </View>
    );
  }

  const width = triangleWidth(cardWidth);
  const height = (ROWS - 1) * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight;
  const wasteTop = state.waste[state.waste.length - 1];

  return (
    <CardSizeProvider width={cardWidth}>
    <GameChrome
      title="Pyramid"
      onNewGame={handleNewGame}
      onUndo={handleUndo}
      undoDisabled={undoStack.length === 0}
      hasProgress={session.moves > 0}
      elapsedSeconds={session.elapsed}
      movesCount={session.moves}
    >
      <View style={styles.board}>
      <View ref={triangleViewRef} collapsable={false} style={[styles.triangle, { width, height }]}>
        {state.pyramid.map((card, index) => {
          if (!card) return null;
          const { row, col } = rowColOf(index);
          const { left, top } = cardPosition(row, col, cardWidth, cardHeight);
          const exposed = isExposed(state.pyramid, row, col);
          const isDealHidden = dealHiddenIds.has(card.id);
          const isSelected = !!selected && selected.zone === 'pyramid' && selected.index === index;
          const pileRef: PileRef = { zone: 'pyramid', index };
          const cardStyle = [styles.pyramidCard, { left, top, zIndex: row }];

          if (!exposed) {
            return (
              <PlayingCard key={card.id} card={card} disabled dimmed style={[cardStyle, isDealHidden && styles.hiddenCard]} testID={`pyramid-${index}`} />
            );
          }

          return (
            <DropZone key={card.id} registry={dropZones} pileRef={pileRef} style={cardStyle}>
              <DraggableCard
                card={card}
                selected={isSelected}
                hidden={isDealHidden}
                onPress={(measure) => handleSelectPyramid(index, measure)}
                onDrop={(x, y) => attemptDrop(pileRef, x, y)}
                shakeToken={shake?.cardId === card.id ? shake.token : undefined}
                testID={`pyramid-${index}`}
              />
            </DropZone>
          );
        })}
      </View>

      <View style={styles.controlRow}>
        <DiscardCell
          card={won ? undefined : state.discard[state.discard.length - 1]}
          isFlyingHere={!!flying && flying.to.zone === 'discard'}
          viewRef={discardViewRef}
        />
        <StockWaste
          style={styles.stockRow}
          dropZones={dropZones}
          stockTopCard={state.stock[state.stock.length - 1]}
          wasteTop={wasteTop}
          wasteSelected={!!selected && selected.zone === 'waste'}
          wasteHiddenCount={flying && flying.to.zone === 'waste' ? 1 : 0}
          wasteShakeToken={wasteTop && shake?.cardId === wasteTop.id ? shake.token : undefined}
          onDrawStock={handleDrawStock}
          onWastePress={handleSelectWaste}
          onWasteDrop={(x, y) => attemptDrop({ zone: 'waste', index: 0 }, x, y)}
          stockRef={stockViewRef}
        />
      </View>

      </View>
    </GameChrome>
    {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it. Also why winBanner itself became a full-screen centering overlay here
    (position:absolute, see its style) instead of staying an in-flow block under controlRow: an
    in-flow, deeply-nested position can't reliably out-paint these screen-level siblings at all,
    regardless of styling. */}
    {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
    <WinCascadeGhosts />
    {won && (
      <View style={styles.winOverlay}>
        <View style={styles.winBanner}>
          <Text style={styles.winText}>
            Pyramid cleared! {formatTime(session.elapsed)} · {session.moves} moves · Score {computeScore(session.moves, session.elapsed)}
          </Text>
          <Pressable style={styles.button} onPress={startNewGame}>
            <Text style={styles.buttonText}>New Game</Text>
          </Pressable>
        </View>
      </View>
    )}
    </CardSizeProvider>
  );
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.tableFelt,
    alignItems: 'center',
    padding: 16,
  },
  // GameChrome's own content area now centers a natural-width board itself (see GameChrome.tsx's
  // GAME_CONTENT_MAX_WIDTH/ContentGutter wiring) - board no longer needs width:'100%' to opt into
  // that. alignItems:'center' still does its own separate job here: centering controlRow (narrower
  // than triangle) within board's own width, which now naturally shrinks to match triangle's real
  // width instead of an artificial full-window one.
  board: {
    alignItems: 'center',
  },
  timer: {
    color: '#fff',
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 16,
    fontWeight: '700',
  },
  // zIndex below (`row`) only stays scoped to this container if the container itself
  // establishes a stacking context - position:relative alone doesn't, without its own zIndex
  // (see PileView.tsx's identical fix for its tableau fan). Without this, a row's zIndex leaks
  // out to compete with the screen-level drag/deal ghost overlays, which lost that fight past
  // row 0, rendering "under" the triangle mid-flight.
  triangle: {
    position: 'relative',
    zIndex: 0,
    marginBottom: 20,
  },
  pyramidCard: {
    position: 'absolute',
  },
  hiddenCard: {
    opacity: 0,
  },
  controlRow: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 20,
  },
  stockRow: {
    gap: 24,
  },
  button: {
    backgroundColor: '#ffffffee',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  buttonText: {
    color: colors.tableFeltDark,
    fontFamily: CARD_FONT_FAMILY,
    fontWeight: '700',
    fontSize: 14,
  },
  // Transparent (unlike Klondike/FreeCell's own winOverlay) - Pyramid's win treatment was never a
  // dimmed scrim, just a centered card; this only exists now to center winBanner as a screen-level
  // overlay instead of an in-flow block (see the JSX for why it has to be one).
  winOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  winBanner: {
    alignItems: 'center',
    backgroundColor: '#ffffffee',
    borderRadius: 12,
    padding: 18,
    gap: 12,
  },
  winText: {
    color: colors.tableFeltDark,
    fontFamily: CARD_FONT_FAMILY,
    fontWeight: '800',
    fontSize: 18,
  },
  });
}
