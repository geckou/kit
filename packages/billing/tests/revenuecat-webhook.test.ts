import { beforeEach, describe, expect, it, vi } from 'vitest'

// applySubscriptionEvent の戻り値は ApplyResult（実装と同じ形にしておく）
const mockApplySubscriptionEvent = vi
  .fn()
  .mockResolvedValue({ status: 'applied', wasActive: false, isActive: true })

vi.mock('../src/subscription.js', () => ({
  applySubscriptionEvent: (...args: unknown[]) =>
    mockApplySubscriptionEvent(...args),
}))

import { handleRevenueCatWebhook } from '../src/revenuecat-webhook.js'
import type { WebhookRequest } from '../src/types.js'
import { createTestConfig } from './helpers.js'

// RevenueCat Dashboard で設定する Authorization ヘッダー値
const AUTH_HEADER = 'Bearer test-webhook-auth'

function createConfig(
  webhookAuth: string | null = AUTH_HEADER,
  overrides: Record<string, unknown> = {}
) {
  return createTestConfig(
    webhookAuth === null ? {} : { revenuecat: { webhookAuth, ...overrides } }
  )
}

function createRequest(
  body: unknown = {},
  headers: WebhookRequest['headers'] = {}
): WebhookRequest {
  return {
    rawBody:
      typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body),
    headers,
  }
}

function createEventBody(
  type: string,
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    event: {
      id: 'rc_evt_1',
      type,
      app_user_id: userId,
      event_timestamp_ms: 1_754_000_000_000,
      entitlement_ids: ['pro'],
      ...overrides,
    },
  }
}

const authed = { authorization: AUTH_HEADER }

describe('RevenueCat Webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApplySubscriptionEvent.mockResolvedValue({
      status: 'applied',
      wasActive: false,
      isActive: true,
    })
  })

  it('webhookAuth 未設定で 500 を返す', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(null),
      createRequest()
    )

    expect(result.status).toBe(500)
  })

  it('Authorization ヘッダーなしで 401 を返す', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest()
    )

    expect(result.status).toBe(401)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  it('不正な Authorization ヘッダーで 401 を返す', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest({}, { authorization: 'Bearer wrong-value-xx' })
    )

    expect(result.status).toBe(401)
  })

  it('INITIAL_PURCHASE を active として反映する', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('INITIAL_PURCHASE', 'user-1', {
          expiration_at_ms: 1_756_000_000_000,
        }),
        authed
      )
    )

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventId: 'rc_evt_1',
        source: 'revenuecat',
        uid: 'user-1',
        subscription: expect.objectContaining({
          status: 'active',
          source: 'revenuecat',
          planId: 'pro',
          currentPeriodEnd: new Date(1_756_000_000_000),
        }),
      })
    )
  })

  it.each([
    ['RENEWAL', 'active'],
    ['UNCANCELLATION', 'active'],
    ['BILLING_ISSUE', 'in_grace_period'],
    ['EXPIRATION', 'expired'],
  ])('%s を %s として反映する', async (type, status) => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(createEventBody(type, 'user-1'), authed)
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ status }),
      })
    )
  })

  it('CANCELLATION は cancelled（期間終了までは有効）として反映する', async () => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(createEventBody('CANCELLATION', 'user-1'), authed)
    )

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

  // TRANSFER は処理対象なので、ここでは mapRevenueCatStatus が null を返す種別を使う
  it('未知のイベントタイプでも 200 を返す（Firestore 更新なし）', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(createEventBody('SUBSCRIBER_ALIAS', 'user-1'), authed)
    )

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
  })

  it('event.id があればそれを冪等性キーに使う', async () => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(createEventBody('RENEWAL', 'user-1'), authed)
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventId: 'rc_evt_1' })
    )
  })

  it('event.id が無い場合、同じペイロードなら同じ冪等性キーになる', async () => {
    const send = async () => {
      const body = createEventBody('RENEWAL', 'user-1')
      delete (body.event as Record<string, unknown>).id

      await handleRevenueCatWebhook(createConfig(), createRequest(body, authed))
    }

    await send()
    await send()

    const [first, second] = mockApplySubscriptionEvent.mock.calls
    expect(first[1].eventId).toBe(second[1].eventId)
  })

  it('event.id も時刻も無い別イベント同士が同じキーに衝突しない', async () => {
    // 種別 + uid + 0 のような固定値をキーにすると衝突し、
    // 2件目以降が duplicate として捨てられてしまう
    const send = async (type: string) => {
      const body = createEventBody(type, 'user-1')
      delete (body.event as Record<string, unknown>).id
      delete (body.event as Record<string, unknown>).event_timestamp_ms

      await handleRevenueCatWebhook(createConfig(), createRequest(body, authed))
    }

    await send('RENEWAL')
    await send('CANCELLATION')

    const [first, second] = mockApplySubscriptionEvent.mock.calls
    expect(first[1].eventId).not.toBe(second[1].eventId)
  })

  it('event_timestamp_ms が数値でなければ Invalid Date にせず受信時刻を使う', async () => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('RENEWAL', 'user-1', {
          event_timestamp_ms: 'not-a-number',
        }),
        authed
      )
    )

    const { occurredAt } = mockApplySubscriptionEvent.mock.calls[0][1]
    expect(occurredAt).toBeInstanceOf(Date)
    expect(Number.isNaN(occurredAt.getTime())).toBe(false)
  })

  it('expiration_at_ms が数値でなければ currentPeriodEnd を設定しない', async () => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('CANCELLATION', 'user-1', { expiration_at_ms: null }),
        authed
      )
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ currentPeriodEnd: undefined }),
      })
    )
  })

  it('entitlement_ids が配列でなければ planId を設定しない', async () => {
    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('RENEWAL', 'user-1', { entitlement_ids: 'pro' }),
        authed
      )
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({ planId: undefined }),
      })
    )
  })

  it('Firestore エラー時に 500 を返す', async () => {
    mockApplySubscriptionEvent.mockRejectedValue(new Error('Firestore down'))

    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(createEventBody('RENEWAL', 'user-1'), authed)
    )

    expect(result.status).toBe(500)
  })

  it('不正な JSON の body で 400 を返す', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(Buffer.from('{ broken'), authed)
    )

    expect(result.status).toBe(400)
  })

  it('event の形が想定外の payload で 400 を返す', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest({ event: { type: 'RENEWAL' } }, authed)
    )

    expect(result.status).toBe(400)
  })

  it('文字列 body も正しく処理する', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        JSON.stringify(createEventBody('RENEWAL', 'user-1')),
        authed
      )
    )

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalled()
  })

  // 回帰: environment を見ておらず、TestFlight / 開発ビルドの購入で
  // 本番の権利が付いていた
  describe('SANDBOX イベント', () => {
    it('既定では適用しない（200 は返す）', async () => {
      const result = await handleRevenueCatWebhook(
        createConfig(),
        createRequest(
          createEventBody('INITIAL_PURCHASE', 'user-1', {
            environment: 'SANDBOX',
          }),
          authed
        )
      )

      expect(result.status).toBe(200)
      expect(mockApplySubscriptionEvent).not.toHaveBeenCalled()
    })

    it('allowSandbox: true なら適用する', async () => {
      const result = await handleRevenueCatWebhook(
        createConfig(AUTH_HEADER, { allowSandbox: true }),
        createRequest(
          createEventBody('INITIAL_PURCHASE', 'user-1', {
            environment: 'SANDBOX',
          }),
          authed
        )
      )

      expect(result.status).toBe(200)
      expect(mockApplySubscriptionEvent).toHaveBeenCalled()
    })

    it('PRODUCTION は既定でも適用する', async () => {
      await handleRevenueCatWebhook(
        createConfig(),
        createRequest(
          createEventBody('INITIAL_PURCHASE', 'user-1', {
            environment: 'PRODUCTION',
          }),
          authed
        )
      )

      expect(mockApplySubscriptionEvent).toHaveBeenCalled()
    })
  })

  // 回帰: BILLING_ISSUE の expiration_at_ms は元の期間終了（ほぼ今）を指すため、
  // in_grace_period になった直後に利用不可になっていた
  it('BILLING_ISSUE は猶予期間の終了を currentPeriodEnd に使う', async () => {
    const graceEnd = 1_756_000_000_000

    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('BILLING_ISSUE', 'user-1', {
          expiration_at_ms: 1_754_000_000_000,
          grace_period_expiration_at_ms: graceEnd,
        }),
        authed
      )
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({
          status: 'in_grace_period',
          currentPeriodEnd: new Date(graceEnd),
        }),
      })
    )
  })

  it('猶予期間の終了が無ければ expiration_at_ms を使う', async () => {
    const expiration = 1_754_000_000_000

    await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('BILLING_ISSUE', 'user-1', {
          expiration_at_ms: expiration,
        }),
        authed
      )
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: expect.objectContaining({
          currentPeriodEnd: new Date(expiration),
        }),
      })
    )
  })

  // 回帰: TRANSFER を無視しており、元ユーザーの active が残っていた
  it('TRANSFER は移動元の uid を expired にする', async () => {
    const result = await handleRevenueCatWebhook(
      createConfig(),
      createRequest(
        createEventBody('TRANSFER', 'user-new', {
          transferred_from: ['user-old-1', 'user-old-2'],
          transferred_to: ['user-new'],
        }),
        authed
      )
    )

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalledTimes(2)

    for (const uid of ['user-old-1', 'user-old-2']) {
      expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          uid,
          subscription: expect.objectContaining({ status: 'expired' }),
        })
      )
    }
  })

  // 回帰: TRANSFER のペイロードには期限も entitlement も乗らないため、移動先は
  // 次の更新（年額なら最長 1 年後）まで未購読扱いになっていた
  it('fetchSubscriber があれば移動先の権利を取り直して反映する', async () => {
    const fetchSubscriber = vi.fn().mockResolvedValue({
      status: 'active' as const,
      source: 'revenuecat' as const,
      planId: 'premium',
    })

    const result = await handleRevenueCatWebhook(
      createConfig(AUTH_HEADER, { fetchSubscriber }),
      createRequest(
        createEventBody('TRANSFER', 'user-new', {
          transferred_from: ['user-old'],
          transferred_to: ['user-new'],
        }),
        authed
      )
    )

    expect(result.status).toBe(200)
    expect(fetchSubscriber).toHaveBeenCalledWith('user-new')
    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        uid: 'user-new',
        subscription: expect.objectContaining({
          status: 'active',
          planId: 'premium',
        }),
      })
    )
  })

  it('fetchSubscriber が null を返したら移動先には何も書かない', async () => {
    const fetchSubscriber = vi.fn().mockResolvedValue(null)

    await handleRevenueCatWebhook(
      createConfig(AUTH_HEADER, { fetchSubscriber }),
      createRequest(
        createEventBody('TRANSFER', 'user-new', {
          transferred_from: ['user-old'],
          transferred_to: ['user-new'],
        }),
        authed
      )
    )

    expect(mockApplySubscriptionEvent).toHaveBeenCalledTimes(1)
    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uid: 'user-old' })
    )
  })

  // 移動元の失効は確定させたいので、移動先の取得失敗で 500 にしない
  it('fetchSubscriber が失敗しても移動元の失効は残り 200 を返す', async () => {
    const fetchSubscriber = vi.fn().mockRejectedValue(new Error('RC down'))

    const result = await handleRevenueCatWebhook(
      createConfig(AUTH_HEADER, { fetchSubscriber }),
      createRequest(
        createEventBody('TRANSFER', 'user-new', {
          transferred_from: ['user-old'],
          transferred_to: ['user-new'],
        }),
        authed
      )
    )

    expect(result.status).toBe(200)
    expect(mockApplySubscriptionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        uid: 'user-old',
        subscription: expect.objectContaining({ status: 'expired' }),
      })
    )
  })
})
