import type { HttpResult, WebhookRequest } from './types.js'

/**
 * rawBody がパース前の生のボディであることを検査する。
 *
 * Firebase Functions（onRequest）の土台である Functions Framework は、
 * 自前のハンドラより前に JSON をパースする。後段に置いた express.raw() は
 * パース済み（req._body）を見てスキップするため、req.body はオブジェクトになる。
 * その状態で署名検証へ渡すと Stripe は「署名不正」、RevenueCat は
 * 「JSON 不正」として落ち、原因が配線ミスであることがログから読み取れない。
 * 生のボディは req.rawBody にしか無いので、ここで配線ミスとして弾く。
 *
 * @returns 問題があれば返すべき HttpResult、正しければ undefined
 */
export function assertRawBody(
  req: WebhookRequest,
  source: 'Stripe' | 'RevenueCat'
): HttpResult | undefined {
  const rawBody: unknown = req.rawBody
  if (typeof rawBody === 'string' || Buffer.isBuffer(rawBody)) {
    return undefined
  }

  // クライアント起因ではなく配線ミスなので 4xx にはしない
  console.error(
    `${source} webhook rawBody is already parsed (${typeof rawBody}). ` +
      'Pass the unparsed body: on Cloud Functions use req.rawBody, not req.body.'
  )

  return { status: 500, body: { error: 'Webhook misconfigured' } }
}
