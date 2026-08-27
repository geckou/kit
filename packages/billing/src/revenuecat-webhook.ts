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
    entitlement_ids?: string[]
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

  const status = mapRevenueCatStatus(event.type)
  if (!status) {
    console.log(`Unhandled RevenueCat event: ${event.type}`)
    return { status: 200, body: { received: true } }
  }

  const eventId = buildEventId(event)
  const occurredAtMs = asFiniteNumber(event.event_timestamp_ms)
  const expirationMs = asFiniteNumber(event.expiration_at_ms)
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
