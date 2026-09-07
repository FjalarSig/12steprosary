const crypto = require('crypto');

// Fixed pricing for the single product this shop sells.
const PRODUCT_PRICE_ISK = 4450;
const SHIPPING_FEE_IS_ISK = 490; // flat, within Iceland
const SHIPPING_FEE_US_ISK = 1070; // flat, to the USA (export, 0% VAT)
const MAX_QUANTITY = 5;

const RAPYD_BASE_URL = process.env.RAPYD_BASE_URL || 'https://sandboxapi.rapyd.net';

function sign(method, urlPath, salt, timestamp, accessKey, secretKey, body) {
  let bodyString = '';
  if (body) {
    bodyString = JSON.stringify(body);
    bodyString = bodyString === '{}' ? '' : bodyString;
  }
  const toSign = method.toLowerCase() + urlPath + salt + timestamp + accessKey + secretKey + bodyString;
  const hash = crypto.createHmac('sha256', secretKey);
  hash.update(toSign);
  return Buffer.from(hash.digest('hex')).toString('base64');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_input' });
    return;
  }

  const accessKey = process.env.RAPYD_ACCESS_KEY;
  const secretKey = process.env.RAPYD_SECRET_KEY;
  if (!accessKey || !secretKey) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const address = (body.address || '').toString().trim();
  const postcode = (body.postcode || '').toString().trim();
  const city = (body.city || '').toString().trim();
  const destination = body.destination === 'US' ? 'US' : 'IS';
  const state = (body.state || '').toString().trim();
  const lang = body.lang === 'is' ? 'is' : 'en';

  if (!name || !email || !address || !postcode || !city) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  // USA orders need a state and a 5-digit ZIP; Iceland orders a 3-digit postcode.
  if (destination === 'US') {
    if (!state || !/^\d{5}$/.test(postcode)) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
  }

  const quantity = Math.max(1, Math.min(MAX_QUANTITY, parseInt(body.quantity, 10) || 1));
  const shippingFee = destination === 'US' ? SHIPPING_FEE_US_ISK : SHIPPING_FEE_IS_ISK;
  const amount = PRODUCT_PRICE_ISK * quantity + shippingFee;

  const origin = `https://${req.headers.host}`;
  const urlPath = '/v1/checkout';
  const merchantReferenceId = `rosary_${Date.now()}`;
  const checkoutBody = {
    amount,
    currency: 'ISK',
    country: destination === 'US' ? 'US' : 'IS',
    complete_checkout_url: `${origin}/order-success.html?amount=${amount}&qty=${quantity}&ref=${merchantReferenceId}`,
    cancel_checkout_url: `${origin}/order-cancelled.html`,
    error_payment_url: `${origin}/order-error.html`,
    merchant_reference_id: merchantReferenceId,
    language: lang,
    metadata: {
      name,
      email,
      address,
      postcode,
      city,
      state,
      country: destination === 'US' ? 'US' : 'IS',
      destination,
      quantity,
      lang,
    },
  };

  const salt = crypto.randomBytes(12).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign('post', urlPath, salt, timestamp, accessKey, secretKey, checkoutBody);

  try {
    const rapydRes = await fetch(`${RAPYD_BASE_URL}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_key: accessKey,
        salt,
        timestamp: String(timestamp),
        signature,
        idempotency: `${timestamp}${salt}`,
      },
      body: JSON.stringify(checkoutBody),
    });

    const data = await rapydRes.json();
    const redirectUrl = data && data.data && data.data.redirect_url;

    if (!rapydRes.ok || !redirectUrl) {
      console.error('Rapyd checkout creation failed', data);
      res.status(502).json({ error: 'payment_failed' });
      return;
    }

    res.status(200).json({ redirect_url: redirectUrl });
  } catch (err) {
    console.error('Rapyd checkout request error', err);
    res.status(500).json({ error: 'payment_failed' });
  }
};
