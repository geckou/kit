import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetStripeCustomerId = vi.fn()
const mockSaveStripeCustomerId = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/subscription.js', () => ({
  getStripeCustomerId: (...args: unknown[]) => mockGetStripeCustomerId(...args),
  saveStripeCustomerId: (...args: unknown[]) =>
    mockSaveStripeCustomerId(...args),
}))

import { createCheckoutSession, createPortalSession } from '../src/checkout.js'
import { createFakeAuth, createTestConfig } from './helpers.js'

const mockCustomersCreate = vi.fn()
const mockCheckoutCreate = vi.fn()
const mockPortalCreate = vi.fn()

const stripeClient = {
  customers: { create: mockCustomersCreate },
  checkout: { sessions: { create: mockCheckoutCreate } },
  billingPortal: { sessions: { create: mockPortalCreate } },
} as unknown as Stripe

const fakeAuth = createFakeAuth()

function createConfig(stripeOverrides: Record<string, unknown> = {}) {
  return createTestConfig({
    auth: fakeAuth.auth,
    stripe: {
      client: stripeClient,
      webhookSecret: 'whsec_test',
      allowedPriceIds: ['price_allowed', 'price_other'],
      successUrl: 'https://example.com/billing?status=ok',
      cancelUrl: 'https://example.com/billing?status=ng',
      portalReturnUrl: 'https://example.com/billing',
      ...stripeOverrides,
    },
  })
}

describe('createCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuth.getUser.mockResolvedValue({ email: 'user@example.com' })
    mockGetStripeCustomerId.mockResolvedValue('cus_existing')
    mockCheckoutCreate.mockResolvedValue({
      url: 'https://checkout.stripe.com/x',
    })
  })

  it('Stripe 未設定なら 503 を返す', async () => {
    const config = createTestConfig()

    const result = await createCheckoutSession(config, {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(503)
  })

  it('リダイレクト先 URL が未設定なら 500 を返す', async () => {
    const result = await createCheckoutSession(
      createConfig({ successUrl: undefined }),
      { uid: 'user-1', priceId: 'price_allowed' }
    )

    expect(result.status).toBe(500)
  })

  it('許可リストにない priceId を 400 で拒否する', async () => {
    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_evil',
    })

    expect(result.status).toBe(400)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('priceId が文字列でなければ 400 を返す', async () => {
    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 123,
    })

    expect(result.status).toBe(400)
  })

  it('空文字の priceId を 400 で拒否する', async () => {
    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: '',
    })

    expect(result.status).toBe(400)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('空白のみの priceId を 400 で拒否する', async () => {
    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: '  ',
    })

    expect(result.status).toBe(400)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  // 許可リストが `(process.env.X ?? '').split(',')` で作られていると未設定時に
  // [''] になる。「何も許可しない」つもりの設定で空文字だけが通ってしまうため、
  // 許可リストに空文字が入っていても弾くこと
  it('許可リストに空文字が入っていても空文字の priceId を 400 で拒否する', async () => {
    const result = await createCheckoutSession(
      createConfig({ allowedPriceIds: [''] }),
      { uid: 'user-1', priceId: '' }
    )

    expect(result.status).toBe(400)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('許可された priceId で Checkout セッションを作り URL を返す', async () => {
    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ url: 'https://checkout.stripe.com/x' })
  })

  it('Webhook が誰の購入か特定できるよう uid を metadata に入れる', async () => {
    await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_existing',
        client_reference_id: 'user-1',
        metadata: { uid: 'user-1' },
        subscription_data: { metadata: { uid: 'user-1' } },
        // リダイレクト先はクライアント入力ではなく設定から取る
        success_url: 'https://example.com/billing?status=ok',
        cancel_url: 'https://example.com/billing?status=ng',
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^checkout:user-1:\d+:[0-9a-f]{16}$/
        ),
      })
    )
  })

  it('顧客が未作成なら作成して保存する', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new' })

    await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { uid: 'user-1' } }),
      // 二重送信で顧客が重複しないよう uid とパラメータの指紋をキーにする
      {
        idempotencyKey: expect.stringMatching(/^customer_user-1_[0-9a-f]{16}$/),
      }
    )
    expect(mockSaveStripeCustomerId).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'cus_new'
    )
  })

  it('auth 未設定でもメール無しで顧客を作成できる', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new' })

    const config = createTestConfig({
      stripe: {
        client: stripeClient,
        webhookSecret: 'whsec_test',
        allowedPriceIds: ['price_allowed'],
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/ng',
      },
    })

    const result = await createCheckoutSession(config, {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(200)
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: undefined }),
      {
        idempotencyKey: expect.stringMatching(/^customer_user-1_[0-9a-f]{16}$/),
      }
    )
  })

  // 回帰: 既存の購読状態を見ておらず、有効なユーザーが再度呼ぶと
  // 同一顧客に 2 本目のサブスクリプションが作られていた
  it('有効な購読があれば 409 を返す', async () => {
    const config = createConfig()
    config.store.set('users/user-1', {
      subscription: { status: 'active', source: 'stripe' },
    })

    const result = await createCheckoutSession(config, {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(409)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })

  it('失効済みなら Checkout を作れる', async () => {
    const config = createConfig()
    config.store.set('users/user-1', {
      subscription: { status: 'expired', source: 'stripe' },
    })

    const result = await createCheckoutSession(config, {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(200)
  })

  // 回帰: ダブルクリック・複数タブで customers.create が 2 回呼ばれ、
  // 保存される顧客 ID が実際に決済した顧客と食い違っていた
  it('同時に 2 回呼んでも同じ idempotencyKey で顧客を作る', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new' })

    const config = createConfig()
    await Promise.all([
      createCheckoutSession(config, {
        uid: 'user-1',
        priceId: 'price_allowed',
      }),
      createCheckoutSession(config, {
        uid: 'user-1',
        priceId: 'price_allowed',
      }),
    ])

    expect(mockCustomersCreate).toHaveBeenCalledTimes(2)
    for (const call of mockCustomersCreate.mock.calls) {
      expect(call[1]).toEqual({
        idempotencyKey: expect.stringMatching(/^customer_user-1_[0-9a-f]{16}$/),
      })
    }
  })

  // 回帰: 409 判定と Checkout 作成の間にロックが無く、二重送信で Checkout が
  // 2 本作られていた（両方決済すると同一顧客に 2 本目の購読ができる）
  it('同時に 2 回呼んでも同じ idempotencyKey で Checkout を作る', async () => {
    const config = createConfig()

    await Promise.all([
      createCheckoutSession(config, {
        uid: 'user-1',
        priceId: 'price_allowed',
      }),
      createCheckoutSession(config, {
        uid: 'user-1',
        priceId: 'price_allowed',
      }),
    ])

    expect(mockCheckoutCreate).toHaveBeenCalledTimes(2)

    const keys = mockCheckoutCreate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey
    )

    expect(keys[0]).toBe(keys[1])
  })

  // 回帰: キーを uid だけで作ると、1 回目に email 取得と保存が失敗した後の
  // 再試行が「同じキー + 別パラメータ」になり、Stripe が 24 時間
  // idempotency_error を返して自力で抜けられなかった。
  // パラメータを指紋にして畳み込むので、キーが変わって衝突しない
  it('パラメータが変わればキーも変わる（idempotency 衝突を作らない）', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)
    mockCustomersCreate.mockResolvedValue({ id: 'cus_new' })

    fakeAuth.getUser.mockRejectedValueOnce(new Error('auth down'))
    await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    fakeAuth.getUser.mockResolvedValue({ email: 'user@example.com' })
    await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    const keys = mockCustomersCreate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey
    )

    expect(keys[0]).not.toBe(keys[1])
  })

  // キーなしで作り直すフォールバックは置かない（重複顧客が復活するため）
  it('顧客作成のエラーはそのまま 500 になる', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)
    mockCustomersCreate.mockRejectedValue({ type: 'StripeIdempotencyError' })

    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(500)
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1)
  })

  it('Stripe API がエラーなら 500 を返す', async () => {
    mockCheckoutCreate.mockRejectedValue(new Error('Stripe down'))

    const result = await createCheckoutSession(createConfig(), {
      uid: 'user-1',
      priceId: 'price_allowed',
    })

    expect(result.status).toBe(500)
  })
})

describe('createPortalSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStripeCustomerId.mockResolvedValue('cus_existing')
    mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/x' })
  })

  it('Stripe 未設定なら 503 を返す', async () => {
    const result = await createPortalSession(createTestConfig(), {
      uid: 'user-1',
    })

    expect(result.status).toBe(503)
  })

  it('戻り先 URL が未設定なら 500 を返す', async () => {
    const result = await createPortalSession(
      createConfig({ portalReturnUrl: undefined }),
      { uid: 'user-1' }
    )

    expect(result.status).toBe(500)
  })

  it('Stripe で購入したことがないユーザーには 404 を返す', async () => {
    mockGetStripeCustomerId.mockResolvedValue(undefined)

    const result = await createPortalSession(createConfig(), { uid: 'user-1' })

    expect(result.status).toBe(404)
    expect(mockPortalCreate).not.toHaveBeenCalled()
  })

  it('ポータルの URL を返す', async () => {
    const result = await createPortalSession(createConfig(), { uid: 'user-1' })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ url: 'https://billing.stripe.com/x' })
  })
})
