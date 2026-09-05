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
    // 未設定のときに [''] にならないよう filter(Boolean) を通す
    allowedPriceIds: (process.env.STRIPE_PRICE_IDS ?? '')
      .split(',')
      .filter(Boolean),
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
// Functions Framework が自前のハンドラより前に JSON をパースするため、
// 後段の express.raw() はスキップされ req.body はオブジェクトになる。
// 署名検証に使える生のボディは req.rawBody にしか無い。
// express.raw() は Functions Framework を介さない素の Express 用の保険として
// 残し、express.json() より前に置く
const rawBodyOf = (req: express.Request) =>
  (req as express.Request & { rawBody?: Buffer | string }).rawBody ??
  (req.body as Buffer)

app.post('/webhooks/stripe', express.raw({ type: '*/*' }), async (req, res) => {
  const result = await billing.handleStripeWebhook({
    rawBody: rawBodyOf(req),
    headers: req.headers,
  })
  res.status(result.status).json(result.body)
})

// RevenueCat も同じ（生のボディを JSON.parse するため、req.rawBody が要る）
app.post(
  '/webhooks/revenuecat',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    const result = await billing.handleRevenueCatWebhook({
      rawBody: rawBodyOf(req),
      headers: req.headers,
    })
    res.status(result.status).json(result.body)
  }
)

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
    // source は返さない（型が Omit<..., 'source'>。実装側で 'revenuecat' を入れる）
    return { status: 'active', planId: entitlement.id }
  },
}
```

移動先の取得に失敗しても Webhook は 200 を返す（移動元の失効は確定させたいため）。
未設定なら警告のみで、従来どおり後続イベント待ちになる。

**`app_user_id` は Firebase の uid にすること。** Webhook が書き込む先は
`users/{app_user_id}` で、`Purchases.logIn(uid)` していない匿名 ID のままだと
`users/$RCAnonymousID:...` が作られ、そのユーザーの権利はどこからも参照されない。

`app_user_id` はクライアントが自由に決められる値なので、Firestore の
ドキュメント ID にできない値（`/` を含む・`.` / `..`・`__x__` の形・1500 バイト超）は
**400 で弾く**。そのまま `doc()` に渡すと同期 throw して 500 になり、
RevenueCat が再送を繰り返すため。

### Checkout とプラン変更

`createCheckoutSession` は **新規契約のみ**を扱う。既に有効な購読を持つユーザーには
409 を返すので、プラン変更・解約・支払い方法の更新は `createPortalSession`
（Stripe カスタマーポータル）へ誘導する。Checkout は重複を防がないため、
有効なまま再度作らせると同一顧客に 2 本目のサブスクリプションが作られる。

409 の判定と Checkout の作成の間にロックは無い（Firestore の読みと Stripe の
作成をまたぐため）。二重送信で判定を同時に通り抜けても Checkout が 2 本に
ならないよう、作成には `checkout:<uid>:<10 分の時間窓>:<パラメータの指紋>` を
idempotencyKey として渡している。キャンセル後の作り直しは次の時間窓で通る。

指紋（作成パラメータの SHA-256 の先頭 16 桁）を混ぜているのは、**同じキーに
異なるパラメータを送ると Stripe が `idempotency_error`（400）を返し、そのキーが
24 時間残る**ため。顧客 ID が変わった直後などにこれを踏むと、利用者には 500 が
返り続ける。顧客の作成キー（`customer_<uid>_<パラメータの指紋>`）も同じ理由で
指紋を含む。

⚠️ **時間窓の境界をまたいだ二重送信は取りこぼす。** Firestore のロックではなく
確率的な防御なので、確実性が要るなら利用側でボタンを無効化すること。

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
- イベント側が `active` で期限を持たず（買い切り等の無期限）、今の権利は期限を持つ

期限を持たない `in_grace_period` / `cancelled` は「無期限」ではなく、単に期限
フィールドが欠けているだけの可能性がある。これを最強として扱うと、期限を持たない
`BILLING_ISSUE` が生きている権利のスロットを奪い、直後の `EXPIRATION` で権利が消える。

日時と `sequence` だけで前後を決めると、次の 2 通りで生きている権利が消える。

1. Stripe `active` → RevenueCat `EXPIRATION`（`occurredAt` が新しい）が直接上書きする
2. Stripe `active` → RevenueCat `CANCELLATION`（まだ有効なのでスロットを奪う）
   → RevenueCat `EXPIRATION`（同一経路なので通る）

無視したイベントは `applied: false` で記録し、警告をログに出す
（`ApplyResult.status` は `'ignored'`）。

### 反映後の副作用と再送

カスタムクレームの同期と権利変化フック（`onSubscriptionUpgraded` /
`onSubscriptionDowngraded`）は、Firestore への反映が確定した後に実行する。
ここで失敗した場合は **`ApplyResult.effectsPending` が true になり、Webhook ハンドラは
503 を返す**。200 を返すとプロバイダは配信成功と見なして再送せず、失敗した副作用が
二度と実行されないため。権利状態そのものは書き込み済みなので、再送は `'duplicate'`
として扱われ、**失敗した種類（`billing_events/{id}.failedEffects`）だけがやり直される**。
成功済みのフックは二度呼ばれない。

再送の判定に使う遷移（`wasActive` / `isActive`）は初回適用時の値をイベント側に残して使う。
現在の状態から計算し直すと、期限付きの権利が切れた後の再送で「無効 → 無効」に見え、
失敗したままのフックが呼ばれない。

同じイベントが**並行して**届く場合に備えて、副作用の実行権（`effectsClaimedAt`、60 秒）を
トランザクションの中で取る。先に取った側だけが実行し、実行中にプロセスが落ちても
期限切れで次の再送が引き継ぐ。

現在の `subscription.lastEventId` がそのイベントでなくなっている場合
（後続のイベントが既にスロットを上書きしている場合）はやり直さず、完了として記録する。
古い状態でクレームを書き戻さないため。

> フックが恒久的に失敗する（実装のバグ等）と、プロバイダの再送が続く。
> ログ（`post-apply effects failed`）を監視して、原因側を直すこと。

**同じ経路の遷移は従来どおり全て適用する。** 経路ごとに権利を保持して OR を取る形には
していない（`Subscription` の形が変わるため）。両経路の購入を UI から防ぎたい場合は、
IAP の購入画面側でも権利を確認すること。

### 0.6.0 の変更

- `ApplyResult` に `effectsPending` が増えた。反映後の副作用が失敗したことを表す
  （Webhook ハンドラはこれを見て 503 を返す）。`ApplyResult` を自分で組み立てている
  コードは追従が要る
- 副作用の再実行に実行権（`billing_events/{id}.effectsClaimedAt`）を使う
- `TRANSFER` の派生イベント ID が `<eventId>:from:<app_user_id のハッシュ>` になった
  （長い `app_user_id` でドキュメント ID の上限を超えないようにするため）。
  この変更より前に処理した TRANSFER は、再送されると 1 度だけ再適用されうる

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
import { toDate, type Subscription } from '@geckou/billing'

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
