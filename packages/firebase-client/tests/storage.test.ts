import { beforeEach, describe, expect, it, vi } from 'vitest'

type StateChangedHandler = (snapshot: {
  bytesTransferred: number
  totalBytes: number
}) => void

const sdk = vi.hoisted(() => ({
  getStorage: vi.fn((app: unknown) => ({ __storage: app })),
  ref: vi.fn((_storage: unknown, path: string) => ({ __ref: path })),
  uploadBytesResumable: vi.fn(),
  getDownloadURL: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('firebase/storage', () => sdk)

const { deleteFile, getFileUrl, getFirebaseStorage, uploadFile } =
  await import('../src/storage')

const app = {} as never

/**
 * uploadBytesResumable が返すタスクの代役。
 * on() に渡されたハンドラを控えておき、テストから任意に発火させる
 */
function uploadTask() {
  const handlers: {
    onStateChanged?: StateChangedHandler
    onError?: (error: Error) => void
    onComplete?: () => void | Promise<void>
  } = {}

  return {
    snapshot: { ref: { __ref: 'uploaded' } },
    on: vi.fn(
      (
        _event: string,
        onStateChanged: StateChangedHandler,
        onError: (error: Error) => void,
        onComplete: () => void | Promise<void>
      ) => {
        handlers.onStateChanged = onStateChanged
        handlers.onError = onError
        handlers.onComplete = onComplete
      }
    ),
    handlers,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getFirebaseStorage', () => {
  it('アプリからストレージを取得する', () => {
    expect(getFirebaseStorage(app)).toEqual({ __storage: app })
  })
})

describe('uploadFile', () => {
  it('完了時に downloadUrl と path を返す', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)
    sdk.getDownloadURL.mockResolvedValue('https://example.com/f.png')

    const promise = uploadFile(app, 'images/f.png', new Uint8Array([1]))
    await task.handlers.onComplete?.()

    await expect(promise).resolves.toEqual({
      downloadUrl: 'https://example.com/f.png',
      path: 'images/f.png',
    })
    expect(sdk.ref).toHaveBeenCalledWith({ __storage: app }, 'images/f.png')
  })

  it('進捗をパーセントに換算して通知する', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)
    sdk.getDownloadURL.mockResolvedValue('https://example.com/f.png')
    const onProgress = vi.fn()

    const promise = uploadFile(
      app,
      'images/f.png',
      new Uint8Array([1]),
      onProgress
    )
    task.handlers.onStateChanged?.({ bytesTransferred: 30, totalBytes: 120 })
    await task.handlers.onComplete?.()
    await promise

    // 換算式を壊しても気付けるよう、生の値とパーセントが一致しない比を使う
    expect(onProgress).toHaveBeenCalledWith({
      bytesTransferred: 30,
      totalBytes: 120,
      progress: 25,
    })
  })

  it('0 バイトのファイルでも進捗が NaN にならない', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)
    sdk.getDownloadURL.mockResolvedValue('https://example.com/f.png')
    const onProgress = vi.fn()

    const promise = uploadFile(app, 'empty.txt', new Uint8Array(), onProgress)
    task.handlers.onStateChanged?.({ bytesTransferred: 0, totalBytes: 0 })
    await task.handlers.onComplete?.()
    await promise

    // 転送するものが無い＝完了として 100。README が保証する 0〜100 を外れない
    expect(onProgress).toHaveBeenCalledWith({
      bytesTransferred: 0,
      totalBytes: 0,
      progress: 100,
    })
  })

  it('onProgress を渡さなくても進捗通知で落ちない', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)
    sdk.getDownloadURL.mockResolvedValue('https://example.com/f.png')

    const promise = uploadFile(app, 'images/f.png', new Uint8Array([1]))
    expect(() =>
      task.handlers.onStateChanged?.({ bytesTransferred: 1, totalBytes: 2 })
    ).not.toThrow()
    await task.handlers.onComplete?.()
    await promise
  })

  it('アップロード失敗は reject する', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)

    const promise = uploadFile(app, 'images/f.png', new Uint8Array([1]))
    task.handlers.onError?.(new Error('quota exceeded'))

    await expect(promise).rejects.toThrow('quota exceeded')
  })

  it('URL 取得に失敗したら reject する（pending のままにしない）', async () => {
    const task = uploadTask()
    sdk.uploadBytesResumable.mockReturnValue(task)
    sdk.getDownloadURL.mockRejectedValue(new Error('object not found'))

    const promise = uploadFile(app, 'images/f.png', new Uint8Array([1]))
    await task.handlers.onComplete?.()

    await expect(promise).rejects.toThrow('object not found')
  })
})

describe('deleteFile / getFileUrl', () => {
  it('deleteFile は該当パスの参照を削除する', async () => {
    sdk.deleteObject.mockResolvedValue(undefined)

    await deleteFile(app, 'images/f.png')

    expect(sdk.deleteObject).toHaveBeenCalledWith({ __ref: 'images/f.png' })
  })

  it('deleteFile の失敗はそのまま伝わる', async () => {
    sdk.deleteObject.mockRejectedValue(new Error('object not found'))

    await expect(deleteFile(app, 'images/f.png')).rejects.toThrow(
      'object not found'
    )
  })

  it('getFileUrl はダウンロード URL を返す', async () => {
    sdk.getDownloadURL.mockResolvedValue('https://example.com/f.png')

    await expect(getFileUrl(app, 'images/f.png')).resolves.toBe(
      'https://example.com/f.png'
    )
  })
})
