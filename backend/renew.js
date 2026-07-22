// Standalone renewal job: the merchant-initiated (off-session) recurring charge.
// In production a scheduler would run this on each subscriber's renewal date.
// Here it's a script you can run manually to prove the mandate works:
//
//   node renew.js <customer_id>
//
// It reads the stored mandate_id and charges the card with no customer present.
import "dotenv/config";
import { chargeRecurring } from "./hyperswitch.js";
import { getSubscription, upsertPayment } from "./db.js";

const PLAN = { amount: 2499, currency: "USD" };

const customerId = process.argv[2];
if (!customerId) {
  console.error("Usage: node renew.js <customer_id>");
  process.exit(1);
}

const sub = getSubscription(customerId);
if (!sub || sub.status !== "active" || !sub.mandate_id) {
  console.error(`No active subscription with a mandate for ${customerId}.`);
  console.error("Complete a first payment before running a renewal.");
  process.exit(1);
}

const idempotencyKey = `renew_${customerId}_${new Date().toISOString().slice(0, 10)}`;

try {
  const payment = await chargeRecurring({
    amount: PLAN.amount,
    currency: PLAN.currency,
    customerId,
    mandateId: sub.mandate_id,
    idempotencyKey,
  });
  upsertPayment({
    paymentId: payment.payment_id,
    customerId,
    status: payment.status,
    amount: PLAN.amount,
    currency: PLAN.currency,
    mandateId: sub.mandate_id,
  });
  console.log(`Recurring charge created: ${payment.payment_id} status=${payment.status}`);
} catch (e) {
  console.error("Recurring charge failed:", e.message, e.body || "");
  process.exit(1);
}
