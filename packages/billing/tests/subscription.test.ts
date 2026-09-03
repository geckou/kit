import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applySubscriptionEvent } from '../src/subscription.js'
import { createFakeAuth, createTestConfig } from './helpers.js'

const mockOnUpgraded = vi.fn().mockResolvedValue(undefined)
const mockOnDowngraded = vi.fn().mockResolvedValue(undefined)

const fakeAuth = createFakeAuth()

let config = createTestConfig()
let store = config.store

function rebuildConfig() {
  config = createTestConfig({
    syncClaims: true,
    auth: fakeAuth.auth,
    onSubscriptionUpgraded: (...args) => mockOnUpgraded(...args),
    onSubscriptionDowngraded: (...args) => mockOnDowngraded(...args),
  })
  store = config.store
}

/** Firestore の Timestamp を模したオブジェクト（読み出し時はこの形で返る） */
function timestamp(date: Date) {
  return { toDate: () => date }
}

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt_1',
    source: 'stripe' as const,
    uid: 'user-1',
    occurredAt: new Date('2026-08-01T00:00:00Z'),
    subscription: {
      status: 'active' as const,
      source: 'stripe' as const,
      planId: 'price_abc',
      currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    },
    ...overrides,
  }
}

function readSubscription(uid: string) {
  return store.get(`users/${uid}`)?.subscription as Record<string, unknown>
}

describe('applySubscriptionEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rebuildConfig()
    fakeAuth.getUser.mockResolvedValue({ customClaims: undefined })
    fakeAuth.setCustomUserClaims.mockResolvedValue(undefined)
    mockOnUpgraded.mockResolvedValue(undefined)
    mockOnDowngraded.mockResolvedValue(undefined)
  })

  it('新規イベントを users/{uid}.subscription に反映する', async () => {
    const result = await applySubscriptionEvent(config, createEvent())

    expect(result.status).toBe('applied')

    const subscription = readSubscription('user-1')
    expect(subscription.status).toBe('active')
    expect(subscription.source).toBe('stripe')
    expect(subscription.planId).toBe('price_abc')
    expect(subscription.lastEventId).toBe('evt_1')
  })

  it('コレクション名を注入で差し替えられる（3環境相乗り構成）', async () => {
    const prefixed = createTestConfig({
      collections: {
        users: 'staging_users',
        billingEvents: 'staging_billing_events',
      },
    })

    const result = await applySubscriptionEvent(prefixed, createEvent())

    expect(result.status).toBe('applied')
    expect(prefixed.store.has('staging_users/user-1')).toBe(true)
    expect(prefixed.store.has('staging_billing_events/stripe_evt_1')).toBe(true)
    expect(prefixed.store.has('users/user-1')).toBe(false)
  })

  it('任意項目（planId / currentPeriodEnd）が undefined でも書き込みが成功する', async () => {
    // RevenueCat の expiration_at_ms: null / entitlement_ids 空に相当するイベント
    const result = await applySubscriptionEvent(
      config,
      createEvent({
        subscription: {
          status: 'cancelled' as const,
          source: 'revenuecat' as const,
          planId: undefined,
          currentPeriodEnd: undefined,
          cancelAtPeriodEnd: true,
        },
      })
    )

    expect(result.status).toBe('applied')

    const subscription = readSubscription('user-1')
    expect(subscription.status).toBe('cancelled')
    expect('planId' in subscription).toBe(false)
    expect('currentPeriodEnd' in subscription).toBe(false)
  })

  it('イベントに無いキーは前の subscription から引き継がない', async () => {
    await applySubscriptionEvent(config, createEvent())

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_2',
        occurredAt: new Date('2026-09-02T00:00:00Z'),
        subscription: { status: 'expired' as const, source: 'stripe' as const },
      })
    )

    expect(result.status).toBe('applied')

    // merge: true の深いマージだと前の currentPeriodEnd / planId が残ってしまう
    const subscription = readSubscription('user-1')
    expect(subscription.status).toBe('expired')
    expect('planId' in subscription).toBe(false)
    expect('currentPeriodEnd' in subscription).toBe(false)
  })

  it('処理済みイベントを記録する', async () => {
    await applySubscriptionEvent(config, createEvent())

    expect(store.get('billing_events/stripe_evt_1')).toMatchObject({
      source: 'stripe',
      uid: 'user-1',
      applied: true,
    })
  })

  it('同じイベントを再送されても二重に適用しない', async () => {
    await applySubscriptionEvent(config, createEvent())
    const result = await applySubscriptionEvent(
      config,
      createEvent({
        subscription: {
          status: 'expired' as const,
          source: 'stripe' as const,
        },
      })
    )

    expect(result.status).toBe('duplicate')
    expect(readSubscription('user-1').status).toBe('active')
  })

  it('経路が違えば同じ eventId でも別イベントとして扱う', async () => {
    await applySubscriptionEvent(config, createEvent())
    const result = await applySubscriptionEvent(
      config,
      createEvent({
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-02T00:00:00Z'),
        subscription: {
          status: 'active' as const,
          source: 'revenuecat' as const,
        },
      })
    )

    expect(result.status).toBe('applied')
    expect(store.has('billing_events/revenuecat_evt_1')).toBe(true)
  })

  // 回帰: users/{uid}.subscription は 1 スロットしかなく、経路が違う購読が
  // そこを取り合う。日時だけで前後を決めると、後から届いた別経路の失効が
  // 生きている権利を消してしまう
  it('別経路からのダウングレードで有効な権利を上書きしない', async () => {
    await applySubscriptionEvent(config, createEvent())

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_expired',
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'expired' as const,
          source: 'revenuecat' as const,
        },
      })
    )

    expect(result.status).toBe('ignored')
    expect(result.isActive).toBe(true)
    expect(readSubscription('user-1')).toMatchObject({
      status: 'active',
      source: 'stripe',
    })
    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('逆向き（RevenueCat 有効 → Stripe の失効）も上書きしない', async () => {
    await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_active',
        source: 'revenuecat' as const,
        subscription: {
          status: 'active' as const,
          source: 'revenuecat' as const,
        },
      })
    )

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_stripe_expired',
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'expired' as const,
          source: 'stripe' as const,
        },
      })
    )

    expect(result.status).toBe('ignored')
    expect(readSubscription('user-1')).toMatchObject({
      status: 'active',
      source: 'revenuecat',
    })
  })

  // 回帰: 別経路の「まだ有効」がスロットを奪い、その後で同一経路の失効が通ると、
  // 生きている Stripe の権利が消えていた（ガードが「有効 → 無効」しか見ていなかった）
  it('別経路の弱い（期限が手前の）権利でスロットを奪わせない', async () => {
    await applySubscriptionEvent(
      config,
      createEvent({
        subscription: {
          status: 'active' as const,
          source: 'stripe' as const,
          currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
        },
      })
    )

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_cancelled',
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'cancelled' as const,
          source: 'revenuecat' as const,
          currentPeriodEnd: new Date('2098-01-01T00:00:00Z'),
        },
      })
    )

    expect(result.status).toBe('ignored')
    expect(readSubscription('user-1')).toMatchObject({
      status: 'active',
      source: 'stripe',
    })

    // 奪われていなければ、続く同一経路の失効も「別経路」として弾かれる
    const expired = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_expired',
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-06T00:00:00Z'),
        subscription: {
          status: 'expired' as const,
          source: 'revenuecat' as const,
        },
      })
    )

    expect(expired.isActive).toBe(true)
    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('別経路でも期限が後ろへ伸びるならスロットを渡す', async () => {
    await applySubscriptionEvent(
      config,
      createEvent({
        subscription: {
          status: 'active' as const,
          source: 'stripe' as const,
          currentPeriodEnd: new Date('2098-01-01T00:00:00Z'),
        },
      })
    )

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_longer',
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'active' as const,
          source: 'revenuecat' as const,
          currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
        },
      })
    )

    expect(result.status).toBe('applied')
    expect(readSubscription('user-1').source).toBe('revenuecat')
  })

  it('同じ経路のダウングレードはこれまでどおり適用する', async () => {
    await applySubscriptionEvent(config, createEvent())

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_stripe_expired',
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'expired' as const,
          source: 'stripe' as const,
        },
      })
    )

    expect(result.status).toBe('applied')
    expect(readSubscription('user-1').status).toBe('expired')
    expect(mockOnDowngraded).toHaveBeenCalled()
  })

  it('別経路でも有効 → 有効の切り替えは適用する', async () => {
    await applySubscriptionEvent(config, createEvent())

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_rc_active',
        source: 'revenuecat' as const,
        occurredAt: new Date('2026-08-05T00:00:00Z'),
        subscription: {
          status: 'active' as const,
          source: 'revenuecat' as const,
        },
      })
    )

    expect(result.status).toBe('applied')
    expect(readSubscription('user-1').source).toBe('revenuecat')
  })

  it('反映済みより古いイベントで上書きしない', async () => {
    store.set('users/user-1', {
      subscription: {
        status: 'active',
        lastEventAt: timestamp(new Date('2026-08-10T00:00:00Z')),
      },
    })

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_old',
        occurredAt: new Date('2026-08-01T00:00:00Z'),
        subscription: { status: 'expired' as const, source: 'stripe' as const },
      })
    )

    expect(result.status).toBe('stale')
    expect(readSubscription('user-1').status).toBe('active')
  })

  it('古いイベントでもイベント自体は applied: false で記録する', async () => {
    store.set('users/user-1', {
      subscription: {
        status: 'active',
        lastEventAt: timestamp(new Date('2026-08-10T00:00:00Z')),
      },
    })

    await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_old',
        occurredAt: new Date('2026-08-01T00:00:00Z'),
      })
    )

    expect(store.get('billing_events/stripe_evt_old')).toMatchObject({
      applied: false,
    })
  })

  it('新しいイベントは反映する', async () => {
    store.set('users/user-1', {
      subscription: {
        status: 'active',
        lastEventAt: timestamp(new Date('2026-08-01T00:00:00Z')),
      },
    })

    const result = await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_new',
        occurredAt: new Date('2026-08-20T00:00:00Z'),
        subscription: { status: 'expired' as const, source: 'stripe' as const },
      })
    )

    expect(result.status).toBe('applied')
    expect(readSubscription('user-1').status).toBe('expired')
  })

  it('ユーザードキュメントが未作成でも反映できる', async () => {
    const result = await applySubscriptionEvent(
      config,
      createEvent({ uid: 'brand-new-user' })
    )

    expect(result.status).toBe('applied')
    expect(store.has('users/brand-new-user')).toBe(true)
  })
})

describe('権利変化の副作用', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rebuildConfig()
    fakeAuth.getUser.mockResolvedValue({ customClaims: undefined })
    fakeAuth.setCustomUserClaims.mockResolvedValue(undefined)
    mockOnUpgraded.mockResolvedValue(undefined)
    mockOnDowngraded.mockResolvedValue(undefined)
  })

  it('反映時にカスタムクレームを同期する', async () => {
    await applySubscriptionEvent(config, createEvent())

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ subscriptionActive: true, plan: 'price_abc' })
    )
  })

  it('無効 → 有効でアップグレードフックを呼ぶ', async () => {
    await applySubscriptionEvent(config, createEvent())

    expect(mockOnUpgraded).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'active' })
    )
    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('有効 → 無効でダウングレードフックを呼ぶ', async () => {
    store.set('users/user-1', { subscription: { status: 'active' } })

    await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_expire',
        subscription: { status: 'expired' as const, source: 'stripe' as const },
      })
    )

    expect(mockOnDowngraded).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'expired' })
    )
    expect(mockOnUpgraded).not.toHaveBeenCalled()
  })

  it('有効のまま更新された場合はどちらのフックも呼ばない', async () => {
    store.set('users/user-1', { subscription: { status: 'active' } })

    await applySubscriptionEvent(config, createEvent({ eventId: 'evt_renew' }))

    expect(mockOnUpgraded).not.toHaveBeenCalled()
    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('cancelled でも期間内なら有効のままなのでフックを呼ばない', async () => {
    store.set('users/user-1', { subscription: { status: 'active' } })

    await applySubscriptionEvent(
      config,
      createEvent({
        eventId: 'evt_cancel',
        subscription: {
          status: 'cancelled' as const,
          source: 'stripe' as const,
          currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
        },
      })
    )

    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('duplicate / stale ではフックもクレーム同期も走らない', async () => {
    await applySubscriptionEvent(config, createEvent())
    vi.clearAllMocks()

    await applySubscriptionEvent(config, createEvent())

    expect(fakeAuth.setCustomUserClaims).not.toHaveBeenCalled()
    expect(mockOnUpgraded).not.toHaveBeenCalled()
    expect(mockOnDowngraded).not.toHaveBeenCalled()
  })

  it('クレーム同期が失敗しても反映は成功扱いにする', async () => {
    fakeAuth.getUser.mockRejectedValue(new Error('auth down'))

    const result = await applySubscriptionEvent(config, createEvent())

    expect(result.status).toBe('applied')
    expect(readSubscription('user-1').status).toBe('active')
  })

  it('フックが例外を投げても反映は成功扱いにする', async () => {
    mockOnUpgraded.mockRejectedValue(new Error('cleanup failed'))

    const result = await applySubscriptionEvent(config, createEvent())

    expect(result.status).toBe('applied')
  })

  // 回帰: Stripe の event.created は秒精度で配信順も保証されない。
  // Checkout 完了時の created(incomplete) と updated(active) は同じ秒に生成され、
  // 日時の比較だけだと後から届いた created が active を上書きしていた
  describe('同じ occurredAt のイベント', () => {
    const sameSecond = new Date('2026-08-01T00:00:00Z')

    it('後から届いた created は sequence が小さいので stale になる', async () => {
      await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_updated',
          occurredAt: sameSecond,
          sequence: 1,
          subscription: { status: 'active', source: 'stripe' },
        })
      )

      const result = await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_created',
          occurredAt: sameSecond,
          sequence: 0,
          subscription: { status: 'expired', source: 'stripe' },
        })
      )

      expect(result.status).toBe('stale')
      expect(readSubscription('user-1').status).toBe('active')
    })

    it('created → updated の順なら両方適用される', async () => {
      await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_created',
          occurredAt: sameSecond,
          sequence: 0,
          subscription: { status: 'expired', source: 'stripe' },
        })
      )

      const result = await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_updated',
          occurredAt: sameSecond,
          sequence: 1,
          subscription: { status: 'active', source: 'stripe' },
        })
      )

      expect(result.status).toBe('applied')
      expect(readSubscription('user-1').status).toBe('active')
    })

    it('sequence が同じなら後から来たものを適用する', async () => {
      await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_a',
          occurredAt: sameSecond,
          sequence: 1,
          subscription: { status: 'active', source: 'stripe' },
        })
      )

      const result = await applySubscriptionEvent(
        config,
        createEvent({
          eventId: 'evt_b',
          occurredAt: sameSecond,
          sequence: 1,
          subscription: { status: 'cancelled', source: 'stripe' },
        })
      )

      expect(result.status).toBe('applied')
      expect(readSubscription('user-1').status).toBe('cancelled')
    })
  })
})
