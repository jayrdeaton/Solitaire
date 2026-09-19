import { render } from '@testing-library/react-native'

import { GamePreview, type PreviewCardPlacement } from '@/components/GamePreview'
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

const ALL_PREVIEWS: Record<string, PreviewCardPlacement[]> = {
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

async function renderPreview(placements: PreviewCardPlacement[]) {
  const screen = await render(
    <SettingsProvider initialValue={DEFAULT_SETTINGS}>
      <GamePreview placements={placements} colors={lightColors} />
    </SettingsProvider>
  )
  return countNodes(screen.toJSON())
}

// Home mounts all eleven of these at once, and it used to draw each thumbnail card with the real full-detail
// @tastic/cards art (~35 elements per card on average, ~12k native views for the menu - 1.3-1.5s of blocked
// JS thread in a production bundle, 2.6s in dev, every time Home mounted). At ~7pt wide none of that detail
// is legible, so a thumbnail card is now a Rect plus (face-up only) one suit-pip Path. This budget is
// deliberately generous for that shape but far below the old one, so bringing the heavy art back fails here.
const MAX_NODES_PER_CARD = 4 // the per-card fallback (Pyramid/TriPeaks): a Rect plus a pip Path, or a Rect plus a medallion
const FIXED_OVERHEAD = 6 // wrapper View + Svg + a little slack
// Column layouts are merged into a handful of Paths (see previewGeometry.ts), independent of how many cards there are.
const MERGED_MAX_NODES = 12
const OVERLAPPING_LAYOUTS = ['pyramid', 'tripeaks']

describe('GamePreview weight', () => {
  it.each(Object.entries(ALL_PREVIEWS))('%s tile stays lightweight', async (_name, placements) => {
    const nodes = await renderPreview(placements)

    expect(placements.length).toBeGreaterThan(0)
    if (OVERLAPPING_LAYOUTS.includes(_name)) expect(nodes).toBeLessThanOrEqual(placements.length * MAX_NODES_PER_CARD + FIXED_OVERHEAD)
    else expect(nodes).toBeLessThanOrEqual(MERGED_MAX_NODES)
  })

  it('keeps the whole menu to a few hundred nodes', async () => {
    let total = 0
    for (const placements of Object.values(ALL_PREVIEWS)) total += await renderPreview(placements)

    // Was ~12,000 with the full card art (and ~780 with one Rect per card).
    expect(total).toBeLessThan(300)
  })

  it('draws every placement (the face/back split is preserved)', async () => {
    const placements = ALL_PREVIEWS.klondike
    const faceUp = placements.filter((p) => p.faceUp).length
    const faceDown = placements.length - faceUp
    const screen = await render(
      <SettingsProvider initialValue={DEFAULT_SETTINGS}>
        <GamePreview placements={placements} colors={lightColors} />
      </SettingsProvider>
    )

    // Klondike's starting deal is 7 up / 21 down, drawn as merged strips: back strips, face strips and pips.
    expect(faceUp).toBe(7)
    expect(faceDown).toBe(21)
    const nodes = countNodes(screen.toJSON())
    expect(nodes).toBeGreaterThanOrEqual(5) // wrapper + Svg + backs + faces + pips (the medallion path only exists for a fully visible back)
  })
})
