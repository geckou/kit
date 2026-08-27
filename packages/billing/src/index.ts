/**
 * @geckou/billing
 *
 * Stripe / RevenueCat のサブスク権利判定・Webhook 処理。
 * project-starter の packages/shared/src/billing/ と apps/functions/src/lib/ から
 * 実行環境非依存の形（firebase-admin とコレクション名解決を注入）へ移植する。
 */

/** パッケージの疎通確認用。移植が始まったら削除する */
export const PACKAGE_NAME = '@geckou/billing'
