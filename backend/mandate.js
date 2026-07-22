// Shared mandate handling for BOTH confirmation paths (webhook and poll).
//
// Why this file exists: the webhook path and the poll fallback used to parse
// the payment payload separately, and they disagreed. The poll path read
// `live.mandate_id` when activating the subscription while storing
// `live.mandate_id || live.connector_mandate_id`, so a connector that returns
// the mandate as `connector_mandate_id` produced an "active" subscription with
// mandate_id: null. Activated, but not billable.
//
// Everything that reads a mandate out of a payment, or writes payment outcome
// state, goes through here now so the two paths cannot drift again.
import { upsertPayment, activateSubscription, getPayment } from "./db.js";

// Hyperswitch surfaces the mandate under different keys depending on the
// connector, the API version, and whether you're reading a webhook payload or a
// retrieve response. Checked in priority order.
const MANDATE_ACCESSORS = [
  (p) => p.mandate_id,
  (p) => p.connector_mandate_id,
  (p) => p.payment_method_data?.connector_mandate_id,
  (p) => p.payment_method_data?.card?.connector_mandate_id,
  (p) => p.mandate_data?.mandate_id,
  (p) => p.recurring_details?.data,
];

export function extractMandateId(payment = {}) {
  for (const get of MANDATE_ACCESSORS) {
    let value;
    try {
      value = get(payment);
    } catch {
      value = undefined;
    }
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

// Normalizes either payload shape into the facts we act on.
export function extractPaymentFacts(payment = {}) {
  return {
    paymentId: payment.payment_id || payment.id || null,
    status: payment.status || null,
    customerId: payment.customer_id || payment.customer?.id || null,
    mandateId: extractMandateId(payment),
    amount: payment.amount,
    currency: payment.currency,
    // Not a mandate, but the strongest signal that the card network actually
    // registered the credential. Useful when the mandate looks missing.
    networkTransactionId: payment.network_transaction_id || null,
    setupFutureUsage: payment.setup_future_usage || null,
  };
}

/**
 * Single place that records a payment outcome and decides whether the
 * subscription is billable. Called by the webhook AND the poll fallback.
 *
 * @param {object} payment  raw payment object from webhook or retrieve
 * @param {string} source   "webhook" | "poll", for logs
 * @param {string} planName plan label stored on the subscription
 */
export function applyPaymentOutcome(payment, { source = "unknown", planName } = {}) {
  const facts = extractPaymentFacts(payment);
  const { paymentId, status, customerId, mandateId } = facts;

  if (!paymentId) return { applied: false, activated: false };

  // upsertPayment never clobbers an existing mandate with null, so calling this
  // from both paths is safe and order-independent.
  upsertPayment({
    paymentId,
    customerId,
    status,
    amount: facts.amount,
    currency: facts.currency,
    mandateId,
  });

  if (status !== "succeeded") return { applied: true, activated: false, facts };

  // Fall back to what the other path may already have stored. This is what lets
  // a payment self-heal when the mandate shows up on a later read.
  const stored = getPayment(paymentId);
  const resolvedCustomer = customerId || stored?.customer_id || null;
  const resolvedMandate = mandateId || stored?.mandate_id || null;

  if (!resolvedCustomer) {
    console.warn(`[${source}] payment ${paymentId} succeeded but has no customer_id; cannot activate`);
    return { applied: true, activated: false, facts };
  }

  // Activate either way: the payment genuinely succeeded and the customer paid.
  // But say loudly when it isn't billable, because that's the failure that
  // silently produces a subscriber you can never charge again.
  activateSubscription(resolvedCustomer, resolvedMandate, planName);

  if (!resolvedMandate) {
    console.warn(
      `[${source}] payment ${paymentId} SUCCEEDED WITHOUT A MANDATE ` +
        `(customer=${resolvedCustomer}, setup_future_usage=${facts.setupFutureUsage}, ` +
        `network_transaction_id=${facts.networkTransactionId ?? "none"}). ` +
        `Subscription is active but NOT billable off-session.`
    );
    return { applied: true, activated: true, billable: false, facts };
  }

  console.log(`[${source}] subscription activated for ${resolvedCustomer} (mandate ${resolvedMandate})`);
  return { applied: true, activated: true, billable: true, facts };
}
