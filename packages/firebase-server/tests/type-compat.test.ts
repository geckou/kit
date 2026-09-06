import { describe, expect, it } from 'vitest'
import type { Request, RequestHandler } from 'express'
import type { Auth, DecodedIdToken } from 'firebase-admin/auth'
import type { Messaging } from 'firebase-admin/messaging'

import {
  createRequireAuth,
  type AuthenticatedRequest,
  type DecodedTokenLike,
  type TokenVerifierLike,
} from '../src/auth-middleware'
import type { MessagingLike } from '../src/messaging'

/**
 * firebase-admin / express の実型が Like 型を満たすことの型レベル検証。
 * 実行時は何もしない。tsconfig.test.json の type-check で強制される
 */

const _auth: TokenVerifierLike = undefined as unknown as Auth
const _messaging: MessagingLike = undefined as unknown as Messaging
const _middleware: RequestHandler = createRequireAuth(_auth)
// firebase-admin の DecodedIdToken をそのまま req.token に載せられること
const _decoded: DecodedTokenLike = undefined as unknown as DecodedIdToken
// Express の Request をハンドラ側でキャストできること
const _authenticated: AuthenticatedRequest = undefined as unknown as Request &
  AuthenticatedRequest

void _auth
void _messaging
void _middleware
void _decoded
void _authenticated

describe('型互換', () => {
  it('firebase-admin の Auth / Messaging と express の RequestHandler に適合する（type-check で検証）', () => {
    expect(typeof createRequireAuth).toBe('function')
  })
})
