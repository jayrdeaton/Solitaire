/* global jest */
const RN = require('react-native')
const passthrough = (value: unknown) => value
const passthroughLast = (...values: unknown[]) => values[values.length - 1]
function layoutTransition() {
  const transition: Record<string, () => unknown> = {}
  for (const step of ['duration', 'easing', 'delay', 'springify', 'damping', 'stiffness']) transition[step] = () => transition
  return transition
}

const Animated = {
  View: RN.View,
  Text: RN.Text,
  Image: RN.Image,
  ScrollView: RN.ScrollView,
  FlatList: RN.FlatList,
  createAnimatedComponent: (Component: unknown) => Component,
  // get/set as well as value, as Reanimated 4's shared values have (the React Compiler-safe way to write one from JS).
  useSharedValue: <T>(value: T) => ({
    value,
    get(): T {
      return this.value
    },
    set(next: T) {
      this.value = next
    }
  }),
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
  runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedRef: () => ({ current: null }),
  Easing: {
    linear: passthrough,
    ease: passthrough,
    quad: passthrough,
    cubic: passthrough,
    back: () => passthrough,
    in: passthrough,
    out: passthrough,
    inOut: passthrough,
    bezier: () => passthrough
  },
  ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
  // Reanimated's global Reduce Motion override (reducedMotion.tsx's bridge): renders nothing.
  ReducedMotionConfig: () => null,
  // A layout transition (PileView's fan glide): inert here, every builder step hands the same transition back.
  LinearTransition: layoutTransition(),
  default: {
    View: RN.View,
    Text: RN.Text,
    createAnimatedComponent: (Component: unknown) => Component,
    call: jest.fn()
  }
}

module.exports = Animated
