import type { ResolvedConfig } from './config.js'
import { getStripeCustomerId, saveStripeCustomerId } from './subscription.js'
import type { HttpResult } from './types.js'

/**
 * uid に対応する Stripe 顧客を取得する。無ければ作成して保存する。
 * metadata.uid を入れておくと Stripe ダッシュボードから逆引きできる。
 */
async function findOrCreateCustomer(
  config: ResolvedConfig,
  uid: string
): Promise<string> {
  const existing = await getStripeCustomerId(config, uid)
  if (existing) return existing

  const stripe = config.stripe
  if (!stripe) throw new Error('Stripe not configured')

  // メールは Stripe 側の顧客一覧を見やすくするためだけに使う（取得失敗は致命的でない）
  let email: string | undefined
  try {
    email = config.auth ? (await config.auth.getUser(uid)).email : undefined
  } catch {
    email = undefined
  }

  const customer = await stripe.client.customers.create({
    email,
    metadata: { uid },
  })
  await saveStripeCustomerId(config, uid, customer.id)

  return customer.id
}

/**
 * Stripe Checkout のセッションを作成し、リダイレクト先 URL を返す。
 *
 * uid は認証済みであること（呼び出し側の認証ミドルウェア / セッション検証を通った値を渡す）。
 * priceId は未検証の外部入力として受け、許可リストで検証する。
 */
export async function createCheckoutSession(
  config: ResolvedConfig,
  input: { uid: string; priceId: unknown }
): Promise<HttpResult> {
  const stripe = config.stripe
  if (!stripe) {
    return { status: 503, body: { error: 'Stripe not configured' } }
  }

  const { successUrl, cancelUrl } = stripe
  if (!successUrl || !cancelUrl) {
    console.error('Stripe successUrl / cancelUrl not configured')
    return { status: 500, body: { error: 'Checkout URLs not configured' } }
  }

  // 任意の price を購入されないよう、サーバー側の許可リストで検証する
  const allowedPriceIds = stripe.allowedPriceIds ?? []
  const priceId = input.priceId

  if (typeof priceId !== 'string' || !allowedPriceIds.includes(priceId)) {
    return { status: 400, body: { error: 'Invalid priceId' } }
  }

  try {
    const customerId = await findOrCreateCustomer(config, input.uid)
    const session = await stripe.client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Webhook 側で誰の購入か特定するために uid を両方へ入れる
      client_reference_id: input.uid,
      metadata: { uid: input.uid },
      subscription_data: { metadata: { uid: input.uid } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    })

    if (!session.url) {
      return { status: 500, body: { error: 'Checkout session has no URL' } }
    }

    return { status: 200, body: { url: session.url } }
  } catch (error) {
    console.error('Failed to create checkout session', error)
    return { status: 500, body: { error: 'Internal error' } }
  }
}

/**
 * Stripe カスタマーポータル（解約・プラン変更・支払い方法の更新）の URL を返す。
 * uid は認証済みであること。
 */
export async function createPortalSession(
  config: ResolvedConfig,
  input: { uid: string }
): Promise<HttpResult> {
  const stripe = config.stripe
  if (!stripe) {
    return { status: 503, body: { error: 'Stripe not configured' } }
  }

  const returnUrl = stripe.portalReturnUrl
  if (!returnUrl) {
    console.error('Stripe portalReturnUrl not configured')
    return { status: 500, body: { error: 'Portal return URL not configured' } }
  }

  try {
    const customerId = await getStripeCustomerId(config, input.uid)

    // 一度も Stripe で購入していないユーザーにはポータルが存在しない
    if (!customerId) {
      return { status: 404, body: { error: 'No Stripe customer for this user' } }
    }

    const session = await stripe.client.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })

    return { status: 200, body: { url: session.url } }
  } catch (error) {
    console.error('Failed to create portal session', error)
    return { status: 500, body: { error: 'Internal error' } }
  }
}
