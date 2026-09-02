import { beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({
  initializeApp: vi.fn((config: unknown) => ({ __app: config })),
  getApps: vi.fn(() => [] as unknown[]),
}))

const auth = vi.hoisted(() => ({
  getAuth: vi.fn((a: unknown) => ({ __auth: a })),
}))

const firestore = vi.hoisted(() => ({
  getFirestore: vi.fn((a: unknown) => ({ __db: a })),
}))

vi.mock('firebase/app', () => app)
vi.mock('firebase/auth', () => auth)
vi.mock('firebase/firestore', () => firestore)

const { initFirebase } = await import('../src/index')

const config = {
  apiKey: 'key',
  authDomain: 'example.firebaseapp.com',
  projectId: 'example',
  storageBucket: 'example.appspot.com',
  messagingSenderId: '1',
  appId: '1:1:web:1',
}

beforeEach(() => {
  vi.clearAllMocks()
  app.getApps.mockReturnValue([])
})

describe('initFirebase', () => {
  it('初回は設定でアプリを初期化する', () => {
    const result = initFirebase(config)

    expect(app.initializeApp).toHaveBeenCalledWith(config)
    expect(result.app).toEqual({ __app: config })
    expect(result.db).toEqual({ __db: { __app: config } })
  })

  it('既にアプリがあれば初期化せず再利用する（多重初期化を防ぐ）', () => {
    const existing = { __app: 'existing' }
    app.getApps.mockReturnValue([existing])

    const result = initFirebase(config)

    expect(app.initializeApp).not.toHaveBeenCalled()
    expect(result.app).toBe(existing)
  })

  it('既定では getAuth を使う', () => {
    const result = initFirebase(config)

    expect(auth.getAuth).toHaveBeenCalledWith({ __app: config })
    expect(result.auth).toEqual({ __auth: { __app: config } })
  })

  it('Auth の生成を差し替えられる（React Native の永続化用）', () => {
    const custom = { __auth: 'custom' } as never
    const createAuth = vi.fn(() => custom)

    const result = initFirebase(config, createAuth)

    expect(auth.getAuth).not.toHaveBeenCalled()
    expect(createAuth).toHaveBeenCalledWith({ __app: config })
    expect(result.auth).toBe(custom)
  })

  // 回帰: 2 回目も createAuth を呼んでいたため、React Native の
  // initializeAuth + getReactNativePersistence が auth/already-initialized で
  // throw していた（Fast Refresh、複数モジュールからの呼び出し）
  it('2 回目は createAuth を呼ばず getAuth を返す', () => {
    const custom = { __auth: 'custom' } as never
    const createAuth = vi.fn(() => custom)

    initFirebase(config, createAuth)
    expect(createAuth).toHaveBeenCalledTimes(1)

    // 1 回目で app が作られた状態を再現する
    app.getApps.mockReturnValue([{ __app: config }])
    const result = initFirebase(config, createAuth)

    expect(createAuth).toHaveBeenCalledTimes(1)
    expect(auth.getAuth).toHaveBeenCalledWith({ __app: config })
    expect(result.auth).toEqual({ __auth: { __app: config } })
  })
})
