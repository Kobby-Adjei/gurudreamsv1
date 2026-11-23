import Stripe from 'stripe';
import type { SubscriptionStatus } from './store.js';

/** Minimal Stripe subscription shape we rely on (works across API versions). */
export interface StripeSubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> } | null;
}

/** The Stripe API surface the server uses. Real impl wraps the `stripe` SDK; tests pass a fake. */
export interface BillingApi {
  createCheckoutSession(params: {
    clerkUserId: string;
    priceId: string;
    customerId: string | null;
    email: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
  createPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<StripeSubscriptionLike>;
}

export type WebhookVerifier = (rawBody: Buffer, signature: string, secret: string) => Stripe.Event;

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 10_000, appInfo: { name: 'airbridge-license-server' } });
}

export function createWebhookVerifier(stripe: Stripe): WebhookVerifier {
  return (rawBody, signature, secret) => stripe.webhooks.constructEvent(rawBody, signature, secret, 300);
}

export function createStripeBillingApi(stripe: Stripe): BillingApi {
  return {
    async createCheckoutSession(p) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: p.priceId, quantity: 1 }],
        client_reference_id: p.clerkUserId,
        metadata: { clerk_user_id: p.clerkUserId },
        subscription_data: { metadata: { clerk_user_id: p.clerkUserId } },
        ...(p.customerId ? { customer: p.customerId } : p.email ? { customer_email: p.email } : {}),
        allow_promotion_codes: true,
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
      });
      if (!session.url) throw new Error('Stripe returned a checkout session without url');
      return { url: session.url };
    },
    async createPortalSession(p) {
      const s = await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl });
      return { url: s.url };
    },
    async retrieveSubscription(id) {
      return (await stripe.subscriptions.retrieve(id)) as unknown as StripeSubscriptionLike;
    },
  };
}

/** Map Stripe's subscription status onto the contract's status set. */
export function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
    case 'incomplete':
      return status;
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'unpaid';
    default:
      return 'incomplete';
  }
}

export function customerIdOf(c: StripeSubscriptionLike['customer']): string | null {
  if (!c) return null;
  return typeof c === 'string' ? c : c.id;
}

export function periodEndOf(sub: StripeSubscriptionLike): number | null {
  return sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
}
