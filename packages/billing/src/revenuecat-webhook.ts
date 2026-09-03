import crypto from 'crypto'

import type { ResolvedConfig } from './config.js'
import { mapRevenueCatStatus } from './status-mapping.js'
import { applySubscriptionEvent } from './subscription.js'
import type { HttpResult, WebhookRequest } from './types.js'

// 外部入力なので、型はあくまで想定される形。実際の値は実行時に検証する
type RevenueCatEvent = {
  event: {
    // 古い RevenueCat の設定では id が来ないことがある
    id?: string
    type: string
    app_user_id: string
    event_timestamp_ms?: number
    expiration_at_ms?: number
    /** BILLING_ISSUE のときの猶予期間終了。expiration_at_ms は元の期間終了（ほぼ今） */
    grace_period_expiration_at_ms?: number
    entitlement_ids?: string[]
    environment?: string
    /** TRANSFER で権利を失う側の app_user_id */
    transferred_from?: string[]
    /** TRANSFER で権利を受け取る側の app_user_id */
    transferred_to?: string[]
  }
}

/** 有限な数値のみ受け取る（NaN・文字列・undefined は null にする） */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 冪等性キーを決める。
 *
 * id が無い場合に「種別 + ユーザー + 時刻」のような組み立てキーを使うと、
 * 時刻まで欠けたときに別イベントが同じキーへ衝突し、2件目以降が
 * duplicate として捨てられてしまう。ペイロード全体のハッシュなら
 * 再送では同じ値、別イベントでは別の値になる。
 */
function buildEventId(event: RevenueCatEvent['event']): string {
  if (typeof event.id === 'string' && event.id !== '') return event.id

  return crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

// RevenueCat の Webhook は HMAC 署名ではなく、Dashboard で設定した
// Authorization ヘッダー値をそのまま送信する方式。
// タイミング攻撃を避けるため timingSafeEqual で比較する
function verifyAuthorization(
  header: string | string[] | undefined,
  expected: string
): boolean {
  if (typeof header !== 'string' || header === '') return false

  const received = Buffer.from(header)
  const secret = Buffer.from(expected)

  if (received.length !== secret.length) return false

  return crypto.timingSafeEqual(received, secret)
}

/**
 * TRANSFER（権利が別の app_user_id へ移った）を処理する。
 *
 * 元のユーザーを expired にしないと active が残り続ける。
 *
 * 移動先は TRANSFER のペイロードだけでは決まらない（期限も entitlement も
 * 乗らない）。config.revenuecat.fetchSubscriber があれば、そこで現在の権利を
 * 取り直して反映する。無ければ警告のみで、次の購入・更新イベントまで
 * 「未購読」扱いのままになる（年額なら最長 1 年）
 */
async function handleTransfer(
  config: ResolvedConfig,
  event: RevenueCatEvent['event']
): Promise<HttpResult> {
  const eventId = buildEventId(event)
  const occurredAtMs = asFiniteNumber(event.event_timestamp_ms)
  const occurredAt = occurredAtMs !== null ? new Date(occurredAtMs) : new Date()

  const from = Array.isArray(event.transferred_from)
    ? event.transferred_from.filter(
        (uid): uid is string => typeof uid === 'string' && uid !== ''
      )
    : []

  const to = Array.isArray(event.transferred_to)
    ? event.transferred_to.filter(
        (uid): uid is string => typeof uid === 'string' && uid !== ''
      )
    : []

  const fetchSubscriber = config.revenuecat?.fetchSubscriber

  if (to.length > 0 && !fetchSubscriber) {
    console.warn(
      `RevenueCat TRANSFER to ${to.join(', ')}: 権利は後続の購入・更新イベントまで反映されない（revenuecat.fetchSubscriber を設定すると取り直せる）`
    )
  }

  try {
    for (const uid of from) {
      await applySubscriptionEvent(config, {
        // uid ごとに別イベントとして記録する（同じキーだと 2 件目が duplicate になる）
        eventId: `${eventId}:from:${uid}`,
        source: 'revenuecat',
        uid,
        occurredAt,
        subscription: {
          status: 'expired',
          source: 'revenuecat',
        },
      })
    }

    // 移動先の権利を取り直す。取得に失敗しても移動元の失効は確定させたいので、
    // ここでの失敗は Webhook を 500 にしない（RevenueCat に再送させても
    // 移動元は duplicate になるだけで、移動先の取得が成功する保証もない）
    if (fetchSubscriber) {
      for (const uid of to) {
        try {
          const subscription = await fetchSubscriber(uid)

          if (!subscription) {
            console.warn(
              `RevenueCat TRANSFER to ${uid}: 有効な権利がありません`
            )
            continue
          }

          await applySubscriptionEvent(config, {
            eventId: `${eventId}:to:${uid}`,
            source: 'revenuecat',
            uid,
            occurredAt,
            // source はフックに決めさせない（config.ts の注意書きを参照）
            subscription: { ...subscription, source: 'revenuecat' },
          })
        } catch (error) {
          console.error(
            `Failed to restore the transferred entitlement for ${uid}`,
            error
          )
        }
      }
    }
  } catch (error) {
    console.error('Failed to process RevenueCat transfer', error)
    return { status: 500, body: { error: 'Internal error' } }
  }

  return { status: 200, body: { received: true } }
}

export async function handleRevenueCatWebhook(
  config: ResolvedConfig,
  req: WebhookRequest
): Promise<HttpResult> {
  // RevenueCat Dashboard > Integrations > Webhooks > Authorization header value
  const expected = config.revenuecat?.webhookAuth
  if (!expected) {
    console.error('RevenueCat webhook auth not configured')
    return { status: 500, body: { error: 'Webhook auth not configured' } }
  }

  if (!verifyAuthorization(req.headers.authorization, expected)) {
    console.error('Invalid RevenueCat webhook authorization')
    return { status: 401, body: { error: 'Unauthorized' } }
  }

  // 外部入力のため、パース失敗・想定外の形は 400 で返す
  let parsed: RevenueCatEvent
  try {
    parsed = JSON.parse(req.rawBody.toString('utf-8'))
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } }
  }

  const event = parsed?.event
  if (
    typeof event?.type !== 'string' ||
    typeof event?.app_user_id !== 'string' ||
    event.app_user_id === ''
  ) {
    return { status: 400, body: { error: 'Invalid payload' } }
  }

  // TestFlight / 開発ビルドが本番の Webhook URL を叩くと、サンドボックス購入で
  // 本番の権利が付いてしまう。既定では適用せず、ログだけ残す
  if (
    event.environment === 'SANDBOX' &&
    config.revenuecat?.allowSandbox !== true
  ) {
    console.log(
      `Ignored RevenueCat SANDBOX event: ${event.type} (${event.app_user_id})`
    )
    return { status: 200, body: { received: true } }
  }

  // 権利が別の app_user_id へ移った。元のユーザーの active を残さない
  if (event.type === 'TRANSFER') {
    return handleTransfer(config, event)
  }

  const status = mapRevenueCatStatus(event.type)
  if (!status) {
    console.log(`Unhandled RevenueCat event: ${event.type}`)
    return { status: 200, body: { received: true } }
  }

  const eventId = buildEventId(event)
  const occurredAtMs = asFiniteNumber(event.event_timestamp_ms)

  // BILLING_ISSUE の expiration_at_ms は元の期間終了（ほぼ今）を指す。
  // ストア側の猶予期間（Apple は最大 16 日）は別フィールドにあるため、
  // そちらを優先しないと in_grace_period になった直後に利用不可になる
  const expirationMs =
    asFiniteNumber(event.grace_period_expiration_at_ms) ??
    asFiniteNumber(event.expiration_at_ms)
  const planId = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids.find((id) => typeof id === 'string')
    : undefined

  try {
    const result = await applySubscriptionEvent(config, {
      eventId,
      source: 'revenuecat',
      uid: event.app_user_id,
      // 時刻が無ければ受信時刻で代用する（順序制御の基準として使う）
      occurredAt: occurredAtMs !== null ? new Date(occurredAtMs) : new Date(),
      subscription: {
        status,
        source: 'revenuecat',
        planId,
        currentPeriodEnd:
          expirationMs !== null ? new Date(expirationMs) : undefined,
        cancelAtPeriodEnd: status === 'cancelled',
      },
    })

    if (result.status !== 'applied') {
      console.log(`RevenueCat event ${eventId} skipped: ${result.status}`)
    }
  } catch (error) {
    console.error('Failed to process RevenueCat webhook', error)
    return { status: 500, body: { error: 'Internal error' } }
  }

  return { status: 200, body: { received: true } }
}
