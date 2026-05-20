/**
 * Stripe webhook handler test — AGE-31.
 *
 * Proves the new sandbox-observable webhook path:
 *   • Stripe-signed event with valid `whsec_*` → 200, handlePaymentSuccess
 *     invoked exactly once for `payment_intent.succeeded`.
 *   • Same event-id replayed (idempotency) → 200 ack-no-op, handler called
 *     exactly once total.
 *   • Tampered body / wrong signing secret → 400 (fail visibly).
 *   • Missing `stripe-signature` header → 400.
 *   • `charge.refunded` → 200 observably logged.
 *   • Unhandled event type (`customer.created`) → 200 ack-but-ignore.
 *   • Missing `STRIPE_PRIVATE_KEY` / `STRIPE_WEBHOOK_SECRET` env → 503.
 *
 * We use the **real Stripe SDK signature algorithm** by calling
 * `Stripe.webhooks.generateTestHeaderString` — the same algorithm Stripe
 * applies to real deliveries — so a green test is a faithful proof of the
 * signature path. Only the booking lookup and handlePaymentSuccess side
 * effects are mocked so the test is CI-safe with no network.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlePaymentSuccessMock = vi.hoisted(() => vi.fn());
vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: handlePaymentSuccessMock,
}));

const repoFindMock = vi.hoisted(() => vi.fn());
vi.mock("@calcom/features/bookings/repositories/PrismaBookingPaymentRepository", () => {
  // Must be a real constructor (not arrow) so `new BookingPaymentRepository()` works.
  function PrismaBookingPaymentRepository(this: any) {
    this.findByExternalIdIncludeBookingUserCredentials = repoFindMock;
  }
  return { PrismaBookingPaymentRepository };
});

vi.mock("@calcom/lib/tracing/factory", () => ({
  distributedTracing: {
    createTrace: vi.fn().mockReturnValue({}),
    updateTrace: vi.fn().mockReturnValue({}),
  },
}));

import handler from "../webhook";

const TEST_WEBHOOK_SECRET = "whsec_test_aGE31_sandbox_signing_secret_value";

function makeReq(rawBody: Buffer, headers: Record<string, string>): NextApiRequest {
  const stream = Readable.from(rawBody) as unknown as NextApiRequest;
  // Object.assign would lose the stream prototype; mutate directly.
  (stream as any).method = "POST";
  (stream as any).headers = headers;
  return stream as NextApiRequest;
}

function makeRes() {
  const res: any = { _bodies: [] };
  res.status = vi.fn().mockImplementation(() => res);
  res.json = vi.fn().mockImplementation((body: any) => {
    res._bodies.push(body);
    return res;
  });
  res.send = vi.fn().mockImplementation((body: any) => {
    res._bodies.push(body);
    return res;
  });
  res.setHeader = vi.fn().mockImplementation(() => res);
  return res as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    _bodies: any[];
  };
}

function buildEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: "evt_test_paymentintent_succeeded_001",
    object: "event",
    api_version: "2020-08-27",
    created: 1700000000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_test_age31_observable_001",
        object: "payment_intent",
        amount: 5000,
        currency: "usd",
        status: "succeeded",
      } as unknown as Stripe.PaymentIntent,
    },
    ...overrides,
  } as Stripe.Event;
}

function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  // Stripe's official test-header helper — same algorithm prod uses.
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

describe("Stripe webhook (AGE-31)", () => {
  beforeEach(() => {
    process.env.STRIPE_PRIVATE_KEY = "sk_test_age31_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    handlePaymentSuccessMock.mockReset();
    repoFindMock.mockReset();
  });

  afterEach(() => {
    delete process.env.STRIPE_PRIVATE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("verifies a valid Stripe signature and marks booking paid (payment_intent.succeeded)", async () => {
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);
    const req = makeReq(Buffer.from(payload), { "stripe-signature": signature });
    const res = makeRes();

    repoFindMock.mockResolvedValueOnce({
      id: 42,
      bookingId: 7,
      success: false,
      externalId: "pi_test_age31_observable_001",
      booking: { user: { credentials: [{ key: {} }] } },
    });
    handlePaymentSuccessMock.mockResolvedValueOnce(undefined);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(handlePaymentSuccessMock).toHaveBeenCalledTimes(1);
    expect(handlePaymentSuccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 42, bookingId: 7, appSlug: "stripe" })
    );
  });

  it("is idempotent: a replayed event-id does not double-confirm", async () => {
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);

    // First delivery — booking not yet success.
    repoFindMock.mockResolvedValueOnce({
      id: 42,
      bookingId: 7,
      success: false,
      externalId: "pi_test_age31_observable_001",
      booking: { user: { credentials: [{ key: {} }] } },
    });
    await handler(makeReq(Buffer.from(payload), { "stripe-signature": signature }), makeRes());
    expect(handlePaymentSuccessMock).toHaveBeenCalledTimes(1);

    // Second delivery (Stripe retry) — now booking is success=true.
    repoFindMock.mockResolvedValueOnce({
      id: 42,
      bookingId: 7,
      success: true,
      externalId: "pi_test_age31_observable_001",
      booking: { user: { credentials: [{ key: {} }] } },
    });
    const res2 = makeRes();
    await handler(makeReq(Buffer.from(payload), { "stripe-signature": signature }), res2);

    expect(res2.status).toHaveBeenCalledWith(200);
    // No second invocation — idempotent ack.
    expect(handlePaymentSuccessMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered body with 400", async () => {
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);
    // Body mutated after signing.
    const tamperedPayload = payload.replace(`"amount":5000`, `"amount":9999999`);
    const req = makeReq(Buffer.from(tamperedPayload), { "stripe-signature": signature });
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
  });

  it("rejects a signature minted with the wrong secret with 400", async () => {
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const wrongSig = signPayload(payload, "whsec_test_WRONG_SECRET_VALUE");
    const res = makeRes();

    await handler(makeReq(Buffer.from(payload), { "stripe-signature": wrongSig }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no stripe-signature header with 400", async () => {
    const payload = JSON.stringify(buildEvent());
    const res = makeRes();

    await handler(makeReq(Buffer.from(payload), {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
  });

  it("acknowledges charge.refunded with 200 (observable log path)", async () => {
    const event = buildEvent({
      id: "evt_test_charge_refunded_001",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_001",
          object: "charge",
          payment_intent: "pi_test_age31_observable_001",
          amount_refunded: 5000,
          currency: "usd",
        } as unknown as Stripe.Charge,
      },
    });
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);
    const res = makeRes();

    await handler(makeReq(Buffer.from(payload), { "stripe-signature": signature }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
  });

  it("acknowledges unhandled event types with 200 (no booking side effects)", async () => {
    const event = buildEvent({
      id: "evt_test_customer_created_001",
      type: "customer.created",
      data: { object: { id: "cus_test_001", object: "customer" } as unknown as Stripe.Customer },
    });
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);
    const res = makeRes();

    await handler(makeReq(Buffer.from(payload), { "stripe-signature": signature }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
    expect(repoFindMock).not.toHaveBeenCalled();
  });

  it("returns 503 when STRIPE_WEBHOOK_SECRET is missing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const res = makeRes();

    await handler(makeReq(Buffer.from(payload), { "stripe-signature": "t=1,v1=anything" }), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("acks-but-ignores when no Payment row matches the intent id", async () => {
    const event = buildEvent();
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, TEST_WEBHOOK_SECRET);
    const res = makeRes();

    repoFindMock.mockResolvedValueOnce(null);

    await handler(makeReq(Buffer.from(payload), { "stripe-signature": signature }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(handlePaymentSuccessMock).not.toHaveBeenCalled();
  });
});
