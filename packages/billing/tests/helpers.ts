import type { Auth } from 'firebase-admin/auth'
import type { Firestore } from 'firebase-admin/firestore'
import { vi } from 'vitest'

import type { BillingConfig } from '../src/config.js'
import { resolveConfig, type ResolvedConfig } from '../src/config.js'

/**
 * Firestore をインメモリの簡易ストアで置き換える。
 * トランザクションは「渡された関数をそのまま実行する」形で再現する
 */
export type FakeFirestore = {
  firestore: Firestore
  store: Map<string, Record<string, unknown>>
}

// 実際の Firestore は undefined を値として受け付けず throw する。
// モックが undefined を受理すると本番でだけ落ちる書き込みを見逃すため、同じ挙動にする
function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(
      `Cannot use "undefined" as a Firestore value (found in field ${path})`
    )
  }

  if (value === null || value instanceof Date) return

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      assertNoUndefined(child, path ? `${path}.${key}` : key)
    }
  }
}

export function createFakeFirestore(): FakeFirestore {
  const store = new Map<string, Record<string, unknown>>()

  type Ref = { path: string }

  const setDoc = (
    ref: Ref,
    data: Record<string, unknown>,
    options?: { merge?: boolean; mergeFields?: string[] }
  ) => {
    assertNoUndefined(data, '')

    // mergeFields は指定フィールドをまるごと置き換える（深いマージはしない）
    if (options?.mergeFields) {
      const previous = store.get(ref.path) ?? {}
      const nextDoc = { ...previous }
      for (const field of options.mergeFields) {
        nextDoc[field] = data[field]
      }
      store.set(ref.path, nextDoc)
      return
    }

    const previous = options?.merge ? (store.get(ref.path) ?? {}) : {}
    store.set(ref.path, { ...previous, ...data })
  }

  const getDoc = (ref: Ref) => {
    const data = store.get(ref.path)

    return {
      exists: data !== undefined,
      get: (field: string) => data?.[field],
    }
  }

  const transaction = {
    get: async (ref: Ref) => getDoc(ref),
    set: setDoc,
  }

  const firestore = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => getDoc({ path: `${name}/${id}` }),
        set: async (
          data: Record<string, unknown>,
          options?: { merge?: boolean }
        ) => setDoc({ path: `${name}/${id}` }, data, options),
      }),
    }),
    runTransaction: (fn: (t: typeof transaction) => Promise<unknown>) =>
      fn(transaction),
  } as unknown as Firestore

  return { firestore, store }
}

export function createFakeAuth(
  overrides: Partial<Record<string, unknown>> = {}
) {
  const getUser = vi.fn().mockResolvedValue({
    email: 'user@example.com',
    customClaims: undefined,
  })
  const setCustomUserClaims = vi.fn().mockResolvedValue(undefined)

  return {
    auth: { getUser, setCustomUserClaims, ...overrides } as unknown as Auth,
    getUser,
    setCustomUserClaims,
  }
}

export function createTestConfig(
  overrides: Partial<BillingConfig> = {}
): ResolvedConfig & { store: Map<string, Record<string, unknown>> } {
  const { firestore, store } = createFakeFirestore()

  return {
    ...resolveConfig({ firestore, ...overrides }),
    store,
  }
}
