import { describe, expect, it, vi } from 'vitest'

import { handleRevenueCatWebhook } from '../src/revenuecat-webhook.js'
import type {
  BillingConfig,
  RevenueCatWebhookEvent,
  WebhookRequest,
} from '../src/index.js'
import { createTestConfig } from './helpers.js'

// ここでは applySubscriptionEvent をモックしない。単発購入で
// users/{uid}.subscription が実際に書かれる／書かれないところまで見る
const AUTH_HEADER = 'Bearer test-webhook-auth'
const authed = { authorization: AUTH_HEADER }

function createConfig(
  revenuecat: Partial<NonNullable<BillingConfig['revenuecat']>> = {}
) {
  return createTestConfig({
    revenuecat: { webhookAuth: AUTH_HEADER, ...revenuecat },
  })
}

function createRequest(
  type: string,
  overrides: Record<string, unknown> = {},
  headers: WebhookRequest['headers'] = authed
): WebhookRequest {
  return {
    rawBody: JSON.stringify({
      event: {
        id: 'rc_evt_1',
        type,
        app_user_id: 'user-1',
        event_timestamp_ms: 1_754_000_000_000,
        entitlement_ids: ['pro'],
        product_id: 'single_unlock',
        ...overrides,
      },
    }),
    headers,
  }
}

// 回帰: NON_RENEWING_PURCHASE は期限を持たないため active として反映すると
// isSubscriptionActive が無期限に有効と判定する。消費型アイテムを売る構成では、
// 単発購入 1 件でプランの権利が永久に付いていた
describe('NON_RENEWING_PURCHASE の扱い', () => {
  it('既定では従来どおり active として反映する', async () => {
    const config = createConfig()

    const result = await handleRevenueCatWebhook(
      config,
      createRequest('NON_RENEWING_PURCHASE')
    )

    expect(result.status).toBe(200)
    expect(config.store.get('users/user-1')).toMatchObject({
      subscription: expect.objectContaining({
        status: 'active',
        source: 'revenuecat',
      }),
    })
  })

  it("'ignore' なら subscription を変えない（200 は返す）", async () => {
    const config = createConfig({ nonRenewingPurchase: 'ignore' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await handleRevenueCatWebhook(
      config,
      createRequest('NON_RENEWING_PURCHASE')
    )

    expect(result.status).toBe(200)
    expect(config.store.get('users/user-1')).toBeUndefined()
    // 記録も残さない（次に同じ eventId が来ても duplicate にしない）
    expect(
      config.store.get('billing_events/revenuecat_rc_evt_1')
    ).toBeUndefined()

    logSpy.mockRestore()
  })

  it("'ignore' でも購読の更新イベントはこれまでどおり反映する", async () => {
    const config = createConfig({ nonRenewingPurchase: 'ignore' })

    await handleRevenueCatWebhook(config, createRequest('RENEWAL'))

    expect(config.store.get('users/user-1')).toMatchObject({
      subscription: expect.objectContaining({ status: 'active' }),
    })
  })

  it('関数なら product_id ごとに振り分けられる', async () => {
    const nonRenewingPurchase = (event: RevenueCatWebhookEvent) =>
      event.product_id === 'lifetime_pro'
        ? ('entitlement' as const)
        : ('ignore' as const)

    const ignored = createConfig({ nonRenewingPurchase })
    await handleRevenueCatWebhook(
      ignored,
      createRequest('NON_RENEWING_PURCHASE', { product_id: 'single_unlock' })
    )
    expect(ignored.store.get('users/user-1')).toBeUndefined()

    const applied = createConfig({ nonRenewingPurchase })
    await handleRevenueCatWebhook(
      applied,
      createRequest('NON_RENEWING_PURCHASE', { product_id: 'lifetime_pro' })
    )
    expect(applied.store.get('users/user-1')).toMatchObject({
      subscription: expect.objectContaining({ status: 'active' }),
    })
  })

  // 期限の無い active は無期限の権利になる。判定できないときは与えないほうに倒す
  it('関数が想定外の値を返したら反映しない', async () => {
    const config = createConfig({
      nonRenewingPurchase: () =>
        'grant' as unknown as ReturnType<() => 'entitlement'>,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await handleRevenueCatWebhook(
      config,
      createRequest('NON_RENEWING_PURCHASE')
    )

    expect(result.status).toBe(200)
    expect(config.store.get('users/user-1')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('関数が例外を投げたら 500 を返して再送させる（権利は付けない）', async () => {
    const config = createConfig({
      nonRenewingPurchase: () => {
        throw new Error('lookup failed')
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await handleRevenueCatWebhook(
      config,
      createRequest('NON_RENEWING_PURCHASE')
    )

    expect(result.status).toBe(500)
    expect(config.store.get('users/user-1')).toBeUndefined()

    errorSpy.mockRestore()
  })

  describe('onNonRenewingPurchase', () => {
    it('認可を通ったイベントだけを渡す', async () => {
      const onNonRenewingPurchase = vi.fn()
      const config = createConfig({
        nonRenewingPurchase: 'ignore',
        onNonRenewingPurchase,
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const unauthorized = await handleRevenueCatWebhook(
        config,
        createRequest(
          'NON_RENEWING_PURCHASE',
          {},
          { authorization: 'Bearer x' }
        )
      )

      expect(unauthorized.status).toBe(401)
      expect(onNonRenewingPurchase).not.toHaveBeenCalled()

      await handleRevenueCatWebhook(
        config,
        createRequest('NON_RENEWING_PURCHASE')
      )

      expect(onNonRenewingPurchase).toHaveBeenCalledTimes(1)
      expect(onNonRenewingPurchase).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rc_evt_1',
          type: 'NON_RENEWING_PURCHASE',
          app_user_id: 'user-1',
          product_id: 'single_unlock',
        })
      )

      errorSpy.mockRestore()
      logSpy.mockRestore()
    })

    // SANDBOX は本番の権利を汚さないために捨てるイベント。フックにも渡さない
    it('既定では SANDBOX のイベントで呼ばない', async () => {
      const onNonRenewingPurchase = vi.fn()
      const config = createConfig({
        nonRenewingPurchase: 'ignore',
        onNonRenewingPurchase,
      })
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await handleRevenueCatWebhook(
        config,
        createRequest('NON_RENEWING_PURCHASE', { environment: 'SANDBOX' })
      )

      expect(onNonRenewingPurchase).not.toHaveBeenCalled()

      logSpy.mockRestore()
    })

    it('ドキュメント ID にできない app_user_id では呼ばない', async () => {
      const onNonRenewingPurchase = vi.fn()
      const config = createConfig({
        nonRenewingPurchase: 'ignore',
        onNonRenewingPurchase,
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await handleRevenueCatWebhook(
        config,
        createRequest('NON_RENEWING_PURCHASE', { app_user_id: 'a/b' })
      )

      expect(result.status).toBe(400)
      expect(onNonRenewingPurchase).not.toHaveBeenCalled()

      errorSpy.mockRestore()
    })

    it("'entitlement'（既定）でも呼ばれる", async () => {
      const onNonRenewingPurchase = vi.fn()
      const config = createConfig({ onNonRenewingPurchase })

      await handleRevenueCatWebhook(
        config,
        createRequest('NON_RENEWING_PURCHASE')
      )

      expect(onNonRenewingPurchase).toHaveBeenCalledTimes(1)
      expect(config.store.get('users/user-1')).toMatchObject({
        subscription: expect.objectContaining({ status: 'active' }),
      })
    })

    it('他の種別では呼ばれない', async () => {
      const onNonRenewingPurchase = vi.fn()
      const config = createConfig({ onNonRenewingPurchase })

      await handleRevenueCatWebhook(config, createRequest('INITIAL_PURCHASE'))

      expect(onNonRenewingPurchase).not.toHaveBeenCalled()
    })

    // 'ignore' のときはこのフックが唯一の処理系。200 を返すと再送されず、
    // 購入がどこにも残らない
    it('例外を投げたら 5xx を返して再送させる', async () => {
      const config = createConfig({
        nonRenewingPurchase: 'ignore',
        onNonRenewingPurchase: () => {
          throw new Error('credit grant failed')
        },
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const result = await handleRevenueCatWebhook(
        config,
        createRequest('NON_RENEWING_PURCHASE')
      )

      expect(result.status).toBe(503)

      errorSpy.mockRestore()
      logSpy.mockRestore()
    })
  })
})
