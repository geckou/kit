import { describe, expect, it } from 'vitest'

import * as billing from '../src/index.js'

describe('@geckou/billing のルート export', () => {
  // README はルート import の例を載せている。サブパスからしか取れない状態に
  // 戻ると利用側が TS2305 になるため、ここで固定する
  it('純粋関数をルートから export している', () => {
    expect(typeof billing.hasPlan).toBe('function')
    expect(typeof billing.isSubscriptionActive).toBe('function')
    expect(typeof billing.toDate).toBe('function')
  })

  it('toDate は Timestamp 風の値を Date にする', () => {
    const date = new Date('2026-08-19T00:00:00Z')

    expect(billing.toDate({ toDate: () => date })).toEqual(date)
    expect(billing.toDate(null)).toBeNull()
  })
})
