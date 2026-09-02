'use client'

import { initializeApp, getApps } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import type { FirebaseApp } from 'firebase/app'
import type { Auth } from 'firebase/auth'

// 環境変数の取得方法は web / mobile で異なるので、
// config を外部から受け取る形にする。
// React Native は initializeAuth + AsyncStorage 永続化が必要なため、
// Auth の生成もファクトリで差し替えられるようにする
export function initFirebase(
  config: {
    apiKey: string
    authDomain: string
    projectId: string
    storageBucket: string
    messagingSenderId: string
    appId: string
  },
  createAuth?: (app: FirebaseApp) => Auth
) {
  const existingApp = getApps()[0]
  const app = existingApp ?? initializeApp(config)

  // 2 回目以降は createAuth を呼ばない。
  // React Native の getReactNativePersistence() は呼ぶたびに別のクラスを返すため、
  // 初期化済みの app に対して initializeAuth を再度呼ぶと
  // auth/already-initialized で throw する（Fast Refresh や複数モジュールからの呼び出し）。
  // initializeAuth 済みの app に対する getAuth は、そのインスタンスを返す
  const auth = existingApp
    ? getAuth(app)
    : createAuth
      ? createAuth(app)
      : getAuth(app)

  return {
    app,
    auth,
    db: getFirestore(app),
  }
}
