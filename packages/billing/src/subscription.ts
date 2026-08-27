import type { ResolvedConfig } from './config.js'
import { isSubscriptionActive, toDate } from './entitlement.js'
import type { ApplyResult, Subscription, SubscriptionEvent } from './types.js'

/**
 * 値が undefined のキーを取り除く。
 * Firestore は undefined を値として受け付けず書き込みが throw するため、
 * 任意項目（planId / currentPeriodEnd 等）が無いイベントでも安全に書けるようにする
 */
function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as T
}

/**
 * サブスクリプションイベントを users/{uid}.subscription に反映する。
 *
 * Webhook は再送されるため、以下をトランザクションで保証する:
 * - 同じ eventId を二重に適用しない（duplicate）
 * - 既に反映済みのイベントより古いイベントで上書きしない（stale）
 *
 * 反映が確定した後に、カスタムクレームの同期と権利変化フックを実行する。
 * これらはトランザクションの外で行う（時間がかかる処理を含みうるため）。
 */
export async function applySubscriptionEvent(
  config: ResolvedConfig,
  event: SubscriptionEvent
): Promise<ApplyResult> {
  const db = config.firestore
  const eventRef = db
    .collection(config.collectionNames.billingEvents)
    .doc(`${event.source}_${event.eventId}`)
  const userRef = db.collection(config.collectionNames.users).doc(event.uid)

  const next: Subscription = omitUndefined({
    ...event.subscription,
    updatedAt: new Date(),
    lastEventId: event.eventId,
    lastEventAt: event.occurredAt,
  })

  const result = await db.runTransaction<ApplyResult>(async (transaction) => {
    // Firestore のトランザクションは全ての read を write より先に行う必要がある
    const [eventSnapshot, userSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ])

    const current = userSnapshot.get('subscription') as Subscription | undefined
    const wasActive = isSubscriptionActive(current)

    if (eventSnapshot.exists) {
      return { status: 'duplicate', wasActive, isActive: wasActive }
    }

    const lastEventAt = toDate(current?.lastEventAt)
    const isStale =
      lastEventAt !== null && lastEventAt.getTime() > event.occurredAt.getTime()

    // stale でもイベント自体は記録して、再送のたびに読み直さないようにする
    transaction.set(eventRef, {
      source: event.source,
      eventId: event.eventId,
      uid: event.uid,
      occurredAt: event.occurredAt,
      applied: !isStale,
      processedAt: new Date(),
    })

    if (isStale) {
      return { status: 'stale', wasActive, isActive: wasActive }
    }

    // update ではなく set + mergeFields を使う（ドキュメント未作成時に throw するため）。
    // merge: true だと subscription マップが深いマージになり、今回のイベントに
    // 無いキー（例: 解約時の currentPeriodEnd）に前の値が残ってしまうため、
    // subscription フィールドはまるごと置き換える
    transaction.set(
      userRef,
      { subscription: next },
      { mergeFields: ['subscription'] }
    )

    return {
      status: 'applied',
      wasActive,
      isActive: isSubscriptionActive(next),
    }
  })

  if (result.status === 'applied') {
    await runPostApplyEffects(config, event.uid, next, result)
  }

  return result
}

/**
 * 反映確定後の副作用。
 *
 * ここでの失敗は Webhook を 500 にしない。権利状態（正）は既に Firestore に
 * 書き込み済みで、再送させても同じイベント ID は duplicate になるため。
 */
async function runPostApplyEffects(
  config: ResolvedConfig,
  uid: string,
  subscription: Subscription,
  result: ApplyResult
): Promise<void> {
  try {
    await syncSubscriptionClaims(config, uid, subscription)
  } catch (error) {
    console.error(`Failed to sync custom claims for ${uid}`, error)
  }

  try {
    if (!result.wasActive && result.isActive) {
      await config.onSubscriptionUpgraded?.(uid, subscription)
    } else if (result.wasActive && !result.isActive) {
      await config.onSubscriptionDowngraded?.(uid, subscription)
    }
  } catch (error) {
    console.error(`Entitlement hook failed for ${uid}`, error)
  }
}

/**
 * 権利状態を Firebase Auth のカスタムクレームに同期する。
 *
 * **正は Firestore の users/{uid}.subscription。**クレームはあくまで
 * セキュリティルールから Firestore の get() なしで参照するためのコピー。
 *
 * ルール側ではこう書ける:
 *   allow write: if request.auth.token.subscriptionActive == true;
 *
 * 注意: クレームは ID トークンが更新されるまで最大1時間反映されない。
 * 購入直後に反映させたい場合はクライアント側で getIdToken(true) を呼ぶこと。
 */
export async function syncSubscriptionClaims(
  config: ResolvedConfig,
  uid: string,
  subscription: Subscription
): Promise<void> {
  if (!config.syncClaims) return

  const auth = config.auth
  if (!auth) {
    throw new Error('syncClaims が有効ですが、config.auth が渡されていません')
  }

  // setCustomUserClaims は既存クレームを丸ごと置き換えるため、
  // 他のクレーム（role 等）を消さないよう既存値にマージする
  const existingClaims = (await auth.getUser(uid)).customClaims ?? {}

  await auth.setCustomUserClaims(uid, {
    ...existingClaims,
    subscriptionActive: isSubscriptionActive(subscription),
    plan: subscription.planId ?? null,
  })
}

/** Stripe の顧客 ID をユーザーに保存する（サーバーのみ書き込み可） */
export async function saveStripeCustomerId(
  config: ResolvedConfig,
  uid: string,
  stripeCustomerId: string
): Promise<void> {
  await config.firestore
    .collection(config.collectionNames.users)
    .doc(uid)
    .set({ stripeCustomerId }, { merge: true })
}

/** ユーザーに保存済みの Stripe 顧客 ID を取得する */
export async function getStripeCustomerId(
  config: ResolvedConfig,
  uid: string
): Promise<string | undefined> {
  const snapshot = await config.firestore
    .collection(config.collectionNames.users)
    .doc(uid)
    .get()

  return snapshot.get('stripeCustomerId') as string | undefined
}
