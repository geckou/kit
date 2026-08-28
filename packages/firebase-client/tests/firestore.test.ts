import { beforeEach, describe, expect, it, vi } from 'vitest'

// firebase/firestore は実 SDK を呼ばずに差し替える。
// ここで検証したいのは「SDK をどう呼ぶか」と「結果をどう整形するか」で、
// SDK 自体の挙動ではないため
const sdk = vi.hoisted(() => ({
  collection: vi.fn((_db: unknown, name: string) => ({ __collection: name })),
  doc: vi.fn((_db: unknown, name: string, id: string) => ({
    __doc: `${name}/${id}`,
  })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  addDoc: vi.fn(),
  query: vi.fn((base: unknown, ...constraints: unknown[]) => ({
    base,
    constraints,
  })),
  where: vi.fn((field: string, op: string, value: unknown) => ({
    __where: [field, op, value],
  })),
  orderBy: vi.fn((field: string, direction: string) => ({
    __orderBy: [field, direction],
  })),
  limit: vi.fn((n: number) => ({ __limit: n })),
  startAfter: vi.fn((cursor: unknown) => ({ __startAfter: cursor })),
  onSnapshot: vi.fn(),
}))

vi.mock('firebase/firestore', () => sdk)

const {
  createDocument,
  getDocument,
  queryDocuments,
  removeDocument,
  setDocument,
  subscribeCollection,
  subscribeDocument,
  updateDocument,
} = await import('../src/firestore')

const db = {} as never

/** getDoc / onSnapshot が返すスナップショットを組み立てる */
function snapshot(id: string, data: Record<string, unknown> | null) {
  return {
    id,
    exists: () => data !== null,
    data: () => data,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getDocument', () => {
  it('存在しないドキュメントは data: null を返す', async () => {
    sdk.getDoc.mockResolvedValue(snapshot('missing', null))

    const result = await getDocument(db, 'posts', 'missing')

    expect(result).toEqual({ success: true, data: null })
  })

  it('ドキュメント ID をデータにマージして返す', async () => {
    sdk.getDoc.mockResolvedValue(snapshot('abc', { title: 'hello' }))

    const result = await getDocument(db, 'posts', 'abc')

    expect(result).toEqual({
      success: true,
      data: { id: 'abc', title: 'hello' },
    })
    expect(sdk.doc).toHaveBeenCalledWith(db, 'posts', 'abc')
  })

  it('データ側の id フィールドでドキュメント ID を上書きしない', async () => {
    // ドキュメント本文に id を持たせている設計は珍しくない。
    // その値が Firestore のドキュメント ID を潰すと、以降の参照が壊れる
    sdk.getDoc.mockResolvedValue(
      snapshot('real-doc-id', { id: 'データ側の id', title: 'hello' })
    )

    const result = await getDocument(db, 'posts', 'real-doc-id')

    expect(result).toEqual({
      success: true,
      data: { id: 'real-doc-id', title: 'hello' },
    })
  })

  it('例外は success: false とメッセージに変換する（throw しない）', async () => {
    sdk.getDoc.mockRejectedValue(new Error('permission denied'))

    const result = await getDocument(db, 'posts', 'abc')

    expect(result).toEqual({ success: false, error: 'permission denied' })
  })

  it('Error 以外が投げられても既定メッセージを返す', async () => {
    sdk.getDoc.mockRejectedValue('文字列が投げられた')

    const result = await getDocument(db, 'posts', 'abc')

    expect(result).toEqual({ success: false, error: 'ドキュメント取得に失敗' })
  })
})

describe('queryDocuments', () => {
  it('条件・並び順・カーソル・件数を制約に変換する', async () => {
    sdk.getDocs.mockResolvedValue({ docs: [] })
    const cursor = { __cursor: true } as never

    await queryDocuments(db, 'posts', {
      conditions: [{ field: 'authorId', op: '==', value: 'u1' }],
      sort: [{ field: 'createdAt', direction: 'desc' }],
      cursor,
      pageSize: 20,
    })

    expect(sdk.where).toHaveBeenCalledWith('authorId', '==', 'u1')
    expect(sdk.orderBy).toHaveBeenCalledWith('createdAt', 'desc')
    expect(sdk.startAfter).toHaveBeenCalledWith(cursor)
    expect(sdk.limit).toHaveBeenCalledWith(20)
  })

  it('direction を省略すると昇順になる', async () => {
    sdk.getDocs.mockResolvedValue({ docs: [] })

    await queryDocuments(db, 'posts', { sort: [{ field: 'createdAt' }] })

    expect(sdk.orderBy).toHaveBeenCalledWith('createdAt', 'asc')
  })

  it('オプションが空なら制約を付けない', async () => {
    sdk.getDocs.mockResolvedValue({ docs: [] })

    await queryDocuments(db, 'posts')

    expect(sdk.where).not.toHaveBeenCalled()
    expect(sdk.orderBy).not.toHaveBeenCalled()
    expect(sdk.limit).not.toHaveBeenCalled()
    expect(sdk.startAfter).not.toHaveBeenCalled()
  })

  it('取得結果に ID を付け、最後のドキュメントを lastDoc として返す', async () => {
    const docs = [snapshot('a', { n: 1 }), snapshot('b', { n: 2 })]
    sdk.getDocs.mockResolvedValue({ docs })

    const result = await queryDocuments<{ id: string; n: number }>(db, 'posts')

    expect(result).toEqual({
      success: true,
      data: {
        items: [
          { id: 'a', n: 1 },
          { id: 'b', n: 2 },
        ],
        lastDoc: docs[1],
      },
    })
  })

  it('データ側の id フィールドでドキュメント ID を上書きしない', async () => {
    sdk.getDocs.mockResolvedValue({
      docs: [snapshot('real-a', { id: 'データ側', n: 1 })],
    })

    const result = await queryDocuments<{ id: string; n: number }>(db, 'posts')

    expect(result.success && result.data.items).toEqual([
      { id: 'real-a', n: 1 },
    ])
  })

  it('0 件なら lastDoc は null', async () => {
    sdk.getDocs.mockResolvedValue({ docs: [] })

    const result = await queryDocuments(db, 'posts')

    expect(result).toEqual({
      success: true,
      data: { items: [], lastDoc: null },
    })
  })

  it('例外は success: false に変換する', async () => {
    sdk.getDocs.mockRejectedValue(new Error('index required'))

    const result = await queryDocuments(db, 'posts')

    expect(result).toEqual({ success: false, error: 'index required' })
  })
})

describe('書き込み系', () => {
  it('createDocument は採番された ID を返す', async () => {
    sdk.addDoc.mockResolvedValue({ id: 'generated' })

    const result = await createDocument(db, 'posts', { title: 'hello' })

    expect(result).toEqual({ success: true, data: 'generated' })
    expect(sdk.collection).toHaveBeenCalledWith(db, 'posts')
  })

  it('setDocument は既定で merge しない', async () => {
    sdk.setDoc.mockResolvedValue(undefined)

    await setDocument(db, 'posts', 'a', { title: 'hello' })

    expect(sdk.setDoc).toHaveBeenCalledWith(
      { __doc: 'posts/a' },
      { title: 'hello' },
      { merge: false }
    )
  })

  it('setDocument は merge を指定できる', async () => {
    sdk.setDoc.mockResolvedValue(undefined)

    await setDocument(db, 'posts', 'a', { title: 'hello' }, true)

    expect(sdk.setDoc).toHaveBeenCalledWith(
      { __doc: 'posts/a' },
      { title: 'hello' },
      { merge: true }
    )
  })

  it('updateDocument は成功時に data: undefined を返す', async () => {
    sdk.updateDoc.mockResolvedValue(undefined)

    const result = await updateDocument(db, 'posts', 'a', { title: 'x' })

    expect(result).toEqual({ success: true, data: undefined })
  })

  it('removeDocument の失敗は success: false に変換する', async () => {
    sdk.deleteDoc.mockRejectedValue(new Error('denied'))

    const result = await removeDocument(db, 'posts', 'a')

    expect(result).toEqual({ success: false, error: 'denied' })
  })
})

describe('subscribeCollection', () => {
  it('スナップショットに ID を付けて onData に渡し、解除関数を返す', () => {
    const unsubscribe = vi.fn()
    sdk.onSnapshot.mockImplementation((_q, onNext) => {
      onNext({ docs: [snapshot('a', { n: 1 })] })
      return unsubscribe
    })
    const onData = vi.fn()

    const result = subscribeCollection(db, 'posts', {}, onData)

    expect(onData).toHaveBeenCalledWith([{ id: 'a', n: 1 }])
    expect(result).toBe(unsubscribe)
  })

  it('データ側の id フィールドでドキュメント ID を上書きしない', () => {
    sdk.onSnapshot.mockImplementation((_q, onNext) => {
      onNext({ docs: [snapshot('real-a', { id: 'データ側', n: 1 })] })
      return vi.fn()
    })
    const onData = vi.fn()

    subscribeCollection(db, 'posts', {}, onData)

    expect(onData).toHaveBeenCalledWith([{ id: 'real-a', n: 1 }])
  })

  it('カーソルは購読では使わない（startAfter を呼ばない）', () => {
    sdk.onSnapshot.mockReturnValue(vi.fn())

    subscribeCollection(db, 'posts', { cursor: {} as never }, vi.fn())

    expect(sdk.startAfter).not.toHaveBeenCalled()
  })

  it('onError があればそちらへ渡す', () => {
    const error = new Error('stream failed')
    sdk.onSnapshot.mockImplementation((_q, _onNext, onErr) => {
      onErr(error)
      return vi.fn()
    })
    const onError = vi.fn()

    subscribeCollection(db, 'posts', {}, vi.fn(), onError)

    expect(onError).toHaveBeenCalledWith(error)
  })

  it('onError が無ければ console.error にフォールバックする', () => {
    const error = new Error('stream failed')
    sdk.onSnapshot.mockImplementation((_q, _onNext, onErr) => {
      onErr(error)
      return vi.fn()
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    subscribeCollection(db, 'posts', {}, vi.fn())

    expect(spy).toHaveBeenCalledWith('Firestore subscription error:', error)
    spy.mockRestore()
  })
})

describe('subscribeDocument', () => {
  it('存在すれば ID 付きで、存在しなければ null を渡す', () => {
    const received: unknown[] = []
    sdk.onSnapshot.mockImplementation((_ref, onNext) => {
      onNext(snapshot('a', { n: 1 }))
      onNext(snapshot('a', null))
      return vi.fn()
    })

    subscribeDocument(db, 'posts', 'a', (data) => received.push(data))

    expect(received).toEqual([{ id: 'a', n: 1 }, null])
  })

  it('データ側の id フィールドでドキュメント ID を上書きしない', () => {
    const received: unknown[] = []
    sdk.onSnapshot.mockImplementation((_ref, onNext) => {
      onNext(snapshot('real-a', { id: 'データ側', n: 1 }))
      return vi.fn()
    })

    subscribeDocument(db, 'posts', 'real-a', (data) => received.push(data))

    expect(received).toEqual([{ id: 'real-a', n: 1 }])
  })
})
