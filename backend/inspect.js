// Diagnostic: dump the raw payment object straight from Hyperswitch.
// Use this to see whether a mandate actually exists and under which field,
// rather than guessing from what our store captured.
//
//   node inspect.js <payment_id>
import "dotenv/config";
import { retrievePayment } from "./hyperswitch.js";

const paymentId = process.argv[2];
if (!paymentId) {
  console.error("Usage: node inspect.js <payment_id>");
  process.exit(1);
}

const p = await retrievePayment(paymentId);

console.log("\n=== mandate-related fields ===");
for (const k of [
  "payment_id",
  "status",
  "mandate_id",
  "connector_mandate_id",
  "payment_method",
  "payment_method_id",
  "setup_future_usage",
  "connector",
]) {
  console.log(`${k}:`, p[k] ?? "(absent)");
}

console.log("\n=== full response ===");
console.log(JSON.stringify(p, null, 2));
