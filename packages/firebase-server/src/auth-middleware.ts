/**
 * Firebase Auth の ID トークンを検証する Express 互換ミドルウェア。
 *
 * `firebase-admin` / `express` の型を直接使わず、使用するメソッドだけを
 * 構造的に要求する（stripe の型がメジャー間で壊れた教訓と同じ扱い）。
 * `getAuth()` の戻り値は TokenVerifierLike を、Express の req / res / next は
 * それぞれ RequestLike / ResponseLike / NextLike を満たす。
 */

export type TokenVerifierLike = {
  verifyIdToken(token: string): Promise<{ uid: string }>
}

export type RequestLike = {
  headers: { authorization?: string | undefined }
}

export type ResponseLike = {
  status(code: number): { json(body: unknown): unknown }
}

export type NextLike = () => void

/**
 * ID トークン検証ミドルウェアを生成する。
 * 検証に成功すると req.uid に uid が入る。
 *
 * Auth インスタンスは直接でもゲッターでも渡せる。ミドルウェアの登録は
 * アプリ初期化より先に評価されることがあるため、`createRequireAuth(getAuth)` の
 * ように渡すと解決をリクエスト時まで遅延できる
 */
export function createRequireAuth(
  auth: TokenVerifierLike | (() => TokenVerifierLike)
) {
  const resolveAuth = typeof auth === 'function' ? auth : () => auth

  return async function requireAuth(
    req: RequestLike,
    res: ResponseLike,
    next: NextLike
  ): Promise<void> {
    const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    try {
      const decoded = await resolveAuth().verifyIdToken(token)
      ;(req as RequestLike & { uid: string }).uid = decoded.uid
      next()
    } catch {
      res.status(401).json({ error: 'Unauthorized' })
    }
  }
}
