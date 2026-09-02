import type { Auth } from 'firebase-admin/auth'
import type { Firestore } from 'firebase-admin/firestore'

import type { Subscription } from './types.js'

/**
 * Stripe クライアントに要求する形。
 *
 * `stripe` の型を直接使うと、メジャーバージョン間の型定義の差
 * （v22 で CJS が `export = StripeConstructor` に変わった等）が
 * 利用側の型エラーになるため、使用するメソッドだけを構造的に要求する。
 * `new Stripe(secretKey)` のインスタンスはどのメジャーでもこの形を満たす。
 */
export type StripeClientLike = {
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string,
      secret: string
    ): unknown
  }
  customers: {
    create(params: {
      email?: string
      metadata: Record<string, string>
    }): Promise<{ id: string }>
  }
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ url?: string | null }>
    }
  }
  billingPortal: {
    sessions: {
      create(params: {
        customer: string
        return_url: string
      }): Promise<{ url: string }>
    }
  }
}

/**
 * createBilling に渡す設定。
 *
 * 実行環境（Cloud Functions / Next.js Route Handler）に依存する値は
 * 全てここから注入する。パッケージ内では process.env を一切読まない。
 */
export type BillingConfig = {
  /** firebase-admin/firestore の getFirestore() で得たインスタンス */
  firestore: Firestore

  /**
   * firebase-admin/auth の getAuth() で得たインスタンス。
   * カスタムクレーム同期と、Stripe 顧客作成時のメール逆引きに使う。
   * 省略した場合、クレーム同期は無効・顧客はメール無しで作成される
   */
  auth?: Auth

  /**
   * コレクション名の解決。3環境を 1 つの Firebase プロジェクトに相乗り
   * させる構成などで、接頭辞付きの名前に差し替えられる
   */
  collections?: {
    /** 既定: 'users' */
    users?: string
    /** 処理済みイベントの記録先（冪等性のため）。既定: 'billing_events' */
    billingEvents?: string
  }

  /**
   * 権利状態を Firebase Auth のカスタムクレームに同期するか。
   *
   * セキュリティルールから権利状態を参照する場合だけ有効にする。
   * 画面側の表示制御しかしないプロダクトでは Firestore の
   * users/{uid}.subscription を読めば足りるので、有効化する必要はない
   */
  syncClaims?: boolean

  /** Web 決済（Stripe）を使う場合のみ設定する */
  stripe?: {
    /** new Stripe(secretKey) で生成したクライアント */
    client: StripeClientLike
    /** Webhook 署名検証用シークレット */
    webhookSecret: string
    /**
     * 購入を許可する price ID の一覧。
     * クライアントから任意の price を渡されないよう、サーバー側で許可リストを持つ
     */
    allowedPriceIds?: string[]
    /** Checkout 完了後のリダイレクト先 */
    successUrl?: string
    /** Checkout キャンセル時のリダイレクト先 */
    cancelUrl?: string
    /** カスタマーポータルからの戻り先 */
    portalReturnUrl?: string
  }

  /** アプリ内課金（RevenueCat）を使う場合のみ設定する */
  revenuecat?: {
    /** Dashboard > Integrations > Webhooks で設定した Authorization ヘッダー値 */
    webhookAuth: string
  }

  /**
   * 権利が「無効 → 有効」に変わったときに呼ばれるフック。
   *
   * Webhook のトランザクション確定後に呼ばれるため、複数ドキュメントの更新や
   * 削除など、時間のかかる処理を書いてよい。ここで例外を投げても Webhook は
   * 500 にならない（権利状態の反映自体は既に確定しているため）
   */
  onSubscriptionUpgraded?: (
    uid: string,
    subscription: Subscription
  ) => Promise<void>

  /**
   * 権利が「有効 → 無効」に変わったときに呼ばれるフック。
   * 無料プランの制限にデータを収める後始末をここに書く
   */
  onSubscriptionDowngraded?: (
    uid: string,
    subscription: Subscription
  ) => Promise<void>
}

/** 設定に既定値を適用した内部表現 */
export type ResolvedConfig = BillingConfig & {
  collectionNames: { users: string; billingEvents: string }
}

export function resolveConfig(config: BillingConfig): ResolvedConfig {
  return {
    ...config,
    collectionNames: {
      users: config.collections?.users ?? 'users',
      billingEvents: config.collections?.billingEvents ?? 'billing_events',
    },
  }
}
