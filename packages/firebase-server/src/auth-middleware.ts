/**
 * Firebase Auth の ID トークンを検証する Express 互換ミドルウェア。
 *
 * `firebase-admin` / `express` の型を直接使わず、使用するメソッドだけを
 * 構造的に要求する（stripe の型がメジャー間で壊れた教訓と同じ扱い）。
 * `getAuth()` の戻り値は TokenVerifierLike を、Express の req / res / next は
 * それぞれ RequestLike / ResponseLike / NextLike を満たす。
 */

export type TokenVerifierLike = {
  verifyIdToken(token: string, checkRevoked?: boolean): Promise<{ uid: string }>
}

export type RequireAuthOptions = {
  /**
   * 失効（revokeRefreshTokens）済みのトークンを弾くか。既定 false。
   *
   * true にすると検証のたびに Firebase Auth へ問い合わせるので、
   * レイテンシと呼び出し回数が増える。false のままだと、失効させても
   * ID トークンの有効期限（最大 1 時間）は通り続ける
   */
  checkRevoked?: boolean
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
  auth: TokenVerifierLike | (() => TokenVerifierLike),
  options: RequireAuthOptions = {}
) {
  const resolveAuth = typeof auth === 'function' ? auth : () => auth
  const checkRevoked = options.checkRevoked ?? false

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

    // next() を try の中で呼ぶと、後続ハンドラの同期例外まで catch に入り
    // 401 に化ける。NextLike は Express 以外も想定した型なので、
    // 検証の await だけを try で囲む
    // resolveAuth() も try の外で呼ぶ。中に入れると、App 未初期化などの
    // 設定ミスが「トークンが無効」と区別できない 401 に化ける
    const verifier = resolveAuth()
    let uid: string

    try {
      const decoded = await verifier.verifyIdToken(token, checkRevoked)
      uid = decoded.uid
    } catch {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    ;(req as RequestLike & { uid: string }).uid = uid
    next()
  }
}
