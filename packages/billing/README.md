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
`expired` にする。

**移動先は TRANSFER のペイロードだけでは決まらない**（期限も entitlement も乗らない）。
何もしないと次の購入・更新イベントまで「未購読」扱いのままで、年額なら最長 1 年かかる。
Restore の既定（Transfer to new App User ID）で普通に起きる導線なので、
`revenuecat.fetchSubscriber` を設定して現在の権利を取り直すこと。

```ts
revenuecat: {
  webhookAuth: process.env.REVENUECAT_WEBHOOK_AUTH!,
  // GET /subscribers/{app_user_id} などで今の権利を取り、反映する内容を返す
  fetchSubscriber: async (appUserId) => {
    const entitlement = await fetchEntitlementFromRevenueCat(appUserId)
    if (!entitlement) return null
    return { status: 'active', source: 'revenuecat', planId: entitlement.id }
  },
}
```

移動先の取得に失敗しても Webhook は 200 を返す（移動元の失効は確定させたいため）。
未設定なら警告のみで、従来どおり後続イベント待ちになる。

**`app_user_id` は Firebase の uid にすること。** Webhook が書き込む先は
`users/{app_user_id}` で、`Purchases.logIn(uid)` していない匿名 ID のままだと
`users/$RCAnonymousID:...` が作られ、そのユーザーの権利はどこからも参照されない。

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

このとき**別経路の書き込みは「今より強いとき」だけ通す**。具体的には、現在の権利が
有効で、かつイベントの経路が違う場合、次のどれかを満たさないと適用しない。

- 反映後も有効で、`currentPeriodEnd` が今より後ろへ伸びる
- 反映後も有効で、今は期限を持つがイベント側は期限を持たない（無期限とみなす）

日時と `sequence` だけで前後を決めると、次の 2 通りで生きている権利が消える。

1. Stripe `active` → RevenueCat `EXPIRATION`（`occurredAt` が新しい）が直接上書きする
2. Stripe `active` → RevenueCat `CANCELLATION`（まだ有効なのでスロットを奪う）
   → RevenueCat `EXPIRATION`（同一経路なので通る）

無視したイベントは `applied: false` で記録し、警告をログに出す
（`ApplyResult.status` は `'ignored'`）。

**同じ経路の遷移は従来どおり全て適用する。** 経路ごとに権利を保持して OR を取る形には
していない（`Subscription` の形が変わるため）。両経路の購入を UI から防ぎたい場合は、
IAP の購入画面側でも権利を確認すること。

### 0.3.0 の破壊的変更

- `Subscription` の日時（`currentPeriodEnd` / `lastEventAt` / `updatedAt`）が
  `Date` から `DateLike` になった。読み出した値を `Date` として使っていた箇所は
  `toDate()` を通す（→「日時の型」）
- `ApplyStatus` に `'ignored'` が増えた。`status` を網羅的に分岐している箇所は追従する
- 経路をまたぐイベントの扱いが変わった（→「同一ユーザーが両経路で購入した場合」）

### 日時の型（Date と Timestamp）

`Subscription` の日時（`currentPeriodEnd` / `lastEventAt` / `updatedAt`）は
書き込むときは `Date` だが、`users/{uid}.subscription` を Firestore から読み出すと
`Timestamp` になる。公開型は両方を受ける `DateLike` にしてあるので、
**値を使うときは export 済みの `toDate()` を通すこと**。

```ts
import { toDate, type Subscription } from '@geckou/billing/entitlement'

const subscription = snapshot.get('subscription') as Subscription | undefined
const periodEnd = toDate(subscription?.currentPeriodEnd) // Date | null
```

## 設計方針

- **`users/{uid}.subscription` / `stripeCustomerId` / `billing_events` はサーバー専用の
  書き込みにすること。** Checkout の 409 判定・権利変化の検出・`isSubscriptionActive` は
  全てこの値を信用する。クライアントから `subscription` を書けるセキュリティルールだと、
  ユーザーが自分で権利を付与できる（project-starter の `firestore.rules` は
  これらを read-only にしている）
- `process.env` を読まない（設定は全て `createBilling` の config で注入）
- コレクション名は `collections` で差し替え可能（複数環境を 1 プロジェクトに相乗りさせる構成向け）
- `firebase-admin` は peerDependencies（Firestore / Auth のインスタンスを注入して使うため、
  利用側と同一インスタンスを共有する必要がある）。`stripe` は optional peer で、
  型は `StripeClientLike` として構造的に要求するだけなので、RevenueCat だけの構成では入れなくてよい
- Webhook は `{ rawBody, headers }` → `{ status, body }` の純粋な入出力
