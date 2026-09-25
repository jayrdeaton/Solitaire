import fs from 'fs'
import path from 'path'

import { CARD_FACE_BITMAPS } from '@/components/cardFaceBitmaps'

// cardFaceBitmaps.ts is generated (scripts/generate-card-face-bitmaps.mjs) - this pins that every face PlayingCard can ask
// for exists, so a partial regeneration or a hand edit can't leave a style/variant with a hole that crashes a render.
describe('CARD_FACE_BITMAPS', () => {
  it('has all 52 faces for every style and ink variant', () => {
    for (const style of ['compact', 'numeric', 'tarot', 'decorated'] as const) {
      for (const variant of ['normal', 'invert'] as const) {
        for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const) {
          const faces = CARD_FACE_BITMAPS[style][variant][suit]
          expect(faces).toHaveLength(13)
          faces.forEach((face) => expect(face).toBeDefined())
        }
      }
    }
  })

  it('only references images that exist', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../components/cardFaceBitmaps.ts'), 'utf8')
    const files = [...source.matchAll(/require\('\.\.\/\.\.\/(assets\/cardFaces\/[^']+)'\)/g)].map((m) => m[1])
    expect(files).toHaveLength(4 * 2 * 52)
    for (const file of new Set(files)) expect(fs.existsSync(path.join(__dirname, '../../..', file))).toBe(true)
  })
})
