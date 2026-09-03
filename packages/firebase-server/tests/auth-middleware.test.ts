import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createRequireAuth,
  type RequestLike,
  type ResponseLike,
} from '../src/auth-middleware'

const verifyIdToken = vi.fn()
const requireAuth = createRequireAuth({ verifyIdToken })

function createRequest(authorization?: string): RequestLike {
  return { headers: authorization ? { authorization } : {} }
}

function createResponse() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
  }
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createRequireAuth', () => {
  it('トークンなしで 401 を返す', async () => {
    const req = createRequest()
    const res = createResponse()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(next).not.toHaveBeenCalled()
  })

  it('Bearer 形式でない Authorization ヘッダで 401 を返す', async () => {
    const req = createRequest('Basic dXNlcjpwYXNz')
    const res = createResponse()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(verifyIdToken).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('無効なトークンで 401 を返す', async () => {
    verifyIdToken.mockRejectedValueOnce(new Error('invalid token'))

    const req = createRequest('Bearer invalid-token')
    const res = createResponse()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('有効なトークンで req.uid をセットして next を呼ぶ', async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: 'user-1' })

    const req = createRequest('Bearer valid-token')
    const res = createResponse()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(verifyIdToken).toHaveBeenCalledWith('valid-token', false)
    expect((req as RequestLike & { uid: string }).uid).toBe('user-1')
    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(0)
  })

  // 回帰: next() を try の中で呼んでいたため、後続ハンドラの同期例外が
  // catch に入り 401 に化けていた
  it('next() が投げた例外を 401 に化けさせない', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'user-1' })

    const res = createResponse()
    const next = vi.fn(() => {
      throw new Error('downstream failed')
    })

    await expect(
      requireAuth(
        createRequest('Bearer valid-token'),
        res as unknown as ResponseLike,
        next
      )
    ).rejects.toThrow('downstream failed')

    expect(res.statusCode).toBe(0)
  })

  it('ゲッターで渡すと解決がリクエスト時まで遅延される', async () => {
    const getVerifier = vi.fn(() => ({ verifyIdToken }))
    const middleware = createRequireAuth(getVerifier)

    expect(getVerifier).not.toHaveBeenCalled()

    verifyIdToken.mockResolvedValueOnce({ uid: 'user-2' })
    const req = createRequest('Bearer token')
    await middleware(req, createResponse(), vi.fn())

    expect(getVerifier).toHaveBeenCalledTimes(1)
    expect((req as RequestLike & { uid: string }).uid).toBe('user-2')
  })
})

// ResponseLike の互換性を型レベルで固定するための参照。
// tsconfig.test.json の type-check で検証される
const _responseLikeCheck: ResponseLike = createResponse()
void _responseLikeCheck

describe('createRequireAuth の checkRevoked', () => {
  it('checkRevoked: true なら失効チェック付きで検証する', async () => {
    const verifyIdToken = vi.fn().mockResolvedValue({ uid: 'user-1' })
    const requireAuth = createRequireAuth(
      { verifyIdToken },
      { checkRevoked: true }
    )

    const next = vi.fn()
    await requireAuth(
      { headers: { authorization: 'Bearer valid-token' } },
      { status: () => ({ json: () => undefined }) },
      next
    )

    expect(verifyIdToken).toHaveBeenCalledWith('valid-token', true)
    expect(next).toHaveBeenCalled()
  })
})
