import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  createCustomer,
  createOrderPayment,
  retrievePayment,
  verifyWebhookSignature,
} from "./hyperswitch.js";
import {
  upsertCustomer,
  upsertPayment,
  getPayment,
  createOrder,
  markOrderPaid,
  markOrderFailed,
  getOrder,
} from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
// Strip any trailing slash so `${PUBLIC_BASE_URL}/return.html` can't become a
// double slash. Easy to get wrong when pasting a URL into a host dashboard.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const PUBLISHABLE_KEY = process.env.HYPERSWITCH_PUBLISHABLE_KEY || "";
const WEBHOOK_SECRET = process.env.HYPERSWITCH_WEBHOOK_SECRET || "";

// The single product this storefront sells.
const PRODUCT = {
  name: "Aster Table Lamp",
  blurb: "Hand-finished oak base with a linen shade. Warm dimmable LED included.",
  price: 12900, // $129.00 in minor units
  currency: "USD",
};

// US retail reality: sales tax is destination-based and varies by state, so it
// has to be computed server-side per order, never trusted from the client.
// A real store would call a tax service (Avalara/TaxJar). Flat rate here.
const TAX_RATE = 0.0875;
const SHIPPING_FEE = 0; // free shipping, kept explicit so the total is auditable

function priceOrder() {
  const subtotal = PRODUCT.price;
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + tax + SHIPPING_FEE;
  return { subtotal, tax, shipping: SHIPPING_FEE, total, currency: PRODUCT.currency };
}

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
    handleWebhookEvent(JSON.parse(rawBody.toString("utf8")));
  } catch (e) {
    console.error("[webhook] parse error", e.message);
  }
});

function handleWebhookEvent(event) {
  const type = event.event_type || event.type;
  const payment = event.content?.object || event.content?.payment || event.data || {};
  const paymentId = payment.payment_id || payment.id;
  const status = payment.status;

  console.log(`[webhook] ${type} payment=${paymentId} status=${status}`);
  if (!paymentId) return;

  upsertPayment({
    paymentId,
    customerId: payment.customer_id,
    status,
    amount: payment.amount,
    currency: payment.currency,
  });

  // Webhook is the source of truth for fulfilment.
  if (status === "succeeded") {
    const order = markOrderPaid(paymentId);
    if (order) console.log(`[webhook] order paid: ${paymentId} (${order.product?.name})`);
  } else if (status === "failed") {
    markOrderFailed(paymentId);
  }
}

// JSON parser for the rest of the API.
app.use(express.json());

// "embedded" mounts the Unified Checkout SDK ourselves. "hosted" redirects to a
// Hyperswitch payment link. Embedded gives us control of the checkout UI;
// hosted is the fallback if the SDK can't run in a given environment.
const CHECKOUT_MODE = (process.env.CHECKOUT_MODE || "embedded").toLowerCase();

// Behind Render/Railway the real client IP is in x-forwarded-for.
app.set("trust proxy", true);

// Expose the publishable key + priced order to the frontend (safe to share).
app.get("/api/config", (req, res) => {
  res.json({
    publishableKey: PUBLISHABLE_KEY,
    product: PRODUCT,
    pricing: priceOrder(),
    checkoutMode: CHECKOUT_MODE,
    configured: Boolean(PUBLISHABLE_KEY && !PUBLISHABLE_KEY.includes("replace_me")),
  });
});

// Start checkout: create the customer, price the order server-side, create the
// payment. The client never tells us the amount.
app.post("/api/checkout", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const s = req.body?.shipping || {};
    const shipping = s.line1
      ? {
          address: {
            line1: s.line1,
            line2: s.line2 || null,
            city: s.city,
            state: s.state,
            zip: s.zip,
            country: "US",
            first_name: s.firstName || null,
            last_name: s.lastName || null,
          },
        }
      : null;

    const pricing = priceOrder();

    const customer = await createCustomer({ email });
    const customerId = customer.customer_id || customer.id;
    upsertCustomer(customerId, email);

    // Deterministic key so a double-click can't create two charges.
    const idempotencyKey = `order_${customerId}`;

    const payment = await createOrderPayment({
      amount: pricing.total,
      currency: pricing.currency,
      customerId,
      email,
      returnUrl: `${PUBLIC_BASE_URL}/return.html`,
      idempotencyKey,
      profileId: process.env.HYPERSWITCH_PROFILE_ID,
      usePaymentLink: CHECKOUT_MODE === "hosted",
      product: PRODUCT,
      shipping,
    });

    upsertPayment({
      paymentId: payment.payment_id,
      customerId,
      status: payment.status,
      amount: pricing.total,
      currency: pricing.currency,
    });

    createOrder({
      paymentId: payment.payment_id,
      customerId,
      email,
      product: { name: PRODUCT.name, price: PRODUCT.price },
      amount: pricing.total,
      shipping,
    });

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
      return res.json({ paymentLinkUrl: link, paymentId: payment.payment_id });
    }

    // Embedded mode: the browser mounts Unified Checkout with the client_secret.
    res.json({
      clientSecret: payment.client_secret,
      paymentId: payment.payment_id,
    });
  } catch (e) {
    console.error("[checkout] error", e.message, e.body || "");
    res.status(e.status || 500).json({ error: e.message, details: e.body });
  }
});

// Poll fallback for the return page: reconcile status if the webhook is late.
app.get("/api/payment/:id", async (req, res) => {
  const paymentId = req.params.id;
  try {
    let record = getPayment(paymentId);
    if (!record || (record.status !== "succeeded" && record.status !== "failed")) {
      const live = await retrievePayment(paymentId);
      upsertPayment({
        paymentId: live.payment_id,
        customerId: live.customer_id,
        status: live.status,
        amount: live.amount,
        currency: live.currency,
      });
      if (live.status === "succeeded") markOrderPaid(live.payment_id);
      if (live.status === "failed") markOrderFailed(live.payment_id);
      record = getPayment(paymentId);
    }
    const order = getOrder(paymentId);
    res.json({
      paymentId,
      status: record?.status || "unknown",
      order: order
        ? { status: order.status, product: order.product, amount: order.amount }
        : null,
    });
  } catch (e) {
    console.error("[payment status] error", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Serve the static storefront.
app.use(express.static(join(__dirname, "..", "frontend")));

app.listen(PORT, () => {
  console.log(`\n  Aster & Co. storefront running: ${PUBLIC_BASE_URL}`);
  console.log(`  Checkout mode: ${CHECKOUT_MODE}`);
  if (!PUBLISHABLE_KEY || PUBLISHABLE_KEY.includes("replace_me")) {
    console.log("  ⚠  No keys set yet. Copy backend/.env.example to backend/.env and add sandbox keys.");
  }
  console.log(`  Webhook endpoint: ${PUBLIC_BASE_URL}/webhooks/hyperswitch\n`);
});
