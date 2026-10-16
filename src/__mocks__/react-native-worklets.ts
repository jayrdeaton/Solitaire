module.exports = {
  createSerializable: (value: unknown) => value,
  isWorkletFunction: () => false,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  scheduleOnUI: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => void fn(...args)
}
