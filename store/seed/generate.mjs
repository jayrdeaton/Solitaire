// Seed data for the App Store screenshots (see store/README.md), made by the app's own rules, Hint,
// stats engine and achievement catalog: three weeks of play by a Hint-following player who wins about two
// deals in three and gets quicker over time, a Klondike board partway through a game, a Yukon board whose
// hint moves a clean run, and a FreeCell board one foundation play from its finish.
//
//   node store/seed/generate.mjs        writes store/seed/seed.json (gitignored), then store/seed/reseed.sh
//
// Deterministic apart from the dates, which count back from now.
import { build } from 'esbuild'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '../..')

const ENTRY = `
import { findHint } from '@/engine/hint'
import { gameOfVariant } from '@/engine/variants'
import { applyDealWon, applyDealAbandoned, applyHintUsed } from '@/stores/statsEngine'
import { DEFAULT_STATS } from '@/stores/statsValidation'
import { ACHIEVEMENT_CATALOG } from '@/stores/achievementCatalog'
import { createCanfieldController } from '@/games/canfield/rules'
import { createFortyThievesController } from '@/games/fortythieves/rules'
import { AcesUpController } from '@/games/acesup/rules'
import { FreeCellController } from '@/games/freecell/rules'
import { canAutoFinish } from '@/games/freecell/autoPlay'
import { createGolfController } from '@/games/golf/rules'
import { createKlondikeController } from '@/games/klondike/rules'
import { PyramidController } from '@/games/pyramid/rules'
import { createScorpionController } from '@/games/scorpion/rules'
import { createSpiderController } from '@/games/spider/rules'
import { createTriPeaksController } from '@/games/tripeaks/rules'
import { createYukonController } from '@/games/yukon/rules'

const CONTROLLERS = {
  klondike: createKlondikeController(1),
  'klondike-draw3': createKlondikeController(3),
  spider: createSpiderController(1),
  'spider-2suit': createSpiderController(2),
  freecell: FreeCellController,
  pyramid: PyramidController,
  yukon: createYukonController(),
  golf: createGolfController(false),
  tripeaks: createTriPeaksController(false),
  canfield: createCanfieldController(3),
  scorpion: createScorpionController(true),
  fortythieves: createFortyThievesController(false),
  acesup: AcesUpController
}
const AUTO_PLAY_GAMES = new Set(['klondike', 'freecell', 'yukon', 'canfield', 'fortythieves'])

let rng = 4242
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng / 0x7fffffff)

// One deal by a Hint-following player, up to 3 tries (later tries sometimes take Hint's 2nd or 3rd pick).
function play(variant, seed) {
  const c = CONTROLLERS[variant]
  for (let attempt = 0; attempt < 3; attempt++) {
    let s = c.newGame(seed)
    let count = 0
    let foundation = 0
    const seen = new Map()
    for (let step = 0; step < 3000 && !c.isWon(s); step++) {
      const key = JSON.stringify(s)
      const visits = (seen.get(key) ?? 0) + 1
      seen.set(key, visits)
      if (visits > 2) break
      const skip = attempt > 0 && rand() < 0.25 ? 1 + Math.floor(rand() * 2) : 0
      const hint = findHint(c, s, skip)
      const next = hint.kind === 'move' ? c.tryMove(s, hint.move) : hint.kind === 'drawStock' ? c.drawStock(s) : null
      if (!next) break
      if (hint.kind === 'move' && hint.move.to.zone === 'foundation') foundation++
      s = next
      count++
    }
    if (c.isWon(s)) {
      const decisions = AUTO_PLAY_GAMES.has(gameOfVariant(variant)) ? count - foundation : count
      return { won: true, moves: count, decisions }
    }
  }
  return { won: false }
}

// How many deals of each variant the player dealt over three weeks.
const PLAN = { klondike: 16, freecell: 11, spider: 8, pyramid: 6, tripeaks: 7, golf: 5, yukon: 4, 'klondike-draw3': 4, canfield: 3, scorpion: 3, acesup: 3, fortythieves: 2, 'spider-2suit': 2 }

export function run(nowMs) {
  const deals = []
  for (const [variant, n] of Object.entries(PLAN)) for (let i = 0; i < n; i++) deals.push(variant)
  // Shuffle so the days mix games.
  for (let i = deals.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[deals[i], deals[j]] = [deals[j], deals[i]]
  }
  const DAYS = 21
  let stats = DEFAULT_STATS
  const unlocked = {}
  let seed = 1000
  deals.forEach((variant, i) => {
    const day = DAYS - 1 - Math.floor((i * DAYS) / deals.length)
    const when = new Date(nowMs - day * 86400000 - 3600000 * (2 + (i % 5)))
    // About two in three deals are wins: the player's winning deals are found by dealing on until one is won.
    const wantWin = rand() < 0.66
    let r = play(variant, (seed += 7919))
    for (let n = 0; wantWin && !r.won && n < 80; n++) r = play(variant, (seed += 7919))
    const usedHint = rand() < 0.3
    if (usedHint) stats = applyHintUsed(stats, variant, null)
    if (r.won) {
      // A player who gets quicker over the three weeks: about 4.6 seconds per decision at first, 2.4 by the end.
      const seconds = Math.round(r.decisions * (4.2 - (2.2 * i) / deals.length + rand() * 0.8))
      stats = applyDealWon(stats, variant, { seconds, moves: r.moves, score: r.moves + seconds, usedHint }, null, when)
    } else {
      stats = applyDealAbandoned(stats, variant, null, when)
    }
    for (const a of ACHIEVEMENT_CATALOG) if (!unlocked[a.id] && a.isUnlocked(stats)) unlocked[a.id] = when.getTime()
  })

  // A FreeCell deal played until every column is sorted: one foundation play from the finish.
  let finish = null
  for (let s0 = 31; !finish && s0 < 400; s0 += 2) {
    let s = FreeCellController.newGame(s0)
    let count = 0
    let foundation = 0
    const seen = new Set()
    for (let step = 0; step < 400; step++) {
      if (canAutoFinish(s)) break
      const key = JSON.stringify(s)
      if (seen.has(key)) break
      seen.add(key)
      const hint = findHint(FreeCellController, s, 0)
      const next = hint.kind === 'move' ? FreeCellController.tryMove(s, hint.move) : null
      if (!next) break
      if (hint.move.to.zone === 'foundation') foundation++
      s = next
      count++
    }
    const onFoundations = s.foundation.reduce((n, f) => n + f.length, 0)
    // Want a good few cards still on the board so the finish has something to do.
    if (canAutoFinish(s) && onFoundations <= 24) finish = { state: s, moves: count, decisions: count - foundation, seed: s0, onFoundations }
  }
  // Boards partway through a game, by the same Hint-following player, for the gameplay shots.
  function midGame(variant, seed, steps) {
    const c = CONTROLLERS[variant]
    let s = c.newGame(seed)
    let count = 0
    while (count < steps && !c.isWon(s)) {
      const hint = findHint(c, s, 0)
      const next = hint.kind === 'move' ? c.tryMove(s, hint.move) : hint.kind === 'drawStock' ? c.drawStock(s) : null
      if (!next) break
      s = next
      count++
    }
    return { state: s, moves: count }
  }
  const boards = {}
  // Klondike: the best-looking board 25-45 Hint moves into any of 300 deals (cards on the foundations,
  // long face-up runs, no empty column, some stock left).
  let best = null
  for (let seed = 5000; seed < 5300; seed++) {
    for (let steps = 25; steps <= 45; steps += 5) {
      const b = midGame('klondike', seed, steps)
      const s = b.state
      if (s.tableau.some((t) => t.length === 0) || s.stock.length < 6) continue
      const found = s.foundation.reduce((n, f) => n + f.length, 0)
      const faceUp = s.tableau.reduce((n, t) => n + t.filter((c) => c.faceUp).length, 0)
      const score = found * 2 + faceUp
      if (found >= 5 && found <= 12 && (!best || score > best.score)) best = { ...b, score, seed, steps }
    }
  }
  boards.klondike = best
  // Yukon, for the hint shot: a board where Hint's first suggestion moves a run of 3+ cards between columns.
  let hintBest = null
  for (let seed = 3000; seed < 3200 && !hintBest; seed++) {
    for (let steps = 6; steps <= 24 && !hintBest; steps += 2) {
      const b = midGame('yukon', seed, steps)
      const h = findHint(CONTROLLERS.yukon, b.state, 0)
      if (h.kind !== 'move' || h.move.count < 3 || h.move.from.zone !== 'tableau' || h.move.to.zone !== 'tableau') continue
      const from = b.state.tableau[h.move.from.index]
      const run = from.slice(from.length - h.move.count)
      // A clean run: each card one lower and the other color than the one above it, landing on a card, no empty column.
      const red = (c) => c.suit === 'hearts' || c.suit === 'diamonds'
      const clean = run.every((c, i) => i === 0 || (c.rank === run[i - 1].rank - 1 && red(c) !== red(run[i - 1])))
      if (clean && b.state.tableau[h.move.to.index].length > 0 && b.state.tableau.every((t) => t.length > 0)) hintBest = { ...b, seed, steps, hint: h.move }
    }
  }
  boards.yukon = hintBest
  return { stats, unlocked, finish, boards }
}
`

// Beside this file, so the bundle's external requires resolve from the app's node_modules.
const workDir = fs.mkdtempSync(path.join(HERE, '.generate-'))
try {
  const bundleFile = path.join(workDir, 'bundle.cjs')
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundleFile,
    logLevel: 'error',
    // @tastic/cards' index pulls in its React Native components; the rules only need its plain card helpers.
    alias: { '@': path.join(ROOT, 'src'), '@tastic/cards': path.join(ROOT, 'node_modules/@tastic/cards/src/types.ts') },
    external: ['react-native', '@rific/core', 'react', 'react-redux']
  })
  const { run } = createRequire(import.meta.url)(bundleFile)
  const out = run(Date.now())
  fs.writeFileSync(path.join(HERE, 'seed.json'), JSON.stringify(out))
  const wins = Object.values(out.stats.variants).reduce((n, v) => n + v.record.wins, 0)
  const played = Object.values(out.stats.variants).reduce((n, v) => n + v.record.wins + v.record.losses, 0)
  console.log(`${wins}/${played} won, ${Object.keys(out.unlocked).length} achievements, Klondike deal ${out.boards.klondike.seed}, Yukon deal ${out.boards.yukon.seed}, FreeCell deal ${out.finish.seed}`)
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}
