/* global jest */
module.exports = {
  ...jest.requireActual('react-native-safe-area-context'),
  SafeAreaProvider: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}
