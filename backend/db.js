// Tiny persistent store backed by a JSON file. Zero dependencies (no native
// build), works on any Node 18+. The point isn't the storage engine: it's that
// order state survives a restart, so a webhook arriving after a crash still
// finds the order it belongs to. Swap for Postgres in production.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "store.json");

const empty = { customers: {}, payments: {}, orders: {} };

function load() {
  if (!existsSync(FILE)) return structuredClone(empty);
  try {
    return { ...structuredClone(empty), ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return structuredClone(empty);
  }
}

let data = load();

function save() {
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function upsertCustomer(customerId, email) {
  data.customers[customerId] = {
    customer_id: customerId,
    email,
    created_at: data.customers[customerId]?.created_at || new Date().toISOString(),
  };
  save();
}

export function upsertPayment({ paymentId, customerId, status, amount, currency }) {
  const prev = data.payments[paymentId] || {};
  data.payments[paymentId] = {
    payment_id: paymentId,
    customer_id: customerId ?? prev.customer_id,
    status,
    amount: amount ?? prev.amount,
    currency: currency ?? prev.currency,
    updated_at: new Date().toISOString(),
  };
  save();
}

export function getPayment(paymentId) {
  return data.payments[paymentId] || null;
}

// Orders are keyed by payment_id: one payment, one order, for this prototype.
export function createOrder({ paymentId, customerId, email, product, amount, shipping }) {
  data.orders[paymentId] = {
    payment_id: paymentId,
    customer_id: customerId,
    email,
    product,
    amount,
    shipping: shipping || null,
    status: "pending_payment",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  save();
}

export function markOrderPaid(paymentId) {
  const o = data.orders[paymentId];
  if (!o) return null;
  o.status = "paid";
  o.updated_at = new Date().toISOString();
  save();
  return o;
}

export function markOrderFailed(paymentId) {
  const o = data.orders[paymentId];
  if (!o) return null;
  o.status = "payment_failed";
  o.updated_at = new Date().toISOString();
  save();
  return o;
}

export function getOrder(paymentId) {
  return data.orders[paymentId] || null;
}

export default { load, save };
