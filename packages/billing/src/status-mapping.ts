import type Stripe from 'stripe'

import type { SubscriptionStatus } from './types.js'

/**
 * Stripe のサブスクリプションステータスを共通の SubscriptionStatus に変換する。
 *
 * Stripe の綴りは 'canceled'（l が1つ）である点に注意。
 */
export function mapStripeStatus(
  status: Stripe.Subscription.Status
): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active'

    // 支払い失敗中。Stripe のリトライが続いている猶予期間
    case 'past_due':
      return 'in_grace_period'

    // リトライを使い切った後の状態。以後の請求は行われないため失効扱いにする
    case 'unpaid':
      return 'expired'

    case 'canceled':
      return 'cancelled'

    // 初回決済が完了しなかった / 一時停止
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'expired'

    // Stripe.Subscription.Status は将来値のための OtherString を含むため
    // 網羅できない。未知のステータスは失効扱いにする
    // （誤って権利を与えるより、与えないほうが被害が小さい）
    default:
      console.warn(`Unknown Stripe subscription status: ${status}`)
      return 'expired'
  }
}

/**
 * RevenueCat のイベント種別を共通の SubscriptionStatus に変換する。
 * null を返した種別は権利状態を変えない（ログのみ）。
 */
export function mapRevenueCatStatus(type: string): SubscriptionStatus | null {
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE':
      return 'active'

    // 自動更新を止めただけ。expiration_at_ms までは利用できる
    case 'CANCELLATION':
    case 'SUBSCRIPTION_PAUSED':
      return 'cancelled'

    // 支払い失敗。ストアのリトライが続いている猶予期間
    case 'BILLING_ISSUE':
      return 'in_grace_period'

    case 'EXPIRATION':
      return 'expired'

    default:
      return null
  }
}
