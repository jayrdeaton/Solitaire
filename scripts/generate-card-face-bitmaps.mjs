// Regenerates assets/cardFaces/*.png and src/components/cardFaceBitmaps.ts: every face-up card, as
// PlayingCard draws it, pre-rasterized - 4 card styles (compact/numeric/tarot/decorated) x 2 ink
// variants (normal, and dark mode's invertDarkModeColors) x 52 cards.
//
//   node scripts/generate-card-face-bitmaps.mjs
//
// Why: a live CardFace is ~14-17 native views (a court card's vector figure alone was ~100), and the
// board's mount cost is dominated by view count, not JS logic (see CLAUDE.md's performance notes). A
// bitmap face is ONE Image.
//
// Pixel-derived from the REAL component, never a lookalike: esbuild bundles @tastic/cards' CardFace
// with react-native aliased to react-native-web, react-dom/server renders it to HTML (react-native-svg
// has a real DOM implementation on web), and headless Chrome screenshots each card at 288px wide
// (CARD_WIDTH_MAX, 96pt, at 3x - the largest a card is ever drawn). The colours are
// this app's own palettes (theme.ts's lightColors/darkColors), which is why this lives in the app and
// not in @tastic/cards: the faces bake in Solitaire's inks.
//
// Needs Google Chrome installed (macOS path below, or CHROME=/path/to/chrome). Chrome runs with software
// rendering, and every card starts on a whole device pixel, so the output is byte-for-byte repeatable.
// Identical images (the compact and numeric styles share their court cards) are written once and
// referenced twice.
import { spawn, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import UPNG from 'upng-js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT_DIR = path.join(ROOT, 'assets', 'cardFaces')
const INDEX_FILE = path.join(ROOT, 'src', 'components', 'cardFaceBitmaps.ts')
const PREVIEW_OUT_DIR = path.join(ROOT, 'assets', 'previewFaces')
const PREVIEW_INDEX_FILE = path.join(ROOT, 'src', 'components', 'previewFaceBitmaps.ts')
// Inside the project, so both the bundle and the entry resolve this app's node_modules.
const WORK_DIR = fs.mkdtempSync(path.join(HERE, '.card-faces-'))
const ENTRY_FILE = path.join(WORK_DIR, 'entry.tsx')
const BUNDLE_FILE = path.join(WORK_DIR, 'bundle.cjs')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades']
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
const STYLES = ['compact', 'numeric', 'tarot', 'decorated']
// 'normal' is the ink every appearance mode draws when invertDarkModeColors is off (the card inks are
// the same in both palettes - see theme.ts's CARD_INK_*); 'invert' is dark mode with it on. Light mode
// with it on is meant to be a no-op (lightColors' *Inverted tokens mirror the plain ones), so it uses
// 'normal' - see cardFaceBitmaps' own doc.
const VARIANTS = { normal: { palette: 'lightColors', invert: false }, invert: { palette: 'darkColors', invert: true } }

// 288px wide: CARD_WIDTH_MAX (96pt, cardLayout.ts) at 3x - a phone can get there (Aces Up's 4 columns
// on a large phone are ~90pt). Laid out directly in device pixels (a 288-wide card at 1 pixel per CSS
// px), NOT as a 96pt card at 3x: Chrome snaps a fractional border to whole CSS pixels, which turned the
// frame's 0.02W border (1.92pt) into 1pt - a third thinner than the phone draws it. The height is
// fractional (418.5), so the capture takes the next whole pixel; an Image stretched to the card's box
// is off by 0.1% vertically, well under a pixel.
const CARD_W = 288
const CARD_H = (CARD_W * 93) / 64
const CAPTURE_H = Math.ceil(CARD_H)
const SCALE = 1
// Every cell starts on a whole device pixel (a half-pixel row offset re-antialiases the whole card).
const STRIDE_X = CARD_W + 8
const STRIDE_Y = Math.ceil(CARD_H) + 8
const COLS = 13

// Home's game previews (GamePreview.tsx): each game's face-up cards on a transparent canvas, drawn by the same
// CardFace, laid out by the game's own previewLayout.ts. The backs stay live SVG underneath (they carry the profile's
// colour), so this layer must never need a back drawn ABOVE a face - checked per game below. Rasterized at 2x the
// 360x200 design canvas: the widest tile (the wide layout's grid) is ~240pt, 720px at 3x.
const PREVIEW_GAMES = ['klondike', 'freecell', 'yukon', 'canfield', 'fortythieves', 'spider', 'scorpion', 'pyramid', 'golf', 'tripeaks', 'acesup']
const PREVIEW_BUILDERS = { klondike: 'Klondike', freecell: 'FreeCell', yukon: 'Yukon', canfield: 'Canfield', fortythieves: 'FortyThieves', spider: 'Spider', scorpion: 'Scorpion', pyramid: 'Pyramid', golf: 'Golf', tripeaks: 'TriPeaks', acesup: 'AcesUp' }
const PREVIEW_SCALE = 2

function bundle() {
  fs.writeFileSync(
    ENTRY_FILE,
    `import { CardFace } from '@tastic/cards'
import { AppRegistry } from 'react-native'
import { darkColors, lightColors } from '${path.join(ROOT, 'src', 'components', 'palettes')}'
export * from '${path.join(ROOT, 'src', 'components', 'previewCanvas')}'
${PREVIEW_GAMES.map((g) => `export { build${PREVIEW_BUILDERS[g]}Preview } from '${path.join(ROOT, 'src', 'games', g, 'previewLayout')}'`).join('\n')}
export { AppRegistry, CardFace, darkColors, lightColors }
`
  )
  execSync(
    [
      `${path.join(ROOT, 'node_modules', '.bin', 'esbuild')} ${ENTRY_FILE}`,
      '--bundle --format=cjs --platform=node',
      `--outfile=${BUNDLE_FILE}`,
      '--resolve-extensions=.web.tsx,.web.ts,.web.js,.tsx,.ts,.js',
      '--main-fields=react-native,browser,module,main',
      '--conditions=react-native,browser',
      '--alias:react-native=react-native-web',
      `--alias:@=${path.join(ROOT, 'src')}`,
      '--external:react --external:react-dom --external:react-dom/server',
      '--loader:.png=dataurl --loader:.ttf=dataurl --loader:.otf=dataurl --loader:.js=jsx',
      '--jsx=automatic',
      '--define:__DEV__=false --define:process.env.NODE_ENV=\\"production\\"',
      '--log-level=error'
    ].join(' '),
    { cwd: ROOT, stdio: 'inherit' }
  )
}

function buildPages() {
  const req = createRequire(import.meta.url)
  const React = req('react')
  const { renderToStaticMarkup } = req('react-dom/server')
  const mod = req(BUNDLE_FILE)
  const fontUrl = pathToFileURL(req.resolve('dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf')).href

  // One HTML page of absolutely placed CardFaces (each `{ card, x, y, w, h }`), rendered by react-native-web. Each is
  // clipped to the card's rounded box like PlayingCard's own clip (theme.ts's cardRadiusForWidth): a court figure is
  // nudged down and spills past the card's bottom edge on purpose (CardFace's COURT_TOP_INSET_FRACTION).
  function writePage(key, colors, invert, style, faces, width, height) {
    function Page() {
      return React.createElement(
        'div',
        null,
        faces.map(({ card, x, y, w, h }, i) =>
          React.createElement('div', { key: i, style: { position: 'absolute', left: x, top: y, width: w, height: h, display: 'flex', overflow: 'hidden', borderRadius: w * 0.06 } }, React.createElement(mod.CardFace, { card, colors, width: w, height: h, cardStyle: style, invertDarkModeColors: invert }))
        )
      )
    }
    mod.AppRegistry.registerComponent(key, () => Page)
    const { element, getStyleElement } = mod.AppRegistry.getApplication(key, {})
    const body = renderToStaticMarkup(element)
    const css = renderToStaticMarkup(getStyleElement())
    // The app registers the Bold TTF under the plain family name (useFontsPreload), so every weight
    // resolves to it - declare the whole weight range so Chrome never synthesizes a bolder copy.
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:'DejaVu Serif';src:url('${fontUrl}');font-weight:100 900}html,body{margin:0;background:transparent}#root{position:relative}</style>${css}</head><body><div id="root">${body}</div></body></html>`
    const file = path.join(WORK_DIR, `${key}.html`)
    fs.writeFileSync(file, html)
    return { file, width, height }
  }

  const previewW = mod.PREVIEW_CANVAS_WIDTH * PREVIEW_SCALE
  const previewH = mod.PREVIEW_CANVAS_HEIGHT * PREVIEW_SCALE
  const previewStride = previewH + 8
  const previewLayouts = PREVIEW_GAMES.map((game) => {
    const placements = mod[`build${PREVIEW_BUILDERS[game]}Preview`]()
    assertBacksBelowFaces(game, placements, mod.PREVIEW_CARD_WIDTH, mod.PREVIEW_CARD_HEIGHT)
    return placements
  })

  const pages = []
  for (const style of STYLES) {
    for (const [variant, { palette, invert }] of Object.entries(VARIANTS)) {
      const colors = mod[palette]
      const cells = []
      SUITS.forEach((suit, row) => RANKS.forEach((rank, col) => cells.push({ card: { id: `${suit}-${rank}`, suit, rank, faceUp: true }, x: col * STRIDE_X, y: row * STRIDE_Y, w: CARD_W, h: CARD_H })))
      const facePage = writePage(`${style}-${variant}`, colors, invert, style, cells, COLS * STRIDE_X, SUITS.length * STRIDE_Y)
      pages.push({ ...facePage, shots: cells.map(({ card, x, y }) => ({ kind: 'face', style, variant, suit: card.suit, rank: card.rank, clip: { x, y, width: CARD_W, height: CAPTURE_H } })) })

      const previewFaces = []
      previewLayouts.forEach((placements, i) =>
        placements.forEach((p) => {
          if (p.faceUp && p.card) previewFaces.push({ card: p.card, x: p.x * PREVIEW_SCALE, y: i * previewStride + p.y * PREVIEW_SCALE, w: mod.PREVIEW_CARD_WIDTH * PREVIEW_SCALE, h: mod.PREVIEW_CARD_HEIGHT * PREVIEW_SCALE })
        })
      )
      const previewPage = writePage(`preview-${style}-${variant}`, colors, invert, style, previewFaces, previewW, PREVIEW_GAMES.length * previewStride)
      pages.push({ ...previewPage, shots: PREVIEW_GAMES.map((game, i) => ({ kind: 'preview', game, style, variant, clip: { x: 0, y: i * previewStride, width: previewW, height: previewH } })) })
    }
  }
  return pages
}

// GamePreview draws every back (live SVG, profile-coloured) under this image, so a back that the layout paints on top
// of an earlier face-up card would come out underneath it. Every current layout fans face-down cards first; fail loudly
// if one ever doesn't.
function assertBacksBelowFaces(game, placements, w, h) {
  placements.forEach((back, i) => {
    if (back.faceUp) return
    placements.slice(0, i).forEach((face) => {
      if (face.faceUp && Math.abs(face.x - back.x) < w && Math.abs(face.y - back.y) < h) throw new Error(`${game}'s preview paints a face-down card over a face-up one - GamePreview's back layer can't draw that`)
    })
  })
}

async function launchChrome() {
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(WORK_DIR, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--allow-file-access-from-files', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    proc.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
    proc.on('exit', (code) => reject(new Error(`chrome exited (${code}): ${buf}`)))
  })
  const port = new URL(wsUrl).port
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 1
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}`))
      else resolve(msg.result)
    } else if (msg.method) listeners.forEach((l) => l(msg))
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const once = (method) => new Promise((resolve) => listeners.push((m) => m.method === method && resolve(m.params)))
  return { proc, ws, send, once }
}

async function capture(pages) {
  const chrome = await launchChrome()
  const { send, once } = chrome
  try {
    await send('Page.enable')
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    const shots = []
    for (const page of pages) {
      await send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(page.width), height: Math.ceil(page.height), deviceScaleFactor: SCALE, mobile: false })
      const loaded = once('Page.loadEventFired')
      await send('Page.navigate', { url: pathToFileURL(page.file).href })
      await loaded
      await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => document.fonts.size)', awaitPromise: true })
      for (const shot of page.shots) {
        const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...shot.clip, scale: 1 } })
        shots.push({ ...shot, png: Buffer.from(data, 'base64') })
      }
    }
    return shots
  } finally {
    chrome.ws.close()
    chrome.proc.kill()
  }
}

// Deduplicated on decoded pixels, then re-encoded as a 256-colour palette PNG: Chrome's own encoder is ~2x larger, and
// the quantization is invisible on these faces (mean error <0.2/255 on the most colourful court art; the
// compact/numeric/tarot faces have ~300 distinct colours to begin with). Returns each shot's file name.
function writePngs(shots, dir, nameFor) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const byHash = new Map()
  let bytes = 0
  const names = shots.map((shot) => {
    const decoded = UPNG.decode(shot.png)
    const rgba = UPNG.toRGBA8(decoded)[0]
    const hash = crypto.createHash('sha1').update(Buffer.from(rgba)).digest('hex')
    let name = byHash.get(hash)
    if (!name) {
      name = nameFor(shot)
      byHash.set(hash, name)
      const png = Buffer.from(UPNG.encode([rgba], decoded.width, decoded.height, 256))
      fs.writeFileSync(path.join(dir, name), png)
      bytes += png.length
    }
    return name
  })
  return { names, files: byHash.size, bytes }
}

// The repo's prettier config (printWidth 1000) wants each array on one line; format rather than hand-wrap.
function writeFormatted(file, source) {
  fs.writeFileSync(file, source)
  execSync(`${path.join(ROOT, 'node_modules', '.bin', 'prettier')} --write ${file}`, { cwd: ROOT, stdio: 'ignore' })
}

function write(shots) {
  const { names, files, bytes } = writePngs(shots, OUT_DIR, (shot) => `${shot.style}-${shot.variant}-${shot.suit}-${shot.rank}.png`)
  const refs = {}
  shots.forEach((shot, i) => {
    ;(((refs[shot.style] ??= {})[shot.variant] ??= {})[shot.suit] ??= [])[shot.rank - 1] = names[i]
  })

  const lines = STYLES.map(
    (style) =>
      `  ${style}: {\n${Object.keys(VARIANTS)
        .map((variant) => `    ${variant}: {\n${SUITS.map((suit) => `      ${suit}: [\n${refs[style][variant][suit].map((name) => `        require('../../assets/cardFaces/${name}')`).join(',\n')}\n      ]`).join(',\n')}\n    }`)
        .join(',\n')}\n  }`
  )
  writeFormatted(
    INDEX_FILE,
    `// GENERATED by scripts/generate-card-face-bitmaps.mjs - do not edit by hand.
import type { Suit } from '@tastic/cards'
import type { ImageSourcePropType } from 'react-native'

export type CardFaceStyle = 'compact' | 'numeric' | 'tarot' | 'decorated'
/** 'normal': invertDarkModeColors off (any appearance), or on in light mode, where it is meant to be a
 * no-op. 'invert': invertDarkModeColors on in dark mode. */
export type CardFaceVariant = 'normal' | 'invert'

/** Every face-up card as CardFace draws it with this app's palettes, rasterized at ${CARD_W}x${CAPTURE_H}px
 * (CARD_WIDTH_MAX, 96pt, at 3x) - indexed [style][variant][suit][rank - 1]. See the generator's header for how. */
export const CARD_FACE_BITMAPS: Record<CardFaceStyle, Record<CardFaceVariant, Record<Suit, ImageSourcePropType[]>>> = {
${lines.join(',\n')}
}
`
  )
  return { files, bytes }
}

function writePreviews(shots) {
  const { names, files, bytes } = writePngs(shots, PREVIEW_OUT_DIR, (shot) => `${shot.game}-${shot.style}-${shot.variant}.png`)
  const refs = {}
  shots.forEach((shot, i) => {
    ;((refs[shot.game] ??= {})[shot.style] ??= {})[shot.variant] = names[i]
  })
  const lines = PREVIEW_GAMES.map((game) => `  ${game}: { ${STYLES.map((style) => `${style}: { ${Object.keys(VARIANTS).map((variant) => `${variant}: require('../../assets/previewFaces/${refs[game][style][variant]}')`).join(', ')} }`).join(', ')} }`)
  writeFormatted(
    PREVIEW_INDEX_FILE,
    `// GENERATED by scripts/generate-card-face-bitmaps.mjs - do not edit by hand.
import type { ImageSourcePropType } from 'react-native'

import type { CardFaceStyle, CardFaceVariant } from './cardFaceBitmaps'

export type PreviewGame = ${PREVIEW_GAMES.map((g) => `'${g}'`).join(' | ')}

/** Each Home preview's FACE-UP cards, drawn by CardFace on a transparent PREVIEW_CANVAS_WIDTH x PREVIEW_CANVAS_HEIGHT
 * canvas at ${PREVIEW_SCALE}x - indexed [game][style][variant]. GamePreview lays it over its live SVG card backs. */
export const PREVIEW_FACE_BITMAPS: Record<PreviewGame, Record<CardFaceStyle, Record<CardFaceVariant, ImageSourcePropType>>> = {
${lines.join(',\n')}
}
`
  )
  return { files, bytes }
}

bundle()
const pages = buildPages()
const shots = await capture(pages)
const faces = write(shots.filter((shot) => shot.kind === 'face'))
const previews = writePreviews(shots.filter((shot) => shot.kind === 'preview'))
fs.rmSync(WORK_DIR, { recursive: true, force: true })
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)}MB`
console.log(`wrote ${faces.files} card faces (${mb(faces.bytes)}) to ${path.relative(ROOT, OUT_DIR)}`)
console.log(`wrote ${previews.files} preview layers (${mb(previews.bytes)}) to ${path.relative(ROOT, PREVIEW_OUT_DIR)}`)
