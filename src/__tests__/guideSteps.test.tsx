import { render, screen } from '@testing-library/react-native'
import { isValidElement, type ReactElement } from 'react'

import { GuideCardPlay, GuideHint, GuideScore } from '@/components/GuideArt'
import { getGuideSteps } from '@/constants/guideSteps'
import { computeScore } from '@/engine/score'

const PLATFORMS = [
  ['touch', true],
  ['desktop', false]
] as const

function textOf(touch: boolean) {
  return getGuideSteps({ touch })
    .map((step) => `${step.title} ${step.body}`)
    .join(' ')
}

// Title Case as the fleet writes it: every word capitalized except short joining words mid-title.
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to'])
function isTitleCase(title: string) {
  return title.split(' ').every((word, i) => (i > 0 && SMALL_WORDS.has(word)) || /^[A-Z]/.test(word))
}

describe('getGuideSteps', () => {
  it.each(PLATFORMS)('gives the %s guide three complete, illustrated cards', (_name, touch) => {
    const steps = getGuideSteps({ touch })

    expect(steps).toHaveLength(3)
    for (const step of steps) {
      expect(step.title.trim().length).toBeGreaterThan(0)
      expect(isTitleCase(step.title)).toBe(true)
      // A card a casual player reads in a glance, not a wall of text.
      expect(step.body.length).toBeLessThanOrEqual(90)
      // Two lines, not three: turned with Home, the card's height has to fit the portrait window's
      // width (see GuideHost), and a third body line takes it past a 360dp phone. 62 characters is a
      // proxy for "two lines of DejaVu Serif Bold at 14/20 on a 264pt page" (the longest body here,
      // measured against the real TTF); a new body under it still needs measuring, since letters vary.
      expect(step.body.length).toBeLessThanOrEqual(62)
      // The pager sizes every page to the tallest, so a card without art leaves a visible gap.
      expect(isValidElement(step.art)).toBe(true)
    }
  })

  it.each(PLATFORMS)('keeps the %s copy to plain statements: no questions, no dashes', (_name, touch) => {
    for (const step of getGuideSteps({ touch })) {
      expect(`${step.title} ${step.body}`).not.toMatch(/[?\u2013\u2014]/)
    }
  })

  it('never tells a touch player to click, and never tells a desktop player to tap', () => {
    expect(textOf(true)).not.toMatch(/click|mouse|pointer|cursor/i)
    expect(textOf(false)).not.toMatch(/\btap|touch|finger|swipe/i)
  })

  it('changes only the verb between touch and desktop', () => {
    const touch = getGuideSteps({ touch: true })
    const desktop = getGuideSteps({ touch: false })

    touch.forEach((step, i) => {
      expect(desktop[i].title).toBe(step.title.replace(/Tap/g, 'Click'))
      expect(desktop[i].body).toBe(step.body.replace(/Tap/g, 'Click').replace(/\btap(s?)\b/g, 'click$1'))
    })
  })

  it('teaches tap-to-play and scopes the one game where a tap does not move a card (Pyramid pairs)', () => {
    const [play] = getGuideSteps({ touch: true })
    const [desktopPlay] = getGuideSteps({ touch: false })

    expect(play.title).toBe('Tap to Play')
    expect(play.body).toBe('Tap a card for its best move. Pyramid pairs take two taps.')
    expect(desktopPlay.title).toBe('Click to Play')
    expect(desktopPlay.body).toBe('Click a card for its best move. Pyramid pairs take two clicks.')
  })

  it('never promises a drag, which cannot make every move (Aces Up and Pyramid discards have no drop zone)', () => {
    for (const touch of [true, false]) {
      expect(textOf(touch)).not.toMatch(/drag/i)
    }
  })

  it('states the scoring the game never spells out up front: moves plus seconds, lower is better, clock starts on the first move', () => {
    for (const touch of [true, false]) {
      const [, score] = getGuideSteps({ touch })
      expect(score.title).toBe('Lower Is Better')
      expect(score.body).toBe('Score is moves plus seconds. The first move starts the clock.')
    }
  })

  it('points at the in-game light bulb, and not at the info button every Home tile already shows behind the card', () => {
    for (const touch of [true, false]) {
      const [, , hint] = getGuideSteps({ touch })

      expect(hint.title).toBe('Get a Hint')
      expect(hint.body).toMatch(/light bulb in any game/)
      expect(hint.body).not.toMatch(/info|rules/i)
    }
  })

  it('draws each card with its own app-local art, a fingertip on touch and a mouse pointer on desktop', () => {
    for (const touch of [true, false]) {
      const [play, score, hint] = getGuideSteps({ touch })
      const playArt = play.art as ReactElement<{ pointer: string }>

      expect(playArt.type).toBe(GuideCardPlay)
      expect(playArt.props.pointer).toBe(touch ? 'finger' : 'mouse')
      expect((score.art as ReactElement).type).toBe(GuideScore)
      expect((hint.art as ReactElement).type).toBe(GuideHint)
    }
  })
})

describe('GuideArt', () => {
  it('renders the play picture with a screen-reader verb that matches the pointer', async () => {
    const { unmount } = await render(<GuideCardPlay pointer='finger' />)
    expect(screen.getByLabelText('Tapping a red seven sends it onto a black eight')).toBeTruthy()
    await unmount()

    await render(<GuideCardPlay pointer='mouse' />)
    expect(screen.getByLabelText('Clicking a red seven sends it onto a black eight')).toBeTruthy()
  })

  it('renders a score picture whose numbers follow the real formula', async () => {
    await render(<GuideScore />)
    expect(screen.getByLabelText('12 moves plus 33 seconds is a score of 45')).toBeTruthy()
    expect(computeScore(12, 33)).toBe(45)
  })

  it('renders the hint picture', async () => {
    await render(<GuideHint />)
    expect(screen.getByLabelText('The light bulb button, and a red seven and a black eight ringed as a move you can make')).toBeTruthy()
  })
})
