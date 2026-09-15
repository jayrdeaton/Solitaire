/* global jest */
module.exports = {
  DeviceMotion: {
    Gravity: 9.80665,
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeAllListeners: jest.fn(),
    setUpdateInterval: jest.fn(),
    isAvailableAsync: jest.fn().mockResolvedValue(true)
  }
}
