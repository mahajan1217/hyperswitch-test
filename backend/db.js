// Tiny persistent store backed by a JSON file. Zero dependencies (no native
// build), works on any Node 18+. The point isn't the storage engine: it's that
// state (customer_id, mandate_id, status) survives a restart, so the recurring
// charge for month two has something to reference. Swap for Postgres in prod.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "store.json");

const empty = { customers: {}, payments: {}, subscriptions: {} };

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

export function upsertPayment({ paymentId, customerId, status, amount, currency, mandateId }) {
  const prev = data.payments[paymentId] || {};
  data.payments[paymentId] = {
    payment_id: paymentId,
    customer_id: customerId ?? prev.customer_id,
    status,
    amount: amount ?? prev.amount,
    currency: currency ?? prev.currency,
    // Never clobber a real mandate_id with null on a later update.
    mandate_id: mandateId ?? prev.mandate_id ?? null,
    updated_at: new Date().toISOString(),
  };
  save();
}

export function getPayment(paymentId) {
  return data.payments[paymentId] || null;
}

export function activateSubscription(customerId, mandateId, plan = "monthly-box") {
  const prev = data.subscriptions[customerId] || {};
  data.subscriptions[customerId] = {
    customer_id: customerId,
    status: "active",
    mandate_id: mandateId ?? prev.mandate_id ?? null,
    plan,
    updated_at: new Date().toISOString(),
  };
  save();
}

export function setSubscriptionPending(customerId, plan = "monthly-box") {
  const prev = data.subscriptions[customerId];
  if (prev?.status === "active") return; // don't downgrade an active sub
  data.subscriptions[customerId] = {
    customer_id: customerId,
    status: "pending",
    mandate_id: prev?.mandate_id ?? null,
    plan,
    updated_at: new Date().toISOString(),
  };
  save();
}

export function getSubscription(customerId) {
  return data.subscriptions[customerId] || null;
}

export default { load, save };
