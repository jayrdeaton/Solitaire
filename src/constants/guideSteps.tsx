import type { GuideStep } from '@tastic/hud/guide'

import { GuideCardPlay, GuideHint, GuideScore } from '@/components/GuideArt'

interface GuideStepsInput {
  // A touch screen vs. a desktop browser (useIsTouchPrimaryDevice()): a touch player taps, a desktop
  // player clicks. That verb is the only thing that changes between the two sets of cards.
  touch: boolean
}

// The three cards of Solitaire's how-to-play flow. Pure and hook-free so it's trivially testable;
// GuideHost feeds it useIsTouchPrimaryDevice() and memoizes the result.
//
// Per-game rules are NOT here: RulesDialog (constants/gameRules.ts) already covers each of the 11
// games. These are the suite-wide things a first-time player can't work out alone, and every
// sentence has to be true in all 11 games at the default settings:
// - Tap to Play: a tap sends the card to its best legal spot (each screen's handleCardTap runs the
//   game's autoMoveHint; no select-then-place). Pyramid is the one game where a tap does NOT move a
//   card (handleSelectPyramid selects it and a tap on its partner removes the pair; only a King goes
//   on one tap), so that exception is spelled out rather than left false. Dragging is NOT taught: it
//   can't make every move (Aces Up's discard and Pyramid's King have no drop zone on the discard pile,
//   see DiscardCell, so those drags snap back), and a player tries a drag on their own anyway.
// - Lower Is Better: the score is moves plus elapsed seconds (engine/score.ts's computeScore, every
//   game via GameChrome) and the clock only starts on the first move (useGameSession's registerMove),
//   which nothing in the game says.
// - Get a Hint: every game's footer has the light bulb (GameChrome, both layouts). It rings a legal
//   move, or the stock when a draw is the move (engine/hint.ts's findHint); with no move at all each
//   screen's handleHint toasts that there is none. Home has no light bulb, so this isn't describing
//   what's behind the card; the info button is left out because every Home tile shows it.
//
// Copy rules (Jay, 2026-09-24): Title Case titles, one-word buttons (the defaults: Skip / Back / Next /
// Ready), bodies of 90 characters or less, no questions, no filler, never tell a desktop player to tap
// or a touch player to click, and don't describe what's already visible behind the card. On top of
// that every touch body fits in TWO lines of DejaVu Serif Bold (the app-wide Paper font) on the
// narrowest page, 264pt on a 360dp phone: a third line makes the card too tall for the short side
// when Home is turned (see GuideHost). Left out on purpose: tap-the-felt-to-hide-the-footer (portrait
// only, so it isn't true in the wide layout or a desktop window), the shake on a card with no move (in
// Pyramid it means a failed pair instead), hint cycling (not true when the hint is a stock draw or the
// only move), auto-save (it shows itself the first time you come back).
export function getGuideSteps({ touch }: GuideStepsInput): GuideStep[] {
  return [
    {
      title: touch ? 'Tap to Play' : 'Click to Play',
      body: touch ? 'Tap a card for its best move. Pyramid pairs take two taps.' : 'Click a card for its best move. Pyramid pairs take two clicks.',
      art: <GuideCardPlay pointer={touch ? 'finger' : 'mouse'} />
    },
    {
      title: 'Lower Is Better',
      body: 'Score is moves plus seconds. The first move starts the clock.',
      art: <GuideScore />
    },
    {
      title: 'Get a Hint',
      body: touch ? 'Tap the light bulb in any game to see a move you can make.' : 'Click the light bulb in any game to see a move you can make.',
      art: <GuideHint />
    }
  ]
}
