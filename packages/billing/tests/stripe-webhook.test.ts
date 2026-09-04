import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// applySubscriptionEvent の戻り値は ApplyResult（実装と同じ形にしておく）
const mockApplySubscriptionEvent = vi
  .fn()
  .mockResolvedValue({ status: 'applied', wasActive: false, isActive: true })
const mockSaveStripeCustomerId = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/subscription.js', () => ({
  applySubscriptionEvent: (...args: unknown[]) =>
    mockApplySubscriptionEvent(...args),
  saveStripeCustomerId: (...args: unknown[]) =>
    mockSaveStripeCustomerId(...args),
}))

import { handleStripeWebhook } from '../src/stripe-webhook.js'
import type { WebhookRequest } from '../src/types.js'
import { createTestConfig } from './helpers.js'

const mockConstructEvent = vi.fn()

const stripeClient = {
  webhooks: { constructEvent: mockConstructEvent },
} as unknown as Stripe

function createConfig(overrides: Record<string, unknown> = {}) {
  return createTestConfig({
    stripe: {
      client: stripeClient,
      webhookSecret: 'whsec_test',
      ...overrides,
    },
  })
}

function createRequest(
  overrides: Partial<WebhookRequest> = {}
): WebhookRequest {
  return {
    rawBody: Buffer.from('{}'),
    headers: { 'stripe-signature': 'sig_test' },
    ...overrides,
  }
}

/** Stripe の Subscription オブジェクトを模した最小構造 */
function createSubscriptionEvent(
  type: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'evt_test',
    type,
    created: 1_754_000_000,
    data: {
      object: {
        id: 'sub_test',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { uid: 'user-1' },
        items: {
          data: [
            {
              current_period_end: 1_756_000_000,
              price: { id: 'price_abc' },
            },
          ],
        },
        ...overrides,
      },
    },
  }
}

describe('Stripe Webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApplySubscriptionEvent.mockResolvedValue({
      status: 'applied',
      wasActive: false,
      isActive: true,
    })
  })

  it('rawBody がパース済みのオブジェクトなら 500 を返し、理由をログに出す', async () => {
    const config = createConfig()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await handleStripeWebhook(
      config,
      createRequest({
        rawBody: { id: 'evt_1' } as unknown as WebhookRequest['rawBody'],
      })
    )

    expect(result.status).toBe(500)
    expect(mockConstructEvent).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('req.rawBody')

    errorSpy.mockRestore()
  })

  it('Stripe 未設定で 500 を返す', async () => {
    const config = createTestConfig()

    const result = await handleStripeWebhook(config, createRequest())

    expect(result.status).toBe(500)
  })

  it('webhookSecret 未設定で 500 を返す', async () => {
    const result = await handleStripeWebhook(
      createConfig({ webhookSecret: '' }),
      createRequest()
    )

    expect(result.status).toBe(500)
  })

  it('stripe-signature ヘッダーなしで 400 を返す', async () => {
    const result = await handleStripeWebhook(
      createConfig(),
      createRequest({ headers: {} })
    )

    expect(result.status).toBe(400)
    expect(mockConstructEvent).not.toHaveBeenCalled()
  })

  // 署名検証には「パース前の生ボディ」が要る。パース済みの body を渡す退行を止める
  it('constructEvent に rawBody・署名・シークレットをそのまま渡す', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated')
    )

    const rawBody = Buffer.from('{"id":"evt_test"}')

    await handleStripeWebhook(
      createConfig(),
      createRequest({
        rawBody,
        headers: { 'stripe-signature': 'sig_test' },
      })
    )

    expect(mockConstructEvent).toHaveBeenCalledWith(
      rawBody,
      'sig_test',
      'whsec_test'
    )
  })

  it('署名検証に失敗すると 400 を返す', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(400)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  // 回帰: incomplete（決済待ち）を expired にマップしており、同じ秒に届く
  // updated(active) の後に created(incomplete) が来ると権利を失っていた
  it('incomplete は権利状態を変えない', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.created', {
        status: 'incomplete',
      })
    )

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  it('同じ秒のイベントを並べるための sequence を渡す', async () => {
    for (const [type, sequence] of [
      ['customer.subscription.created', 0],
      ['customer.subscription.updated', 1],
      ['customer.subscription.deleted', 2],
    ] as const) {
      mockApplySubscriptionEvent.mockClear()
      mockConstructEvent.mockReturnValue(createSubscriptionEvent(type))

      await handleStripeWebhook(createConfig(), createRequest())

      expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sequence })
      )
    }
  })

  it('customer.subscription.created を active として反映する', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.created')
    )

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventId: 'evt_test',
        source: 'stripe',
        uid: 'user-1',
        subscription: expect.objectContaining({
          status: 'active',
          planId: 'price_abc',
          currentPeriodEnd: new Date(1_756_000_000 * 1000),
        }),
      })
    )
  })

  it('past_due を in_grace_period に変換する', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated', {
        status: 'past_due',
      })
    )

    await handleStripeWebhook(createConfig(), createRequest())

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ status: 'in_grace_period' }),
      })
    )
  })

  it('unpaid を expired に変換する（リトライ枯渇後は猶予期間としない）', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated', {
        status: 'unpaid',
      })
    )

    await handleStripeWebhook(createConfig(), createRequest())

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ status: 'expired' }),
      })
    )
  })

  it('canceled を cancelled に変換する（綴りの違いを吸収する）', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated', {
        status: 'canceled',
        cancel_at_period_end: true,
      })
    )

    await handleStripeWebhook(createConfig(), createRequest())

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({
          status: 'cancelled',
          cancelAtPeriodEnd: true,
        }),
      })
    )
  })

  it('customer.subscription.deleted は status に関わらず expired にする', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.deleted', {
        status: 'active',
      })
    )

    await handleStripeWebhook(createConfig(), createRequest())

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ status: 'expired' }),
      })
    )
  })

  it('current_period_end が Subscription 直下にある旧形式も読める', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated', {
        current_period_end: 1_757_000_000,
        items: { data: [{ price: { id: 'price_abc' } }] },
      })
    )

    await handleStripeWebhook(createConfig(), createRequest())

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({
          currentPeriodEnd: new Date(1_757_000_000 * 1000),
        }),
      })
    )
  })

  it('uid metadata がない場合は反映せず 200 を返す（再送を止める）', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated', {
        metadata: {},
      })
    )

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  it('checkout.session.completed で顧客 ID を保存する', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      created: 1_754_000_000,
      data: {
        object: {
          id: 'cs_test',
          client_reference_id: 'user-1',
          customer: 'cus_test',
        },
      },
    })

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(200)
    expect(mockSaveStripeCustomerId).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'cus_test'
    )
  })

  it('未知のイベントでも 200 を返す', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_other',
      type: 'invoice.created',
      created: 1_754_000_000,
      data: { object: {} },
    })

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  it('Firestore エラー時に 500 を返す', async () => {
    mockConstructEvent.mockReturnValue(
      createSubscriptionEvent('customer.subscription.updated')
    )
    mockApplySubscriptionEvent.mockRejectedValue(new Error('Firestore down'))

    const result = await handleStripeWebhook(createConfig(), createRequest())

    expect(result.status).toBe(500)
  })
})
