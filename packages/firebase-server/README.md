# @geckou/firebase-server

サーバーサイド（Cloud Functions 等）向けの Firebase ヘルパー。
Firebase Auth の ID トークンを検証する Express 互換ミドルウェアと、FCM によるプッシュ通知送信を提供する。

`firebase-admin` / `express` は依存に**持たない**。インスタンスは利用側から注入し、
型は使用するメソッドだけを構造的に要求する（`TokenVerifierLike` / `MessagingLike`）。
peer の型を公開 API に使うとメジャーバージョン間の型定義の差が利用側の型エラーになるため
（`@geckou/billing` の `StripeClientLike` と同じ扱い）。`getAuth()` / `getMessaging()` の
戻り値はそのまま渡せる。

## インストール

```bash
yarn add @geckou/firebase-server
```

`firebase-admin` は利用側のプロジェクトが持っている前提（Cloud Functions なら必ずある）。

## 認証ミドルウェア

```ts
import { createRequireAuth } from '@geckou/firebase-server'
import { getAuth } from 'firebase-admin/auth'

// ゲッターで渡すと Auth の解決がリクエスト時まで遅延されるため、
// initializeApp() より先にミドルウェアを定義しても安全
export const requireAuth = createRequireAuth(getAuth)
```

```ts
import type { Request } from 'express'

app.get('/me', requireAuth, (req, res) => {
  // 検証に成功すると req.uid に uid が入る
  const { uid } = req as Request & { uid: string }
  res.json({ uid })
})
```

`Authorization: Bearer <ID トークン>` を検証し、トークンが無い・不正な場合は
`401 { "error": "Unauthorized" }` を返してハンドラへ進まない。

## プッシュ通知（FCM）

```ts
import {
  sendPushNotification,
  sendPushNotificationBatch,
} from '@geckou/firebase-server'
import { getMessaging } from 'firebase-admin/messaging'

// 単一デバイス
await sendPushNotification(getMessaging(), fcmToken, {
  title: '新着メッセージ',
  body: '○○さんからメッセージが届きました',
  data: { screen: 'chat' },
})

// 複数デバイス（トークンが空配列なら送信せず { 0, 0 } を返す）
const { successCount, failureCount } = await sendPushNotificationBatch(
  getMessaging(),
  fcmTokens,
  { title: 'お知らせ', body: '本文' }
)
```

モバイル側の受信（権限リクエスト・トークン取得）はこのパッケージの対象外。
テンプレートの `apps/mobile/src/lib/push-notifications.ts`（expo-notifications）が担当する。
