import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'

import type { StripeClientLike } from '../src/config.js'
import { resolveConfig } from '../src/config.js'

/**
 * stripe の実型が StripeClientLike を満たすことの型レベル検証。
 * 実行時はインスタンスを 1 つ作るだけ。tsconfig.test.json の type-check で強制される。
 *
 * stripe の型はメジャー間で壊れた実績がある（v22 で CJS が
 * `export = StripeConstructor` に変わった）。Renovate のメジャー更新で
 * 黙って壊れないよう、firebase-server の type-compat.test.ts と同じ形で固定する
 */

const _client: StripeClientLike = new Stripe('sk_test_dummy')

// BillingConfig.stripe.client にそのまま渡せること
const _config = resolveConfig({
  firestore: undefined as never,
  stripe: {
    client: new Stripe('sk_test_dummy'),
    webhookSecret: 'whsec_test',
    allowedPriceIds: ['price_abc'],
  },
})

void _client
void _config

describe('型互換', () => {
  it('stripe の Stripe インスタンスが StripeClientLike に適合する（type-check で検証）', () => {
    expect(typeof _client.webhooks.constructEvent).toBe('function')
    expect(typeof _client.customers.create).toBe('function')
    expect(typeof _client.checkout.sessions.create).toBe('function')
    expect(typeof _client.billingPortal.sessions.create).toBe('function')
  })
})
