// Thin wrapper around the Hyperswitch REST API. The secret key lives here,
// server-side, and is sent as the `api-key` header. The browser never sees it.
import crypto from "crypto";

const BASE_URL = process.env.HYPERSWITCH_BASE_URL || "https://sandbox.hyperswitch.io";
const API_KEY = process.env.HYPERSWITCH_API_KEY;

// Hyperswitch expects ISO 8601 without milliseconds, e.g. 2026-07-22T05:40:08Z
function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function yearsFromNow(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d;
}

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

// Create a customer so saved payment methods / future charges have a stable id.
export function createCustomer({ email }) {
  return hsFetch("/customers", {
    body: {
      email,
      description: "Subscription box customer",
    },
  });
}

// The core call. This is a mandate-creating first payment: it charges the first
// box AND stores the card as a reusable mandate, in one step. That consent
// (setup_future_usage + mandate_data) has to be on the first payment, or there
// is no network-valid way to bill month two.
// `usePaymentLink` selects the integration mode:
//   false (embedded) -> return client_secret, mount Unified Checkout ourselves.
//                       Carries mandate_data through to confirm, so this is the
//                       mode that actually produces an off-session mandate.
//   true  (hosted)   -> Hyperswitch-hosted page. Robust to SDK/CDN issues, but
//                       its own confirm step drops our mandate_data, which
//                       downgrades setup_future_usage to on_session.
export function createFirstPayment({
  amount,
  currency,
  customerId,
  returnUrl,
  idempotencyKey,
  profileId,
  usePaymentLink = false,
  customerIp,
  userAgent,
}) {
  return hsFetch("/payments", {
    idempotencyKey,
    body: {
      amount, // minor units, e.g. 2499 = $24.99
      currency, // "USD"
      customer_id: customerId,
      confirm: false, // confirmed client-side (embedded) or on the hosted page
      ...(profileId ? { profile_id: profileId } : {}),
      ...(usePaymentLink
        ? {
            payment_link: true,
            payment_link_config: {
              seller_name: "Kindred",
              sdk_layout: "accordion",
              show_card_form_by_default: true,
            },
          }
        : {}),
      capture_method: "automatic",
      authentication_type: "three_ds", // let the issuer challenge if it wants
      setup_future_usage: "off_session", // we will charge again with no customer present
      return_url: returnUrl,
      // Ask the network for permission to charge this card on a recurring basis.
      // multi_use needs an explicit validity window (start_date/end_date). Without
      // it the mandate can be rejected, which shows up as mandate_data: null and
      // setup_future_usage silently downgraded to on_session.
      mandate_data: {
        customer_acceptance: {
          acceptance_type: "online",
          accepted_at: isoSeconds(new Date()),
          // ip_address is REQUIRED by some connectors (Stripe rejects with
          // IR_04 without it). It's also the audit trail proving the customer
          // consented to recurring billing, so it belongs here regardless.
          online: {
            ip_address: customerIp || "0.0.0.0",
            user_agent: userAgent || "subbox-prototype",
          },
        },
        mandate_type: {
          multi_use: {
            amount,
            currency,
            start_date: isoSeconds(new Date()),
            end_date: isoSeconds(yearsFromNow(3)), // subscription runs until canceled
          },
        },
      },
    },
  });
}

// Poll fallback: if a webhook is missed, we can still reconcile the real status.
export function retrievePayment(paymentId) {
  return hsFetch(`/payments/${paymentId}?force_sync=true`, { method: "GET" });
}

// Merchant-initiated (off-session) recurring charge for renewals. No UI, no
// customer present. References the stored mandate. Used by the renewal job.
export function chargeRecurring({ amount, currency, customerId, mandateId, idempotencyKey }) {
  return hsFetch("/payments", {
    idempotencyKey,
    body: {
      amount,
      currency,
      customer_id: customerId,
      confirm: true,
      off_session: true,
      recurring_details: {
        type: "mandate_id",
        data: mandateId,
      },
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
