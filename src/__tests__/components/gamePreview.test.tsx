import { render } from '@testing-library/react-native'

import { GamePreview, type PreviewCardPlacement } from '@/components/GamePreview'
import { PREVIEW_FACE_BITMAPS, type PreviewGame } from '@/components/previewFaceBitmaps'
import { lightColors } from '@/components/theme'
import { buildAcesUpPreview } from '@/games/acesup/previewLayout'
import { buildCanfieldPreview } from '@/games/canfield/previewLayout'
import { buildFortyThievesPreview } from '@/games/fortythieves/previewLayout'
import { buildFreeCellPreview } from '@/games/freecell/previewLayout'
import { buildGolfPreview } from '@/games/golf/previewLayout'
import { buildKlondikePreview } from '@/games/klondike/previewLayout'
import { buildPyramidPreview } from '@/games/pyramid/previewLayout'
import { buildScorpionPreview } from '@/games/scorpion/previewLayout'
import { buildSpiderPreview } from '@/games/spider/previewLayout'
import { buildTriPeaksPreview } from '@/games/tripeaks/previewLayout'
import { buildYukonPreview } from '@/games/yukon/previewLayout'
import { DEFAULT_SETTINGS, SettingsProvider } from '@/stores/settings'

const ALL_PREVIEWS: Record<PreviewGame, PreviewCardPlacement[]> = {
  acesup: buildAcesUpPreview(),
  canfield: buildCanfieldPreview(),
  fortythieves: buildFortyThievesPreview(),
  freecell: buildFreeCellPreview(),
  golf: buildGolfPreview(),
  klondike: buildKlondikePreview(),
  pyramid: buildPyramidPreview(),
  scorpion: buildScorpionPreview(),
  spider: buildSpiderPreview(),
  tripeaks: buildTriPeaksPreview(),
  yukon: buildYukonPreview()
}

// Counts every element in a rendered tree (host nodes here - react-native and react-native-svg both render
// as host components under jest-expo).
function countNodes(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  const { children } = node as { children?: unknown[] | null }
  return 1 + (children ?? []).reduce<number>((sum, child) => sum + countNodes(child), 0)
}

async function renderPreview(game: PreviewGame, placements: PreviewCardPlacement[]) {
  const screen = await render(
    <SettingsProvider initialValue={DEFAULT_SETTINGS}>
      <GamePreview game={game} placements={placements} colors={lightColors} />
    </SettingsProvider>
  )
  return countNodes(screen.toJSON())
}

// Home mounts all eleven of these at once, and it used to draw each thumbnail card with the real full-detail
// @tastic/cards art (~35 elements per card on average, ~12k native views for the menu - 1.3-1.5s of blocked
// JS thread in a production bundle, 2.6s in dev, every time Home mounted). Now the face-up cards are one pre-rendered
// Image per tile and the backs are live SVG (a merged Path for column layouts, a Rect per back otherwise). This budget
// is deliberately generous for that shape but far below the old one, so bringing the per-card art back fails here.
const FIXED_OVERHEAD = 6 // wrapper View + Svg + Image + a little slack
const OVERLAPPING_LAYOUTS = ['pyramid', 'tripeaks']

describe('GamePreview weight', () => {
  it.each(Object.entries(ALL_PREVIEWS) as [PreviewGame, PreviewCardPlacement[]][])('%s tile stays lightweight', async (game, placements) => {
    const nodes = await renderPreview(game, placements)
    const backs = placements.filter((p) => !p.faceUp).length

    expect(placements.length).toBeGreaterThan(0)
    // One node per back for the per-card layouts, one Path for all of them otherwise - never one per face-up card.
    expect(nodes).toBeLessThanOrEqual((OVERLAPPING_LAYOUTS.includes(game) ? backs : 1) + FIXED_OVERHEAD)
  })

  it('keeps the whole menu to a few dozen nodes', async () => {
    let total = 0
    for (const [game, placements] of Object.entries(ALL_PREVIEWS) as [PreviewGame, PreviewCardPlacement[]][]) total += await renderPreview(game, placements)

    // Was ~12,000 with the full card art (and ~780 with one Rect per card).
    expect(total).toBeLessThan(100)
  })

  it('has a face layer for every game, card style and ink', () => {
    for (const game of Object.keys(ALL_PREVIEWS) as PreviewGame[]) {
      for (const style of ['compact', 'numeric', 'tarot', 'decorated'] as const) {
        expect(PREVIEW_FACE_BITMAPS[game][style].normal).toBeDefined()
        expect(PREVIEW_FACE_BITMAPS[game][style].invert).toBeDefined()
      }
    }
  })
})
