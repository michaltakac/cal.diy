/**
 * Paid-booking → Stripe (fiat) integration test — AGE-9.
 *
 * Proves the native Cal Stripe app's payment path works in Stripe **test mode**
 * with no live keys and no network: the Stripe SDK, prisma and the customer
 * helper are mocked so the test is fully reproducible in CI. Live cut-over is
 * a config swap (board-provided sk_live_/pk_live_ keys) — the wiring proven
 * here is identical between test and live mode.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  paymentIntentsCreate: vi.fn(),
  paymentIntentsCancel: vi.fn(),
  refundsCreate: vi.fn(),
  sessionsList: vi.fn(),
  sessionsExpire: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  paymentCreate: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentUpdate: vi.fn(),
}));

const retrieveOrCreateStripeCustomerByEmail = vi.hoisted(() => vi.fn());

// `import Stripe from "stripe"` — default export must be a real constructor.
vi.mock("stripe", () => {
  class StripeMock {
    paymentIntents = {
      create: stripeMocks.paymentIntentsCreate,
      cancel: stripeMocks.paymentIntentsCancel,
    };
    refunds = { create: stripeMocks.refundsCreate };
    checkout = { sessions: { list: stripeMocks.sessionsList, expire: stripeMocks.sessionsExpire } };
  }
  return { default: StripeMock };
});

// PaymentService uses a default prisma import; provide both shapes.
vi.mock("@calcom/prisma", () => {
  const payment = {
    create: prismaMocks.paymentCreate,
    findFirst: prismaMocks.paymentFindFirst,
    update: prismaMocks.paymentUpdate,
  };
  return { default: { payment }, prisma: { payment } };
});

vi.mock("./customer", () => ({ retrieveOrCreateStripeCustomerByEmail }));

// Heavy top-level deps not exercised by create/refund/isSetupAlready.
vi.mock("@calcom/features/tasker", () => ({ default: { create: vi.fn() } }));
vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({
  BookingRepository: vi.fn(),
}));

import { BuildPaymentService } from "./PaymentService";

// Stripe *test-mode* credentials (note the _test_ prefixes / acct_).
const TEST_CREDENTIALS = {
  key: {
    stripe_user_id: "acct_test_AGE9",
    default_currency: "usd",
    stripe_publishable_key: "pk_test_AGE9_publishable",
  },
};

describe("StripePaymentService — paid booking in Stripe test mode (AGE-9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_PRIVATE_KEY = "sk_test_AGE9_secret_key";
    retrieveOrCreateStripeCustomerByEmail.mockResolvedValue({ id: "cus_test_AGE9" });
  });

  it("creates a Stripe test-mode PaymentIntent on the connected account and a pending Payment row", async () => {
    const testPaymentIntent = {
      id: "pi_3Test_AGE9_abc",
      object: "payment_intent",
      client_secret: "pi_3Test_AGE9_abc_secret_xyz",
      status: "requires_payment_method",
      livemode: false,
      amount: 5000,
      currency: "usd",
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue(testPaymentIntent);
    prismaMocks.paymentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 101,
      uid: data.uid,
      externalId: data.externalId,
      amount: data.amount,
      currency: data.currency,
      success: data.success,
      paymentOption: data.paymentOption,
    }));

    const service = BuildPaymentService(TEST_CREDENTIALS);
    const result = await service.create(
      { amount: 5000, currency: "usd" },
      1, // bookingId
      2, // userId
      "ageuser",
      "AGE Booker",
      "ON_BOOKING",
      "booker@age.test",
      null,
      "AGE Paid Consultation",
      "AGE Paid Consultation between AGE and AGE Booker"
    );

    // PaymentIntent created in test mode against the connected account.
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = stripeMocks.paymentIntentsCreate.mock.calls[0];
    expect(params).toMatchObject({
      amount: 5000,
      currency: "usd",
      customer: "cus_test_AGE9",
      automatic_payment_methods: { enabled: true },
    });
    expect(opts).toEqual({ stripeAccount: "acct_test_AGE9" });

    // Payment row persisted, linked to the stripe app, not yet succeeded.
    expect(prismaMocks.paymentCreate).toHaveBeenCalledTimes(1);
    const createArg = prismaMocks.paymentCreate.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      amount: 5000,
      currency: "usd",
      externalId: "pi_3Test_AGE9_abc",
      success: false,
      refunded: false,
      paymentOption: "ON_BOOKING",
      app: { connect: { slug: "stripe" } },
      booking: { connect: { id: 1 } },
    });
    expect(createArg.data.data).toMatchObject({
      id: "pi_3Test_AGE9_abc",
      livemode: false,
      stripe_publishable_key: "pk_test_AGE9_publishable",
      stripeAccount: "acct_test_AGE9",
    });

    expect(result).toMatchObject({ id: 101, externalId: "pi_3Test_AGE9_abc", success: false });
  });

  it("rejects a payment option incompatible with create() (HOLD must use collectCard)", async () => {
    const service = BuildPaymentService(TEST_CREDENTIALS);
    await expect(
      service.create(
        { amount: 5000, currency: "usd" },
        1,
        2,
        "ageuser",
        "AGE Booker",
        "HOLD",
        "booker@age.test"
      )
    ).rejects.toThrow("payment_not_created_error");
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
    expect(prismaMocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("fails the booking payment when Stripe credentials are missing (fail visibly, not silently)", async () => {
    const service = BuildPaymentService({ key: {} });
    expect(service.isSetupAlready()).toBe(false);
    await expect(
      service.create(
        { amount: 5000, currency: "usd" },
        1,
        2,
        "ageuser",
        "AGE Booker",
        "ON_BOOKING",
        "booker@age.test"
      )
    ).rejects.toThrow("payment_not_created_error");
  });

  it("reports setup complete with valid test-mode credentials", () => {
    expect(BuildPaymentService(TEST_CREDENTIALS).isSetupAlready()).toBe(true);
  });

  it("refunds a successful test-mode payment via the connected account", async () => {
    prismaMocks.paymentFindFirst.mockResolvedValue({
      id: 55,
      externalId: "pi_3Test_AGE9_abc",
      success: true,
      refunded: false,
      data: { stripeAccount: "acct_test_AGE9" },
    });
    stripeMocks.refundsCreate.mockResolvedValue({ id: "re_test_AGE9", status: "succeeded" });
    prismaMocks.paymentUpdate.mockResolvedValue({ id: 55, refunded: true });

    const service = BuildPaymentService(TEST_CREDENTIALS);
    const refunded = await service.refund(55);

    expect(stripeMocks.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_3Test_AGE9_abc" },
      { stripeAccount: "acct_test_AGE9" }
    );
    expect(prismaMocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: 55 },
      data: { refunded: true },
    });
    expect(refunded).toMatchObject({ id: 55, refunded: true });
  });

  it("refuses to refund a payment that never succeeded", async () => {
    prismaMocks.paymentFindFirst.mockResolvedValue({
      id: 56,
      externalId: "pi_3Test_AGE9_unpaid",
      success: false,
      refunded: false,
      data: { stripeAccount: "acct_test_AGE9" },
    });
    const service = BuildPaymentService(TEST_CREDENTIALS);
    await expect(service.refund(56)).rejects.toThrow("Unable to refund failed payment");
    expect(stripeMocks.refundsCreate).not.toHaveBeenCalled();
  });
});
