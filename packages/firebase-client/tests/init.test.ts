import { beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({
  initializeApp: vi.fn((config: { projectId: string }) => ({
    __app: config,
    options: config,
  })),
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
    expect(result.app).toEqual({ __app: config, options: config })
    expect(result.db).toEqual({ __db: { __app: config, options: config } })
  })

  it('既にアプリがあれば初期化せず再利用する（多重初期化を防ぐ）', () => {
    const existing = {
      __app: 'existing',
      options: { projectId: config.projectId },
    }
    app.getApps.mockReturnValue([existing])

    const result = initFirebase(config)

    expect(app.initializeApp).not.toHaveBeenCalled()
    expect(result.app).toBe(existing)
  })

  it('既定では getAuth を使う', () => {
    const result = initFirebase(config)

    expect(auth.getAuth).toHaveBeenCalledWith({
      __app: config,
      options: config,
    })
    expect(result.auth).toEqual({ __auth: { __app: config, options: config } })
  })

  it('Auth の生成を差し替えられる（React Native の永続化用）', () => {
    const custom = { __auth: 'custom' } as never
    const createAuth = vi.fn(() => custom)

    const result = initFirebase(config, createAuth)

    expect(auth.getAuth).not.toHaveBeenCalled()
    expect(createAuth).toHaveBeenCalledWith({ __app: config, options: config })
    expect(result.auth).toBe(custom)
  })

  // 回帰: 2 回目も createAuth を呼んでいたため、React Native の
  // initializeAuth + getReactNativePersistence が auth/already-initialized で
  // throw していた（Fast Refresh、複数モジュールからの呼び出し）
  it('2 回目は createAuth を呼ばず getAuth を返す', () => {
    const custom = { __auth: 'custom' } as never
    const createAuth = vi.fn(() => custom)

    const first = initFirebase(config, createAuth)
    expect(createAuth).toHaveBeenCalledTimes(1)

    // 1 回目で app が作られた状態を再現する
    app.getApps.mockReturnValue([first.app])
    const result = initFirebase(config, createAuth)

    expect(createAuth).toHaveBeenCalledTimes(1)
    expect(auth.getAuth).toHaveBeenCalledWith(first.app)
    expect(result.auth).toEqual({ __auth: first.app })
  })
})

describe('initFirebase の食い違い警告', () => {
  // 回帰: 既存アプリを無条件に再利用するため、渡した config が効かないことに
  // 気付けなかった（テストで別プロジェクトを初期化済み、複数プロジェクト構成）
  it('既存アプリの projectId が config と違えば警告する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    app.getApps.mockReturnValue([
      { __app: 'existing', options: { projectId: 'another-project' } },
    ])

    initFirebase(config)

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('another-project')
    warn.mockRestore()
  })

  it('projectId が一致していれば警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    app.getApps.mockReturnValue([
      { __app: 'existing', options: { projectId: config.projectId } },
    ])

    initFirebase(config)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // 回帰: 最初の呼び出しが createAuth 無しだと、その後 createAuth 付きで
  // 呼んでも createAuth は実行されない（React Native で気付きにくい）
  it('createAuth 無しで初期化済みのアプリに createAuth を渡すと警告する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = initFirebase(config)

    app.getApps.mockReturnValue([first.app])
    initFirebase(config, () => ({ __auth: 'custom' }) as never)

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('createAuth')
    warn.mockRestore()
  })

  it('初回から createAuth で初期化していれば 2 回目は警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const createAuth = vi.fn(() => ({ __auth: 'custom' }) as never)
    const first = initFirebase(config, createAuth)

    app.getApps.mockReturnValue([first.app])
    initFirebase(config, createAuth)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
