import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  createCustomer,
  createFirstPayment,
  retrievePayment,
  verifyWebhookSignature,
} from "./hyperswitch.js";
import {
  upsertCustomer,
  upsertPayment,
  getPayment,
  activateSubscription,
  setSubscriptionPending,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PUBLISHABLE_KEY = process.env.HYPERSWITCH_PUBLISHABLE_KEY || "";
const WEBHOOK_SECRET = process.env.HYPERSWITCH_WEBHOOK_SECRET || "";

// The single product this prototype sells.
const PLAN = {
  name: "The Monthly Box",
  amount: 2499, // $24.99 in minor units
  currency: "USD",
};

// Webhook route needs the RAW body for signature verification, so register it
// BEFORE the json body parser.
app.post("/webhooks/hyperswitch", express.raw({ type: "*/*" }), (req, res) => {
  const rawBody = req.body; // Buffer
  const signature =
    req.get("x-webhook-signature") ||
    req.get("x-webhook-signature-512") ||
    req.get("x-signature") ||
    "";

  const ok = verifyWebhookSignature(rawBody.toString("utf8"), signature, WEBHOOK_SECRET);
  if (!ok) {
    console.warn("[webhook] rejected: bad or missing signature");
    return res.status(401).send("invalid signature");
  }

  // Respond 2xx fast, then process. Handlers must be idempotent because the
  // same event can arrive more than once.
  res.status(200).send("ok");

  try {
    const event = JSON.parse(rawBody.toString("utf8"));
    handleWebhookEvent(event);
  } catch (e) {
    console.error("[webhook] parse error", e.message);
  }
});

function handleWebhookEvent(event) {
  const type = event.event_type || event.type;
  const payment = event.content?.object || event.content?.payment || event.data || {};
  const paymentId = payment.payment_id || payment.id;
  const status = payment.status;
  const customerId = payment.customer_id;
  const mandateId = payment.mandate_id || payment.connector_mandate_id || null;

  console.log(`[webhook] ${type} payment=${paymentId} status=${status} mandate=${mandateId}`);

  if (!paymentId) return;

  upsertPayment({
    paymentId,
    customerId,
    status,
    amount: payment.amount,
    currency: payment.currency,
    mandateId,
  });

  // Webhook is the source of truth. Only a succeeded payment activates the sub.
  if (status === "succeeded" && customerId) {
    activateSubscription(customerId, mandateId, PLAN.name);
    console.log(`[webhook] subscription activated for ${customerId} (mandate ${mandateId})`);
  }
}

// JSON parser for the rest of the API.
app.use(express.json());

// "embedded" mounts the Unified Checkout SDK ourselves and preserves the
// off-session mandate. "hosted" redirects to a Hyperswitch payment link, which
// is more robust but drops mandate_data at its confirm step.
const CHECKOUT_MODE = (process.env.CHECKOUT_MODE || "embedded").toLowerCase();

// Behind Render/Railway the real client IP is in x-forwarded-for.
app.set("trust proxy", true);

function clientIp(req) {
  const fwd = req.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0].trim() : req.socket?.remoteAddress || "";
  return ip.replace(/^::ffff:/, "") || "0.0.0.0";
}

// Expose the publishable key + plan to the frontend (safe to share).
app.get("/api/config", (req, res) => {
  res.json({
    publishableKey: PUBLISHABLE_KEY,
    plan: PLAN,
    checkoutMode: CHECKOUT_MODE,
    configured: Boolean(PUBLISHABLE_KEY && !PUBLISHABLE_KEY.includes("replace_me")),
  });
});

// Start the purchase: create customer, then the mandate-creating first payment.
app.post("/api/subscribe", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const customer = await createCustomer({ email });
    const customerId = customer.customer_id || customer.id;
    upsertCustomer(customerId, email);
    setSubscriptionPending(customerId, PLAN.name);

    // Deterministic idempotency key so a double click reuses the same payment.
    const idempotencyKey = `subscribe_${customerId}`;

    const payment = await createFirstPayment({
      amount: PLAN.amount,
      currency: PLAN.currency,
      customerId,
      returnUrl: `${PUBLIC_BASE_URL}/return.html`,
      idempotencyKey,
      profileId: process.env.HYPERSWITCH_PROFILE_ID,
      usePaymentLink: CHECKOUT_MODE === "hosted",
      // Real client IP + UA for the mandate consent record.
      customerIp: clientIp(req),
      userAgent: req.get("user-agent"),
    });

    upsertPayment({
      paymentId: payment.payment_id,
      customerId,
      status: payment.status,
      amount: PLAN.amount,
      currency: PLAN.currency,
      mandateId: payment.mandate_id || payment.connector_mandate_id || null,
    });

    // Warn loudly if the recurring consent didn't survive creation. This is the
    // exact failure that silently produced an on-session card with no mandate.
    if (payment.setup_future_usage && payment.setup_future_usage !== "off_session") {
      console.warn(
        `[subscribe] setup_future_usage came back "${payment.setup_future_usage}" (wanted off_session). ` +
          `This payment will NOT be billable off-session.`
      );
    }

    if (CHECKOUT_MODE === "hosted") {
      const link =
        payment.payment_link?.link ||
        payment.payment_link?.web_url ||
        payment.payment_link?.payment_link ||
        null;

      if (!link) {
        return res.status(500).json({
          error: "No payment_link returned. Enable Payment Links for this profile in the dashboard.",
          details: payment.payment_link || payment,
        });
      }
      return res.json({ paymentLinkUrl: link, paymentId: payment.payment_id, customerId });
    }

    // Embedded mode: the browser mounts Unified Checkout with the client_secret.
    res.json({
      clientSecret: payment.client_secret,
      paymentId: payment.payment_id,
      customerId,
    });
  } catch (e) {
    console.error("[subscribe] error", e.message, e.body || "");
    res.status(e.status || 500).json({ error: e.message, details: e.body });
  }
});

// Poll fallback for the return page: reconcile status if the webhook is late.
app.get("/api/payment/:id", async (req, res) => {
  const paymentId = req.params.id;
  try {
    // Prefer our own store (updated by webhook); fall back to a live sync.
    let record = getPayment(paymentId);
    if (!record || (record.status !== "succeeded" && record.status !== "failed")) {
      const live = await retrievePayment(paymentId);
      upsertPayment({
        paymentId: live.payment_id,
        customerId: live.customer_id,
        status: live.status,
        amount: live.amount,
        currency: live.currency,
        mandateId: live.mandate_id || live.connector_mandate_id || null,
      });
      if (live.status === "succeeded" && live.customer_id) {
        activateSubscription(live.customer_id, live.mandate_id, PLAN.name);
      }
      record = getPayment(paymentId);
    }
    res.json({
      paymentId,
      status: record?.status || "unknown",
      mandateId: record?.mandate_id || null,
    });
  } catch (e) {
    console.error("[payment status] error", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Serve the static storefront.
app.use(express.static(join(__dirname, "..", "frontend")));

app.listen(PORT, () => {
  console.log(`\n  Sub Box prototype running: ${PUBLIC_BASE_URL}`);
  if (!PUBLISHABLE_KEY || PUBLISHABLE_KEY.includes("replace_me")) {
    console.log("  ⚠  No keys set yet. Copy backend/.env.example to backend/.env and add sandbox keys.");
  }
  console.log(`  Webhook endpoint: ${PUBLIC_BASE_URL}/webhooks/hyperswitch\n`);
});
