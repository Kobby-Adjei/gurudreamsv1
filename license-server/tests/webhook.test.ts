import { describe, expect, it } from 'vitest';
import { makeHarness, USER, WEBHOOK_SECRET } from './helpers.js';

describe('POST /v1/stripe/webhook', () => {
  it('rejects a bad signature with 400 and changes nothing', async () => {
    const h = await makeHarness();
    h.billing.setSub('sub_1', 'active');
    const res = await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } }, {
      secret: 'whsec_wrong',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_signature' });
    expect(await h.store.get(USER)).toBeNull();
  });

  it('rejects a missing signature header with 400', async () => {
    const h = await makeHarness();
    const res = await h.app.request('/v1/stripe/webhook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
  });

  it('rejects a tampered body with 400', async () => {
    const h = await makeHarness();
    const payload = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.created', data: { object: {} } });
    const header = h.stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const res = await h.app.request('/v1/stripe/webhook', {
      method: 'POST',
      body: payload.replace('created', 'deleted'),
      headers: { 'stripe-signature': header },
    });
    expect(res.status).toBe(400);
  });

  it('checkout.session.completed retrieves the subscription and persists it by clerk_user_id', async () => {
    const h = await makeHarness();
    h.billing.setSub('sub_1', 'active', null, 'cus_9');
    const res = await h.sendEvent('checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      mode: 'subscription',
      subscription: 'sub_1',
      metadata: { clerk_user_id: USER },
    });
    expect(res.status).toBe(200);
    expect(await h.store.get(USER)).toMatchObject({
      clerkUserId: USER,
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_9',
      status: 'active',
      currentPeriodEnd: 1_900_000_000,
    });
  });

  it('persists subscription status transitions created -> updated(past_due) -> deleted', async () => {
    let t = 1_800_000_000_000;
    const hh = await makeHarness({ now: () => (t += 1000) });
    {
      hh.billing.setSub('sub_1', 'trialing');
      expect((await hh.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } })).status).toBe(200);
      expect((await hh.store.get(USER))?.status).toBe('trialing');

      hh.billing.setSub('sub_1', 'active');
      await hh.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
      expect((await hh.store.get(USER))?.status).toBe('active');

      hh.billing.setSub('sub_1', 'past_due');
      await hh.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
      expect((await hh.store.get(USER))?.status).toBe('past_due');

      hh.billing.setSub('sub_1', 'unpaid');
      await hh.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
      expect((await hh.store.get(USER))?.status).toBe('unpaid');

      hh.billing.setSub('sub_1', 'canceled');
      await hh.sendEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { clerk_user_id: USER } });
      expect((await hh.store.get(USER))?.status).toBe('canceled');
    }
  });

  it('maps incomplete_expired to canceled and incomplete stays incomplete', async () => {
    let t = 1_800_000_000_000;
    const h = await makeHarness({ now: () => (t += 1000) });
    h.billing.setSub('sub_1', 'incomplete');
    await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } });
    expect((await h.store.get(USER))?.status).toBe('incomplete');
    h.billing.setSub('sub_1', 'incomplete_expired');
    await h.sendEvent('customer.subscription.updated', { id: 'sub_1', metadata: { clerk_user_id: USER } });
    expect((await h.store.get(USER))?.status).toBe('canceled');
  });

  it('is idempotent on event.id (a replayed event is not re-applied)', async () => {
    let t = 1_800_000_000_000;
    const h = await makeHarness({ now: () => (t += 1000) });
    h.billing.setSub('sub_1', 'active');
    await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } }, { id: 'evt_A' });
    h.billing.setSub('sub_1', 'canceled');
    await h.sendEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { clerk_user_id: USER } }, { id: 'evt_B' });
    h.billing.setSub('sub_1', 'active'); // if evt_A were re-processed it would flip back to active
    const res = await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } }, { id: 'evt_A' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect((await h.store.get(USER))?.status).toBe('canceled');
  });

  it('an old subscription ending does not revoke a newer active one', async () => {
    let t = 1_800_000_000_000;
    const h = await makeHarness({ now: () => (t += 1000) });
    h.billing.setSub('sub_new', 'active');
    await h.sendEvent('customer.subscription.created', { id: 'sub_new', metadata: { clerk_user_id: USER } });
    h.billing.setSub('sub_old', 'canceled');
    await h.sendEvent('customer.subscription.deleted', { id: 'sub_old', metadata: { clerk_user_id: USER } });
    expect(await h.store.get(USER)).toMatchObject({ status: 'active', stripeSubscriptionId: 'sub_new' });
  });

  it('ignores events without clerk_user_id metadata but acknowledges them', async () => {
    const h = await makeHarness();
    h.billing.setSub('sub_1', 'active', null);
    const res = await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: {} });
    expect(res.status).toBe(200);
    expect(await h.store.get(USER)).toBeNull();
  });

  it('returns 500 (so Stripe retries) when Stripe retrieval fails, and does not mark the event processed', async () => {
    const h = await makeHarness();
    h.billing.setSub('sub_1', 'active');
    h.billing.failRetrieve = true;
    const r1 = await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } }, { id: 'evt_R' });
    expect(r1.status).toBe(500);
    h.billing.failRetrieve = false;
    const r2 = await h.sendEvent('customer.subscription.created', { id: 'sub_1', metadata: { clerk_user_id: USER } }, { id: 'evt_R' });
    expect(r2.status).toBe(200);
    expect((await h.store.get(USER))?.status).toBe('active');
  });

  it('acknowledges unrelated event types', async () => {
    const h = await makeHarness();
    const res = await h.sendEvent('invoice.paid', { id: 'in_1' });
    expect(res.status).toBe(200);
  });
});
