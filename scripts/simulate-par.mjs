// Measures par for every game and rule set (src/engine/par.ts's PAR_INPUTS) by simulating wins.
//
//   npm run par                      every variant, 300 deals, up to 10 tries per deal (~40s)
//   npm run par -- --only spider     just the variants whose id starts with "spider"
//   npm run par -- --deals 1000 --tries 20
//
// The player follows the app's own Hint (engine/hint.ts's findHint) on each variant's real rules.ts, so par moves with
// the rules and the Hint. The first try of a deal is pure Hint; later tries take Hint's 2nd or 3rd suggestion a quarter of
// the time, which wins deals plain Hint loses. A try ends at a win, a board seen three times (a draw loop), or 3000
// moves. For each deal the first winning try counts.
//
// Prints, per variant: wins, and the median (p25-p75) winning moves and DECISIONS - the moves a player makes themselves:
// every move, less the foundation plays in the five auto-play games, which Auto-Move makes for them. Every move counts
// toward the score either way (see engine/score.ts). Then a PAR_INPUTS block to paste into par.ts: moves rounded to 5,
// decisions as measured. A variant with fewer than MIN_WINS wins is printed as a comment instead: keep its estimate.
//
// Deterministic: the same deals (seeds) and the same random choices every run.
import { build } from 'esbuild'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const MIN_WINS = 20

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const DEALS = Number(arg('deals', 300))
const TRIES = Number(arg('tries', 10))
const ONLY = arg('only', '')

// The simulation itself, bundled against the app's own source. Every VariantId needs a controller here, or it stops.
const ENTRY = `
import { findHint } from '@/engine/hint'
import { gameOfVariant, VARIANT_IDS } from '@/engine/variants'
import { createCanfieldController } from '@/games/canfield/rules'
import { createFortyThievesController } from '@/games/fortythieves/rules'
import { AcesUpController } from '@/games/acesup/rules'
import { FreeCellController } from '@/games/freecell/rules'
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
  'spider-4suit': createSpiderController(4),
  freecell: FreeCellController,
  pyramid: PyramidController,
  yukon: createYukonController(),
  golf: createGolfController(false),
  'golf-wrap': createGolfController(true),
  tripeaks: createTriPeaksController(false),
  'tripeaks-wrap': createTriPeaksController(true),
  canfield: createCanfieldController(3),
  'canfield-draw1': createCanfieldController(1),
  scorpion: createScorpionController(true),
  'scorpion-classic': createScorpionController(false),
  fortythieves: createFortyThievesController(false),
  'fortythieves-runs': createFortyThievesController(true),
  acesup: AcesUpController
}
const AUTO_PLAY_GAMES = new Set(['klondike', 'freecell', 'yukon', 'canfield', 'fortythieves'])

const missing = VARIANT_IDS.filter((id) => !CONTROLLERS[id])
if (missing.length) throw new Error('scripts/simulate-par.mjs has no controller for: ' + missing.join(', '))

export function simulate(variant, deals, tries) {
  const c = CONTROLLERS[variant]
  const autoPlay = AUTO_PLAY_GAMES.has(gameOfVariant(variant))
  let rng = 12345
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng / 0x7fffffff)
  const moves = []
  const decisions = []
  for (let deal = 1; deal <= deals; deal++) {
    for (let attempt = 0; attempt < tries; attempt++) {
      let s = c.newGame(deal * 7919 + 13)
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
        moves.push(count)
        decisions.push(autoPlay ? count - foundation : count)
        break
      }
    }
  }
  return { moves, decisions }
}
export { VARIANT_IDS }
`

const workDir = fs.mkdtempSync(path.join(HERE, '.simulate-par-'))
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
    external: ['react-native']
  })
  const { simulate, VARIANT_IDS } = createRequire(import.meta.url)(bundleFile)

  const sorted = (a) => [...a].sort((x, y) => x - y)
  const at = (a, p) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))]
  const spread = (a) => (a.length ? `${at(a, 0.5)} (${at(a, 0.25)}-${at(a, 0.75)})` : '-')
  const lines = []
  console.log(`${DEALS} deals per variant, up to ${TRIES} tries each\n`)
  console.log(`${'variant'.padEnd(18)} ${'wins'.padStart(9)}  ${'moves'.padEnd(16)} decisions`)
  for (const id of VARIANT_IDS.filter((v) => v.startsWith(ONLY))) {
    const { moves, decisions } = simulate(id, DEALS, TRIES)
    console.log(`${id.padEnd(18)} ${`${moves.length}/${DEALS}`.padStart(9)}  ${spread(moves).padEnd(16)} ${spread(decisions)}`)
    const key = /^[a-z]+$/.test(id) ? id : `'${id}'`
    lines.push(moves.length >= MIN_WINS ? `  ${key}: { moves: ${Math.round(at(moves, 0.5) / 5) * 5}, decisions: ${at(decisions, 0.5)} },` : `  // ${key}: only ${moves.length} wins - keep the estimate`)
  }
  console.log(`\nPAR_INPUTS (src/engine/par.ts):\n${lines.join('\n')}`)
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}
