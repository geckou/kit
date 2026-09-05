/**
 * FCM によるプッシュ通知の送信。
 *
 * Messaging インスタンスは利用側から注入する（`getMessaging()` の戻り値は
 * MessagingLike を満たす）。`firebase-admin` の型を直接使わないのは
 * auth-middleware.ts と同じ理由
 */

export type PushNotificationPayload = {
  title: string
  body: string
  data?: Record<string, string>
}

export type MessagingLike = {
  send(message: {
    token: string
    notification: { title: string; body: string }
    data?: Record<string, string>
  }): Promise<string>
  sendEachForMulticast(message: {
    tokens: string[]
    notification: { title: string; body: string }
    data?: Record<string, string>
  }): Promise<{
    successCount: number
    failureCount: number
    /** tokens と同じ順序で並ぶ個別の結果 */
    responses?: { success: boolean; error?: { code: string } }[]
  }>
}

/** firebase-admin が sendEachForMulticast に許す 1 回あたりのトークン数 */
const MAX_TOKENS_PER_REQUEST = 500

/**
 * 恒久的に届かないトークンのエラーコード。
 * 端末のアンインストールや再インストールで発生し、再送しても回復しない
 */
const INVALID_TOKEN_ERROR_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]

export type BatchPushResult = {
  successCount: number
  failureCount: number
  /** 保存先から削除すべきトークン（恒久的に失敗したもの） */
  invalidTokens: string[]
  /**
   * 送信そのものが失敗した分割チャンクのエラー。
   * 空でなければ、そのチャンクのトークンは結果に反映されていない
   */
  errors: unknown[]
}

/**
 * 単一デバイスにプッシュ通知を送信
 */
export async function sendPushNotification(
  messaging: MessagingLike,
  fcmToken: string,
  payload: PushNotificationPayload
): Promise<string> {
  return messaging.send({
    token: fcmToken,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
  })
}

/**
 * 複数デバイスにプッシュ通知を一括送信する。
 *
 * firebase-admin は 1 回のリクエストにつき 500 件までしか受け付けず、501 件以上を
 * 渡すと 1 件も送らずに throw する。ここで 500 件ずつに分割して送り、件数を合算する。
 *
 * 恒久的に失敗したトークン（アンインストール済み端末など）は invalidTokens で返す。
 * 呼び出し側で保存先から削除しないと溜まり続け、送信のたびに失敗数が増える。
 *
 * 途中のチャンクが throw しても、それまでの成功数と invalidTokens は返す。
 * 全体を巻き戻すと、呼び出し側が無効トークンを削除できず次回も同じ失敗を繰り返す。
 * 失敗したチャンクは failureCount に計上し、エラーは errors で返す。
 */
export async function sendPushNotificationBatch(
  messaging: MessagingLike,
  fcmTokens: string[],
  payload: PushNotificationPayload
): Promise<BatchPushResult> {
  const result: BatchPushResult = {
    successCount: 0,
    failureCount: 0,
    invalidTokens: [],
    errors: [],
  }

  for (
    let index = 0;
    index < fcmTokens.length;
    index += MAX_TOKENS_PER_REQUEST
  ) {
    const tokens = fcmTokens.slice(index, index + MAX_TOKENS_PER_REQUEST)

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
      })

      result.successCount += response.successCount
      result.failureCount += response.failureCount

      response.responses?.forEach((each, position) => {
        const code = each.error?.code

        if (!each.success && code && INVALID_TOKEN_ERROR_CODES.includes(code)) {
          result.invalidTokens.push(tokens[position])
        }
      })
    } catch (error) {
      result.failureCount += tokens.length
      result.errors.push(error)
      console.error(
        `Failed to send a push notification chunk (${tokens.length} tokens)`,
        error
      )
    }
  }

  return result
}
