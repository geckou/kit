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
  const app = getApps().length === 0 ? initializeApp(config) : getApps()[0]

  return {
    app,
    auth: createAuth ? createAuth(app) : getAuth(app),
    db: getFirestore(app),
  }
}
