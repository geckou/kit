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
  revenuecat: {
    webhookAuth: process.env.REVENUECAT_WEBHOOK_AUTH!,
    // develop 環境の Functions でのみ true にする（既定 false）
    allowSandbox: process.env.REVENUECAT_ALLOW_SANDBOX === 'true',
  },
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

### RevenueCat の環境

Webhook の `environment` が `SANDBOX` のイベントは、既定では**適用せず 200 を返す**。
TestFlight や開発ビルドが本番の Webhook URL を叩いたときに、サンドボックス購入で
本番の権利が付くのを防ぐため。開発環境の Functions では `allowSandbox: true` にする。

`TRANSFER`（権利が別の `app_user_id` へ移った）は、`transferred_from` の各ユーザーを
`expired` にする。移った先は後続の購入・更新イベントで `active` になる。

### Checkout とプラン変更

`createCheckoutSession` は **新規契約のみ**を扱う。既に有効な購読を持つユーザーには
409 を返すので、プラン変更・解約・支払い方法の更新は `createPortalSession`
（Stripe カスタマーポータル）へ誘導する。Checkout は重複を防がないため、
有効なまま再度作らせると同一顧客に 2 本目のサブスクリプションが作られる。

409 の判定と Checkout の作成の間にロックは無い（Firestore の読みと Stripe の
作成をまたぐため）。二重送信で判定を同時に通り抜けても Checkout が 2 本に
ならないよう、作成には `checkout_<uid>_<priceId>_<10 分の時間窓>` を
idempotencyKey として渡している。キャンセル後の作り直しは次の時間窓で通る。

権利判定だけなら factory 不要:

```ts
import { isSubscriptionActive, hasPlan } from '@geckou/billing'
```

**ブラウザ（クライアントコンポーネント）からはサブパスを使う。**
ルートは Webhook の署名検証で Node の `crypto` を読むため、バンドルに入ってしまう。

```ts
import { isSubscriptionActive } from '@geckou/billing/entitlement'
import type { Subscription } from '@geckou/billing/entitlement'
```

### 同一ユーザーが両経路で購入した場合

`users/{uid}.subscription` は 1 スロットしか持たないため、Stripe と RevenueCat の
購読は同じ場所を取り合う。Checkout の 409 は Stripe 側の重複しか防がず、
アプリ内課金（IAP）はゲートできないので、両方で購入された状態は起こりうる。

このとき**別経路からのダウングレード（有効 → 無効）は適用しない**。日時と
`sequence` だけで前後を決めると、Stripe が有効なまま IAP を買ったユーザーに後日
届く RevenueCat の `EXPIRATION` が Stripe の `active` を `expired` で上書きし、
`onSubscriptionDowngraded` まで呼ばれてしまうため。無視したイベントは
`applied: false` で記録し、警告をログに出す（`ApplyResult.status` は `stale`）。

**同じ経路のダウングレードと、経路をまたぐ有効 → 有効の切り替えは従来どおり適用する。**
経路ごとに権利を保持して OR を取る形にはしていない（`Subscription` の形が変わるため）。
両経路の購入を UI から防ぎたい場合は、IAP の購入画面側でも権利を確認すること。

## 設計方針

- `process.env` を読まない（設定は全て `createBilling` の config で注入）
- コレクション名は `collections` で差し替え可能（複数環境を 1 プロジェクトに相乗りさせる構成向け）
- `firebase-admin` / `stripe` は peerDependencies（利用側と同一インスタンスを共有する）
- Webhook は `{ rawBody, headers }` → `{ status, body }` の純粋な入出力
