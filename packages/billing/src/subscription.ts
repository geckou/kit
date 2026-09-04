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
 * 別経路（Stripe ↔ RevenueCat）のイベントで、生きているスロットを奪ってよいか。
 *
 * users/{uid}.subscription は 1 スロットしかなく、両方の経路で購入されると
 * そこを取り合う。日時と sequence だけで前後を決めると、次の 2 通りで
 * 生きている権利が消える:
 *
 *   1. 別経路の失効が直接上書きする
 *      Stripe active → RevenueCat EXPIRATION（occurredAt が新しい）
 *   2. 別経路の「まだ有効」がスロットを奪い、その後で同一経路の失効が通る
 *      Stripe active → RevenueCat CANCELLATION（有効）→ RevenueCat EXPIRATION
 *
 * どちらも「今の権利より弱いものに置き換わる」のが原因なので、
 * 別経路の書き込みは **今より強いとき** だけ通す。
 */
function acceptsCrossSourceTakeover(
  current: Subscription,
  next: Subscription
): boolean {
  // 無効になるなら、生きている権利のほうが正
  if (!isSubscriptionActive(next)) return false

  const currentEnd = toDate(current.currentPeriodEnd)
  const nextEnd = toDate(next.currentPeriodEnd)

  // 期限を持たない active は「いつまで有効か分からない」。強弱を決められないので、
  // 現状維持に倒す（next だけが期限を持たない場合は next のほうが強いと見なす）
  if (nextEnd === null) return currentEnd !== null
  if (currentEnd === null) return false

  return nextEnd.getTime() > currentEnd.getTime()
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

  const sequence = event.sequence ?? 0

  const next: Subscription = omitUndefined({
    ...event.subscription,
    updatedAt: new Date(),
    lastEventId: event.eventId,
    lastEventAt: event.occurredAt,
    lastEventSequence: sequence,
  })

  // トランザクションは再試行されうるので、警告は確定後に 1 回だけ出す
  let crossSourceBlocked = false

  const result = await db.runTransaction<ApplyResult>(async (transaction) => {
    crossSourceBlocked = false

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
    const lastSequence = current?.lastEventSequence ?? 0

    // lastEventAt / lastEventSequence は「同じ経路の中での順序制御」用。
    // Stripe と RevenueCat のイベントは因果関係が無く時計も別なので、経路をまたいで
    // 比較すると、遅れて届いた別経路の強い権利が stale として落ちてしまう。
    // 経路が違うときの採否は acceptsCrossSourceTakeover だけで決める
    // （source を持たない古いデータは経路が分からないので、同一経路として扱う）
    const isSameSource =
      current?.source === undefined || current.source === event.source

    // 同じ occurredAt のときは sequence で前後を決める。
    // Stripe の event.created は秒精度で配信順も保証されないため、日時の比較だけだと
    // 後から届いた created(incomplete) が updated(active) を上書きしてしまう
    const isOlderThanWatermark =
      lastEventAt !== null &&
      (lastEventAt.getTime() > event.occurredAt.getTime() ||
        (lastEventAt.getTime() === event.occurredAt.getTime() &&
          sequence < lastSequence))

    const isStale = isSameSource && isOlderThanWatermark

    // 別経路の書き込みは、今より強いときだけ通す（→ acceptsCrossSourceTakeover）。
    // 透かしより古い別経路のイベントは、期限が今より先へ伸びるものに限って認める。
    // 既に終わった期間の active を後から適用すると、status === 'active' は
    // 日時を見ずに有効扱いされる（isSubscriptionActive）ため、失効済みの権利が
    // 遅延した再送 1 通で恒久的に復活してしまう
    const nextPeriodEnd = toDate(next.currentPeriodEnd)
    const extendsIntoFuture =
      nextPeriodEnd !== null && nextPeriodEnd.getTime() > Date.now()

    const acceptsTakeover =
      current !== undefined &&
      acceptsCrossSourceTakeover(current, next) &&
      (!isOlderThanWatermark || extendsIntoFuture)

    // source を持たない古いデータは経路が分からないので対象外にする
    // （wasActive だけを条件にすると、現在の権利が無効なときに別経路の古い
    //  イベントが順序も強さも見られずに通ってしまう）
    crossSourceBlocked =
      current?.source !== undefined &&
      current.source !== event.source &&
      (wasActive || isOlderThanWatermark) &&
      !acceptsTakeover

    const skip = isStale || crossSourceBlocked

    // 適用しない場合でもイベント自体は記録して、再送のたびに読み直さないようにする
    transaction.set(eventRef, {
      source: event.source,
      eventId: event.eventId,
      uid: event.uid,
      occurredAt: event.occurredAt,
      applied: !skip,
      processedAt: new Date(),
    })

    if (skip) {
      return {
        status: crossSourceBlocked ? 'ignored' : 'stale',
        wasActive,
        isActive: wasActive,
      }
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

  if (crossSourceBlocked) {
    console.warn(
      'Ignored a cross-source subscription event that is not stronger than the current one; the active entitlement was kept',
      { uid: event.uid, eventSource: event.source, eventId: event.eventId }
    )
  }

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
