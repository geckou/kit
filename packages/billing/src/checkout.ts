import crypto from 'node:crypto'

import type { ResolvedConfig } from './config.js'
import { isSubscriptionActive } from './entitlement.js'
import { getStripeCustomerId, saveStripeCustomerId } from './subscription.js'
import type { HttpResult, Subscription } from './types.js'

/**
 * Checkout セッションの idempotencyKey に使う時間窓。
 * 短すぎると二重送信を取りこぼし、長すぎるとキャンセル後の作り直しが
 * 同じセッションに戻ってしまう。
 *
 * ⚠️ 窓の境界をまたいだ二重送信は取りこぼす（確率的な防御）。
 * Firestore のロックではないので、確実性が要るなら利用側でボタンを無効化すること
 */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000

/**
 * idempotencyKey に混ぜるパラメータの指紋。
 *
 * Stripe は「同じキー + 異なるパラメータ」に `idempotency_error`（400）を返し、
 * そのキーは 24 時間残る。パラメータをキーに畳み込んでおけば衝突自体が起きない。
 */
function fingerprint(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16)
}

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

  // 二重送信（ダブルクリック・複数タブ）で顧客が 2 つ作られると、保存した ID と
  // 実際に決済された顧客が食い違い、ポータルから解約できなくなる。
  // 同じキーなら Stripe が同じ顧客を返す
  const params = { email, metadata: { uid } }

  // キーを `customer_${uid}` に固定すると、1 回目に email の取得が失敗し
  // （undefined で作成）その後の保存も失敗したとき、再試行は email 付きの
  // 別パラメータで同じキーを送るため 24 時間ずっと 400 になり自力で抜けられない。
  // かといってキーなしで作り直すと、このキーが防いでいる二重送信の重複顧客が
  // 復活する。パラメータを指紋にしてキーへ畳み込めば、衝突せず、
  // かつ同じパラメータの同時送信は 1 顧客にまとまる
  const customer = await stripe.client.customers.create(params, {
    idempotencyKey: `customer_${uid}_${fingerprint(params)}`,
  })

  await saveStripeCustomerId(config, uid, customer.id)

  return customer.id
}

/** users/{uid}.subscription を読む（未作成のユーザーは undefined） */
async function getSubscription(
  config: ResolvedConfig,
  uid: string
): Promise<Subscription | undefined> {
  const snapshot = await config.firestore
    .collection(config.collectionNames.users)
    .doc(uid)
    .get()

  return snapshot.get('subscription') as Subscription | undefined
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

  // 任意の price を購入されないよう、サーバー側の許可リストで検証する。
  // 空文字・空白のみは許可リストの作り方（`(process.env.X ?? '').split(',')` が
  // 未設定時に `['']` になる等）で紛れ込みうるため、リストを見る前に弾く
  const allowedPriceIds = stripe.allowedPriceIds ?? []
  const priceId = input.priceId

  if (typeof priceId !== 'string' || priceId.trim() === '') {
    return { status: 400, body: { error: 'Invalid priceId' } }
  }

  if (!allowedPriceIds.includes(priceId)) {
    return { status: 400, body: { error: 'Invalid priceId' } }
  }

  try {
    // 有効な購読があるまま再度作らせると、同一顧客に 2 本目のサブスクリプションが
    // 作られる（Checkout は重複を防がない）。users/{uid}.subscription は 1 つしか
    // 持てないため、片方が解約されるともう片方は課金だけ残る。
    // プラン変更はカスタマーポータルへ誘導する
    const current = await getSubscription(config, input.uid)

    if (isSubscriptionActive(current)) {
      return {
        status: 409,
        body: { error: 'Subscription already active' },
      }
    }

    const customerId = await findOrCreateCustomer(config, input.uid)

    // 上の 409 判定と作成の間にロックは無いため、同時に呼ぶと両方が判定を
    // 通過して Checkout が 2 本できる。同じキーなら Stripe が同じセッションを
    // 返すので、実質 1 本になる。
    // キャンセル後の作り直しは許したいので、時間窓（CHECKOUT_IDEMPOTENCY_WINDOW_MS）
    // をキーに含める
    const windowIndex = Math.floor(Date.now() / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
    const sessionParams = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Webhook 側で誰の購入か特定するために uid を両方へ入れる
      client_reference_id: input.uid,
      metadata: { uid: input.uid },
      subscription_data: { metadata: { uid: input.uid } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    }

    // 顧客 ID もパラメータに含まれるため、キーには指紋を混ぜる。
    // 固定キーのままだと、customerId が変わった直後に同じキー・別パラメータで
    // idempotency_error（400）になり、利用者には 500 が返る
    const session = await stripe.client.checkout.sessions.create(
      sessionParams,
      {
        idempotencyKey: `checkout:${input.uid}:${windowIndex}:${fingerprint(sessionParams)}`,
      }
    )

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
      return {
        status: 404,
        body: { error: 'No Stripe customer for this user' },
      }
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
