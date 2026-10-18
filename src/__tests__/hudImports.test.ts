import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// Solitaire takes everything it needs from @tastic/hud through hud's light './chrome' and './guide'
// entries. hud's main entry also re-exports the per-seat lobby and the Skia gauge, so a single import
// from it would need @shopify/react-native-skia and @tastic/split-screen, which this app no longer
// installs. eslint.config.cjs bans the bare specifier in import statements; this also covers
// jest.mock(), jest.requireActual(), require() and import(), and any other hud subpath, by checking
// every quoted '@tastic/hud...' string under src/ (comments name hud without quotes).

const SRC = join(__dirname, '..')
const HUD_SPECIFIER = /(['"`])(@tastic\/hud(?:\/[^'"`]*)?)\1/g
const ALLOWED = ['@tastic/hud/chrome', '@tastic/hud/guide']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    // This file names the bare specifier itself, in the pattern above.
    return /\.tsx?$/.test(name) && path !== __filename ? [path] : []
  })
}

describe('@tastic/hud import boundary', () => {
  const found = sourceFiles(SRC).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(HUD_SPECIFIER)].map((match) => ({ file: relative(SRC, file), specifier: match[2] })))

  it('sees the hud imports it guards, in source and in the test mocks', () => {
    expect(found.map(({ file }) => file)).toEqual(expect.arrayContaining([join('app', '_layout.tsx'), join('components', 'GameChrome.tsx'), join('components', 'GuideHost.tsx'), join('__tests__', 'components', 'dialogConsistency.test.tsx')]))
  })

  it("names only '@tastic/hud/chrome' and '@tastic/hud/guide'", () => {
    expect(found.filter(({ specifier }) => !ALLOWED.includes(specifier))).toEqual([])
  })
})
