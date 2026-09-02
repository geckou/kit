import type { SubscriptionStatus } from './types.js'

/**
 * Stripe のサブスクリプションステータスを共通の SubscriptionStatus に変換する。
 * null を返した場合は権利状態を変えない（ログのみ）。
 *
 * Stripe の綴りは 'canceled'（l が1つ）である点に注意。
 *
 * 引数を string にしているのは、stripe が任意の peerDependency のため。
 * Stripe.Subscription.Status を使うと dist の .d.ts に stripe からの import が残り、
 * RevenueCat だけを使う（stripe 未インストールの）派生で型解決できなくなる。
 * 未知の値は default で失効扱いになるので、挙動は変わらない
 */
export function mapStripeStatus(status: string): SubscriptionStatus | null {
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

    // 決済待ち。まだ失効ではないので権利状態を変えない
    // （Checkout 完了時は incomplete → active が同じ秒に届き、順序も保証されない）
    case 'incomplete':
      return null

    // 決済待ちのまま期限切れ / 一時停止
    case 'incomplete_expired':
    case 'paused':
      return 'expired'

    // Stripe のステータスは将来増えうるため網羅できない。未知の値は失効扱いにする
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
