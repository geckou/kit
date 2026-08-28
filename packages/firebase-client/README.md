# @geckou/firebase-client

Firebase クライアント SDK の薄いラッパー。アプリの初期化・Firestore の CRUD / 購読・Storage の
アップロードを、web（Next.js）と React Native（Expo）の双方から同じ形で呼べるようにする。

`firebase` は `peerDependencies`。利用側と同じインスタンスを共有するためで、
`dependencies` に入れると別インスタンスの Firebase App が生成され、認証状態が共有されない。

各モジュールは `'use client'` を持つ。Next.js App Router のサーバーコンポーネントから
直接 import するとビルドエラーになるので、クライアントコンポーネント経由で使う。

## インストール

```bash
yarn add @geckou/firebase-client firebase
```

## 初期化

環境変数の取得方法が web / mobile で異なるため、設定は呼び出し側から渡す。
React Native は `initializeAuth` + AsyncStorage による永続化が要るので、
Auth の生成もファクトリで差し替えられる。

```ts
import { initFirebase } from '@geckou/firebase-client'

export const { app, auth, db } = initFirebase({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
})
```

```ts
// React Native
import { getReactNativePersistence, initializeAuth } from 'firebase/auth'
import AsyncStorage from '@react-native-async-storage/async-storage'

initFirebase(config, (app) =>
  initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) })
)
```

すでに初期化済みのアプリがあれば再利用するので、複数回呼んでも多重初期化にならない。

## Firestore

コレクション名は引数で受け取る。1つの Firebase プロジェクトに複数環境を相乗りさせていて
`stg_users` のような接頭辞が要る場合も、呼び出し側で解決する。

```ts
import {
  getDocument,
  queryDocuments,
  subscribeCollection,
} from '@geckou/firebase-client/firestore'

const result = await getDocument<Post>(db, 'posts', postId)
if (result.success) {
  // result.data は Post | null
}
```

書き込み・取得系は例外を投げず、`{ success: true, data }` / `{ success: false, error }` を返す。

取得・購読が返す `id` は**常に Firestore のドキュメント ID**。ドキュメント本文に `id`
フィールドを持たせている場合でも、そちらでは上書きされない。

| 関数 | 用途 |
| --- | --- |
| `getDocument` | 1件取得（存在しなければ `data: null`） |
| `queryDocuments` | 条件・並び順・カーソル・件数を指定して取得。`lastDoc` を次ページのカーソルに使う |
| `createDocument` | ID 自動採番で作成 |
| `setDocument` | ID 指定で作成・上書き（`merge` 指定可） |
| `updateDocument` | 部分更新 |
| `removeDocument` | 削除 |
| `subscribeCollection` | コレクションの購読。解除関数を返す |
| `subscribeDocument` | 単一ドキュメントの購読。解除関数を返す |

購読系は `onError` を省略すると `console.error` にフォールバックする。
`queryDocuments` の `cursor` は購読では使われない（`subscribeCollection` は先頭から流す）。

## Storage

```ts
import { uploadFile } from '@geckou/firebase-client/storage'

const { downloadUrl, path } = await uploadFile(
  app,
  `users/${uid}/avatar.png`,
  file,
  ({ progress }) => setPercent(progress)
)
```

`uploadFile` / `deleteFile` / `getFileUrl` / `getFirebaseStorage` を提供する。
アップロードは `uploadBytesResumable` を使い、`progress` は 0〜100 のパーセント。
0 バイトのファイルは転送するものが無いため `progress: 100` を通知する。
アップロード自体の失敗と、完了後の URL 取得の失敗は、どちらも reject される。
