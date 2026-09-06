const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Must match the pricing in create-checkout.js — used only to split the paid
// total back into "goods" and "shipping" lines for the notification email.
const PRODUCT_PRICE_ISK = 4450;
const SHIPPING_FEE_ISK = 490;

// Rapyd event types that mean "money captured, fulfil the order".
const PAID_EVENTS = ['PAYMENT_COMPLETED', 'PAYMENT_CAPTURE', 'PAYMENT_SUCCEEDED'];

function formatIsk(n) {
  const v = Math.round(Number(n) || 0);
  // Period thousands-separator, matching the rest of the site.
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ISK';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Read the request body byte-for-byte. Rapyd's signature is computed over the
// exact bytes it sent, so a re-serialised object won't always verify.
function readRawBody(req) {
  return new Promise((resolve) => {
    if (req.readableEnded || req.readable === false) return resolve('');
    const chunks = [];
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(''), 3000);
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
  });
}

// Rapyd webhook signature:
//   BASE64( HEX( HMAC-SHA256( secret, urlPath + salt + timestamp + accessKey + secretKey + body ) ) )
// where urlPath is the full webhook URL exactly as configured in the Rapyd dashboard.
function rapydWebhookSignature(urlPath, salt, timestamp, accessKey, secretKey, rawBody) {
  const toSign = urlPath + salt + timestamp + accessKey + secretKey + (rawBody || '');
  return Buffer.from(
    crypto.createHmac('sha256', secretKey).update(toSign).digest('hex')
  ).toString('base64');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

let gmailTransport = null;
function getGmailTransport() {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return gmailTransport;
}

async function sendCustomerConfirmation({ to, name, qty, address, postcode, city }) {
  const transport = getGmailTransport();
  const text = [
    `Sæl/Sæll ${name || ''},`.trim(),
    '',
    'Takk fyrir að panta Tólf spora talnabandið. Greiðslan hefur borist og pöntunin er staðfest.',
    '',
    'Pöntun send á:',
    `${address}, ${postcode} ${city}`,
    '',
    `Fjöldi: ${qty} × Tólf spora talnaband`,
    '',
    'Við sendum pakkann út innan 2-3 virkra daga. Í honum er hraunperluband, flauelspoki, tvö nisti og leiðbeiningar.',
    '',
    'Ef eitthvað er athugavert við heimilisfangið, eða þú hefur spurningar, svaraðu bara þessum tölvupósti.',
    '',
    'Bestu kveðjur,',
    'Fjalar',
    'Fjalar ráðgjöf ehf',
  ].join('\n');

  await transport.sendMail({
    from: `"Fjalar - 12-Step Rosary" <${process.env.GMAIL_USER}>`,
    to,
    subject: 'Pöntun móttekin — Tólf spora talnabandið',
    text,
  });
}

async function sendEmail({ apiKey, from, to, replyTo, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo || undefined,
      subject,
      html,
      text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('resend_failed');
    err.detail = data;
    throw err;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_input' });
    return;
  }

  const accessKey = process.env.RAPYD_ACCESS_KEY;
  const secretKey = process.env.RAPYD_SECRET_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.ORDER_NOTIFY_EMAIL || 'fjalar@fjalarsig.is';
  const fromEmail =
    process.env.ORDER_FROM_EMAIL || 'The 12-Step Rosary <onboarding@resend.dev>';

  if (!accessKey || !secretKey) {
    console.error('rapyd-webhook: RAPYD_ACCESS_KEY / RAPYD_SECRET_KEY not set');
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  if (!resendApiKey) {
    console.error('rapyd-webhook: RESEND_API_KEY not set');
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  // --- Raw body -------------------------------------------------------------
  let rawBody = '';
  if (req.rawBody) {
    rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : String(req.rawBody);
  }
  if (!rawBody) rawBody = await readRawBody(req);
  if (!rawBody && req.body) {
    // Last resort: the platform already parsed and drained the stream.
    // Compact JSON.stringify usually reproduces Rapyd's payload exactly.
    rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  // --- Signature check ----------------------------------------------------
  if (process.env.RAPYD_WEBHOOK_SKIP_VERIFY !== 'true') {
    const salt = req.headers['salt'];
    const timestamp = req.headers['timestamp'];
    const signature = req.headers['signature'];
    const urlPath =
      process.env.RAPYD_WEBHOOK_URL ||
      `https://${req.headers.host}${(req.url || '').split('?')[0]}`;

    if (!salt || !timestamp || !signature) {
      console.error('rapyd-webhook: missing salt/timestamp/signature headers');
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    const expected = rapydWebhookSignature(
      urlPath,
      salt,
      timestamp,
      accessKey,
      secretKey,
      rawBody
    );
    if (!safeEqual(expected, signature)) {
      console.error(
        'rapyd-webhook: signature mismatch (check RAPYD_WEBHOOK_URL matches the dashboard exactly)',
        { urlPath }
      );
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
  }

  // --- Parse event -------------------------------------------------------
  let event = {};
  try {
    event = JSON.parse(rawBody || '{}');
  } catch (e) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }

  const type = (event.type || '').toString().toUpperCase();
  const data = event.data || {};

  // Only fulfil on "payment captured". Ack everything else with 200 so Rapyd
  // does not keep retrying events we intentionally ignore.
  const isPaid =
    PAID_EVENTS.includes(type) || data.paid === true || data.status === 'CLO';
  if (!isPaid) {
    res.status(200).json({ ok: true, ignored: type || 'unknown' });
    return;
  }

  // --- Build the order summary -----------------------------------------
  const meta = data.metadata || {};
  const qty = Math.max(1, parseInt(meta.quantity, 10) || 1);
  const amount =
    Number(data.amount) || PRODUCT_PRICE_ISK * qty + SHIPPING_FEE_ISK;
  const currency = data.currency_code || data.currency || 'ISK';
  const ref = data.merchant_reference_id || event.id || '';
  const paymentId = data.id || '';
  const paidAt = data.paid_at ? new Date(data.paid_at * 1000) : new Date();

  const name = (meta.name || '').toString();
  const email = (meta.email || '').toString();
  const address = (meta.address || '').toString();
  const postcode = (meta.postcode || '').toString();
  const city = (meta.city || '').toString();

  const subtotal = PRODUCT_PRICE_ISK * qty;
  const shipping = Math.max(0, amount - subtotal);

  const rows = [
    ['Customer', name],
    ['Email', email],
    ['Address', address],
    ['Postcode', postcode],
    ['City', city],
    ['Quantity', `${qty} × 12-Step Rosary`],
    ['Goods', formatIsk(subtotal)],
    ['Shipping', formatIsk(shipping)],
    [
      'Total paid',
      `${formatIsk(amount)}${currency === 'ISK' ? '' : ' (' + currency + ')'}`,
    ],
    ['Rapyd payment', paymentId],
    ['Reference', ref],
    ['Paid at', paidAt.toISOString()],
  ];

  const text = rows.map(([k, v]) => `${k}: ${v || '-'}`).join('\n');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">
      <h2 style="margin:0 0 14px;font-size:18px">New order &mdash; ${qty} &times; 12-Step Rosary</h2>
      <table style="border-collapse:collapse">
        ${rows
          .map(
            ([k, v]) =>
              `<tr>` +
              `<td style="padding:4px 18px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${escapeHtml(
                k
              )}</td>` +
              `<td style="padding:4px 0">${v ? escapeHtml(v) : '&mdash;'}</td>` +
              `</tr>`
          )
          .join('')}
      </table>
      <p style="margin:18px 0 0;color:#888;font-size:13px">Sent automatically from the Rapyd payment webhook. Reply to this email to reach the customer.</p>
    </div>`;

  try {
    await sendEmail({
      apiKey: resendApiKey,
      from: fromEmail,
      to: notifyEmail,
      replyTo: email || undefined,
      subject: `New order · ${qty}× 12-Step Rosary · ${formatIsk(
        amount
      )} · ${name || ref}`,
      html,
      text,
    });
  } catch (err) {
    console.error(
      'rapyd-webhook: email send failed',
      err && err.detail ? err.detail : err
    );
    // 500 → Rapyd retries the webhook later, so the order is not lost.
    res.status(500).json({ error: 'email_failed' });
    return;
  }

  if (email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      await sendCustomerConfirmation({ to: email, name, qty, address, postcode, city });
    } catch (err) {
      // Don't fail the webhook over the customer copy — the owner already has the order.
      console.error('rapyd-webhook: customer confirmation email failed', err);
    }
  }

  res.status(200).json({ ok: true });
};

// Ask Vercel not to pre-parse the body so signature verification sees raw bytes.
module.exports.config = { api: { bodyParser: false } };
