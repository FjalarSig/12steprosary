# Order notification webhook

`api/rapyd-webhook.js` receives Rapyd payment events and, as soon as a payment is
captured:

1. emails the full order (name, shipping address, quantity, amount, VAT split,
   payment id) to the shop owner;
2. creates the official VAT invoice in **Payday** (`api/payday.js`) — 24% VAT for
   Iceland, 0% for USA exports — with `sendEmail`, so **Payday emails the finished,
   numbered invoice PDF to the customer**; and
3. emails the customer a short bilingual order confirmation (no attachment — the
   invoice comes from Payday in its own email).

Payday assigns the invoice number asynchronously and the create response carries
no number, so the webhook cannot fetch a usable PDF to attach itself — hence
Payday does the invoice email. Without this webhook, orders only exist in the
Rapyd dashboard.

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
Resend  ──email──►  ORDER_NOTIFY_EMAIL           (reply-to = customer)
Payday  ──create(sendEmail)──►  customer         (official numbered invoice PDF)
Gmail   ──email──►  customer                     (short order confirmation)
```

The shipping details come from the `metadata` that `api/create-checkout.js`
attaches to the checkout (`name`, `email`, `address`, `postcode`, `city`,
`state`, `country`, `destination`, `quantity`, `lang`); Rapyd copies it onto the
resulting payment. `country` / `destination` is `IS` or `US`; USA orders carry a
`state` and a 5-digit ZIP in `postcode`, are shipped for a flat 1.070 ISK, and are
invoiced at 0% VAT (export).

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
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | no | Gmail account + [app password](https://myaccount.google.com/apppasswords) used to send the customer confirmation (with the invoice PDF). If unset, the customer copy is skipped; the owner email still goes out via Resend. |
| `PAYDAY_CLIENT_ID` | no | Payday API application id. Payday → **Company settings → API → create application**, then **Endurnýja** to reveal a secret and **Staðfesta** to activate. If unset, invoice creation is skipped and the owner email says so. |
| `PAYDAY_CLIENT_SECRET` | no | The secret from that screen (shown once — copy it before confirming). |
| `PAYDAY_BASE_URL` | no | `https://api.payday.is` (default, production) or `https://api.test.payday.is` (a separate sandbox signup at `app.test.payday.is`). |
| `PAYDAY_PAYMENT_TYPE_ID` | no | GUID of the payment type to book the invoice as **paid** (the order is already paid via Rapyd). `GET /sales/paymenttypes` lists them, or Payday → **Sala → Greiðslumátar**. If unset, the invoice is still created and emailed, but as unpaid — the owner email flags it to be marked paid by hand. |
| `PAYDAY_PRODUCT_ID` | no | GUID of the registered "Tólf spora talnaband" product (`GET /products`, or Payday → **Sala → Vörur**). When set, the rosary line links to it so the sale shows under the product and decrements its stock. The line still sends its own price and `vatPercentage` (so USA export lines stay 0% on the 24% product). Unset = free-text line, no stock movement. Shipping is always a free-text line. |

Redeploy after adding variables — Vercel functions do not pick up new env vars
until the next deploy.

### Payday invoice notes

- Prices on the site are VAT-inclusive; invoice lines use `unitPriceIncludingVat`
  with `vatPercentage` 24 (Iceland) or 0 (USA export). The formal VSK-report
  classification of export turnover (undanþegin velta) is a Payday
  account-setting / accountant matter, not handled in code.
- The seller's VSK-númer and kennitala print on the invoice automatically from the
  Payday account — nothing is hard-coded.
- Customers are matched by email (`GET /customers/search`) and reused, else created
  without a kennitala (foreign-style customer — fine for B2C retail). The invoice
  language follows the order language (`is` / `en`).
- The whole Payday step is best-effort: on any failure it is logged, the owner
  email says `Payday invoice: FAILED — create manually`, and the webhook still
  returns `200` (so Rapyd does not retry and double-invoice). All Payday calls
  time out after 8 s.

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
