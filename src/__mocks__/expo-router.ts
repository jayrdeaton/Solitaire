/* global jest */
module.exports = {
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn()
  }),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  Stack: { Screen: ({ children }: any) => children || null },
  Link: ({ children }: any) => children || null,
  useIsFocused: () => true
}
