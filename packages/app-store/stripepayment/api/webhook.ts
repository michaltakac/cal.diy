/**
 * Stripe webhook handler — AGE-31 (board-observable sandbox path).
 *
 * Replaces the community-edition 404 stub at
 * /api/integrations/stripepayment/webhook so the self-hosted fork can:
 *   1. Receive Stripe **test-mode** events from a real Stripe sandbox account
 *      via a public URL (Cloudflare Tunnel / ngrok).
 *   2. Verify Stripe's signature with `STRIPE_WEBHOOK_SECRET` — invalid sig
 *      MUST 400 (least privilege, fail-visibly).
 *   3. Be idempotent on retries — Stripe re-delivers; we ack-but-no-op when
 *      the underlying Payment is already success=true.
 *   4. Mark a paid booking via the same `handlePaymentSuccess` path used by
 *      the BTCPay handler — confirmation flow parity, single code path.
 *   5. Log every accepted event with `event.id` so the board can correlate
 *      a Stripe sandbox dashboard delivery to a runtime log line.
 *
 * Live cut-over is the same code with `sk_live_*` / `whsec_*` keys (lens:
 * reversibility — keys are env-only, never committed, never logged).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import getRawBody from "raw-body";
import Stripe from "stripe";

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { PrismaBookingPaymentRepository as BookingPaymentRepository } from "@calcom/features/bookings/repositories/PrismaBookingPaymentRepository";
import { IS_PRODUCTION } from "@calcom/lib/constants";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import { distributedTracing } from "@calcom/lib/tracing/factory";

import { metadata as appConfig } from "../_metadata";

const log = logger.getSubLogger({ prefix: ["[stripe-webhook]"] });

const STRIPE_API_VERSION = "2020-08-27" as const;

const HANDLED_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "charge.refunded",
]);

export const config = { api: { bodyParser: false } };

function getStripeClient() {
  const apiKey = process.env.STRIPE_PRIVATE_KEY;
  if (!apiKey) {
    throw new HttpCode({
      statusCode: 503,
      message: "Stripe not configured (STRIPE_PRIVATE_KEY missing)",
    });
  }
  return new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION });
}

function getWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new HttpCode({
      statusCode: 503,
      message: "Stripe webhook not configured (STRIPE_WEBHOOK_SECRET missing)",
    });
  }
  return secret;
}

async function handlePaymentIntentSucceeded(event: Stripe.Event) {
  const intent = event.data.object as Stripe.PaymentIntent;
  log.info(`payment_intent.succeeded received`, {
    eventId: event.id,
    intentId: intent.id,
    amount: intent.amount,
    currency: intent.currency,
  });

  const bookingPaymentRepository = new BookingPaymentRepository();
  const payment =
    await bookingPaymentRepository.findByExternalIdIncludeBookingUserCredentials(
      intent.id,
      appConfig.type
    );
  if (!payment) {
    // Not our payment — could be a Stripe test fixture or an unrelated PI on
    // the connected account. Acknowledge so Stripe stops retrying.
    log.info(`no Payment row matches intent ${intent.id}; ack-but-ignore`);
    return { acked: true, matched: false };
  }
  if (payment.success) {
    // Idempotent: Stripe re-delivery on a payment we've already confirmed.
    log.info(`payment ${payment.id} already success=true; ack-but-no-op`, {
      eventId: event.id,
    });
    return { acked: true, matched: true, alreadySuccess: true };
  }

  const traceContext = distributedTracing.createTrace("stripe_webhook", {
    meta: { paymentId: payment.id, bookingId: payment.bookingId, eventId: event.id },
  });
  await handlePaymentSuccess({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    appSlug: appConfig.slug,
    traceContext,
  });
  return { acked: true, matched: true, alreadySuccess: false };
}

function logRefund(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  log.info(`charge.refunded received`, {
    eventId: event.id,
    chargeId: charge.id,
    paymentIntentId: charge.payment_intent,
    amountRefunded: charge.amount_refunded,
    currency: charge.currency,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      throw new HttpCode({ statusCode: 405, message: "Method Not Allowed" });
    }
    const signature = req.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      throw new HttpCode({ statusCode: 400, message: "Missing stripe-signature header" });
    }

    const rawBody = await getRawBody(req);
    const webhookSecret = getWebhookSecret();

    const stripe = getStripeClient();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "signature verification failed";
      log.warn(`signature verification failed`, { message });
      throw new HttpCode({ statusCode: 400, message: `Invalid signature: ${message}` });
    }

    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      log.info(`event type ${event.type} acknowledged but ignored`, { eventId: event.id });
      return res.status(200).json({ received: true, handled: false, eventId: event.id });
    }

    if (event.type === "payment_intent.succeeded") {
      const outcome = await handlePaymentIntentSucceeded(event);
      return res.status(200).json({ received: true, handled: true, eventId: event.id, ...outcome });
    }

    if (event.type === "charge.refunded") {
      logRefund(event);
      return res.status(200).json({ received: true, handled: true, eventId: event.id });
    }

    // Defensive — every type in HANDLED_EVENT_TYPES must have a branch above.
    return res.status(200).json({ received: true, handled: false, eventId: event.id });
  } catch (_err) {
    const err = getServerErrorFromUnknown(_err);
    return res.status(err.statusCode).send({
      message: err.message,
      stack: IS_PRODUCTION ? undefined : err.cause?.stack,
    });
  }
}
