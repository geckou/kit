import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  sendPushNotification,
  sendPushNotificationBatch,
  type MessagingLike,
} from '../src/messaging'

const send = vi.fn()
const sendEachForMulticast = vi.fn()
const messaging: MessagingLike = { send, sendEachForMulticast }

const payload = {
  title: 'タイトル',
  body: '本文',
  data: { screen: 'home' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendPushNotification', () => {
  it('トークンとペイロードからメッセージを組み立てて送信する', async () => {
    send.mockResolvedValueOnce('message-id-1')

    const result = await sendPushNotification(messaging, 'fcm-token', payload)

    expect(send).toHaveBeenCalledWith({
      token: 'fcm-token',
      notification: { title: 'タイトル', body: '本文' },
      data: { screen: 'home' },
    })
    expect(result).toBe('message-id-1')
  })

  it('data を省略できる', async () => {
    send.mockResolvedValueOnce('message-id-2')

    await sendPushNotification(messaging, 'fcm-token', {
      title: 'タイトル',
      body: '本文',
    })

    expect(send).toHaveBeenCalledWith({
      token: 'fcm-token',
      notification: { title: 'タイトル', body: '本文' },
      data: undefined,
    })
  })
})

describe('sendPushNotificationBatch', () => {
  it('複数トークンに一括送信して成功・失敗数を返す', async () => {
    sendEachForMulticast.mockResolvedValueOnce({
      successCount: 2,
      failureCount: 1,
    })

    const result = await sendPushNotificationBatch(
      messaging,
      ['token-1', 'token-2', 'token-3'],
      payload
    )

    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ['token-1', 'token-2', 'token-3'],
      notification: { title: 'タイトル', body: '本文' },
      data: { screen: 'home' },
    })
    expect(result).toEqual({
      successCount: 2,
      failureCount: 1,
      invalidTokens: [],
      errors: [],
    })
  })

  it('トークンが空なら送信せず 0 件を返す', async () => {
    const result = await sendPushNotificationBatch(messaging, [], payload)

    expect(sendEachForMulticast).not.toHaveBeenCalled()
    expect(result).toEqual({
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
      errors: [],
    })
  })

  // 回帰: 501 件以上を渡すと firebase-admin が 1 件も送らずに throw していた
  it('500 件ずつに分割して送り、件数を合算する', async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `token-${i}`)

    sendEachForMulticast
      .mockResolvedValueOnce({ successCount: 500, failureCount: 0 })
      .mockResolvedValueOnce({ successCount: 1, failureCount: 0 })

    const result = await sendPushNotificationBatch(messaging, tokens, payload)

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2)
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500)
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toEqual(['token-500'])
    expect(result).toEqual({
      successCount: 501,
      failureCount: 0,
      invalidTokens: [],
      errors: [],
    })
  })

  // 回帰: responses を捨てていたため、恒久的に失敗するトークンを
  // 呼び出し側が掃除できず溜まり続けていた
  it('恒久的に失敗したトークンを invalidTokens で返す', async () => {
    sendEachForMulticast.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    })

    const result = await sendPushNotificationBatch(
      messaging,
      ['token-1', 'token-2', 'token-3'],
      payload
    )

    // 一時的なエラー（internal-error）は削除対象にしない
    expect(result.invalidTokens).toEqual(['token-2'])
  })

  // 回帰: 途中のチャンクが throw すると、それ以前の成功数と invalidTokens が
  // 呼び出し側に返らず、無効トークンを掃除できないまま次回も同じ失敗を繰り返していた
  it('途中のチャンクが失敗しても、それ以外の結果を返す', async () => {
    const tokens = Array.from({ length: 1001 }, (_, i) => `token-${i}`)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('FCM unavailable')

    sendEachForMulticast
      .mockResolvedValueOnce({
        successCount: 499,
        failureCount: 1,
        responses: [
          ...Array.from({ length: 499 }, () => ({ success: true })),
          {
            success: false,
            error: { code: 'messaging/registration-token-not-registered' },
          },
        ],
      })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ successCount: 1, failureCount: 0 })

    const result = await sendPushNotificationBatch(messaging, tokens, payload)

    expect(sendEachForMulticast).toHaveBeenCalledTimes(3)
    expect(result.successCount).toBe(500)
    // 失敗したチャンクの 500 件 + 1 件目の個別失敗
    expect(result.failureCount).toBe(501)
    expect(result.invalidTokens).toEqual(['token-499'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toBe(failure)
    // 失敗したチャンクのトークンだけを再送できる
    expect(result.errors[0].tokens).toHaveLength(500)
    expect(result.errors[0].tokens[0]).toBe('token-500')

    errorSpy.mockRestore()
  })
})
