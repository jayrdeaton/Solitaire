import type { ViewRotation } from '@tastic/core'

// The persisted player settings (see redux/settingsSlice.ts for the defaults and hooks/useSettings.ts
// for reading and writing them).
export interface Settings {
  klondikeDraw: 1 | 3
  spiderSuits: 1 | 2 | 4
  // Canfield's stock draws either 1 or 3 cards at a time, same choice Klondike already exposes -
  // defaults to 3, matching this app's original hardcoded DRAW_COUNT so nobody's existing deal
  // shape changes until they opt in.
  canfieldDraw: 1 | 3
  // Whether a King may build onto an Ace (and vice versa) on Golf's/TriPeaks' single build pile -
  // two independent booleans, not one shared setting: they're the same underlying adjacency check,
  // but each game keeps its own classic identity and default, matching how klondikeDraw/spiderSuits
  // are each scoped to their own game rather than shared across games. Both default false (no
  // wraparound), matching today's behavior.
  golfRankWrap: boolean
  tripeaksRankWrap: boolean
  // Scorpion's stock: true deals only 49 cards into the tableau at first, holding the other 3 back
  // as a one-shot lifeline the player deals in later (see games/scorpion/rules.ts); false is the
  // strict classic layout with no stock at all, dealing all 52 up front. Defaults true - the
  // gentler, more commonly shipped version.
  scorpionAssistedStock: boolean
  // Forty Thieves' tableau moves: false (default) is the strict classic rule, one card at a time
  // only; true allows a valid same-suit descending run to move together as a shortcut.
  fortyThievesRunMoves: boolean
  // Global, not per-game (unlike every setting above): whether auto-play runs at all - the safe cards
  // that follow the player's own play of a card to a foundation (useAutoFoundationCascade), and the
  // finish that files a solved board away on its own (useAutoFinish; see engine/autoFoundation.ts). Applies
  // identically across every foundation-building game (Klondike/FreeCell/Yukon/Canfield/Forty
  // Thieves) as one play-style preference, not a rule variant any single game owns. Defaults true,
  // matching today's always-on behavior.
  autoMoveToFoundation: boolean
  // Global, not per-game (same reasoning as autoMoveToFoundation above): whether a face-up tableau
  // card that isn't currently the head of a legal, draggable run is shown dimmed (see PileView's
  // own dimUnplayable prop). Only FreeCell/Canfield/Golf/Spider ever have anything to dim - a card
  // that's face-up but not a legal move source, because those games' initial deals/move rules don't
  // guarantee every face-up run stays internally valid (see each screen's own dimUnplayable comment
  // on its PileView call). Klondike's and Yukon's own tableau-building rules make this a permanent
  // no-op for them, so the setting has nothing to affect there either way. Defaults true, matching
  // today's always-on behavior - a hint you can turn off for a harder, spot-it-yourself mode.
  dimUnplayable: boolean
  // 'decorated' renders the full-colour illustrated deck instead of the compact corner-index +
  // big-pip layout. 'tarot' is a peer option, not a sub-mode of 'compact': the same corner-index +
  // big-pip layout, but with cups/coins/wands/swords in place of hearts/diamonds/clubs/spades -
  // hearts/diamonds/clubs/spades' historical tarot counterparts. 'numeric' is another peer option:
  // identical to 'compact' except non-court ranks show a big rank numeral instead of a big suit
  // pip (court cards keep their illustrated figure either way) - easier to read at a glance in a
  // same-suit run (e.g. Spider), where every big pip otherwise looks alike.
  cardStyle: 'compact' | 'decorated' | 'tarot' | 'numeric'
  // 'geometric' is CardBack.tsx's own original design; 'ornate'/'plain' are SVG-cards-derived (see
  // artwork/NOTICE.md), rendered via DecoratedCardBack. Independent of cardStyle above - a face
  // style choice, not a back style choice.
  cardBackStyle: 'geometric' | 'ornate' | 'plain'
  // Dark mode only: flips black suit ink (spades/clubs) to white and the card face to near-black.
  // Red suits are never touched. A no-op in light mode (see theme.ts's textBlackInverted/
  // cardFaceInverted/dimOverlayInverted, which mirror their normal counterparts on lightColors) -
  // safe to leave on regardless of current appearance. Defaults false: today's dark mode (same
  // red/black ink as light mode) stays the default look; this is an opt-in alternative, not a
  // replacement.
  invertDarkModeColors: boolean
  // Global, not per-game: freezes the current rotation reading (see @tastic/core's OrientationProvider/
  // useRotation) instead of following the phone's live tilt - the same "Lock Orientation" setting the
  // rest of the fleet's own games expose. Defaults false, matching every existing app's own default
  // for this setting (nothing pins the layout until the player deliberately opts in).
  lockOrientation: boolean
  // The angle the lock is holding, written by OrientationProvider's onLockChange (recorded on lock,
  // cleared on unlock) and handed back as lockInitialValue, so a relaunch reopens in the orientation
  // the player locked to instead of portrait. Never set by the UI directly; absent while unlocked.
  lockedRotation?: ViewRotation
  // Global, not per-game: skips every DealAnimator-driven flight (the initial deal, stock draws,
  // undo/recycle returns, Pyramid's win sweep - see components/dealing/DealLayer.tsx) straight to
  // its landed state, with no ghost ever mounted or flown - the same instant-land outcome a mid-deal
  // skip tap already produces (DealProvider.start reuses that exact path when this is on), just
  // applied automatically rather than waiting for a tap. A standard "Reduce Motion" accessibility
  // preference, matching the same intent as iOS's own systemwide setting of that name - for players
  // who find the fly-in animation distracting, motion-sensitive, or just want to get into a game
  // faster, not a performance workaround (the deal's own pace already accounts for that - see
  // dealSpring.ts's FACE_UP_TARGET_TOTAL_MS). Does not touch drag/tap-to-move flights
  // (dragdrop/DragGhostLayer.tsx) or the win cascade (WinCascadeLayer.tsx), which are separate
  // animation systems - a future extension, not covered here. Defaults false: today's animated deal
  // stays the default experience.
  reduceMotion: boolean
}
