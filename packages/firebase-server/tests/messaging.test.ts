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
    expect(result).toEqual({ successCount: 2, failureCount: 1 })
  })

  it('トークンが空なら送信せず 0 件を返す', async () => {
    const result = await sendPushNotificationBatch(messaging, [], payload)

    expect(sendEachForMulticast).not.toHaveBeenCalled()
    expect(result).toEqual({ successCount: 0, failureCount: 0 })
  })
})
