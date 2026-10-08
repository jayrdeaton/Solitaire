type Api = typeof import('@/stores/gameInProgress')
type Redux = typeof import('@/redux/store')

const board = (moves: number) => ({ state: { tableau: [] as number[], n: moves }, undoStack: [], moves, elapsedSeconds: moves })
// redux-persist stores each key of a persisted slice as its own JSON string inside the entry.
const persistedMoves = (disk: Map<string, string>, gameId: string): number | undefined => {
  const raw = disk.get(`persist:gameInProgress.${gameId}`)
  if (!raw) return undefined
  const saved = JSON.parse(JSON.parse(raw).saved)
  return saved?.moves
}

describe('game-in-progress persistence (coalesced saves)', () => {
  let api: Api
  let redux: Redux
  let disk: Map<string, string>
  let setItem: jest.SpyInstance
  let dispatch: jest.SpyInstance
  let appStateHandler: ((s: string) => void) | undefined

  // Every setSaved dispatch for one game - one per actual save into the store.
  const savesOf = (gameId: string) => dispatch.mock.calls.filter(([action]) => action.type === `gameInProgress/${gameId}/setSaved`)
  const movesInStore = (gameId: 'klondike' | 'spider') => (redux.store.getState().gameInProgress[gameId].saved as { moves: number } | null)?.moves

  beforeEach(async () => {
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
    redux = require('@/redux/store')
    // Rehydration has to finish before redux-persist writes anything (PersistGate guarantees the same in the app).
    while (!redux.persistor.getState().bootstrapped) await jest.advanceTimersByTimeAsync(10)
    dispatch = jest.spyOn(redux.store, 'dispatch')
    api = require('@/stores/gameInProgress')
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('stores nothing per move, then one save of the latest board once moves stop', async () => {
    for (let i = 1; i <= 20; i++) api.saveGameInProgress('klondike', board(i))

    expect(savesOf('klondike')).toHaveLength(0)

    await jest.advanceTimersByTimeAsync(600)

    expect(savesOf('klondike')).toHaveLength(1)
    expect(movesInStore('klondike')).toBe(20)
  })

  it('still saves during a long unbroken burst of moves (bounded wait)', async () => {
    // A move every 100ms for 4s never lets the quiet-period debounce elapse on its own.
    for (let i = 1; i <= 40; i++) {
      api.saveGameInProgress('klondike', board(i))
      await jest.advanceTimersByTimeAsync(100)
    }

    expect(savesOf('klondike').length).toBeGreaterThanOrEqual(1)
    expect(movesInStore('klondike')).toBeGreaterThan(20)
  })

  it('flushes immediately on demand (screen unmount), all the way to storage', async () => {
    api.saveGameInProgress('klondike', board(7))

    await api.flushGameInProgress()

    expect(movesInStore('klondike')).toBe(7)
    expect(persistedMoves(disk, 'klondike')).toBe(7)
    // and the pending timer does not save a second time
    await jest.advanceTimersByTimeAsync(2000)
    expect(savesOf('klondike')).toHaveLength(1)
  })

  it('flushes when the app leaves the foreground', async () => {
    api.saveGameInProgress('klondike', board(3))
    expect(appStateHandler).toBeDefined()

    appStateHandler!('background')
    await jest.advanceTimersByTimeAsync(0)

    expect(movesInStore('klondike')).toBe(3)
    expect(persistedMoves(disk, 'klondike')).toBe(3)
  })

  it('does not flush on a return to the foreground', async () => {
    api.saveGameInProgress('klondike', board(3))

    appStateHandler!('active')
    await Promise.resolve()

    expect(savesOf('klondike')).toHaveLength(0)
  })

  it('a pending save can never resurrect a cleared game (win / New Game / stats reset)', async () => {
    api.saveGameInProgress('klondike', board(5))

    await api.clearGameInProgress('klondike')
    await jest.advanceTimersByTimeAsync(5000)

    expect(movesInStore('klondike')).toBeUndefined()
    expect(savesOf('klondike').every(([action]) => action.payload === null)).toBe(true)
  })

  it('a read sees the latest board even if its save is still waiting out the debounce', async () => {
    api.saveGameInProgress('klondike', board(9))

    const loaded = await api.loadGameInProgress<{ n: number }>('klondike')

    expect(loaded?.moves).toBe(9)
  })

  it('keeps each game in its own slot and its own storage entry', async () => {
    api.saveGameInProgress('klondike', board(1))
    api.saveGameInProgress('spider', board(2))

    await jest.advanceTimersByTimeAsync(600)
    await api.flushGameInProgress()

    expect(persistedMoves(disk, 'klondike')).toBe(1)
    expect(persistedMoves(disk, 'spider')).toBe(2)
    // Never in the root entry: a saved board can run to megabytes.
    expect(disk.get('persist:root') ?? '').not.toContain('gameInProgress')
  })

  it('swallows a failing write (best effort, never an unhandled rejection)', async () => {
    setItem.mockRejectedValue(new Error('disk full'))
    // redux-persist reports the failed write itself; that log is expected here.
    jest.spyOn(console, 'error').mockImplementation(() => {})
    api.saveGameInProgress('klondike', board(1))

    await expect(api.flushGameInProgress()).resolves.toBeUndefined()
  })
})
