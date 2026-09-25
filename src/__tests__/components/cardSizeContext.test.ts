import { CARD_ASPECT, faceUpFanOffset } from '@tastic/cards'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'

describe('FACE_UP_OFFSET_RATIO', () => {
  // Pyramid/TriPeaks/GamePreview fan by a fraction of card HEIGHT while @tastic/cards' faceUpFanOffset is a
  // fraction of WIDTH, so the two only agree through CARD_ASPECT. 0.31 is the 0.45W strip (0.3097) rounded; a
  // drift like the old 0.26 (0.043 off) clips the Jack's corner index and must fail here.
  it('matches the strip @tastic/cards gives a covered face-up card', () => {
    expect(Math.abs(FACE_UP_OFFSET_RATIO - faceUpFanOffset(1) * CARD_ASPECT)).toBeLessThan(0.001)
  })
})
