// The App Store's product page header and search results art (iOS 27's creative assets, see store/README.md), drawn
// by the app's own components at full size, never a lookalike: the felt is TableBackground, the colors are
// useTableColors' for the default player in dark mode, the fan is Home's fan (heroFan.ts) of CardBacks, the trails
// are CardFace Kings bouncing out like the win cascade, the fireworks are SuitPips in their card inks, and the
// search art's phone shows the Klondike screenshot capture (store/screenshots/raw/iphone/01-klondike.png).
//
//   node store/creative/build.mjs
//
// Writes store/screenshots/header.png (3840 x 1646) and store/screenshots/search.png (3840 x 2560), each with -safe
// and -384 previews, through the app-store-prep skill's creative.mjs (CREATIVE=/path/to/creative.mjs to override).
// Same pipeline as scripts/generate-card-face-bitmaps.mjs: esbuild bundles the components for react-native-web,
// react-dom/server renders them to HTML, headless Chrome screenshots the page.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '../..')
const OUT_DIR = path.join(ROOT, 'store', 'screenshots')
const CREATIVE = process.env.CREATIVE ?? path.join(os.homedir(), '.claude/skills/app-store-prep/scripts/creative.mjs')
const CAPTURE = path.join(OUT_DIR, 'raw', 'iphone', '01-klondike.png')
// Inside the project, so the bundle and its externals resolve this app's node_modules.
const WORK = fs.mkdtempSync(path.join(HERE, '.build-'))

const ENTRY = `
export { CardBack, CardFace, SuitPip, cardFaceColor, suitInk } from '@tastic/cards'
export { AppRegistry, View } from 'react-native'
export { TableBackground } from '@/components/TableBackground'
export { useTableColors } from '@/components/theme'
export { HERO_CARD_HEIGHT, HERO_CARD_WIDTH, HERO_FAN_CARDS, HERO_FAN_CENTER_Y, HERO_FAN_HEIGHT } from '@/components/heroFan'
`

// The default player: no profile, no color picked, so useTableColors derives everything from DEFAULT_SEED_COLOR. And
// react-native-svg's web asset lookup, which imports a registry the web build doesn't install (nothing here is an asset).
// theme.ts's other imports are swapped for light stand-ins that give the same answers: auto-paper's color math alone
// (its full entry pulls in Expo native modules), and Paper's useTheme in dark mode, the appearance the screenshots use.
const AUTO_PAPER_UTILS = path.join(ROOT, 'node_modules/@rific/auto-paper/src/utils')
const STUBS = {
  '@/stores/profiles': 'export const useProfiles = () => ({ tableColorOverride: null })',
  '@react-native/assets-registry/registry': 'export const getAssetByID = () => null',
  'react-native-paper': 'export const useTheme = () => ({ dark: true })',
  '@rific/auto-paper': Object.entries({ getBlendedColor: 'getBlendedColor', getContrastColor: 'getSwatchContrast', getTonalColor: 'getTonalColor', getTriadicPalette: 'getTriadicPalette' })
    .map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(AUTO_PAPER_UTILS, file))}`)
    .join('\n')
}
const profilesStub = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(@\/stores\/profiles|@react-native\/assets-registry\/registry|react-native-paper|@rific\/auto-paper)$/ }, (args) => ({ path: args.path, namespace: 'stub' }))
    // react-native-svg's sound module is native only (TurboModuleRegistry), and nothing here plays a sound.
    b.onResolve({ filter: /NativeSvgSoundModule$/ }, () => ({ path: 'svg-sound', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path] ?? 'export default null', loader: 'ts', resolveDir: ROOT }))
  }
}

try {
  const bundleFile = path.join(WORK, 'bundle.cjs')
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: bundleFile,
    logLevel: 'error',
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
    // The web builds (react-native-svg's source is native-first and imports TurboModuleRegistry).
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser'],
    alias: { 'react-native': 'react-native-web', '@': path.join(ROOT, 'src') },
    external: ['react', 'react-dom', 'react-dom/server'],
    loader: { '.png': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.js': 'jsx' },
    jsx: 'automatic',
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    plugins: [profilesStub]
  })
  const req = createRequire(import.meta.url)
  const React = req('react')
  const { renderToStaticMarkup } = req('react-dom/server')
  const m = req(bundleFile)
  const h = React.createElement
  const fontUrl = pathToFileURL(req.resolve('dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf')).href

  // A card as PlayingCard draws it: rounded (cardRadiusForWidth), with its drop shadow, turned about its centre.
  function card({ key, x, y, w, art, deg = 0, z = 0 }) {
    return h(m.View, { key, style: { position: 'absolute', left: x - w / 2, top: y - (w * 93) / 64 / 2, width: w, height: (w * 93) / 64, zIndex: z, transform: [{ rotate: `${deg}deg` }], shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: w * 0.06, shadowOffset: { width: 0, height: w * 0.025 }, borderRadius: w * 0.06 } }, h(m.View, { style: { flex: 1, borderRadius: w * 0.06, overflow: 'hidden' } }, art))
  }
  const back = (colors, w) => h(m.CardBack, { colors, width: w, height: (w * 93) / 64 })
  const face = (colors, suit, rank, w) => h(m.CardFace, { card: { id: `${suit}-${rank}`, suit, rank, faceUp: true }, colors, width: w, height: (w * 93) / 64, cardStyle: 'compact' })

  // Home's fan, scaled, centred on (cx, cy).
  function fan(colors, cx, cy, scale) {
    const w = m.HERO_CARD_WIDTH * scale
    const centerY = cy - (m.HERO_FAN_HEIGHT * scale) / 2 + m.HERO_FAN_CENTER_Y * scale
    return m.HERO_FAN_CARDS.map((c) => card({ key: c.key, x: cx + c.x * scale, y: centerY + c.y * scale, w, art: back(colors, w), deg: c.angleDeg, z: 20 + c.zIndex }))
  }

  // A win-cascade trail: one card bouncing away from (x0, y0) toward `dir`, a copy left every step, the last on top.
  function trail(colors, { suit, rank, x0, y0, dir, w, floor, steps, vx, vy0, g, restitution }) {
    const out = []
    let x = x0
    let y = y0
    let vy = vy0
    for (let i = 0; i < steps; i++) {
      out.push(card({ key: `${suit}-${i}`, x, y, w, art: face(colors, suit, rank, w), z: 1 + i }))
      x += dir * vx
      vy += g
      y += vy
      if (y > floor) {
        y = floor
        vy = -vy * restitution
      }
    }
    return out
  }

  // A pip firework: a ring of one suit's pips in its card ink, ringed in the card face's color.
  function burst(colors, { key, suit, cx, cy, radius, size, count }) {
    const ink = m.suitInk(suit, colors, { cardStyle: 'compact' })
    const outline = { color: m.cardFaceColor(colors), width: size * (1.25 / 14) }
    return Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2
      return h(m.View, { key: `${key}-${i}`, style: { position: 'absolute', left: cx + Math.cos(a) * radius - size / 2, top: cy + Math.sin(a) * radius - size / 2, width: size, height: size, zIndex: 60, transform: [{ rotate: `${(a * 180) / Math.PI + 90}deg` }] } }, h(m.SuitPip, { suit, color: ink, size, outline }))
    })
  }

  function page(name, width, height, art, overlay = '') {
    function Art() {
      const colors = m.useTableColors()
      return h(React.Fragment, null, h(m.TableBackground), ...art(colors))
    }
    function Page() {
      return h(m.View, { style: { position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' } }, h(Art))
    }
    m.AppRegistry.registerComponent(name, () => Page)
    const { element, getStyleElement } = m.AppRegistry.getApplication(name, {})
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'DejaVu Serif'; src: url('${fontUrl}'); font-weight: 100 900; }
html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
#root { position: absolute; inset: 0; }
.overlay { position: absolute; z-index: 100; font-family: 'DejaVu Serif', serif; color: #fff; }
</style>${renderToStaticMarkup(getStyleElement())}</head><body><div id="root">${renderToStaticMarkup(element)}</div>${overlay}</body></html>`
    const file = path.join(WORK, `${name}.html`)
    fs.writeFileSync(file, html)
    return file
  }

  // Header, 3840 x 1646: one idea, the win. Home's fan in the middle of the safe area (x 1097-2743, y 493-1154), Kings
  // bouncing out of it to both edges like the win cascade, and pip fireworks in the top corners. No words: the app's
  // name sits right under it, and the screenshots follow.
  const headerFile = page('header', 3840, 1646, (colors) => {
    const w = 210
    const floor = 1646 - 70 - (w * 93) / 64 / 2
    const common = { w, floor, steps: 30, vx: 46, vy0: -30, g: 4.6, restitution: 0.68 }
    return [
      ...trail(colors, { suit: 'hearts', rank: 13, x0: 1230, y0: 600, dir: -1, ...common }),
      ...trail(colors, { suit: 'spades', rank: 13, x0: 2610, y0: 600, dir: 1, ...common }),
      ...burst(colors, { key: 'l', suit: 'hearts', cx: 470, cy: 380, radius: 150, size: 64, count: 10 }),
      ...burst(colors, { key: 'l2', suit: 'diamonds', cx: 760, cy: 230, radius: 95, size: 48, count: 8 }),
      ...burst(colors, { key: 'r', suit: 'spades', cx: 3370, cy: 380, radius: 150, size: 64, count: 10 }),
      ...burst(colors, { key: 'r2', suit: 'clubs', cx: 3080, cy: 230, radius: 95, size: 48, count: 8 }),
      ...fan(colors, 1920, 823, 4.4)
    ]
  })

  // Search results, 3840 x 2560: state the obvious. The headline on the left and the Klondike screen on the right, both
  // inside the safe area (x 836-3004, y 765-1795); the phone runs off the bottom edge.
  const phoneScale = 0.72
  const phoneW = 1320 * phoneScale
  const phoneH = 2868 * phoneScale
  const bezel = 22
  const phoneLeft = 2040
  const phoneTop = 640
  const radius = 165 * phoneScale
  const searchOverlay = `
<div class="overlay" style="left:876px;top:765px;width:1100px;height:1030px;display:flex;flex-direction:column;justify-content:center;gap:60px">
  <div style="font-size:164px;line-height:1.1;font-weight:700;letter-spacing:1px;text-shadow:0 8px 30px rgba(0,0,0,0.4)">11 Classic<br>Solitaire<br>Games</div>
  <div style="font-size:84px;line-height:1.25;opacity:0.85;letter-spacing:0.5px">No ads.<br>Plays offline.</div>
</div>
<div class="overlay" style="left:${phoneLeft - bezel}px;top:${phoneTop - bezel}px;padding:${bezel}px;background:#0a0a0a;border-radius:${radius + bezel}px;box-shadow:0 50px 140px rgba(0,0,0,0.6),0 0 0 4px rgba(255,255,255,0.10)">
  <div style="position:relative;width:${phoneW}px;height:${phoneH}px;border-radius:${radius}px;overflow:hidden">
    <img src="${pathToFileURL(CAPTURE).href}" style="display:block;width:${phoneW}px;height:${phoneH}px">
    <div style="position:absolute;left:${(phoneW - 378 * phoneScale) / 2}px;top:${41 * phoneScale}px;width:${378 * phoneScale}px;height:${111 * phoneScale}px;border-radius:${(111 * phoneScale) / 2}px;background:#000"></div>
  </div>
</div>`
  const searchFile = page('search', 3840, 2560, () => [], searchOverlay)

  for (const [file, placement] of [
    [headerFile, 'header'],
    [searchFile, 'search']
  ]) {
    execFileSync('node', [CREATIVE, file, placement, path.join(OUT_DIR, `${placement}.png`)], { stdio: 'inherit' })
  }
} finally {
  fs.rmSync(WORK, { recursive: true, force: true })
}
