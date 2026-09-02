/**
 * サブスクリプションの権利状態。
 *
 * Web 決済（Stripe）とアプリ内課金（RevenueCat 経由の IAP）の
 * どちらで購入されても、この単一の形に集約する。
 *
 * - active          有効
 * - in_grace_period 支払いに失敗したが猶予期間中（まだ利用可）
 * - cancelled       自動更新が止まっている（currentPeriodEnd までは利用可）
 * - expired         失効（利用不可）
 */
export type SubscriptionStatus =
  'active' | 'in_grace_period' | 'cancelled' | 'expired'

/** 購入経路 */
export type SubscriptionSource = 'stripe' | 'revenuecat'

export type Subscription = {
  status: SubscriptionStatus
  /** どの経路で購入されたか */
  source: SubscriptionSource
  /** プラン識別子（Stripe は price ID、RevenueCat は entitlement ID） */
  planId?: string
  /** 現在の課金期間の終了日時。cancelled でもこの日時までは利用可 */
  currentPeriodEnd?: Date
  /** 期間終了時に解約されるか */
  cancelAtPeriodEnd?: boolean
  updatedAt: Date
  /** 冪等性・順序制御用（Webhook が書き込む） */
  lastEventId?: string
  lastEventAt?: Date
  /** 同じ occurredAt のイベントを並べるための序列（→ SubscriptionEvent.sequence） */
  lastEventSequence?: number
}

/** Webhook から渡される、経路非依存に正規化済みのイベント */
export type SubscriptionEvent = {
  /** プロバイダ側のイベント ID（冪等性キー） */
  eventId: string
  source: SubscriptionSource
  /** Firebase Auth の uid */
  uid: string
  /** プロバイダ側でイベントが発生した日時（順序制御に使う） */
  occurredAt: Date
  /**
   * 同じ occurredAt を持つイベントの序列。大きいほど後。
   *
   * Stripe の event.created は秒精度で、配信順も保証されない。Checkout 完了時の
   * customer.subscription.created（incomplete）と .updated（active）は同じ秒に
   * 生成されるため、日時だけでは前後を決められない。既定は 0
   */
  sequence?: number
  /** 反映する権利状態（updatedAt / lastEvent* は適用時に付与される） */
  subscription: Omit<Subscription, 'updatedAt' | 'lastEventId' | 'lastEventAt'>
}

export type ApplyStatus = 'applied' | 'duplicate' | 'stale'

export type ApplyResult = {
  status: ApplyStatus
  /** 適用前に権利が有効だったか */
  wasActive: boolean
  /** 適用後に権利が有効か（適用しなかった場合は wasActive と同じ） */
  isActive: boolean
}

/**
 * トランスポート非依存の HTTP リクエスト表現。
 * Express でも Next.js Route Handler でも、この形に詰め替えて渡す。
 *
 * rawBody は署名検証のため、パース前の生のボディであること。
 */
export type WebhookRequest = {
  rawBody: string | Buffer
  /** ヘッダー名は小文字で引く（Node の IncomingHttpHeaders と同じ規約） */
  headers: Record<string, string | string[] | undefined>
}

/** トランスポート非依存の HTTP レスポンス表現。res.status(r.status).json(r.body) で返す */
export type HttpResult = {
  status: number
  body: Record<string, unknown>
}
