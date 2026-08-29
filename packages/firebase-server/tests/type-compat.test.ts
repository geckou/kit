import { describe, expect, it } from 'vitest'
import type { RequestHandler } from 'express'
import type { Auth } from 'firebase-admin/auth'
import type { Messaging } from 'firebase-admin/messaging'

import { createRequireAuth, type TokenVerifierLike } from '../src/auth-middleware'
import type { MessagingLike } from '../src/messaging'

/**
 * firebase-admin / express の実型が Like 型を満たすことの型レベル検証。
 * 実行時は何もしない。tsconfig.test.json の type-check で強制される
 */

const _auth: TokenVerifierLike = undefined as unknown as Auth
const _messaging: MessagingLike = undefined as unknown as Messaging
const _middleware: RequestHandler = createRequireAuth(_auth)

void _auth
void _messaging
void _middleware

describe('型互換', () => {
  it('firebase-admin の Auth / Messaging と express の RequestHandler に適合する（type-check で検証）', () => {
    expect(typeof createRequireAuth).toBe('function')
  })
})
