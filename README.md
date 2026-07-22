# Kindred — subscription box on Juspay Hyperswitch

A minimal storefront that takes a US subscription-box customer from purchase
through to a real, completed payment in the Hyperswitch **sandbox**, and sets up
recurring billing on that first payment.

```
subbox-hyperswitch/
├── backend/
│   ├── server.js        Express app: API + webhook + serves the storefront
│   ├── hyperswitch.js   REST wrapper (secret key lives here, server-side only)
│   ├── db.js            JSON-file store: customers, payments, subscriptions
│   ├── renew.js         Off-session recurring charge (run manually to demo)
│   └── .env.example     Copy to .env and add your sandbox keys
└── frontend/
    ├── index.html       Storefront + start subscription
    ├── checkout.html    Unified Checkout (publishable key + client_secret)
    └── return.html      Polls until the webhook confirms — never trusts the client
```

## The core flow

1. **Create customer** → stable `customer_id`.
2. **Mandate-creating first payment** → charges the first box *and* stores the
   card as a reusable mandate in one step (`setup_future_usage: off_session` +
   `mandate_data`). This is the key decision: recurring consent is captured on
   the first payment, not bolted on later.
3. **3DS handled** → the flow expects `requires_customer_action`/redirect, not
   just instant success.
4. **Webhook is the source of truth** → only a `succeeded` webhook activates the
   subscription. The return page shows "processing" until then.
5. **Mandate stored** → `renew.js` uses it for the off-session monthly charge.

## Run it locally

Requires **Node 18+**.

```bash
# 1. Install
cd backend
npm install

# 2. Configure keys
cp .env.example .env
#   then edit .env and paste your sandbox API key + publishable key
#   (Hyperswitch dashboard → Developers → API Keys)

# 3. Start
npm start
#   → http://localhost:4000
```

### Two setup steps in the Hyperswitch dashboard (easy to miss)

Adding keys is necessary but not sufficient:

1. **Configure a connector in test mode.** A payment has nowhere to route until
   you add at least one processor under *Connectors*. Use a test/dummy connector
   or a real one in test mode. If a connector rejects `mandate_data`, try
   another — not all sandbox connectors support off-session mandates.
2. **Point the webhook at your backend.** localhost isn't reachable by
   Hyperswitch, so tunnel it:

   ```bash
   ngrok http 4000
   ```

   Then in the dashboard set the webhook URL to
   `https://<your-tunnel>/webhooks/hyperswitch` and set the webhook signing
   secret to the same value as `HYPERSWITCH_WEBHOOK_SECRET` in `.env`. Also set
   `PUBLIC_BASE_URL` in `.env` to your tunnel URL so `return_url` matches.

   Without this the payment still succeeds, but the return page sits in
   "processing" because the webhook (your source of truth) never arrives.

## Test cards

| Path | Card | Notes |
|------|------|-------|
| Success (no auth) | `4242 4242 4242 4242` | Clears immediately |
| 3DS challenge | `4000 0000 0000 3220` | Triggers the challenge screen |

Any future expiry (e.g. `12/34`), any 3-digit CVC.

## Verify it worked

The check that matters is a populated `mandate_id`, which proves the first
payment set up recurring billing, not just a one-time charge. State is written
to `backend/store.json`:

```bash
cd backend
cat store.json | python3 -m json.tool   # look at subscriptions[].mandate_id
```

## Demo the recurring charge

```bash
cd backend
node renew.js <customer_id>   # off-session MIT using the stored mandate
```

## Integration modes

Set `CHECKOUT_MODE` in the environment:

| Mode | How it works | Tradeoff |
|------|--------------|----------|
| `embedded` (default) | We mount the Unified Checkout SDK with the `client_secret` | Carries `mandate_data` through to confirm, so it produces a real **off-session mandate**. Needs the SDK to load, which fails on `localhost`. |
| `hosted` | Redirect to a Hyperswitch payment link | Robust, no SDK embedding. But the hosted confirm step drops `mandate_data`, downgrading `setup_future_usage` to `on_session`, so **no mandate is created**. |

This tradeoff was found the hard way: a hosted-mode payment succeeded but came
back with `setup_future_usage: "on_session"`, `mandate_data: null`, and
`is_eligible_for_mit_payment: false`. The card was saved, but not billable
off-session. The server now logs a warning whenever `setup_future_usage` comes
back as anything other than `off_session`.

## Deploy

The app is a single Express service that also serves the storefront, so one
deploy covers everything.

**Render (config included as `render.yaml`):**

1. Push this folder to a GitHub repo.
2. In Render, New → Blueprint, point it at the repo. It reads `render.yaml`.
3. Set the secret env vars in the Render dashboard: `HYPERSWITCH_API_KEY`,
   `HYPERSWITCH_PUBLISHABLE_KEY`, `HYPERSWITCH_WEBHOOK_SECRET`, and optionally
   `HYPERSWITCH_PROFILE_ID`.
4. After the first deploy, set `PUBLIC_BASE_URL` to your live URL
   (e.g. `https://subbox-hyperswitch.onrender.com`) and redeploy so `return_url`
   is correct.
5. In the Hyperswitch dashboard, point the webhook at
   `https://<your-app>/webhooks/hyperswitch` with the same signing secret.

Once deployed, ngrok is no longer needed. The webhook reaches you directly.

Note: `store.json` lives on the container filesystem and resets on redeploy.
Fine for a prototype; use Postgres for anything real.

### Why deploying matters here

The embedded SDK fails on `localhost` (a `403` on the SDK's locale asset and a
failed wallet manifest fetch). Both are typically localhost-only problems. On a
real HTTPS domain, `embedded` mode is expected to work, which is the path that
actually produces the off-session mandate.

## Built vs deferred

**Built:** customer create, mandate-creating first payment, 3DS handling,
signed idempotent webhooks, persistence, poll fallback, and a runnable
off-session renewal script.

**Deferred (with rationale in the decisions doc):** dunning/retry on failed
renewals, smart routing across multiple processors, refunds/cancellations UI,
extra payment methods (Apple/Google Pay, ACH), and proration/plan changes.
# hyperswitch-test
