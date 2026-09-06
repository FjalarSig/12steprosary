# Order notification webhook

`api/rapyd-webhook.js` receives Rapyd payment events and emails the full order
(name, shipping address, quantity, amount, payment id) to the shop owner as soon
as a payment is captured. Without it, orders only exist in the Rapyd dashboard.

## Flow

```
customer pays on Rapyd hosted page
        │
        ▼
Rapyd  ──POST──►  https://12steprosary.vercel.app/api/rapyd-webhook
        │            • verifies the Rapyd signature
        │            • ignores everything except PAYMENT_COMPLETED
        │            • reads shipping details from payment.metadata
        ▼
Resend  ──email──►  ORDER_NOTIFY_EMAIL  (reply-to = customer)
```

The shipping details come from the `metadata` that `api/create-checkout.js`
attaches to the checkout (`name`, `email`, `address`, `postcode`, `city`,
`quantity`); Rapyd copies it onto the resulting payment.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Notes |
| --- | --- | --- |
| `RAPYD_ACCESS_KEY` | yes | Already set for `create-checkout.js`. |
| `RAPYD_SECRET_KEY` | yes | Already set. Used to verify the webhook signature. |
| `RESEND_API_KEY` | yes | Create at <https://resend.com> → API Keys. |
| `ORDER_NOTIFY_EMAIL` | no | Where order emails go. Default `fjalar@fjalarsig.is`. |
| `ORDER_FROM_EMAIL` | no | Sender. Default `The 12-Step Rosary <onboarding@resend.dev>` (works only for sending to the Resend account owner). For production, verify a domain in Resend and set e.g. `orders@12steprosary.com`. |
| `RAPYD_WEBHOOK_URL` | no | Full webhook URL exactly as entered in the Rapyd dashboard. Only needed if signature verification fails because the auto-detected host differs (custom domain, trailing slash). |
| `RAPYD_WEBHOOK_SKIP_VERIFY` | no | Set to `true` to bypass signature checks (not recommended; only for debugging). |

Redeploy after adding variables.

## Register the webhook in Rapyd

1. Rapyd dashboard → **Developers → Webhooks → Add Webhook** (do this in both
   Sandbox and Production as needed).
2. URL: `https://12steprosary.vercel.app/api/rapyd-webhook`
3. Events: at minimum **Payment Completed** (`PAYMENT_COMPLETED`). Adding
   Payment Capture / Payment Succeeded is harmless — the handler de-duplicates
   by acting only on captured payments.
4. Save, then use Rapyd's **Send test** button. You should get an email within a
   few seconds and a `200 {"ok":true}` (a test event with no `metadata` still
   emails, with blank address fields).

## Behaviour notes

- Non-payment events and uncaptured payments get `200 {"ok":true,"ignored":...}`
  so Rapyd stops retrying them.
- If the email send fails, the handler returns `500` so Rapyd retries later — the
  order is not silently dropped.
- There is no database, so a duplicate webhook delivery = a duplicate email.
  Rapyd rarely does this; treat a repeat as the same order (same `Reference`).
- Logs: Vercel → Project → **Logs**, filter for `rapyd-webhook`.
