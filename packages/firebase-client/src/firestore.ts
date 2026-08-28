'use client'

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  type Firestore,
  type DocumentData,
  type QueryConstraint,
  type WhereFilterOp,
  type OrderByDirection,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore'

// ---- 型定義 ----

type FirestoreResult<T> =
  { success: true; data: T } | { success: false; error: string }

type QueryOptions = {
  conditions?: Array<{
    field: string
    op: WhereFilterOp
    value: unknown
  }>
  sort?: Array<{
    field: string
    direction?: OrderByDirection
  }>
  pageSize?: number
  cursor?: DocumentSnapshot
}

// ---- ヘルパー関数 ----

/**
 * ドキュメントを1件取得
 */
export async function getDocument<T>(
  db: Firestore,
  collectionName: string,
  docId: string
): Promise<FirestoreResult<T | null>> {
  try {
    const docRef = doc(db, collectionName, docId)
    const snapshot = await getDoc(docRef)

    if (!snapshot.exists()) {
      return { success: true, data: null }
    }

    return {
      success: true,
      data: { ...snapshot.data(), id: snapshot.id } as T,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'ドキュメント取得に失敗',
    }
  }
}

/**
 * コレクションをクエリで取得（ページネーション対応）
 */
export async function queryDocuments<T>(
  db: Firestore,
  collectionName: string,
  options: QueryOptions = {}
): Promise<FirestoreResult<{ items: T[]; lastDoc: DocumentSnapshot | null }>> {
  try {
    const constraints: QueryConstraint[] = []

    if (options.conditions) {
      for (const condition of options.conditions) {
        constraints.push(where(condition.field, condition.op, condition.value))
      }
    }

    if (options.sort) {
      for (const s of options.sort) {
        constraints.push(orderBy(s.field, s.direction || 'asc'))
      }
    }

    if (options.cursor) {
      constraints.push(startAfter(options.cursor))
    }

    if (options.pageSize) {
      constraints.push(limit(options.pageSize))
    }

    const q = query(collection(db, collectionName), ...constraints)
    const snapshot = await getDocs(q)

    const items = snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as T)

    const lastDoc =
      snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : null

    return { success: true, data: { items, lastDoc } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'クエリ実行に失敗',
    }
  }
}

/**
 * ドキュメントを作成（ID 自動生成）
 */
export async function createDocument<T extends DocumentData>(
  db: Firestore,
  collectionName: string,
  data: T
): Promise<FirestoreResult<string>> {
  try {
    const docRef = await addDoc(collection(db, collectionName), data)
    return { success: true, data: docRef.id }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'ドキュメント作成に失敗',
    }
  }
}

/**
 * ドキュメントを作成・上書き（ID 指定）
 */
export async function setDocument<T extends DocumentData>(
  db: Firestore,
  collectionName: string,
  docId: string,
  data: T,
  merge: boolean = false
): Promise<FirestoreResult<void>> {
  try {
    const docRef = doc(db, collectionName, docId)
    await setDoc(docRef, data, { merge })
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'ドキュメント書き込みに失敗',
    }
  }
}

/**
 * ドキュメントを部分更新
 */
export async function updateDocument(
  db: Firestore,
  collectionName: string,
  docId: string,
  data: Record<string, unknown>
): Promise<FirestoreResult<void>> {
  try {
    const docRef = doc(db, collectionName, docId)
    await updateDoc(docRef, data)
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'ドキュメント更新に失敗',
    }
  }
}

/**
 * ドキュメントを削除
 */
export async function removeDocument(
  db: Firestore,
  collectionName: string,
  docId: string
): Promise<FirestoreResult<void>> {
  try {
    const docRef = doc(db, collectionName, docId)
    await deleteDoc(docRef)
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'ドキュメント削除に失敗',
    }
  }
}

/**
 * コレクションをリアルタイム監視
 */
export function subscribeCollection<T>(
  db: Firestore,
  collectionName: string,
  options: QueryOptions = {},
  onData: (items: T[]) => void,
  onError?: (error: Error) => void
): () => void {
  const constraints: QueryConstraint[] = []

  if (options.conditions) {
    for (const condition of options.conditions) {
      constraints.push(where(condition.field, condition.op, condition.value))
    }
  }

  if (options.sort) {
    for (const s of options.sort) {
      constraints.push(orderBy(s.field, s.direction || 'asc'))
    }
  }

  if (options.pageSize) {
    constraints.push(limit(options.pageSize))
  }

  const q = query(collection(db, collectionName), ...constraints)

  return onSnapshot(
    q,
    (snapshot: QuerySnapshot) => {
      const items = snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as T)
      onData(items)
    },
    (error) => {
      if (onError) {
        onError(error)
      } else {
        console.error('Firestore subscription error:', error)
      }
    }
  )
}

/**
 * 単一ドキュメントをリアルタイム監視
 */
export function subscribeDocument<T>(
  db: Firestore,
  collectionName: string,
  docId: string,
  onData: (data: T | null) => void,
  onError?: (error: Error) => void
): () => void {
  const docRef = doc(db, collectionName, docId)

  return onSnapshot(
    docRef,
    (snapshot: DocumentSnapshot) => {
      if (snapshot.exists()) {
        onData({ ...snapshot.data(), id: snapshot.id } as T)
      } else {
        onData(null)
      }
    },
    (error) => {
      if (onError) {
        onError(error)
      } else {
        console.error('Firestore subscription error:', error)
      }
    }
  )
}

export type { FirestoreResult, QueryOptions }
