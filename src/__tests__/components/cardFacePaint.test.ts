import { isAnyFaceLoading, trackFaceLoad, whenFacesPainted } from '@/components/cardFacePaint'

const flush = () => Promise.resolve().then(() => undefined)

describe('cardFacePaint', () => {
  it('counts every mounted face of a card: the card is loading until the last one is done, and a done called twice counts once', () => {
    const first = trackFaceLoad('hearts-1-0')
    const second = trackFaceLoad('hearts-1-0')
    first()
    first()
    expect(isAnyFaceLoading(['hearts-1-0'])).toBe(true)
    second()
    expect(isAnyFaceLoading(['hearts-1-0'])).toBe(false)
  })

  it('whenFacesPainted answers at once when nothing is loading', () => {
    const painted = jest.fn()
    whenFacesPainted(['spades-2-0'], 250, painted)
    expect(painted).toHaveBeenCalledTimes(1)
  })

  it('whenFacesPainted waits for the last loading face of any of its cards, then answers once', async () => {
    const a = trackFaceLoad('clubs-3-0')
    const b = trackFaceLoad('clubs-4-0')
    const painted = jest.fn()
    const cancel = whenFacesPainted(['clubs-3-0', 'clubs-4-0'], 10_000, painted)
    a()
    await flush()
    expect(painted).not.toHaveBeenCalled()
    b()
    await flush()
    expect(painted).toHaveBeenCalledTimes(1)
    cancel()
  })

  it('whenFacesPainted gives up after maxWaitMs, and a cancelled wait never answers', () => {
    jest.useFakeTimers()
    try {
      const done = trackFaceLoad('diamonds-5-0')
      const capped = jest.fn()
      const cancelled = jest.fn()
      whenFacesPainted(['diamonds-5-0'], 250, capped)
      whenFacesPainted(['diamonds-5-0'], 250, cancelled)()
      jest.advanceTimersByTime(249)
      expect(capped).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1)
      expect(capped).toHaveBeenCalledTimes(1)
      expect(cancelled).not.toHaveBeenCalled()
      done()
    } finally {
      jest.useRealTimers()
    }
  })
})
