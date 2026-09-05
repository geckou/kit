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
 * 副作用（クレーム同期・権利変化フック）の実行権の有効時間。
 *
 * 同じイベントが並行して届くと、両方が「副作用が未完了」を見て同じフックを
 * 二度呼びうる。トランザクションの中で実行権を取り、この時間内は他を通さない。
 * 実行中にプロセスが落ちても、期限が切れれば次の再送が引き継げる
 */
const EFFECTS_LEASE_MS = 60_000

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
  // 現状維持に倒す（next だけが期限を持たない場合は next のほうが強いと見なす）。
  // 「期限なし = 無期限」と見なしてよいのは active だけ。猶予期間・解約済みは
  // 期限フィールドが欠けているだけの可能性があり、それを最強として扱うと
  // 期限を持たない BILLING_ISSUE が生きている権利のスロットを奪ってしまう
  if (nextEnd === null) return next.status === 'active' && currentEnd !== null
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

  // 副作用が未完了のまま残っているイベントの再送を拾うための持ち出し
  // （→ runPostApplyEffects のコメント）
  let pendingEffects: {
    subscription: Subscription
    result: ApplyResult
    only: EffectName[]
  } | null = null
  let effectsSuperseded = false

  const result = await db.runTransaction<ApplyResult>(async (transaction) => {
    crossSourceBlocked = false
    pendingEffects = null
    effectsSuperseded = false

    // Firestore のトランザクションは全ての read を write より先に行う必要がある
    const [eventSnapshot, userSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ])

    const current = userSnapshot.get('subscription') as Subscription | undefined
    const wasActive = isSubscriptionActive(current)

    if (eventSnapshot.exists) {
      // 副作用（クレーム同期・権利変化フック）が未完了なら、再送で実行し直す。
      // duplicate として素通しすると、一度失敗した副作用は二度と実行されず、
      // セキュリティルールが参照するクレームが古いまま残る
      if (
        eventSnapshot.get('applied') === true &&
        // このフィールドを持たないのは、この仕組みより前に記録されたイベント。
        // 副作用の成否が分からないので、再実行はしない
        eventSnapshot.get('effectsCompleted') === false
      ) {
        // 並行して届いた再送が同じフックを二度呼ばないよう、実行権を取る。
        // トランザクションの中で見るので、先に取った側だけが通る
        const claimedAt = toDate(eventSnapshot.get('effectsClaimedAt'))
        const claimIsLive =
          claimedAt !== null &&
          Date.now() - claimedAt.getTime() < EFFECTS_LEASE_MS

        if (!claimIsLive) {
          if (current !== undefined && current.lastEventId === event.eventId) {
            pendingEffects = {
              subscription: current,
              result: {
                status: 'applied',
                // 初回適用時の遷移をそのまま使う。ここで計算し直すと、
                // 期限付きの権利が切れた後の再送で「無効 → 無効」に見え、
                // 失敗したままの upgrade / downgrade フックが呼ばれない
                wasActive: eventSnapshot.get('wasActive') === true,
                isActive: eventSnapshot.get('isActive') === true,
                effectsPending: false,
              },
              // 失敗したものだけをやり直す（成功済みのフックを二度呼ばない）
              only: toEffectNames(eventSnapshot.get('failedEffects')),
            }
          } else {
            // 後続のイベントが既にスロットを上書きしている。古い状態で
            // クレームを書き戻さない（後続イベントの副作用は、そのイベント
            // 自身の effectsCompleted で追跡される）
            effectsSuperseded = true
          }

          transaction.set(
            eventRef,
            { effectsClaimedAt: new Date() },
            { merge: true }
          )
        }
      }

      return {
        status: 'duplicate',
        wasActive,
        isActive: wasActive,
        effectsPending: false,
      }
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
    // 透かしより古い別経路のイベントは、期限が「既に過ぎている」ものだけ弾く。
    // 終わった期間の active を後から適用すると、status === 'active' は日時を
    // 見ずに有効扱いされる（isSubscriptionActive）ため、失効済みの権利が
    // 遅延した再送 1 通で恒久的に復活してしまう。
    // 期限を持たない active（買い切り・NON_RENEWING_PURCHASE 等）は
    // acceptsCrossSourceTakeover が「有限期限より強い」と決めているので、
    // ここで弾かない（弾くと正当な無期限の権利が ignored になる）
    const nextPeriodEnd = toDate(next.currentPeriodEnd)
    const isExpiredPeriod =
      nextPeriodEnd !== null && nextPeriodEnd.getTime() <= Date.now()

    const acceptsTakeover =
      current !== undefined &&
      acceptsCrossSourceTakeover(current, next) &&
      (!isOlderThanWatermark || !isExpiredPeriod)

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
    const nextIsActive = isSubscriptionActive(next)

    transaction.set(eventRef, {
      source: event.source,
      eventId: event.eventId,
      uid: event.uid,
      occurredAt: event.occurredAt,
      applied: !skip,
      // 副作用はトランザクションの外で実行する。失敗したまま終わったものを
      // 再送で拾い直すため、完了したかどうかをイベント側に残す
      // （適用しないイベントには副作用が無いので完了扱い）
      effectsCompleted: skip,
      // 実行権。これから副作用を実行する間、並行する再送を通さない
      effectsClaimedAt: skip ? null : new Date(),
      // 再送で副作用をやり直すときに使う、初回適用時の遷移
      wasActive,
      isActive: skip ? wasActive : nextIsActive,
      processedAt: new Date(),
    })

    if (skip) {
      return {
        status: crossSourceBlocked ? 'ignored' : 'stale',
        wasActive,
        isActive: wasActive,
        effectsPending: false,
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
      isActive: nextIsActive,
      effectsPending: false,
    }
  })

  if (crossSourceBlocked) {
    console.warn(
      'Ignored a cross-source subscription event that is not stronger than the current one; the active entitlement was kept',
      { uid: event.uid, eventSource: event.source, eventId: event.eventId }
    )
  }

  let effectsPending = false

  if (result.status === 'applied') {
    const failed = await runPostApplyEffects(config, event.uid, next, result)
    await recordEffectsResult(eventRef, failed)
    effectsPending = failed.length > 0
  } else if (pendingEffects !== null) {
    const retried: {
      subscription: Subscription
      result: ApplyResult
      only: EffectName[]
    } = pendingEffects
    const failed = await runPostApplyEffects(
      config,
      event.uid,
      retried.subscription,
      retried.result,
      retried.only
    )
    await recordEffectsResult(eventRef, failed)
    effectsPending = failed.length > 0
  } else if (effectsSuperseded) {
    await recordEffectsResult(eventRef, [])
  }

  // 副作用が未完了のまま 200 を返すと、プロバイダは配信成功と見なして
  // 再送しない = 二度と実行されない。呼び出し側（Webhook ハンドラ）が
  // 5xx を返せるように伝える
  return { ...result, effectsPending }
}

/** 副作用の種類。失敗したものだけを再送でやり直すために名前で持つ */
type EffectName = 'claims' | 'hook'

const ALL_EFFECTS: EffectName[] = ['claims', 'hook']

function toEffectNames(value: unknown): EffectName[] {
  if (!Array.isArray(value)) return ALL_EFFECTS

  const names = value.filter((name): name is EffectName =>
    ALL_EFFECTS.includes(name as EffectName)
  )

  return names.length > 0 ? names : ALL_EFFECTS
}

/**
 * 副作用の実行結果をイベント側に記録する。
 * ここでの失敗は次の再送でまた拾えるので、ログだけ残して握り潰す
 */
async function recordEffectsResult(
  eventRef: {
    set: (
      data: Record<string, unknown>,
      options: { merge: boolean }
    ) => Promise<unknown>
  },
  failed: EffectName[]
): Promise<void> {
  try {
    await eventRef.set(
      {
        effectsCompleted: failed.length === 0,
        failedEffects: failed,
        // 実行権を返す。失敗した場合も次の再送がすぐ引き継げるようにする
        effectsClaimedAt: null,
      },
      { merge: true }
    )
  } catch (error) {
    console.error('Failed to record billing event effects', error)
  }
}

/**
 * 反映確定後の副作用。失敗したものの名前を返す。
 *
 * ここでの失敗は Webhook を 500 にしない。権利状態（正）は既に Firestore に
 * 書き込み済みだから。ただし失敗したまま終わると、クレーム同期や
 * onSubscriptionDowngraded が欠けた状態が残るため、失敗した種類を
 * イベント側に残し、次の再送でそれだけをやり直す
 * （→ applySubscriptionEvent の duplicate 経路）。
 */
async function runPostApplyEffects(
  config: ResolvedConfig,
  uid: string,
  subscription: Subscription,
  result: ApplyResult,
  only: EffectName[] = ALL_EFFECTS
): Promise<EffectName[]> {
  const failed: EffectName[] = []

  if (only.includes('claims')) {
    try {
      await syncSubscriptionClaims(config, uid, subscription)
    } catch (error) {
      failed.push('claims')
      console.error(`Failed to sync custom claims for ${uid}`, error)
    }
  }

  if (only.includes('hook')) {
    try {
      if (!result.wasActive && result.isActive) {
        await config.onSubscriptionUpgraded?.(uid, subscription)
      } else if (result.wasActive && !result.isActive) {
        await config.onSubscriptionDowngraded?.(uid, subscription)
      }
    } catch (error) {
      failed.push('hook')
      console.error(`Entitlement hook failed for ${uid}`, error)
    }
  }

  return failed
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
