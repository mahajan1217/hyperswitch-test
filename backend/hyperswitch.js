// Thin wrapper around the Hyperswitch REST API. The secret key lives here,
// server-side, and is sent as the `api-key` header. The browser never sees it.
import crypto from "crypto";

const BASE_URL = process.env.HYPERSWITCH_BASE_URL || "https://sandbox.hyperswitch.io";
const API_KEY = process.env.HYPERSWITCH_API_KEY;

async function hsFetch(path, { method = "POST", body, idempotencyKey } = {}) {
  if (!API_KEY || API_KEY.includes("replace_me")) {
    throw new Error(
      "HYPERSWITCH_API_KEY is not set. Copy .env.example to .env and add your sandbox keys."
    );
  }
  const headers = {
    "Content-Type": "application/json",
    "api-key": API_KEY,
  };
  // Idempotency key stops a double-submit from creating two charges.
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || res.statusText;
    const err = new Error(`Hyperswitch ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Create a customer so orders and receipts have a stable id to hang off.
export function createCustomer({ email }) {
  return hsFetch("/customers", {
    body: {
      email,
      description: "Retail customer",
    },
  });
}

// One-time payment for a physical-goods order.
//
// `usePaymentLink` selects the integration mode:
//   false (embedded) -> return client_secret, we mount Unified Checkout.
//   true  (hosted)   -> Hyperswitch-hosted page, we redirect to payment_link.link.
//
// Notes on the retail-specific choices here:
//  - capture_method "automatic": the order ships immediately, so there's no
//    reason to hold an authorization. Auth-now/capture-on-fulfilment is the
//    right call for made-to-order or backordered goods (see README).
//  - authentication_type "three_ds": lets the issuer challenge. US cards often
//    won't, but the flow must handle it rather than assume instant success.
//  - order_details + shipping are sent so the processor and any downstream
//    risk/fraud checks see what was actually bought and where it's going.
export function createOrderPayment({
  amount,
  currency,
  customerId,
  returnUrl,
  idempotencyKey,
  profileId,
  usePaymentLink = false,
  product,
  shipping,
  email,
}) {
  return hsFetch("/payments", {
    idempotencyKey,
    body: {
      amount, // minor units, total incl. tax
      currency, // "USD"
      customer_id: customerId,
      email,
      confirm: false, // confirmed client-side (embedded) or on the hosted page
      capture_method: "automatic",
      authentication_type: "three_ds",
      return_url: returnUrl,
      description: product ? `Order: ${product.name}` : "Retail order",
      ...(profileId ? { profile_id: profileId } : {}),
      ...(usePaymentLink
        ? {
            payment_link: true,
            payment_link_config: {
              seller_name: "Aster & Co.",
              sdk_layout: "accordion",
              show_card_form_by_default: true,
            },
          }
        : {}),
      ...(product
        ? {
            order_details: [
              {
                product_name: product.name,
                quantity: 1,
                amount: product.price,
              },
            ],
          }
        : {}),
      ...(shipping ? { shipping } : {}),
    },
  });
}

// Poll fallback: if a webhook is missed, we can still reconcile the real status.
export function retrievePayment(paymentId) {
  return hsFetch(`/payments/${paymentId}?force_sync=true`, { method: "GET" });
}

// Refunds. Not wired into a UI in this prototype, but the call is here because
// refunds are table stakes for retail and it's a one-liner to expose.
export function refundPayment({ paymentId, amount, reason, idempotencyKey }) {
  return hsFetch("/refunds", {
    idempotencyKey,
    body: {
      payment_id: paymentId,
      ...(amount ? { amount } : {}), // omit for a full refund
      reason: reason || "requested_by_customer",
    },
  });
}

// Verify a webhook actually came from Hyperswitch by checking the HMAC signature
// against our shared secret. Never trust an unverified webhook.
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const expected256 = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Hyperswitch may sign with sha512 or sha256 depending on config; accept either.
  return timingSafeEqual(signatureHeader, expected) || timingSafeEqual(signatureHeader, expected256);
}

function timingSafeEqual(a, b) {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
