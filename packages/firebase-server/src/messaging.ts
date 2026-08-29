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
  }): Promise<{ successCount: number; failureCount: number }>
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
 * 複数デバイスにプッシュ通知を一括送信
 */
export async function sendPushNotificationBatch(
  messaging: MessagingLike,
  fcmTokens: string[],
  payload: PushNotificationPayload
): Promise<{ successCount: number; failureCount: number }> {
  if (fcmTokens.length === 0) {
    return { successCount: 0, failureCount: 0 }
  }

  const response = await messaging.sendEachForMulticast({
    tokens: fcmTokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
  })

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
  }
}
