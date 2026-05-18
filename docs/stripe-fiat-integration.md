# Stripe (Fiat) Integration — Self-Hosted Cal.diy

This covers wiring **paid bookings → Stripe** using Cal's native Stripe app on
the self-hosted `michaltakac/cal.diy` fork. It is the fiat half of the payment
stack (crypto/BTCPay is tracked separately).

> **LIVE cut-over is parked.** Everything below is built and verified in Stripe
> **test mode**. The real Stripe account keys (`sk_live_…` / `pk_live_…` and the
> Connect `client_id`) are **board/CEO-provided** and are not in the repo.
> Going live is a config-only swap — see [Live cut-over](#live-cut-over).

---

## How Cal's Stripe app works

The native app (`packages/app-store/stripepayment`) is built around **Stripe
Connect**:

1. **App row keys** — `scripts/seed-app-store.ts` reads six env vars and writes
   the `stripe` row's `App.keys` (`client_id`, `client_secret`, `public_key`,
   `webhook_secret`, plus platform fee fields). The app only enables when the
   keys validate (`appKeysSchema`: `ca_` / `sk_` / `pk_` / `whsec_` prefixes).
2. **Connected-account credential** — the operator connects the Stripe account
   via OAuth (`/apps/stripe` → Connect → `api/stripepayment/callback`). This
   stores a `Credential` (`stripe_user_id`, `default_currency`,
   `stripe_publishable_key`).
3. **Paid booking** — when an event type has the Stripe app enabled with a
   price, `StripePaymentService.create()` creates a Stripe `PaymentIntent` on
   the connected account and a pending `Payment` row; the booking confirms once
   the PaymentIntent succeeds. Refunds go back through the same connected
   account.

`STRIPE_PRIVATE_KEY` is the platform secret key used by the Stripe SDK client at
runtime; the per-event charge is executed `stripeAccount`-scoped.

---

## Configuration

All six vars must be set or the app stays disabled. They live in
`.env.selfhost.example` (copy to `.env`):

| Env var | Test-mode value | Notes |
|---|---|---|
| `STRIPE_CLIENT_ID` | `ca_…` | Stripe Connect client id (Connect settings) |
| `STRIPE_PRIVATE_KEY` | `sk_test_…` | Platform secret key |
| `NEXT_PUBLIC_STRIPE_PUBLIC_KEY` | `pk_test_…` | Publishable key (client) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Webhook signing secret |
| `PAYMENT_FEE_FIXED` | `0` | Per-booking platform fee (cents); `0` for single-tenant |
| `PAYMENT_FEE_PERCENTAGE` | `0` | Percentage platform fee; `0` for single-tenant |

Seed / refresh the app row after setting them:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml \
  exec calcom yarn workspace @calcom/prisma db-seed
# (seed-app-store upserts the `stripe` App row from the env vars above)
```

Then in the Cal UI: **Apps → Stripe → Connect**, finish the Stripe OAuth, and on
a paid **Event Type** open the **Stripe** app card, set a **price + currency**
and `paymentOption = ON_BOOKING`. Booking that event type now requires payment.

---

## Automated test (CI-safe, no live keys)

`packages/app-store/stripepayment/lib/PaymentService.test.ts` proves the
paid-booking → Stripe path in **test mode** with the Stripe SDK, prisma and the
customer helper mocked (no network, no keys). It asserts:

- `create()` makes a Stripe **test-mode** `PaymentIntent` on the connected
  account and persists a pending `Payment` row linked to the `stripe` app;
- incompatible payment options and missing credentials **fail visibly**
  (`payment_not_created_error`), not silently;
- `isSetupAlready()` reflects credential validity;
- `refund()` refunds a succeeded payment via the connected account and refuses
  to refund a payment that never succeeded.

Run it:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml \
  exec calcom node_modules/.bin/vitest run \
  packages/app-store/stripepayment/lib/PaymentService.test.ts
# → Test Files 1 passed (1) · Tests 6 passed (6)
```

The wiring exercised here is identical between test and live mode — only the
keys differ — so a green test is the proof-of-readiness for the live swap.

---

## Live cut-over

Blocked on **board/CEO-provided** Stripe credentials (one-way door — real money
path; see the Reversibility and least-privilege lenses). When the board hands
over the live account:

1. Put `STRIPE_CLIENT_ID` / `STRIPE_PRIVATE_KEY=sk_live_…` /
   `NEXT_PUBLIC_STRIPE_PUBLIC_KEY=pk_live_…` / `STRIPE_WEBHOOK_SECRET` into the
   deployment secret store (env only — never commit, never log).
2. Re-run the seed step to refresh `App.keys`.
3. Reconnect the Stripe account via OAuth (live).
4. Point the Stripe **webhook** endpoint at `…/api/integrations/stripepayment/webhook`
   and confirm signature verification.
5. Smoke one real low-value paid booking + refund, then revert.

Until then the integration is complete and verified in test mode.
