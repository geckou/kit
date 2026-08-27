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
      expect.objectContaining({ metadata: { uid: 'user-1' } })
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
      expect.objectContaining({ email: undefined })
    )
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
