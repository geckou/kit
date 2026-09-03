import type { Subscription } from './types.js'

// クライアント（ブラウザ）からは、このモジュールだけを import すれば
// 権利判定と関連型が揃うようにする（ルートは Node 専用の crypto を含むため）
export type {
  DateLike,
  Subscription,
  SubscriptionSource,
  SubscriptionStatus,
} from './types.js'

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value

  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate()
  }

  return null
}

/**
 * サブスクリプションが今この瞬間に有効かを判定する。
 *
 * status === 'cancelled' は「自動更新が止まっている」だけで、
 * 課金期間の終了日時までは利用できる点に注意（Stripe / RevenueCat 共通の挙動）。
 */
export function isSubscriptionActive(
  subscription: Subscription | null | undefined,
  now: Date = new Date()
): boolean {
  if (!subscription) return false

  switch (subscription.status) {
    // Webhook を正とする方針のため、active は日時を見ずに有効扱い
    case 'active':
      return true

    // 猶予期間は有限。currentPeriodEnd を持っている場合はそれを超えたら無効。
    // 日時が無い場合は従来どおり有効扱い（Webhook を正とするフォールバック）
    case 'in_grace_period': {
      const periodEnd = toDate(subscription.currentPeriodEnd)
      if (periodEnd === null) return true
      return periodEnd.getTime() > now.getTime()
    }

    case 'cancelled': {
      const periodEnd = toDate(subscription.currentPeriodEnd)
      return periodEnd !== null && periodEnd.getTime() > now.getTime()
    }

    case 'expired':
      return false

    // 未知のステータス（型の範囲外から来た値）は権利を与えない側に倒す
    default:
      return false
  }
}

/**
 * 指定したプランの権利を持っているかを判定する。
 * planId を使わない（単一プランの）プロダクトでは isSubscriptionActive だけでよい。
 */
export function hasPlan(
  subscription: Subscription | null | undefined,
  planId: string,
  now: Date = new Date()
): boolean {
  if (!isSubscriptionActive(subscription, now)) return false

  return subscription?.planId === planId
}
