import { VariantId } from './variants'

// Par (expert par, since personal par below): a strong win's moves, time and score in one game under one rule set, so a
// score means something next to the game it was made in (a 200 is a fine Golf win and an impossible Spider one). What the
// score/speed/moves achievements and the Stats screen's bests are measured against, told in the Rules sheet, and a
// player's par in the win dialog until their first win in that variant (playerParFor).
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

/** How far under `par` a value is, as a whole percent (negative over par). */
function percentUnderPar(value: number, par: number): number {
  return Math.round((1 - value / par) * 100)
}

/** How a value compares with its par as a whole percentage: "18% under par", "at par", "5% over par". `name` is what the
 * par is called ("your par", "expert par"). */
export function describeVsPar(value: number, par: number, name = 'par'): string {
  const pct = percentUnderPar(value, par)
  if (pct === 0) return `at ${name}`
  return pct > 0 ? `${pct}% under ${name}` : `${-pct}% over ${name}`
}

/** describeVsPar without naming the par, for a row whose par is plain from where it sits (the Stats screen's rows under
 * their rule set's Expert Par): "18% under", "even" (golf's word for at par), "5% over" (Jay, 2026-10-22: "7% under expert
 * par" on every row was wordy). */
export function vsParShort(value: number, par: number): string {
  const pct = percentUnderPar(value, par)
  if (pct === 0) return 'even'
  return pct > 0 ? `${pct}% under` : `${-pct}% over`
}

export type ParMedal = 'bronze' | 'silver' | 'gold'

/** A win's score this far under par or more earns gold: the Low Score achievement's gold line (its threshold -65, a score 65%
 * of par). */
export const GOLD_MEDAL_PERCENT_UNDER_PAR = 35

/** The medal a win's score earns against par, the color of the win card's trophy and title (Jay, 2026-10-17): bronze at par or
 * over (every win earns one), silver for any amount under, gold from GOLD_MEDAL_PERCENT_UNDER_PAR under. Rounded like
 * describeVsPar, so "Score at par" is always bronze and "Score 1% under par" silver. Not the Low Score achievement's tiers
 * (bronze at par, silver 20% under): that one is a lifetime milestone, this is one game. */
export function parMedal(score: number, par: number): ParMedal {
  const pct = percentUnderPar(score, par)
  if (pct >= GOLD_MEDAL_PERCENT_UNDER_PAR) return 'gold'
  return pct > 0 ? 'silver' : 'bronze'
}

// Personal par (Jay, 2026-10-17: the fixed par above was out of reach, so silver was rare and gold never came, and he
// wanted the bar to follow each player). A win's medal is measured against the player's OWN recent wins in that variant:
// silver under the median of their last RECENT_WINS_KEPT, gold in their best fifth. The bar follows the player both ways
// (it tightens as they improve and eases after a rough patch), so each medal comes about as often whatever their level:
// silver about half the time, gold about 1 win in 5. The fixed par stays as expert par: what the score, speed and moves
// achievements and the Stats screen's bests are measured against, and the stand-in before a player's first win.

/** How many of a player's latest wins in a variant their par is made from. */
export const RECENT_WINS_KEPT = 20

/** One win, as a player's par remembers it (redux/recentWinsSlice.ts). */
export interface RecentWin {
  score: number
  moves: number
  seconds: number
}

/** The par a win is measured against. */
export interface PlayerPar extends Par {
  /** 'personal': the medians of the player's recent wins. 'expert': the variant's fixed par, before their first win. */
  kind: 'personal' | 'expert'
  /** Personal only: the highest score that earns gold, or null until there are five recent wins to take a fifth of. */
  goldScore: number | null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** A player's par in a variant from their recent wins (oldest first), measured BEFORE the win being judged joins them.
 * Each number is its own median, so the three needn't add up. Gold: a score no worse than the best fifth's last
 * (the 4th best of 20), so at most a fifth of the recent wins beat it. */
export function playerParFor(variant: VariantId, recent: readonly RecentWin[]): PlayerPar {
  const wins = recent.slice(-RECENT_WINS_KEPT)
  if (wins.length === 0) return { ...parFor(variant), kind: 'expert', goldScore: null }
  const scores = wins.map((w) => w.score).sort((a, b) => a - b)
  const bestFifth = Math.floor(scores.length / 5)
  return {
    kind: 'personal',
    moves: Math.round(median(wins.map((w) => w.moves))),
    seconds: Math.round(median(wins.map((w) => w.seconds))),
    score: Math.round(median(scores)),
    goldScore: bestFifth > 0 ? scores[bestFifth - 1] : null
  }
}

/** The medal a win's score earns against the player's par: bronze at it or over (rounded like describeVsPar, so "at your
 * par" is always bronze), silver under it, gold in the best fifth (never without silver). Expert par keeps parMedal's
 * 35% gold line. */
export function playerParMedal(score: number, par: PlayerPar): ParMedal {
  if (par.kind === 'expert') return parMedal(score, par.score)
  if (percentUnderPar(score, par.score) <= 0) return 'bronze'
  return par.goldScore !== null && score <= par.goldScore ? 'gold' : 'silver'
}
