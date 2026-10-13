import { clearFanTop, fanStep, setFanTop } from '@/components/dragdrop/fanTops'

const RUN = ['clubs-9-0', 'hearts-8-0', 'clubs-7-0']

afterEach(() => {
  RUN.forEach((id) => {
    clearFanTop(id, OLD)
    clearFanTop(id, NEW)
  })
})

const OLD = {}
const NEW = {}
const layOut = (owner: object, top: number, step: number) => RUN.forEach((id, i) => setFanTop(id, owner, top + i * step))

describe('fanStep', () => {
  it("is the run's spacing as its column lays it out: from its first card to its last", () => {
    layOut(OLD, 120, 18.5)
    expect(fanStep(RUN)).toBeCloseTo(18.5, 9)
    expect(fanStep(RUN.slice(1))).toBeCloseTo(18.5, 9)
  })

  it('is null for a single card, for a run that is not laid out in a column, and for a run that is not fanned', () => {
    layOut(OLD, 120, 18.5)
    expect(fanStep(RUN.slice(0, 1))).toBeNull()
    expect(fanStep(['spades-1-0', 'spades-2-0'])).toBeNull()
    layOut(OLD, 120, 0)
    expect(fanStep(RUN)).toBeNull()
  })

  it("follows a card to the column it moves to: the old instance's late cleanup leaves the new one's spot alone", () => {
    layOut(OLD, 120, 18.5)
    layOut(NEW, 300, 24)
    RUN.forEach((id) => clearFanTop(id, OLD))
    expect(fanStep(RUN)).toBeCloseTo(24, 9)
    RUN.forEach((id) => clearFanTop(id, NEW))
    expect(fanStep(RUN)).toBeNull()
  })
})
