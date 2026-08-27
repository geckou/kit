import type Stripe from 'stripe'

import type { ResolvedConfig } from './config.js'
import { mapStripeStatus } from './status-mapping.js'
import { applySubscriptionEvent, saveStripeCustomerId } from './subscription.js'
import type { HttpResult, WebhookRequest } from './types.js'

/**
 * Stripe のサブスクリプション期間終了日時を取り出す。
 *
 * API version 2025-03-31.basil 以降、current_period_end は Subscription 直下から
 * subscription item 側へ移動した。どちらの形でも動くように両方を見る。
 */
function extractCurrentPeriodEnd(
  subscription: Stripe.Subscription
): Date | undefined {
  const fromItem = subscription.items?.data?.[0]?.current_period_end
  const fromSubscription = (
    subscription as unknown as { current_period_end?: number }
  ).current_period_end
  const seconds = fromItem ?? fromSubscription

  return typeof seconds === 'number' ? new Date(seconds * 1000) : undefined
}

/** Checkout Session 作成時に metadata へ入れた Firebase uid を取り出す */
function extractUid(subscription: Stripe.Subscription): string | undefined {
  const uid = subscription.metadata?.uid

  return typeof uid === 'string' && uid !== '' ? uid : undefined
}

function headerValue(
  headers: WebhookRequest['headers'],
  name: string
): string | undefined {
  const value = headers[name]

  return typeof value === 'string' ? value : undefined
}

export async function handleStripeWebhook(
  config: ResolvedConfig,
  req: WebhookRequest
): Promise<HttpResult> {
  if (!config.stripe) {
    console.error('Stripe not configured')
    return { status: 500, body: { error: 'Stripe not configured' } }
  }

  const { client: stripe, webhookSecret } = config.stripe
  if (!webhookSecret) {
    console.error('Stripe webhook secret not configured')
    return { status: 500, body: { error: 'Webhook secret not configured' } }
  }

  const signature = headerValue(req.headers, 'stripe-signature')
  if (!signature) {
    return { status: 400, body: { error: 'Missing stripe-signature header' } }
  }

  // 署名検証には生のリクエストボディが必要（パース前の rawBody を渡すこと）
  let event: Stripe.Event
  try {
    // 署名検証は client に委譲する。戻り値の型は StripeClientLike が
    // バージョン差を吸収するため unknown で返るので、ここで確定させる
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      webhookSecret
    ) as Stripe.Event
  } catch (error) {
    console.error('Stripe webhook signature verification failed', error)
    return { status: 400, body: { error: 'Invalid signature' } }
  }

  const occurredAt = new Date(event.created * 1000)

  try {
    switch (event.type) {
      // 決済完了。以降 顧客ポータルを開けるよう顧客 ID を保存する
      case 'checkout.session.completed': {
        const session = event.data.object
        const uid = session.client_reference_id ?? session.metadata?.uid
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id

        if (uid && customerId) {
          await saveStripeCustomerId(config, uid, customerId)
        } else {
          console.warn(
            `checkout.session.completed without uid or customer: ${session.id}`
          )
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        const uid = extractUid(subscription)

        if (!uid) {
          // uid が無いと誰の権利か特定できない。Stripe には 200 を返して再送を止め、
          // ログで検知できるようにする（Checkout 作成時の metadata 設定漏れ）
          console.error(
            `Stripe subscription without uid metadata: ${subscription.id}`
          )
          break
        }

        // 削除イベントは Stripe 側の status に関わらず失効として扱う
        const status =
          event.type === 'customer.subscription.deleted'
            ? 'expired'
            : mapStripeStatus(subscription.status)

        const result = await applySubscriptionEvent(config, {
          eventId: event.id,
          source: 'stripe',
          uid,
          occurredAt,
          subscription: {
            status,
            source: 'stripe',
            planId: subscription.items?.data?.[0]?.price?.id,
            currentPeriodEnd: extractCurrentPeriodEnd(subscription),
            cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
          },
        })

        if (result.status !== 'applied') {
          console.log(`Stripe event ${event.id} skipped: ${result.status}`)
        }
        break
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`)
    }
  } catch (error) {
    console.error('Failed to process Stripe webhook', error)
    return { status: 500, body: { error: 'Internal error' } }
  }

  return { status: 200, body: { received: true } }
}
