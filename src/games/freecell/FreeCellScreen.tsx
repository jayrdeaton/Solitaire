import { Fireworks } from '@tastic/animations/fireworks';
import { Pressable, useVibration } from '@rific/feedback-press';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import { computeContentBounds } from '@tastic/core';

import { Card, Suit, SUITS } from '@/engine/types';
import { AccessibleCard, PileRef } from '@/engine/gameTypes';
import { randomSeed } from '@/engine/rng';
import { isDescendingAltColor, top } from '@/engine/pile';
import { findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation';
import { CardSizeProvider, cardWidthForRow } from '@/components/CardSizeContext';
import { faceUpFanOffset } from '@/components/cards/CardFace';
import { formatTime, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GameChrome } from '@/components/GameChrome';
import { EmptySlot, FoundationSlot, PlayingCard } from '@/components/PlayingCard';
import { PileDragConfig, PileView } from '@/components/PileView';
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
import { ChainSpec, useWinCascade, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer';
import { CHAIN_ENTRANCE_STAGGER_MS } from '@/components/winning/winCascadeMotion';
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden';
import { useGameSession } from '@/components/useGameSession';
import { computeScore } from '@/engine/score';
import { useGameStats } from '@/stores/gameStats';
import { clearGameInProgress, loadGameInProgress, SavedGame, saveGameInProgress } from '@/stores/gameInProgress';
import { useLastActiveGame } from '@/stores/lastActiveGame';
import { buildFreeCellDealSequence } from './dealSequence';
import { FreeCellController, FreeCellState } from './rules';

const TABLEAU_MAX_HEIGHT = 460;
const TABLEAU_COLUMNS = 8;
const TABLEAU_GAP = 10;
// Plain (theme-independent) style for FoundationCell below - it's a module-level component, so it
// can't reach FreeCellScreenInner's own theme-derived `styles`.
const HIDDEN_CARD_STYLE = { opacity: 0 };
// FreeCell has no stock pile of its own to visually deal from (rules.ts's newGame deals straight
// into the tableau; freecells start, and stay, empty throughout the deal) - the far-right freecell
// doubles as the deck the deal animation flies out of instead, showing this face-down placeholder
// only while dealing (see the freecells row below). Never a real card - just needs to be
// Card-shaped, since a face-down PlayingCard never reads rank/suit.
const DECK_PLACEHOLDER_CARD: Card = { id: 'freecell-deck-origin', suit: 'spades', rank: 1, faceUp: false };

/** Records enough about an applied move to reverse its animation later - undoing doesn't just
 * revert to the previous state snapshot, it flies the moved card(s) back from wherever they
 * currently sit (`to`) to their previous pile (`from`), mirroring the forward flight in reverse. */
interface MoveInfo {
  from: PileRef;
  to: PileRef;
  count: number;
  anchorCardId: string;
}

interface UndoEntry {
  state: FreeCellState;
  move: MoveInfo;
}

/** One foundation pile's display. The real `card` stays mounted and registered in CardRegistry
 * the whole time (just invisible while `isFlyingHere`) - the tap-to-move flight measures its
 * destination by looking up exactly this registration, so hiding it by swapping it out entirely
 * (rather than by opacity) would leave the flight with nothing to measure and no real target to
 * land on. A frozen copy of whatever was on top before is shown instead while flying, so the slot
 * doesn't go blank for the whole flight - purely decorative, not itself registered.
 *
 * `slotRef`, separately, always points at this same outer container regardless of whether `card`
 * is hidden - the win cascade (see runWinCascade) needs to measure this slot's position AFTER the
 * real King has already been hidden (won-gated, see the caller), by which point it's no longer
 * CardRegistry-registered at all. */
function FoundationCell({
  card,
  isFlyingHere,
  suit,
  slotRef,
}: {
  card: Card | undefined;
  isFlyingHere: boolean;
  suit: Suit;
  slotRef?: (el: View | null) => void;
}) {
  const ghost = useDragGhost();
  const viewRef = useRef<View>(null);
  const frozen = useFrozenWhileHidden(card, isFlyingHere);

  useEffect(() => {
    if (!card) return;
    const id = card.id;
    ghost.cardRegistry.register(id, viewRef);
    return () => ghost.cardRegistry.unregister(id, viewRef);
  }, [card, ghost.cardRegistry]);

  return (
    <View
      ref={(el) => {
        viewRef.current = el;
        slotRef?.(el);
      }}
      collapsable={false}
    >
      {card ? <PlayingCard card={card} style={isFlyingHere && HIDDEN_CARD_STYLE} /> : <FoundationSlot suit={suit} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {frozen ? <PlayingCard card={frozen} /> : <FoundationSlot suit={suit} />}
        </View>
      )}
    </View>
  );
}

/** A freecell's display - same reasoning as FoundationCell above: the real `card` stays mounted
 * and registered (via DraggableCard, just hidden by opacity) so the flight has something to
 * measure, while a frozen, decorative copy of whatever was there before (always empty, for a
 * freecell - see useFrozenWhileHidden) covers it while flying. */
function FreecellCell({
  card,
  isFlyingHere,
  shakeToken,
  onPress,
  onDrop,
}: {
  card: Card | undefined;
  isFlyingHere: boolean;
  shakeToken?: number;
  /** Lazy measure function - see DraggableCard.tsx's onPress doc comment for why (this is a
   * straight pass-through to that same prop). */
  onPress: (measure: () => Promise<{ x: number; y: number }>) => void;
  onDrop: (x: number, y: number) => Promise<boolean> | boolean;
}) {
  const frozen = useFrozenWhileHidden(card, isFlyingHere);
  return (
    <View>
      {card ? (
        <DraggableCard card={card} hidden={isFlyingHere} shakeToken={shakeToken} emptyFallback={<EmptySlot />} onPress={onPress} onDrop={onDrop} />
      ) : (
        <EmptySlot />
      )}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {frozen ? <PlayingCard card={frozen} /> : <EmptySlot />}
        </View>
      )}
    </View>
  );
}

/** Thin wrapper so the screen body below can be a descendant of its own DragGhostProvider - it
 * needs useDragGhost() itself now (to drive the tap-to-move fly animation), not just the
 * PileView/DraggableCard children that used to be its only consumers. DealProvider wraps from
 * further out still, for the initial-deal animation (see components/dealing/DealLayer.tsx) - the
 * same split Klondike/Pyramid/Spider use. */
export default function FreeCellScreen() {
  return (
    <DealProvider>
      <DragGhostProvider>
        <WinCascadeProvider>
          <FreeCellScreenInner />
        </WinCascadeProvider>
      </DragGhostProvider>
    </DealProvider>
  );
}

function FreeCellScreenInner() {
  const colors = useTableColors();
  const { dark } = useTheme();
  const { recordDealWon, recordDealAbandoned } = useGameStats();
  const { setLastActiveGame, clearLastActiveGame } = useLastActiveGame();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const dropZones = useDropZoneRegistry();
  const [state, setState] = useState<FreeCellState | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const session = useGameSession();
  const [won, setWon] = useState(false);
  const recordedWinRef = useRef(false);
  const { width: winWidth } = useWindowDimensions();
  const { contentWidth } = computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH);
  const cardWidth = cardWidthForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS, TABLEAU_GAP);
  const ghost = useDragGhost();
  const [flying, setFlying] = useState<{ to: PileRef; count: number } | null>(null);
  // `fast` marks a fireAutoMove-triggered flight, so the effect below passes it on to ghost.flyTo
  // for the quicker auto-play-to-foundation timing (see dragSpring.ts's autoPlaySpringFor). `gen`
  // is the `dealTokenRef` value at the moment this flight was queued - re-checked once the async
  // measurement below resolves, so a flight queued against a game that's since been replaced by
  // "New Game" doesn't measure/land against the new deal's DOM (card ids are shuffle-independent
  // and reused across deals - see deck.ts). Mirrors exactly how runDeal below already guards itself
  // with dealTokenRef/pendingDealTokenRef.
  const pendingAutoMoveCardIdRef = useRef<{ cardId: string; fast?: boolean; gen: number } | null>(null);
  const deal = useDealAnimator();
  const dealOriginRef = useRef<View>(null);
  const [dealHiddenIds, setDealHiddenIds] = useState<Set<string>>(new Set());
  // Separate from dealHiddenIds (which tracks each tableau card's own landing) - the deck
  // placeholder should read as exhausted the moment the LAST card actually leaves it, not once
  // every card has finished landing. See runDeal's setTimeout for the timing.
  const [deckVisible, setDeckVisible] = useState(false);
  const dealTokenRef = useRef(0);
  const pendingDealTokenRef = useRef<number | null>(null);
  const winCascade = useWinCascade();
  /** Mirrors pendingDealTokenRef/pendingAutoMoveCardIdRef's own shape - set by checkWin, consumed
   * by the [state]-effect below once the winning foundation cards have actually committed and
   * registered themselves in CardRegistry (see runWinCascade). */
  const pendingWinCascadeRef = useRef<{ gen: number } | null>(null);
  /** One ref per foundation slot's own container (see FoundationCell's slotRef) - measured
   * independently of CardRegistry so the win cascade can still find each pile's screen position
   * after its real King has been hidden (won-gated, see the foundation row below), at which point
   * that card is no longer CardRegistry-registered at all. */
  const foundationSlotRefs = useRef<(View | null)[]>(new Array(4).fill(null));
  const vibration = useVibration();
  const { playCardSound, playInvalidSound, hapticCard } = useCardSoundEffects();
  // Which card (if any) should play its "nowhere to go" shake right now - see handleCardTap and
  // shakeAnimation.ts. shakeTokenRef only ever counts up, so tapping the same stuck card again
  // still bumps to a new value and re-triggers the shake instead of being a no-op state update.
  const [shake, setShake] = useState<{ cardId: string; count: number; token: number } | null>(null);
  const shakeTokenRef = useRef(0);
  // Mirrors `state` synchronously (assigned directly in the render body, same pattern PileView.tsx
  // uses) so fireAutoMove - which has an await gap before it applies its move, unlike every other
  // mutator here - can tell if some other action already changed state underneath it and bail
  // instead of applying against a stale snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Set right after handleUndo's guard, consumed (and cleared) by the auto-play watcher effect
  // below - suppresses exactly one auto-play check after an undo, so undo doesn't immediately get
  // replayed by the very mechanism it just reverted.
  const justUndidRef = useRef(false);

  // Resumes a saved board if one exists, otherwise deals fresh - either way, this screen becomes
  // the "last active game" for as long as it stays mounted (see app/index.tsx), and stops being it
  // the instant the player actually backs out (a Back tap, swipe-back, or hardware back all unmount
  // this the same way - unlike merely backgrounding the app, which leaves it mounted).
  useEffect(() => {
    loadGameInProgress<FreeCellState>('freecell').then((saved) => {
      if (saved) restoreGame(saved);
      else startNewGame();
      setLastActiveGame('freecell');
    });
    return () => clearLastActiveGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saves after every move/undo/autoplay/fresh-deal (all flow through setState). Gated on !won:
  // Undo is never disabled post-win (a pre-existing gap, out of scope here), so without this guard,
  // winning and then tapping the still-enabled Undo would resurrect a save for an already-resolved
  // deal right after checkWin below just cleared it.
  useEffect(() => {
    if (state && !won) saveGameInProgress('freecell', { state, moves: session.moves, elapsedSeconds: session.elapsed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, won]);

  // dealTokenRef guards against a stray late measurement/landing from this deal delivering a
  // callback into a newer one - card ids are shuffle-independent (see deck.ts), so a fresh
  // newGame() reuses the same ids a previous deal was still using. Origin is the far-right
  // freecell's placeholder (see dealOriginRef/DECK_PLACEHOLDER_CARD above) rather than a real
  // stock pile - FreeCell has none. Unlike Klondike's runDeal, the flying card isn't forced
  // face-down: real FreeCell deals every card face up from the start (rules.ts's newGame already
  // sets faceUp: true on the whole deck), so step.card's own faceUp is left as-is.
  async function runDeal(s: FreeCellState, token: number) {
    const sequence = buildFreeCellDealSequence(s.tableau);
    const [origin, destinations] = await Promise.all([
      measureView(dealOriginRef.current),
      Promise.all(sequence.map((step) => ghost.cardRegistry.measure(step.cardId))),
    ]);
    if (dealTokenRef.current !== token) return;
    if (!origin) {
      setDealHiddenIds(new Set());
      setDeckVisible(false);
      return;
    }

    const entries: DealCardSpec[] = [];
    sequence.forEach((step, i) => {
      const dest = destinations[i];
      if (!dest) return;
      entries.push({
        cardId: step.cardId,
        card: step.card,
        from: origin,
        to: { x: dest.x, y: dest.y },
        delayMs: step.visitOrder * DEAL_STAGGER_MS,
      });
    });
    if (entries.length === 0) {
      setDealHiddenIds(new Set());
      setDeckVisible(false);
      return;
    }

    // The deck should look exhausted the instant its last card actually leaves it (starts its own
    // delayed flight), not once every card has finished landing - those are DEAL_SPRING.duration
    // apart, and waiting for the latter would show the placeholder still sitting there with its
    // last card already visibly flying away. Mirrors that card's own delayMs, guarded by the same
    // dealTokenRef check every other async step here uses.
    const lastDelayMs = Math.max(...entries.map((entry) => entry.delayMs));
    setTimeout(() => {
      if (dealTokenRef.current !== token) return;
      setDeckVisible(false);
    }, lastDelayMs);

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
      () => {
        // Safety net for a tap-to-skip mid-deal: every card lands at once, including any whose
        // own delay hadn't elapsed yet, so the setTimeout above may not have fired yet - this
        // guarantees the deck disappears exactly when the deal actually finishes either way.
        if (dealTokenRef.current !== token) return;
        setDeckVisible(false);
      }
    );
  }

  // Foundation piles are guaranteed full (13 cards each, Ace..King) the instant isWon() is true -
  // measures each pile's own slot container (see foundationSlotRefs/FoundationCell's slotRef),
  // not the King via CardRegistry, since the real King is hidden (and therefore unregistered) the
  // instant `won` flips true, in the same commit this effect reacts to. Chains that whole pile
  // King-first/head down to Ace-last/tail (foundation arrays are built bottom-up, Ace pushed
  // first, so reversing gives the right order). Same dealTokenRef guard as every other async
  // measurement here, for the same "New Game tapped mid-measurement" reason.
  async function runWinCascade(s: FreeCellState, gen: number) {
    const origins = await Promise.all(foundationSlotRefs.current.map((view) => measureView(view)));
    if (dealTokenRef.current !== gen) return;
    const chains: ChainSpec[] = [];
    s.foundation.forEach((pile, suit) => {
      const origin = origins[suit];
      if (!origin || pile.length === 0) return;
      chains.push({ cards: pile.slice().reverse(), origin, entranceDelayMs: chains.length * CHAIN_ENTRANCE_STAGGER_MS });
    });
    winCascade.startChains(chains, cardWidth);
  }

  // Runs once the just-set (but fully hidden) tableau has actually committed and its cards have
  // registered themselves, and only once the deck placeholder below has too - same reasoning as
  // Klondike's identical effect: measuring any earlier (e.g. synchronously right after setState)
  // races the still-mounted previous deal's cards against the new ones' not-yet-run registration
  // effects.
  useEffect(() => {
    if (pendingDealTokenRef.current === null || pendingDealTokenRef.current !== dealTokenRef.current || !state) return;
    const token = pendingDealTokenRef.current;
    pendingDealTokenRef.current = null;
    runDeal(state, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Measuring CardRegistry synchronously right after the setState in applyMove would find the
  // still-mounted SOURCE card (the destination card's own registration effect hasn't run yet), so
  // the ghost would "fly" a near-zero distance back to roughly where it started - indistinguishable
  // from a snap (same race documented for Klondike's deal animation). Deferring to a [state]-keyed
  // effect guarantees the destination card has already registered by the time this runs.
  useEffect(() => {
    const pending = pendingAutoMoveCardIdRef.current;
    if (!pending || !state) return;
    pendingAutoMoveCardIdRef.current = null;
    (async () => {
      const landed = await ghost.cardRegistry.measure(pending.cardId);
      // A new game can start while the measurement above is in flight (e.g. tapping "New Game"
      // mid auto-play-cascade - see maybeAutoPlay). `landed`, if it resolved at all, would then be
      // measuring an unrelated card in the NEW deal (ids are shuffle-independent and reused across
      // deals - see deck.ts), so drop this flight instead of landing on a nonsensical position.
      if (dealTokenRef.current !== pending.gen || !landed) {
        ghost.hide();
        setFlying(null);
        return;
      }
      ghost.flyTo(landed.x, landed.y, () => setFlying(null), { fast: pending.fast });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Same deferral reasoning as the deal/flight effects above - never measure CardRegistry
  // synchronously inside checkWin itself, since the winning foundation cards' own registration
  // effects haven't necessarily run yet in that same commit.
  useEffect(() => {
    const pending = pendingWinCascadeRef.current;
    if (!pending || !state) return;
    pendingWinCascadeRef.current = null;
    runWinCascade(state, pending.gen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Drives the auto-play-to-foundation cascade: re-checks maybeAutoPlay every time the board
  // settles with nothing else animating. `flying !== null` guards against overlapping the
  // single-ghost system (an auto-play's own landing sets it back to null, which re-triggers this
  // effect - the cascade is self-sustaining with no explicit recursion); `dealHiddenIds.size > 0`
  // guards against firing mid-deal, since the deal animation never touches `flying` at all.
  useEffect(() => {
    if (!state || flying !== null || dealHiddenIds.size > 0) return;
    if (justUndidRef.current) {
      justUndidRef.current = false;
      return;
    }
    maybeAutoPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, flying, dealHiddenIds]);

  function startNewGame() {
    const myToken = ++dealTokenRef.current;
    const s = FreeCellController.newGame(randomSeed());
    setUndoStack([]);
    session.reset();
    setWon(false);
    recordedWinRef.current = false;
    winCascade.clear();
    pendingWinCascadeRef.current = null;

    const dealtIds = new Set(s.tableau.flat().map((c) => c.id));
    setDealHiddenIds(dealtIds);
    setDeckVisible(true);
    pendingDealTokenRef.current = myToken;
    setState(s);
  }

  // Restores a previously saved board exactly as left - no deal-fly-in animation (this isn't a new
  // deal), no fresh undo history, and no deck placeholder (deckVisible stays false - nothing is
  // dealing).
  function restoreGame(saved: SavedGame<FreeCellState>) {
    ++dealTokenRef.current;
    setUndoStack([]);
    session.restore(saved.moves, saved.elapsedSeconds);
    setWon(false);
    recordedWinRef.current = false;
    setDealHiddenIds(new Set());
    setDeckVisible(false);
    setState(saved.state);
  }

  // Dealing a new game over one still in progress abandons it (counted as a loss) - GameChrome
  // only ever calls this after the player has confirmed that, or immediately when there's nothing
  // to lose (see components/GameChrome.tsx's warning dialog).
  function handleNewGame() {
    // session.moves, not undoStack.length: a resumed deal always restores with an empty undo
    // stack (see restoreGame above) even when it has real progress, so undoStack alone would miss
    // recording the abandon for any resumed, in-progress game.
    if (session.moves > 0 && !won) recordDealAbandoned('freecell');
    startNewGame();
  }

  function pushUndo(prev: FreeCellState, move: MoveInfo) {
    setUndoStack((stack) => [...stack, { state: prev, move }]);
  }

  // Mirrors handleCardTap's forward flight, just in reverse: the card(s) being undone are still
  // sitting wherever the move left them (`move.to`) - measure that real position before reverting
  // (the pendingAutoMoveCardIdRef effect below can only measure a DESTINATION once it's committed
  // and re-rendered, so the ORIGIN has to be captured here, synchronously against the still-current
  // state), then revert and mark `move.from` as incoming so it flies the rest of the way there
  // exactly like a fresh move would.
  async function handleUndo() {
    if (undoStack.length === 0 || !state) return;
    justUndidRef.current = true;
    const entry = undoStack[undoStack.length - 1];
    const { move, state: prevState } = entry;

    const sourcePile = resolvePile(move.to);
    const movingCards = sourcePile ? sourcePile.slice(sourcePile.length - move.count) : [];
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0;
    const origin = movingCards.length > 0 ? await ghost.cardRegistry.measure(move.anchorCardId) : null;

    setUndoStack((stack) => stack.slice(0, -1));

    if (origin) {
      ghost.originX.value = origin.x;
      ghost.originY.value = origin.y;
      ghost.dx.value = 0;
      ghost.dy.value = 0;
      playCardSound();
      hapticCard();
      ghost.show({ cards: movingCards, offsetStep, cardWidth });
      setFlying({ to: move.from, count: move.count });
      setState(prevState);
      pendingAutoMoveCardIdRef.current = { cardId: move.anchorCardId, gen: dealTokenRef.current };
    } else {
      setState(prevState);
    }
  }

  function checkWin(next: FreeCellState, movesSoFar: number) {
    if (FreeCellController.isWon(next) && !recordedWinRef.current) {
      recordedWinRef.current = true;
      session.stopClock();
      setWon(true);
      recordDealWon('freecell', { seconds: session.elapsed, moves: movesSoFar, score: computeScore(movesSoFar, session.elapsed) });
      clearGameInProgress('freecell');
      pendingWinCascadeRef.current = { gen: dealTokenRef.current };
    }
  }

  // `silent` is for the auto-play-to-foundation feature (see maybeAutoPlay/fireAutoMove below): an
  // auto-played card isn't a player decision, so it skips the undo stack entirely (one Undo press
  // reverts the whole triggering move plus any cascade it set off, in one step) and doesn't count
  // toward the moves/score the player is judged on.
  function applyMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean }) {
    if (!state) return false;
    const result = FreeCellController.tryMove(state, { from, to, count });
    if (result) {
      if (!opts?.silent) pushUndo(state, { from, to, count, anchorCardId });
      setState(result);
      const movesSoFar = opts?.silent ? session.moves : session.registerMove();
      checkWin(result, movesSoFar);
      return true;
    }
    return false;
  }

  function resolvePile(ref: PileRef): Card[] | null {
    if (!state) return null;
    switch (ref.zone) {
      case 'tableau':
        return state.tableau[ref.index] ?? null;
      case 'foundation':
        return state.foundation[ref.index] ?? null;
      case 'freecell': {
        const c = state.freecells[ref.index];
        return c ? [c] : null;
      }
      default:
        return null;
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
    if (!state || !FreeCellController.autoMoveHint) return;
    const move = FreeCellController.autoMoveHint(state, ref, cardId);
    if (!move) {
      // Nowhere legal to go - shake the card so the tap reads as "received, just stuck" rather
      // than a dead press, with a short haptic tap alongside (see shakeAnimation.ts). Tapping mid-
      // stack (indexFromTop > 0) with a valid run below shakes that whole run, not just the one
      // card under the finger - it's the same "stuck" outcome for all of them. Deliberately never
      // calls measure() - this branch has no use for the tapped card's position, so it skips
      // paying for the measurement at all (see PileView.tsx's onPress doc comment).
      const count = ref.zone === 'tableau' && indexFromTop !== undefined ? Math.max(1, tableauRunCount(ref.index, indexFromTop)) : 1;
      setShake({ cardId, count, token: ++shakeTokenRef.current });
      vibration.short();
      playInvalidSound();
      return;
    }

    const origin = await measure();
    const sourcePile = resolvePile(move.from);
    if (!sourcePile) return;
    const movingCards = sourcePile.slice(sourcePile.length - move.count);
    const offsetStep = move.count > 1 ? faceUpFanOffset(cardWidth) : 0;

    ghost.originX.value = origin.x;
    ghost.originY.value = origin.y;
    ghost.dx.value = 0;
    ghost.dy.value = 0;
    playCardSound();
    hapticCard();
    ghost.show({ cards: movingCards, offsetStep, cardWidth });

    if (!completeMove(move.from, move.to, move.count, cardId)) {
      ghost.hide();
    }
  }

  // Shared tail for every successful move, whichever triggered it (tap-to-move or a manual
  // drag's drop) - applies the move, then marks the destination "incoming" and stashes the
  // anchor card id for the [state]-effect above to measure and fly the ghost onto, instead of it
  // just vanishing/appearing at the destination instantly.
  function completeMove(from: PileRef, to: PileRef, count: number, anchorCardId: string, opts?: { silent?: boolean; fast?: boolean }): boolean {
    if (!applyMove(from, to, count, anchorCardId, opts)) return false;
    setFlying({ to, count });
    pendingAutoMoveCardIdRef.current = { cardId: anchorCardId, fast: opts?.fast, gen: dealTokenRef.current };
    return true;
  }

  // Auto-play-to-foundation: see engine/autoFoundation.ts for the two mechanisms this composes.
  // Re-run after every settled state change by the watcher effect above - mechanism B (a
  // guaranteed full clear) takes priority and, once true, ignores mechanism A's caution entirely
  // since there's no longer any player decision left to protect.
  function maybeAutoPlay() {
    if (!state || !FreeCellController.accessibleCards) return;
    const entry = isFullyAutoCompletable(FreeCellController, state)
      ? nextAutoCompleteMove(FreeCellController, state)
      : findSafeAutoPlay(FreeCellController.accessibleCards(state), state.foundation);
    if (entry) fireAutoMove(entry);
  }

  // Mirrors handleCardTap's tail, but there's no tap event to supply an origin - it has to measure
  // the card's current position itself, which is the one place this feature has an await gap
  // before applying its move (every other mutator here either has no await at all, or - like
  // handleUndo - captures everything it needs from the pre-move state synchronously first). Guard
  // against something else changing state during that gap by snapshotting stateRef before the
  // await and bailing if it no longer matches after.
  async function fireAutoMove(entry: AccessibleCard) {
    const stateAtStart = stateRef.current;
    const origin = await ghost.cardRegistry.measure(entry.card.id);
    if (!origin || stateRef.current !== stateAtStart) return;
    const to: PileRef = { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) };
    ghost.originX.value = origin.x;
    ghost.originY.value = origin.y;
    ghost.dx.value = 0;
    ghost.dy.value = 0;
    playCardSound();
    hapticCard();
    ghost.show({ cards: [entry.card], offsetStep: 0, cardWidth });
    if (!completeMove(entry.ref, to, 1, entry.card.id, { silent: true, fast: true })) {
      ghost.hide();
    }
  }

  async function attemptDrop(from: PileRef, count: number, absoluteX: number, absoluteY: number, anchorCardId: string): Promise<boolean> {
    const target = await dropZones.hitTest(absoluteX, absoluteY);
    if (!target) return false;
    return completeMove(from, target, count, anchorCardId);
  }

  function tableauRunCount(colIndex: number, indexFromTop: number): number {
    if (!state) return 0;
    const pile = state.tableau[colIndex];
    const count = indexFromTop + 1;
    const run = pile.slice(pile.length - count);
    if (count > 1 && !isDescendingAltColor(run)) return 0;
    return count;
  }

  if (!state) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <CardSizeProvider width={cardWidth}>
    <GameChrome
      title="FreeCell"
      onNewGame={handleNewGame}
      onUndo={handleUndo}
      undoDisabled={undoStack.length === 0}
      hasProgress={session.moves > 0}
      elapsedSeconds={session.elapsed}
      movesCount={session.moves}
    >
      <View style={[styles.topRow, { width: cardWidth * TABLEAU_COLUMNS + TABLEAU_GAP * (TABLEAU_COLUMNS - 1) }]}>
        <View style={styles.foundationsGroup}>
          {state.foundation.map((pile, i) => {
            const t = top(pile);
            const isFlyingHere = !!flying && flying.to.zone === 'foundation' && flying.to.index === i;
            return (
              <DropZone key={i} registry={dropZones} pileRef={{ zone: 'foundation', index: i }} style={[styles.foundationSlot, { width: cardWidth }]}>
                <FoundationCell
                  card={won ? undefined : t}
                  isFlyingHere={isFlyingHere}
                  suit={SUITS[i]}
                  slotRef={(el) => {
                    foundationSlotRefs.current[i] = el;
                  }}
                />
              </DropZone>
            );
          })}
        </View>

        <View style={styles.freecellsGroup}>
          {state.freecells.map((card, i) => {
            const ref: PileRef = { zone: 'freecell', index: i };
            const isFlyingHere = !!flying && flying.to.zone === 'freecell' && flying.to.index === i;
            // The far-right freecell doubles as the deal's flight origin while dealing (see
            // dealOriginRef/DECK_PLACEHOLDER_CARD above) - freecells are never touched by the
            // initial deal itself, so `card` is guaranteed still null underneath for the whole
            // time this placeholder shows, and it reverts to the plain FreecellCell below as soon
            // as deckVisible goes false (see runDeal - deliberately timed to the last card
            // LEAVING, not landing, so the deck doesn't linger after it's already been emptied).
            const isDealOrigin = i === state.freecells.length - 1 && deckVisible;
            return (
              <DropZone key={i} registry={dropZones} pileRef={ref} style={[styles.freecellSlot, { width: cardWidth }]}>
                {isDealOrigin ? (
                  <View ref={dealOriginRef} collapsable={false}>
                    <PlayingCard card={DECK_PLACEHOLDER_CARD} testID="freecell-deck-origin" />
                  </View>
                ) : (
                  <FreecellCell
                    card={card ?? undefined}
                    isFlyingHere={isFlyingHere}
                    shakeToken={card && shake?.cardId === card.id ? shake.token : undefined}
                    onPress={(measure) => handleCardTap(ref, card!.id, measure)}
                    onDrop={(x, y) => attemptDrop(ref, 1, x, y, card!.id)}
                  />
                )}
              </DropZone>
            );
          })}
        </View>
      </View>

      <View style={styles.tableauRow}>
        {state.tableau.map((col, colIndex) => {
          const dragConfig: PileDragConfig = {
            registry: dropZones,
            getRunCount: (indexFromTop) => tableauRunCount(colIndex, indexFromTop),
            onDrop: (to, count, anchorCardId) => completeMove({ zone: 'tableau', index: colIndex }, to, count, anchorCardId),
          };
          const hiddenCount = flying && flying.to.zone === 'tableau' && flying.to.index === colIndex ? flying.count : 0;
          return (
            <DropZone key={colIndex} registry={dropZones} pileRef={{ zone: 'tableau', index: colIndex }} style={[styles.tableauColumn, { width: cardWidth }]}>
              <PileView
                cards={col}
                onPressCard={(card, indexFromTop, measure) => handleCardTap({ zone: 'tableau', index: colIndex }, card.id, measure, indexFromTop)}
                maxHeight={TABLEAU_MAX_HEIGHT}
                drag={dragConfig}
                hiddenCount={hiddenCount}
                hiddenCardIds={dealHiddenIds}
                dimUnplayable
                shakeCardId={shake?.cardId}
                shakeCount={shake?.count}
                shakeToken={shake?.token}
              />
            </DropZone>
          );
        })}
      </View>

    </GameChrome>
    {/* Fireworks and the bouncing cascade both paint above the whole board by plain sibling order
    (see WinCascadeGhosts' own doc comment for why nesting depth alone can't do this) - the win
    banner comes last of all three so it's the one thing guaranteed to sit on top of the animation,
    not buried under it. */}
    {won && <Fireworks colors={fireworksColors(colors)} dark={dark} />}
    <WinCascadeGhosts />
    {won && (
      <View style={styles.winOverlay}>
        <View style={styles.winCard}>
          <Text style={styles.winTitle}>You Won!</Text>
          <Text style={styles.winSubtitle}>
            Time: {formatTime(session.elapsed)} · Moves: {session.moves} · Score: {computeScore(session.moves, session.elapsed)}
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
    padding: 12,
  },
  loadingText: {
    color: '#fff',
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 16,
    marginTop: 40,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#ffffffee',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  buttonText: {
    color: colors.tableFeltDark,
    fontFamily: CARD_FONT_FAMILY,
    fontWeight: '700',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  freecellsGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  freecellSlot: {},
  foundationsGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  foundationSlot: {},
  tableauRow: {
    flexDirection: 'row',
    gap: TABLEAU_GAP,
    paddingBottom: 20,
  },
  tableauColumn: {},
  winOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#00000088',
    justifyContent: 'center',
    alignItems: 'center',
  },
  winCard: {
    backgroundColor: '#ffffffee',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    gap: 12,
  },
  winTitle: {
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 28,
    fontWeight: '800',
    color: colors.tableFeltDark,
  },
  winSubtitle: {
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 16,
    color: '#444',
    marginBottom: 8,
  },
  });
}
