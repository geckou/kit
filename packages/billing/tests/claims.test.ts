import { beforeEach, describe, expect, it, vi } from 'vitest'

import { syncSubscriptionClaims } from '../src/subscription.js'
import type { Subscription } from '../src/types.js'
import { createFakeAuth, createTestConfig } from './helpers.js'

const fakeAuth = createFakeAuth()

function createConfig(syncClaims = true) {
  return createTestConfig({ syncClaims, auth: fakeAuth.auth })
}

function createSubscription(
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    status: 'active',
    source: 'stripe',
    planId: 'pro',
    updatedAt: new Date('2026-08-19T00:00:00Z'),
    ...overrides,
  }
}

describe('syncSubscriptionClaims', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuth.getUser.mockResolvedValue({ customClaims: undefined })
    fakeAuth.setCustomUserClaims.mockResolvedValue(undefined)
  })

  it('有効な権利を subscriptionActive: true として書き込む', async () => {
    await syncSubscriptionClaims(createConfig(), 'user-1', createSubscription())

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith('user-1', {
      subscriptionActive: true,
      plan: 'pro',
    })
  })

  it('失効した権利を subscriptionActive: false として書き込む', async () => {
    await syncSubscriptionClaims(
      createConfig(),
      'user-1',
      createSubscription({ status: 'expired' })
    )

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ subscriptionActive: false })
    )
  })

  it('既存のクレームを消さずにマージする', async () => {
    // setCustomUserClaims は全置換なので、role 等を巻き添えにしないこと
    fakeAuth.getUser.mockResolvedValue({
      customClaims: { role: 'admin', subscriptionActive: false },
    })

    await syncSubscriptionClaims(createConfig(), 'user-1', createSubscription())

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith('user-1', {
      role: 'admin',
      subscriptionActive: true,
      plan: 'pro',
    })
  })

  it('planId が無ければ plan は null にする', async () => {
    await syncSubscriptionClaims(
      createConfig(),
      'user-1',
      createSubscription({ planId: undefined })
    )

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ plan: null })
    )
  })

  it('cancelled でも期間内なら subscriptionActive: true', async () => {
    await syncSubscriptionClaims(
      createConfig(),
      'user-1',
      createSubscription({
        status: 'cancelled',
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
      })
    )

    expect(fakeAuth.setCustomUserClaims).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ subscriptionActive: true })
    )
  })

  it('syncClaims が無効なら Auth にアクセスしない', async () => {
    await syncSubscriptionClaims(
      createConfig(false),
      'user-1',
      createSubscription()
    )

    expect(fakeAuth.getUser).not.toHaveBeenCalled()
    expect(fakeAuth.setCustomUserClaims).not.toHaveBeenCalled()
  })

  it('syncClaims が有効なのに auth が無ければエラーにする', async () => {
    const config = createTestConfig({ syncClaims: true })

    await expect(
      syncSubscriptionClaims(config, 'user-1', createSubscription())
    ).rejects.toThrow('config.auth')
  })
})
