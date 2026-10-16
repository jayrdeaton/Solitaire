import { render } from '@testing-library/react-native'

import { CardBackArt, DEFAULT_MONOGRAM, monogramFor } from '@/components/CardBackArt'
import { lightColors } from '@/components/theme'

// The player's tag is its own back, Monogram (Jay, 2026-10-16): it shows S until the player has a tag
// (letters or an emoji), and the Geometric back it is drawn on never carries one.

const mockCardBack = jest.fn()
const mockDecoratedCardBack = jest.fn()
const mockMonogramCardBack = jest.fn()

jest.mock('@tastic/cards', () => ({
  CardBack: (props: object) => {
    mockCardBack(props)
    return null
  },
  DecoratedCardBack: (props: object) => {
    mockDecoratedCardBack(props)
    return null
  }
}))
jest.mock('@/components/MonogramCardBack', () => ({
  MonogramCardBack: (props: object) => {
    mockMonogramCardBack(props)
    return null
  }
}))

beforeEach(() => {
  mockCardBack.mockClear()
  mockDecoratedCardBack.mockClear()
  mockMonogramCardBack.mockClear()
})

describe('monogramFor', () => {
  it("is the player's tag, letters or an emoji", () => {
    expect(monogramFor('JD')).toBe('JD')
    expect(monogramFor('🦊')).toBe('🦊')
  })

  it('is S with no tag, an empty one or a blank one', () => {
    expect(DEFAULT_MONOGRAM).toBe('S')
    expect(monogramFor(undefined)).toBe('S')
    expect(monogramFor('')).toBe('S')
    expect(monogramFor('  ')).toBe('S')
  })
})

describe('CardBackArt', () => {
  const size = { colors: lightColors, width: 44, height: 64 }

  it("draws the Monogram back with the player's tag, or S without one", async () => {
    await render(<CardBackArt backStyle='monogram' {...size} tag='🦊' />)
    expect(mockMonogramCardBack).toHaveBeenLastCalledWith(expect.objectContaining({ monogram: '🦊' }))

    await render(<CardBackArt backStyle='monogram' {...size} />)
    expect(mockMonogramCardBack).toHaveBeenLastCalledWith(expect.objectContaining({ monogram: 'S' }))
    expect(mockCardBack).not.toHaveBeenCalled()
  })

  it('never puts the tag on the Geometric back', async () => {
    await render(<CardBackArt backStyle='geometric' {...size} tag='JD' />)
    expect(mockCardBack).toHaveBeenLastCalledWith(expect.not.objectContaining({ tag: expect.anything() }))
  })

  it('draws Ornate and Plain from the sheet art', async () => {
    await render(<CardBackArt backStyle='ornate' {...size} tag='JD' />)
    expect(mockDecoratedCardBack).toHaveBeenLastCalledWith(expect.objectContaining({ style: 'ornate' }))
    expect(mockCardBack).not.toHaveBeenCalled()
  })
})

describe('monogramFontSize', () => {
  // Real module (only the component above is mocked): a tag is sized from the card font's own letter widths.
  const { monogramFontSize } = jest.requireActual('@/components/MonogramCardBack')

  it('makes a lone S big, and shrinks wider tags to the same width', () => {
    const s = monogramFontSize('S', 100)
    expect(s).toBeGreaterThan(70)
    expect(monogramFontSize('JD', 100)).toBeLessThan(s)
    expect(monogramFontSize('MMM', 100) * 1.107 * 3).toBeCloseTo(52)
  })

  it('never lets a narrow letter grow taller than the cap', () => {
    expect(monogramFontSize('I', 100) * 0.729).toBeCloseTo(60)
  })
})
