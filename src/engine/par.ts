import { VariantId } from './variants'

// Par: a good win's moves, time and score in one game under one rule set, so a score means something next to the
// game it was made in (a 200 is a fine Golf win and an impossible Spider one). Shown under each number in the win
// dialog, on the Stats screen and in the Rules sheet, and what the score/speed/moves achievements are measured against.
//
// Moves: the median winning move count of a simulated player (2026-10-14) that follows the app's own Hint on each
// variant's real rules.ts, with a little randomness and up to 10 tries per deal, over 300 deals each. A move is every
// board change, auto-plays included (see engine/score.ts). Seconds: the moves a player DECIDES (every move except a
// foundation play in the five auto-play games, which Auto-Move makes for them) at SECONDS_PER_DECISION each.
// Estimated, not measured: Spider 2 and 4 suit and both Forty Thieves rules (the simulated player never won one), and
// Golf No Wrap and Aces Up are from only 9 and 2 wins (both close to the structural count: Golf's 35 tableau cards plus
// its 16 stock cards, Aces Up's 48 discards plus 12 deals). Re-run `npm run par` (scripts/simulate-par.mjs) after a
// change to a game's rules or to Hint, and paste its PAR_INPUTS block over the measured entries below.

/** The one time knob: seconds a good player takes per move they decide. */
export const SECONDS_PER_DECISION = 3

const PAR_INPUTS: Record<VariantId, { moves: number; decisions: number }> = {
  klondike: { moves: 125, decisions: 73 },
  'klondike-draw3': { moves: 120, decisions: 67 },
  spider: { moves: 120, decisions: 122 },
  'spider-2suit': { moves: 170, decisions: 170 }, // estimate: about 1.4x 1 suit
  'spider-4suit': { moves: 220, decisions: 220 }, // estimate: about 1.8x 1 suit
  freecell: { moves: 105, decisions: 52 },
  pyramid: { moves: 65, decisions: 67 },
  yukon: { moves: 100, decisions: 50 },
  golf: { moves: 50, decisions: 51 },
  'golf-wrap': { moves: 50, decisions: 49 },
  tripeaks: { moves: 50, decisions: 48 },
  'tripeaks-wrap': { moves: 50, decisions: 48 },
  canfield: { moves: 155, decisions: 102 },
  'canfield-draw1': { moves: 155, decisions: 103 },
  scorpion: { moves: 60, decisions: 59 },
  'scorpion-classic': { moves: 60, decisions: 58 },
  fortythieves: { moves: 250, decisions: 150 }, // estimate: 104 foundation plays, 64 draws, the rest building
  'fortythieves-runs': { moves: 230, decisions: 130 }, // estimate: runs save some single-card moves
  acesup: { moves: 70, decisions: 70 }
}

export interface Par {
  moves: number
  /** Whole seconds, rounded to 10. */
  seconds: number
  /** moves + seconds, the same formula as the score itself. */
  score: number
}

export function parFor(variant: VariantId): Par {
  const { moves, decisions } = PAR_INPUTS[variant]
  const seconds = Math.round((decisions * SECONDS_PER_DECISION) / 10) * 10
  return { moves, seconds, score: moves + seconds }
}

/** How a value compares with its par as a whole percentage: "18% under par", "at par", "5% over par". */
export function describeVsPar(value: number, par: number): string {
  const pct = Math.round((1 - value / par) * 100)
  if (pct === 0) return 'at par'
  return pct > 0 ? `${pct}% under par` : `${-pct}% over par`
}
