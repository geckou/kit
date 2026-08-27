/**
 * @geckou/billing
 *
 * Stripe / RevenueCat のサブスク権利判定・Webhook 処理。
 *
 * 実行環境（Cloud Functions / Next.js Route Handler）に依存しない。
 * firebase-admin のインスタンス・コレクション名・シークレットは
 * createBilling() の config で注入する。
 */
import { createCheckoutSession, createPortalSession } from './checkout.js'
import { type BillingConfig, resolveConfig } from './config.js'
import { handleRevenueCatWebhook } from './revenuecat-webhook.js'
import { handleStripeWebhook } from './stripe-webhook.js'
import {
  applySubscriptionEvent,
  getStripeCustomerId,
  saveStripeCustomerId,
  syncSubscriptionClaims,
} from './subscription.js'
import type { Subscription, SubscriptionEvent, WebhookRequest } from './types.js'

// 純粋関数・型は factory を介さず直接使える
export { hasPlan, isSubscriptionActive } from './entitlement.js'
export { mapRevenueCatStatus, mapStripeStatus } from './status-mapping.js'
export type { BillingConfig, StripeClientLike } from './config.js'
export type {
  ApplyResult,
  ApplyStatus,
  HttpResult,
  Subscription,
  SubscriptionEvent,
  SubscriptionSource,
  SubscriptionStatus,
  WebhookRequest,
} from './types.js'

/** 依存を注入して、束ねた billing 関数群を得る */
export function createBilling(config: BillingConfig) {
  const resolved = resolveConfig(config)

  return {
    applySubscriptionEvent: (event: SubscriptionEvent) =>
      applySubscriptionEvent(resolved, event),
    syncSubscriptionClaims: (uid: string, subscription: Subscription) =>
      syncSubscriptionClaims(resolved, uid, subscription),
    saveStripeCustomerId: (uid: string, customerId: string) =>
      saveStripeCustomerId(resolved, uid, customerId),
    getStripeCustomerId: (uid: string) => getStripeCustomerId(resolved, uid),
    handleStripeWebhook: (req: WebhookRequest) =>
      handleStripeWebhook(resolved, req),
    handleRevenueCatWebhook: (req: WebhookRequest) =>
      handleRevenueCatWebhook(resolved, req),
    createCheckoutSession: (input: { uid: string; priceId: unknown }) =>
      createCheckoutSession(resolved, input),
    createPortalSession: (input: { uid: string }) =>
      createPortalSession(resolved, input),
  }
}

export type Billing = ReturnType<typeof createBilling>
