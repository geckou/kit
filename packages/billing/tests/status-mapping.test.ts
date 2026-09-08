import { describe, expect, it, vi } from 'vitest'

import { isSubscriptionActive } from '../src/entitlement.js'
import { mapRevenueCatStatus, mapStripeStatus } from '../src/status-mapping.js'

describe('mapStripeStatus', () => {
  it('active / trialing は active', () => {
    expect(mapStripeStatus('active')).toBe('active')
    expect(mapStripeStatus('trialing')).toBe('active')
  })

  // Stripe は「自動更新を止めただけ」を status: 'active' のまま
  // cancel_at_period_end: true で表す
  it('cancel_at_period_end が立っていれば cancelled', () => {
    expect(mapStripeStatus('active', { cancelAtPeriodEnd: true })).toBe(
      'cancelled'
    )
    expect(mapStripeStatus('trialing', { cancelAtPeriodEnd: true })).toBe(
      'cancelled'
    )
  })

  // 回帰: 綴りだけで cancelled に写していたため、終了済みのユーザーが
  // currentPeriodEnd まで権利を持ち続けていた
  it('canceled は expired（終了済み。cancel_at_period_end は見ない）', () => {
    expect(mapStripeStatus('canceled')).toBe('expired')
    expect(mapStripeStatus('canceled', { cancelAtPeriodEnd: true })).toBe(
      'expired'
    )
  })

  it('past_due は cancel_at_period_end に関わらず in_grace_period', () => {
    expect(mapStripeStatus('past_due')).toBe('in_grace_period')
    expect(mapStripeStatus('past_due', { cancelAtPeriodEnd: true })).toBe(
      'in_grace_period'
    )
  })

  it('unpaid / incomplete_expired / paused は expired', () => {
    expect(mapStripeStatus('unpaid')).toBe('expired')
    expect(mapStripeStatus('incomplete_expired')).toBe('expired')
    expect(mapStripeStatus('paused')).toBe('expired')
  })

  it('incomplete は権利状態を変えない', () => {
    expect(mapStripeStatus('incomplete')).toBeNull()
  })

  it('未知の値は expired に倒す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(mapStripeStatus('brand_new_status')).toBe('expired')
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})

// 完了条件: 「自動更新停止・期間内は利用可」がどちらの経路から来ても同じ status になる
describe('Stripe と RevenueCat の status が一致する', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const past = new Date(Date.now() - 60 * 60 * 1000)

  it('自動更新を止めた状態は両経路とも cancelled', () => {
    expect(mapStripeStatus('active', { cancelAtPeriodEnd: true })).toBe(
      mapRevenueCatStatus('CANCELLATION')
    )
  })

  it('終了済みは両経路とも expired', () => {
    expect(mapStripeStatus('canceled')).toBe(mapRevenueCatStatus('EXPIRATION'))
  })

  it('支払い失敗は両経路とも in_grace_period', () => {
    expect(mapStripeStatus('past_due')).toBe(
      mapRevenueCatStatus('BILLING_ISSUE')
    )
  })

  it('cancelled は currentPeriodEnd までだけ有効', () => {
    const base = {
      status: mapStripeStatus('active', { cancelAtPeriodEnd: true })!,
      source: 'stripe' as const,
      cancelAtPeriodEnd: true,
      updatedAt: new Date(),
    }

    expect(isSubscriptionActive({ ...base, currentPeriodEnd: future })).toBe(
      true
    )
    expect(isSubscriptionActive({ ...base, currentPeriodEnd: past })).toBe(
      false
    )
  })
})
