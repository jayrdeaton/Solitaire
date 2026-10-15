import { render } from '@testing-library/react-native'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

import { ThemeBridge } from '@/components/ThemeBridge'

// The status bar is set per screen: the root Stack's screen options (_layout.tsx's ThemedStack, from @tastic/core's
// useRotationAwareStatusBar) hide it while the content is turned. That needs UIViewControllerBasedStatusBarAppearance
// on (@tastic/core's config plugin), and with it on, every React Native StatusBar logs an error (a red box in a dev
// build). An app linked against the iOS 27 SDK can't set the bar app-wide anyway, which is the only way that component
// works on iOS. So nothing in the app may mount one: not a component here, and not auto-paper's own.

const mockAutoPaperProvider = jest.fn(({ children }: { children: unknown }) => children)
jest.mock('@rific/auto-paper', () => ({
  Provider: (props: { children: unknown }) => mockAutoPaperProvider(props),
  themeActions: { initialize: (settings: unknown) => ({ type: 'theme/initialize', payload: settings }) },
  useThemeBridgeProps: (props: object) => props
}))
jest.mock('react-redux', () => ({ shallowEqual: () => true, useDispatch: () => () => {}, useSelector: () => ({}) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'DejaVuSerif-Bold' }))
jest.mock('@/utils/splashGate', () => ({ markSplashReady: () => {} }))
jest.mock('@react-native-masked-view/masked-view', () => () => null)
jest.mock('expo-blur', () => ({ BlurView: () => null }))

const SRC = join(__dirname, '..', '..')

/** Every app source file (tests and mocks left out). */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || name === '__mocks__' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('the status bar', () => {
  it('is never a StatusBar component: no source file imports expo-status-bar or React Native StatusBar', () => {
    const offenders = sourceFiles().filter((file) => {
      const source = readFileSync(file, 'utf8')
      return /from ['"]expo-status-bar['"]/.test(source) || /import\s*\{[^}]*\bStatusBar\b[^}]*\}\s*from ['"]react-native['"]/.test(source)
    })
    expect(offenders.map((file) => relative(SRC, file))).toEqual([])
  })

  it("turns auto-paper's own StatusBar off", async () => {
    await render(<ThemeBridge>{null}</ThemeBridge>)
    expect(mockAutoPaperProvider).toHaveBeenCalledWith(expect.objectContaining({ statusBar: false }))
  })
})
