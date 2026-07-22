// Diagnostic only. NOT part of the app.
//
// Question this answers: does the configured connector actually create an
// off-session mandate when we send mandate_data, independent of any UI?
//
// It creates AND confirms a payment server-side with a sandbox test card, so
// there is no payment link and no web SDK in the path. If a mandate appears
// here, the connector supports mandates and our UI path is what's dropping them.
// If it does NOT appear here, the connector itself can't do card MIT.
//
// 3DS is disabled for this test so it completes without a challenge.
//
// Optionally force a specific connector so routing doesn't pick for you:
//   node mandateTest.js              -> let Hyperswitch route
//   node mandateTest.js stripe       -> force Stripe
//   node mandateTest.js paypal_test  -> force PayPal, for comparison
import "dotenv/config";

// Hyperswitch expects routing.data as an OBJECT. Passing a bare connector name
// is silently ignored and routing falls back to the default connector, which is
// why an earlier run asked for stripe and still landed on paypal_test.
// Accept "stripe mca_x" as one quoted arg or two separate args.
const argv = process.argv.slice(2).join(" ").trim().split(/\s+/).filter(Boolean);
const forceConnector = argv[0] || null;
const forceMca = argv[1] || null; // mca_... from the dashboard

const BASE_URL = process.env.HYPERSWITCH_BASE_URL || "https://sandbox.hyperswitch.io";
const API_KEY = process.env.HYPERSWITCH_API_KEY;

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const plusYears = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d;
};

// Mandates require a customer. Create one first (error IR_16 otherwise).
const custRes = await fetch(`${BASE_URL}/customers`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "api-key": API_KEY },
  body: JSON.stringify({ email: "mandate-test@example.com", description: "mandate diagnostic" }),
});
const cust = await custRes.json();
const customerId = cust.customer_id || cust.id;
if (!customerId) {
  console.error("Could not create customer:", JSON.stringify(cust, null, 2));
  process.exit(1);
}
console.log("customer_id        :", customerId);

const body = {
  amount: 2499,
  currency: "USD",
  confirm: true, // confirm inline, no UI
  capture_method: "automatic",
  authentication_type: "no_three_ds", // avoid a challenge in this diagnostic
  setup_future_usage: "off_session",
  customer_id: customerId,
  email: "mandate-test@example.com",
  // Pin the connector so routing can't silently send us back to PayPal.
  ...(forceConnector
    ? {
        routing: {
          type: "single",
          data: {
            connector: forceConnector,
            ...(forceMca ? { merchant_connector_id: forceMca } : {}),
          },
        },
      }
    : {}),
  payment_method: "card",
  payment_method_type: "credit",
  payment_method_data: {
    card: {
      card_number: "4242424242424242",
      card_exp_month: "12",
      card_exp_year: "30",
      card_holder_name: "Test Customer",
      card_cvc: "123",
    },
  },
  mandate_data: {
    customer_acceptance: {
      acceptance_type: "online",
      accepted_at: iso(new Date()),
      // Stripe requires ip_address for online mandate acceptance (IR_04 without
      // it). PayPal did not, which is why earlier runs returned 200 and no
      // mandate. Documentation-range IP is fine for a sandbox diagnostic.
      online: { ip_address: "203.0.113.1", user_agent: "mandate-diagnostic" },
    },
    mandate_type: {
      multi_use: {
        amount: 2499,
        currency: "USD",
        start_date: iso(new Date()),
        end_date: iso(plusYears(3)),
      },
    },
  },
};

const res = await fetch(`${BASE_URL}/payments`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "api-key": API_KEY },
  body: JSON.stringify(body),
});

const p = await res.json();

console.log("\n=== result ===");
console.log("requested connector:", forceConnector ?? "(routing decides)");
console.log("requested mca      :", forceMca ?? "(none)");
console.log("http status        :", res.status);
console.log("payment_id         :", p.payment_id ?? "(none)");
console.log("status             :", p.status ?? "(none)");
console.log("connector          :", p.connector ?? "(none)");
console.log("setup_future_usage :", p.setup_future_usage ?? "(none)");
console.log("mandate_id         :", p.mandate_id ?? "(absent)");
console.log("connector_mandate_id:", p.connector_mandate_id ?? "(absent)");
console.log(
  "eligible_for_mit   :",
  p.payment_method_tokenization_details?.is_eligible_for_mit_payment ?? "(absent)"
);
if (p.error_message || p.error_code) {
  console.log("error              :", p.error_code, p.error_message);
}

console.log("\n=== verdict ===");
if (!res.ok || p.error) {
  console.log(`Request rejected (HTTP ${res.status}). Not a connector verdict, the request itself was invalid:`);
  console.log("  ", p.error?.code, "-", p.error?.message);
} else if (p.status === "failed") {
  console.log(`Payment FAILED, so mandate creation never got a chance. Not a mandate verdict.`);
  console.log("   reason:", p.error_message || p.error_details?.connector_details?.reason);
  if (p.setup_future_usage === "off_session") {
    console.log("   NOTE: setup_future_usage survived as off_session on this connector.");
    console.log("   That is the signal that matters. This connector honors recurring intent.");
  }
} else if (p.mandate_id || p.connector_mandate_id) {
  console.log("Connector DOES create mandates. The UI/payment-link path is dropping them.");
} else if (p.setup_future_usage !== "off_session") {
  console.log("setup_future_usage was downgraded even server-side -> connector/profile limitation.");
} else {
  console.log("No mandate created despite off_session -> this connector likely can't do card MIT.");
}

console.log("\n=== full response ===");
console.log(JSON.stringify(p, null, 2));
