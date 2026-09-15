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

/**
 * 日時。書き込むときは Date だが、Firestore から読み出すと Timestamp になる。
 * `users/{uid}.subscription` をそのまま Subscription として扱えるよう、
 * 公開型は両方を受ける。値を使うときは `toDate()` を通すこと
 */
export type DateLike = Date | { toDate: () => Date }

export type Subscription = {
  status: SubscriptionStatus
  /** どの経路で購入されたか */
  source: SubscriptionSource
  /** プラン識別子（Stripe は price ID、RevenueCat は entitlement ID） */
  planId?: string
  /** 現在の課金期間の終了日時。cancelled でもこの日時までは利用可 */
  currentPeriodEnd?: DateLike
  /** 期間終了時に解約されるか */
  cancelAtPeriodEnd?: boolean
  updatedAt: DateLike
  /** 冪等性・順序制御用（Webhook が書き込む） */
  lastEventId?: string
  lastEventAt?: DateLike
  /** 同じ occurredAt のイベントを並べるための序列（→ SubscriptionEvent.sequence） */
  lastEventSequence?: number
}

/**
 * RevenueCat の Webhook ペイロードの `event`。JSON をパースしたそのままの値。
 *
 * `revenuecat.nonRenewingPurchase` / `revenuecat.onNonRenewingPurchase` に
 * そのまま渡すため公開している（`product_id` など、ここに挙げていない
 * フィールドも実際には乗ってくる）。
 *
 * **`type` と `app_user_id` 以外は検証していないので `unknown`。** 外部入力を
 * `number` や `string[]` と名乗らせると、実際には文字列や null が入ってきた
 * ときに利用側が気付けない（例: `event_timestamp_ms` が文字列でも、パッケージが
 * 正規化するのは内部の複製だけ）。使う前に typeof / Array.isArray で絞ること
 */
export type RevenueCatWebhookEvent = {
  /** 検証済み（イベント種別） */
  type: string
  /** 検証済み（空でない、ドキュメント ID にできる文字列） */
  app_user_id: string
  /** 想定は string。古い RevenueCat の設定では来ないことがある */
  id?: unknown
  /** 想定は number（ミリ秒） */
  event_timestamp_ms?: unknown
  /** 想定は number（ミリ秒） */
  expiration_at_ms?: unknown
  /**
   * 想定は number（ミリ秒）。BILLING_ISSUE のときの猶予期間終了。
   * expiration_at_ms は元の期間終了（ほぼ今）
   */
  grace_period_expiration_at_ms?: unknown
  /** 想定は string[] */
  entitlement_ids?: unknown
  /** 想定は string（'SANDBOX' | 'PRODUCTION'） */
  environment?: unknown
  /** 想定は string[]。TRANSFER で権利を失う側の app_user_id */
  transferred_from?: unknown
  /** 想定は string[]。TRANSFER で権利を受け取る側の app_user_id */
  transferred_to?: unknown
  /** 上記以外のフィールド（product_id / price 等）もそのまま渡る */
  [key: string]: unknown
}

/**
 * NON_RENEWING_PURCHASE（消費型・単発購入）の扱い。
 *
 * - entitlement 従来どおり `active` として `users/{uid}.subscription` に反映する
 * - ignore     権利状態を変えない（別処理は onNonRenewingPurchase で受け取る）
 */
export type NonRenewingPurchaseMode = 'entitlement' | 'ignore'

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
  subscription: Omit<
    Subscription,
    'updatedAt' | 'lastEventId' | 'lastEventAt' | 'lastEventSequence'
  >
}

/**
 * - applied   反映した
 * - duplicate 同じ eventId を既に処理済み
 * - stale     反映済みより古いイベント
 * - ignored   意図的に無視した（別経路の、今より強くない権利）
 */
export type ApplyStatus = 'applied' | 'duplicate' | 'stale' | 'ignored'

export type ApplyResult = {
  status: ApplyStatus
  /** 適用前に権利が有効だったか */
  wasActive: boolean
  /** 適用後に権利が有効か（適用しなかった場合は wasActive と同じ） */
  isActive: boolean
  /**
   * 反映後の副作用（クレーム同期・権利変化フック）が未完了か。
   * true なら Webhook ハンドラは 5xx を返し、プロバイダに再送させる
   * （再送時は失敗した副作用だけをやり直す）
   */
  effectsPending: boolean
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
