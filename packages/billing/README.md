# @geckou/billing

Stripe / RevenueCat のサブスク権利判定・Webhook 処理。
実行環境（Cloud Functions / Next.js Route Handler）に依存しない。

```ts
import Stripe from 'stripe'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { createBilling } from '@geckou/billing'

const billing = createBilling({
  firestore: getFirestore(),
  auth: getAuth(),
  stripe: {
    client: new Stripe(process.env.STRIPE_SECRET_KEY!),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    allowedPriceIds: (process.env.STRIPE_PRICE_IDS ?? '').split(','),
    successUrl: process.env.STRIPE_SUCCESS_URL,
    cancelUrl: process.env.STRIPE_CANCEL_URL,
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL,
  },
  revenuecat: { webhookAuth: process.env.REVENUECAT_WEBHOOK_AUTH! },
  syncClaims: process.env.SYNC_SUBSCRIPTION_CLAIMS === 'true',
  onSubscriptionDowngraded: async (uid) => {
    // 無料プランの制限にデータを収める後始末をここに書く
  },
})

// Express（Cloud Functions）
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const result = await billing.handleStripeWebhook({ rawBody: req.body, headers: req.headers })
  res.status(result.status).json(result.body)
})

// Next.js Route Handler でも同じ
export async function POST(req: Request) {
  const result = await billing.handleStripeWebhook({
    rawBody: Buffer.from(await req.arrayBuffer()),
    headers: Object.fromEntries(req.headers),
  })
  return Response.json(result.body, { status: result.status })
}
```

### Checkout とプラン変更

`createCheckoutSession` は **新規契約のみ**を扱う。既に有効な購読を持つユーザーには
409 を返すので、プラン変更・解約・支払い方法の更新は `createPortalSession`
（Stripe カスタマーポータル）へ誘導する。Checkout は重複を防がないため、
有効なまま再度作らせると同一顧客に 2 本目のサブスクリプションが作られる。

権利判定だけなら factory 不要:

```ts
import { isSubscriptionActive, hasPlan } from '@geckou/billing'
```

## 設計方針

- `process.env` を読まない（設定は全て `createBilling` の config で注入）
- コレクション名は `collections` で差し替え可能（複数環境を 1 プロジェクトに相乗りさせる構成向け）
- `firebase-admin` / `stripe` は peerDependencies（利用側と同一インスタンスを共有する）
- Webhook は `{ rawBody, headers }` → `{ status, body }` の純粋な入出力
