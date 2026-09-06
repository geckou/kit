import Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 署名検証を実ライブラリで通すテスト。
 *
 * stripe-webhook.test.ts は constructEvent を vi.fn() に差し替えているため、
 * 「rawBody を Buffer のまま渡せば実際の Stripe 署名が通る」ことも
 * 「tolerance を超えた timestamp は弾かれる」ことも検証されていなかった。
 * ここでは webhooks.constructEvent だけ本物を使い、Firestore 側は差し替える
 */

const mockApplySubscriptionEvent = vi.fn()
const mockSaveStripeCustomerId = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/subscription.js', () => ({
  applySubscriptionEvent: (...args: unknown[]) =>
    mockApplySubscriptionEvent(...args),
  saveStripeCustomerId: (...args: unknown[]) =>
    mockSaveStripeCustomerId(...args),
}))

import { handleStripeWebhook } from '../src/stripe-webhook.js'
import { createTestConfig } from './helpers.js'

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification'

// 実インスタンス。API キーはネットワークを使わない署名検証にしか関わらない
const stripe = new Stripe('sk_test_dummy')

const payload = JSON.stringify({
  id: 'evt_signed',
  object: 'event',
  type: 'customer.subscription.updated',
  created: 1_754_000_000,
  livemode: true,
  data: {
    object: {
      id: 'sub_signed',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { uid: 'user-1' },
      items: {
        data: [
          { current_period_end: 1_756_000_000, price: { id: 'price_abc' } },
        ],
      },
    },
  },
})

function createConfig() {
  return createTestConfig({
    stripe: { client: stripe, webhookSecret: WEBHOOK_SECRET },
  })
}

function sign(body: string, timestamp?: number) {
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
    ...(timestamp === undefined ? {} : { timestamp }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApplySubscriptionEvent.mockResolvedValue({
    status: 'applied',
    wasActive: false,
    isActive: true,
    effectsPending: false,
  })
})

describe('Stripe の署名検証（実ライブラリ）', () => {
  // 回帰: rawBody を文字列化してから渡すと、マルチバイト文字を含むペイロードで
  // 署名が合わなくなる。Buffer のまま渡せば通ることを実ライブラリで固定する
  it('正しい署名の Buffer ボディは 200 で処理される', async () => {
    const result = await handleStripeWebhook(createConfig(), {
      rawBody: Buffer.from(payload),
      headers: { 'stripe-signature': sign(payload) },
    })

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalled()
  })

  it('文字列のままの rawBody でも同じ署名が通る', async () => {
    const result = await handleStripeWebhook(createConfig(), {
      rawBody: payload,
      headers: { 'stripe-signature': sign(payload) },
    })

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalled()
  })

  it('ボディが改ざんされていれば 400 を返す', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const signature = sign(payload)
    const tampered = payload.replace('"user-1"', '"attacker"')

    const result = await handleStripeWebhook(createConfig(), {
      rawBody: Buffer.from(tampered),
      headers: { 'stripe-signature': signature },
    })

    expect(result.status).toBe(400)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('別のシークレットで署名されていれば 400 を返す', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_another_secret',
    })

    const result = await handleStripeWebhook(createConfig(), {
      rawBody: Buffer.from(payload),
      headers: { 'stripe-signature': signature },
    })

    expect(result.status).toBe(400)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  // 既定の tolerance は 300 秒。リプレイ攻撃を弾けることを固定する
  it('timestamp が tolerance を超えていれば 400 を返す', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600

    const result = await handleStripeWebhook(createConfig(), {
      rawBody: Buffer.from(payload),
      headers: { 'stripe-signature': sign(payload, tenMinutesAgo) },
    })

    expect(result.status).toBe(400)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('tolerance の内側の timestamp なら 200 を返す', async () => {
    const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60

    const result = await handleStripeWebhook(createConfig(), {
      rawBody: Buffer.from(payload),
      headers: { 'stripe-signature': sign(payload, oneMinuteAgo) },
    })

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalled()
  })
})
