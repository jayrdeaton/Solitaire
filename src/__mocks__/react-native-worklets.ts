module.exports = {
  createSerializable: (value: unknown) => value,
  isWorkletFunction: () => false,
  runOnUI: (fn: (...args: unknown[]) => unknown) => fn,
  scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => void fn(...args),
  scheduleOnUI: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => void fn(...args)
}
