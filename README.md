# Aster & Co. — retail checkout on Juspay Hyperswitch

A minimal US retail storefront that takes a customer from product page through
to a real, completed card payment in the Hyperswitch **sandbox**.

```
subbox-hyperswitch/
├── backend/
│   ├── server.js        Express app: API + webhook + serves the storefront
│   ├── hyperswitch.js   REST wrapper (secret key lives here, server-side only)
│   ├── db.js            JSON-file store: customers, payments, orders
│   ├── inspect.js       Diagnostic: dump a raw payment from Hyperswitch
│   └── .env.example     Copy to .env and add your sandbox keys
├── frontend/
│   ├── index.html       Product page + shipping address + order total
│   ├── checkout.html    Unified Checkout (publishable key + client_secret)
│   └── return.html      Polls until confirmed — never trusts the client result
└── render.yaml          One-service deploy config
```

## The flow

1. **Product page** collects email and a US shipping address.
2. **Server prices the order.** Subtotal, sales tax, shipping and total are all
   computed server-side. The client never sends an amount.
3. **Create customer, then payment.** `order_details` and `shipping` go with it
   so the processor and any downstream risk checks see what was bought.
4. **Unified Checkout** collects the card in the browser. Card data never
   touches our server, which keeps the PCI scope minimal.
5. **3DS handled.** The flow expects a redirect/challenge, not just instant
   success.
6. **Webhook is the source of truth.** Only a `succeeded` webhook marks the
   order paid. The return page shows "processing" until then, with a polling
   fallback that reconciles if the webhook is delayed.

## Run it locally

Requires **Node 18+**.

```bash
cd backend
npm install
cp .env.example .env      # add your sandbox API key + publishable key
npm start                 # http://localhost:4000
```

### Two dashboard steps that are easy to miss

1. **Configure a connector in test mode.** A payment has nowhere to route until
   you add a processor under *Connectors* and enable **Cards** on it.
2. **Point the webhook at your backend.** Hyperswitch can't reach `localhost`,
   so tunnel it with `ngrok http 4000`, set the dashboard webhook URL to
   `https://<tunnel>/webhooks/hyperswitch`, use the same signing secret as
   `HYPERSWITCH_WEBHOOK_SECRET`, and set `PUBLIC_BASE_URL` to the tunnel URL.

   Without this the payment still succeeds, but the return page relies on the
   polling fallback rather than the webhook.

## Test cards

| Path | Card |
|------|------|
| Success | `4242 4242 4242 4242` |
| 3DS challenge | `4000 0000 0000 3220` |

Any future expiry, any 3-digit CVC.

## Integration modes

`CHECKOUT_MODE` switches how the card is collected:

| Mode | How | When to use |
|------|-----|-------------|
| `embedded` (default) | We mount Unified Checkout with the `client_secret` | Full control of checkout UI and branding |
| `hosted` | Redirect to a Hyperswitch payment link | Fallback if the SDK can't run in an environment |

The SDK does not render on `localhost` (a `403` on its locale asset and a failed
wallet manifest fetch), so `hosted` is the practical mode for local testing and
`embedded` for the deployed site.

## Deploy

Single Express service, serves the frontend too.

1. Push to GitHub.
2. Render → New → Blueprint → pick the repo. It reads `render.yaml`.
3. Set secrets in the Render dashboard: `HYPERSWITCH_API_KEY`,
   `HYPERSWITCH_PUBLISHABLE_KEY`, `HYPERSWITCH_WEBHOOK_SECRET`.
4. After the first deploy, set `PUBLIC_BASE_URL` to the live URL and redeploy.
5. Point the Hyperswitch webhook at `https://<your-app>/webhooks/hyperswitch`.

`store.json` lives on the container filesystem and resets on redeploy. Fine for
a prototype; use Postgres for anything real.

## Built vs deferred

**Built:** product page, server-side order pricing with US sales tax, shipping
address capture, customer + payment creation, Unified Checkout, 3DS handling,
signed idempotent webhooks, idempotency keys on payment creation, a polling
reconciliation fallback, and order state persistence.

**Deferred, with reasoning:**

- **Refunds and cancellations.** The API call is implemented in
  `hyperswitch.js` but not exposed in a UI. Retail needs this, but early volume
  is low enough to handle from the Hyperswitch dashboard.
- **Auth now, capture on fulfilment.** This prototype captures automatically
  because the item ships immediately. For backordered or made-to-order goods
  you'd use `capture_method: "manual"` and capture at shipment, which also
  avoids refund fees on cancellations.
- **Wallets (Apple Pay / Google Pay).** Meaningful conversion lift in US
  retail, but they need domain registration and a reachable merchant manifest,
  so they're a deployment-gated task rather than a code one.
- **Real tax calculation.** Flat rate here. US sales tax is destination-based
  and varies by state and locality, so production would call Avalara or TaxJar.
- **Smart routing across processors.** Hyperswitch's core strength, but
  pointless with one connector and no volume. It becomes valuable once there's
  enough traffic to measure per-processor auth rates and cost.
- **Inventory holds, address validation, saved cards for repeat buyers.**
  Standard retail concerns, all out of scope for a single-product prototype.

## Note on connectors

Sandbox connector capability varies more than the API surface suggests. The
dummy connectors process payments but don't implement the full mandate/stored
credential lifecycle, and the real Stripe connector rejects raw card data
server-side unless the account has been granted access (which requires PCI DSS
SAQ D). Worth verifying connector capability early rather than assuming the API
accepting a field means the processor honors it.
