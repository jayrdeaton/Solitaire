/* global jest */
const RN = require('react-native')
const passthrough = (value: unknown) => value
const passthroughLast = (...values: unknown[]) => values[values.length - 1]

const Animated = {
  View: RN.View,
  Text: RN.Text,
  Image: RN.Image,
  ScrollView: RN.ScrollView,
  FlatList: RN.FlatList,
  createAnimatedComponent: (Component: unknown) => Component,
  useSharedValue: <T>(value: T) => ({ value }),
  useAnimatedStyle: (updater?: () => unknown) => (typeof updater === 'function' ? updater() : {}),
  useAnimatedProps: (updater?: () => unknown) => (typeof updater === 'function' ? updater() : {}),
  useDerivedValue: (updater?: () => unknown) => ({ value: typeof updater === 'function' ? updater() : undefined }),
  withTiming: passthrough,
  // A real jest.fn (not a bare function reference) so a test can override its behavior for one case
  // (e.g. simulating a spring that hasn't actually reached its target yet - see dealLayer.test.tsx's
  // settle-verification tests) while every other test keeps today's default passthrough.
  withSpring: jest.fn(passthrough),
  withDelay: (_ms: number, value: unknown) => value,
  withRepeat: (value: unknown) => value,
  withSequence: passthroughLast,
  cancelAnimation: jest.fn(),
  interpolate: passthrough,
  interpolateColor: () => '#000000',
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedRef: () => ({ current: null }),
  Easing: {
    linear: passthrough,
    ease: passthrough,
    in: passthrough,
    out: passthrough,
    inOut: passthrough,
    bezier: () => passthrough
  },
  default: {
    View: RN.View,
    Text: RN.Text,
    createAnimatedComponent: (Component: unknown) => Component,
    call: jest.fn()
  }
}

module.exports = Animated
