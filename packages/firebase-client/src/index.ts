'use client'

import { initializeApp, getApps } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import type { FirebaseApp } from 'firebase/app'
import type { Auth } from 'firebase/auth'

/**
 * createAuth を使って Auth を生成した app。
 *
 * 2 回目以降の呼び出しで「永続化付きのつもりが getAuth の Auth が返っている」
 * 食い違いを検知するためだけに持つ。app に紐付けるので、
 * テストで app を作り直せば記録も一緒に消える
 */
const appsWithCustomAuth = new WeakSet<FirebaseApp>()

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

  // 既存アプリを無条件に再利用するため、渡した config が効かないことがある。
  // 黙って別プロジェクトへ読み書きするのが最悪なので、食い違いは警告する
  if (existingApp) {
    const existingProjectId = existingApp.options?.projectId

    if (existingProjectId !== config.projectId) {
      console.warn(
        `initFirebase: 初期化済みのアプリ（projectId: ${String(existingProjectId)}）を再利用したため、` +
          `渡された設定（projectId: ${config.projectId}）は適用されていない`
      )
    }

    if (createAuth && !appsWithCustomAuth.has(existingApp)) {
      console.warn(
        'initFirebase: 初期化済みのアプリを再利用したため createAuth は呼ばれず、' +
          'getAuth の Auth が返る（永続化なし）。createAuth を渡す呼び出しを最初に実行すること'
      )
    }
  }

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

  if (!existingApp && createAuth) {
    appsWithCustomAuth.add(app)
  }

  return {
    app,
    auth,
    db: getFirestore(app),
  }
}
