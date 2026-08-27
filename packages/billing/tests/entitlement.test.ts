import { describe, expect, it } from 'vitest'

import { hasPlan, isSubscriptionActive } from '../src/entitlement.js'
import type { Subscription } from '../src/types.js'

const NOW = new Date('2026-08-19T00:00:00Z')

function createSubscription(
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    status: 'active',
    source: 'stripe',
    updatedAt: NOW,
    ...overrides,
  }
}

describe('isSubscriptionActive', () => {
  it('subscription が無ければ false', () => {
    expect(isSubscriptionActive(undefined, NOW)).toBe(false)
    expect(isSubscriptionActive(null, NOW)).toBe(false)
  })

  it('active は true', () => {
    expect(isSubscriptionActive(createSubscription(), NOW)).toBe(true)
  })

  it('in_grace_period で期間終了前なら true', () => {
    const subscription = createSubscription({
      status: 'in_grace_period',
      currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
    })

    expect(isSubscriptionActive(subscription, NOW)).toBe(true)
  })

  it('in_grace_period で期間終了後なら false', () => {
    const subscription = createSubscription({
      status: 'in_grace_period',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    })

    expect(isSubscriptionActive(subscription, NOW)).toBe(false)
  })

  it('in_grace_period で期間終了日時が無ければ true（Webhook を正とするフォールバック）', () => {
    expect(
      isSubscriptionActive(
        createSubscription({ status: 'in_grace_period' }),
        NOW
      )
    ).toBe(true)
  })

  it('expired は false', () => {
    expect(
      isSubscriptionActive(createSubscription({ status: 'expired' }), NOW)
    ).toBe(false)
  })

  it('cancelled でも期間終了前なら true', () => {
    const subscription = createSubscription({
      status: 'cancelled',
      currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
    })

    expect(isSubscriptionActive(subscription, NOW)).toBe(true)
  })

  it('cancelled で期間終了後なら false', () => {
    const subscription = createSubscription({
      status: 'cancelled',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    })

    expect(isSubscriptionActive(subscription, NOW)).toBe(false)
  })

  it('cancelled で期間終了日時が無ければ false', () => {
    expect(
      isSubscriptionActive(createSubscription({ status: 'cancelled' }), NOW)
    ).toBe(false)
  })

  it('Firestore の Timestamp 形式（toDate を持つ値）でも判定できる', () => {
    const subscription = {
      ...createSubscription({ status: 'cancelled' }),
      currentPeriodEnd: {
        toDate: () => new Date('2026-09-01T00:00:00Z'),
      } as unknown as Date,
    }

    expect(isSubscriptionActive(subscription, NOW)).toBe(true)
  })

  it('IAP（RevenueCat）経由でも Web（Stripe）経由でも同じ判定になる', () => {
    const viaStripe = createSubscription({ source: 'stripe' })
    const viaRevenueCat = createSubscription({ source: 'revenuecat' })

    expect(isSubscriptionActive(viaStripe, NOW)).toBe(
      isSubscriptionActive(viaRevenueCat, NOW)
    )
  })
})

describe('hasPlan', () => {
  it('有効かつプランが一致すれば true', () => {
    const subscription = createSubscription({ planId: 'pro' })

    expect(hasPlan(subscription, 'pro', NOW)).toBe(true)
  })

  it('プランが違えば false', () => {
    const subscription = createSubscription({ planId: 'pro' })

    expect(hasPlan(subscription, 'enterprise', NOW)).toBe(false)
  })

  it('失効していればプランが一致していても false', () => {
    const subscription = createSubscription({
      status: 'expired',
      planId: 'pro',
    })

    expect(hasPlan(subscription, 'pro', NOW)).toBe(false)
  })

  it('subscription が無ければ false', () => {
    expect(hasPlan(undefined, 'pro', NOW)).toBe(false)
  })
})
