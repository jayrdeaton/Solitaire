type Store = typeof import('@/stores/gameInProgress')

const KEY = 'solitaire.game-in-progress.v1.klondike'
const board = (moves: number) => ({ state: { tableau: [] as number[], n: moves }, undoStack: [], moves, elapsedSeconds: moves })

describe('game-in-progress persistence (coalesced saves)', () => {
  let store: Store
  let disk: Map<string, string>
  let setItem: jest.SpyInstance
  let appStateHandler: ((s: string) => void) | undefined

  beforeEach(() => {
    jest.useFakeTimers()
    jest.resetModules()
    // Everything is required AFTER resetModules so the spies below are on the very instances the store under
    // test gets (a top-level import would be a different module instance).
    const AsyncStorage = require('@react-native-async-storage/async-storage')
    const { AppState } = require('react-native')
    disk = new Map()
    setItem = jest.spyOn(AsyncStorage, 'setItem').mockImplementation((async (k: string, v: string) => void disk.set(k, v)) as never)
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation((async (k: string) => disk.get(k) ?? null) as never)
    jest.spyOn(AsyncStorage, 'removeItem').mockImplementation((async (k: string) => void disk.delete(k)) as never)
    appStateHandler = undefined
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (s: string) => void) => {
      appStateHandler = handler
      return { remove: jest.fn() }
    }) as never)
    store = require('@/stores/gameInProgress')
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('writes nothing per move, then one write of the latest board once moves stop', async () => {
    for (let i = 1; i <= 20; i++) store.saveGameInProgress('klondike', board(i))

    expect(setItem).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(600)

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(disk.get(KEY)!).moves).toBe(20)
  })

  it('still writes during a long unbroken burst of moves (bounded wait)', async () => {
    // A move every 100ms for 4s never lets the quiet-period debounce elapse on its own.
    for (let i = 1; i <= 40; i++) {
      store.saveGameInProgress('klondike', board(i))
      await jest.advanceTimersByTimeAsync(100)
    }

    expect(setItem.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(disk.get(KEY)!).moves).toBeGreaterThan(20)
  })

  it('flushes immediately on demand (screen unmount)', async () => {
    store.saveGameInProgress('klondike', board(7))

    await store.flushGameInProgress()

    expect(JSON.parse(disk.get(KEY)!).moves).toBe(7)
    // and the pending timer does not write a second time
    await jest.advanceTimersByTimeAsync(2000)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('flushes when the app leaves the foreground', async () => {
    store.saveGameInProgress('klondike', board(3))
    expect(appStateHandler).toBeDefined()

    appStateHandler!('background')
    await Promise.resolve()
    await Promise.resolve()

    expect(JSON.parse(disk.get(KEY)!).moves).toBe(3)
  })

  it('does not flush on a return to the foreground', async () => {
    store.saveGameInProgress('klondike', board(3))

    appStateHandler!('active')
    await Promise.resolve()

    expect(setItem).not.toHaveBeenCalled()
  })

  it('a pending save can never resurrect a cleared game (win / New Game / stats reset)', async () => {
    store.saveGameInProgress('klondike', board(5))

    await store.clearGameInProgress('klondike')
    await jest.advanceTimersByTimeAsync(5000)

    expect(disk.has(KEY)).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('a read sees the latest board even if its save is still waiting out the debounce', async () => {
    store.saveGameInProgress('klondike', board(9))

    const loaded = await store.loadGameInProgress<{ n: number }>('klondike')

    expect(loaded?.moves).toBe(9)
  })

  it('keeps each game in its own slot', async () => {
    store.saveGameInProgress('klondike', board(1))
    store.saveGameInProgress('spider', board(2))

    await jest.advanceTimersByTimeAsync(600)

    expect(JSON.parse(disk.get(KEY)!).moves).toBe(1)
    expect(JSON.parse(disk.get('solitaire.game-in-progress.v1.spider')!).moves).toBe(2)
  })

  describe('preload on press-in', () => {
    let getItem: jest.SpyInstance
    beforeEach(() => {
      getItem = jest.spyOn(require('@react-native-async-storage/async-storage'), 'getItem')
    })

    it('a load right after a preload reuses the read that is already in flight', async () => {
      disk.set(KEY, JSON.stringify(board(4)))

      store.preloadGameInProgress('klondike')
      const loaded = await store.loadGameInProgress('klondike')

      expect(loaded?.moves).toBe(4)
      expect(getItem).toHaveBeenCalledTimes(1)
    })

    it('is used once - the next load reads storage again', async () => {
      disk.set(KEY, JSON.stringify(board(4)))

      store.preloadGameInProgress('klondike')
      await store.loadGameInProgress('klondike')
      await store.loadGameInProgress('klondike')

      expect(getItem).toHaveBeenCalledTimes(2)
    })

    it('a save after the preload makes it stale, so the load sees the new board', async () => {
      disk.set(KEY, JSON.stringify(board(4)))
      store.preloadGameInProgress('klondike')

      store.saveGameInProgress('klondike', board(9))
      const loaded = await store.loadGameInProgress('klondike')

      expect(loaded?.moves).toBe(9)
    })

    it('a clear after the preload makes it stale, so the load sees no game', async () => {
      disk.set(KEY, JSON.stringify(board(4)))
      store.preloadGameInProgress('klondike')

      await store.clearGameInProgress('klondike')

      expect(await store.loadGameInProgress('klondike')).toBeNull()
    })

    it('does not start a read while a save is waiting out its debounce (it would be stale)', async () => {
      disk.set(KEY, JSON.stringify(board(4)))
      store.saveGameInProgress('klondike', board(9))

      store.preloadGameInProgress('klondike')

      expect(getItem).not.toHaveBeenCalled()
      expect((await store.loadGameInProgress('klondike'))?.moves).toBe(9)
    })

    it('a failing preloaded read resolves to no game rather than rejecting', async () => {
      getItem.mockRejectedValueOnce(new Error('boom'))

      store.preloadGameInProgress('klondike')

      expect(await store.loadGameInProgress('klondike')).toBeNull()
    })
  })

  it('swallows a failing write (best effort, never an unhandled rejection)', async () => {
    setItem.mockRejectedValue(new Error('disk full'))
    store.saveGameInProgress('klondike', board(1))

    await expect(store.flushGameInProgress()).resolves.toBeUndefined()
  })
})
