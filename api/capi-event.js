const crypto = require('crypto');

// Same Pixel this shop's client-side fbq() calls use — kept in sync manually.
const PIXEL_ID = '982763194834927';
const GRAPH_API_VERSION = 'v21.0';
const ALLOWED_EVENTS = ['InitiateCheckout', 'Purchase'];

function sha256(value) {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_input' });
    return;
  }

  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const eventName = (body.event_name || '').toString();
  if (!ALLOWED_EVENTS.includes(eventName)) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }

  const eventId = (body.event_id || '').toString().slice(0, 100);
  const eventSourceUrl = (body.event_source_url || '').toString().slice(0, 500);
  const fbp = (body.fbp || '').toString().slice(0, 200);
  const fbc = (body.fbc || '').toString().slice(0, 200);
  const email = (body.email || '').toString();

  const customData = {
    content_ids: ['12-step-rosary'],
    content_type: 'product',
  };
  if (body.value != null) customData.value = Number(body.value);
  if (body.num_items != null) customData.num_items = Number(body.num_items);
  customData.currency = 'ISK';

  const forwardedFor = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const userData = {
    client_ip_address: forwardedFor || req.socket.remoteAddress,
    client_user_agent: req.headers['user-agent'] || '',
  };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (email) userData.em = [sha256(email)];

  const testEventCode = (body.test_event_code || '').toString().slice(0, 50);

  const eventPayload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || undefined,
      event_source_url: eventSourceUrl || undefined,
      action_source: 'website',
      user_data: userData,
      custom_data: customData,
    }],
  };
  if (testEventCode) eventPayload.test_event_code = testEventCode;

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload),
      }
    );
    const data = await metaRes.json();

    if (!metaRes.ok) {
      console.error('Meta CAPI error', data);
      res.status(502).json({ error: 'capi_failed', detail: body.debug ? data : undefined });
      return;
    }

    res.status(200).json({ ok: true, detail: body.debug ? data : undefined });
  } catch (err) {
    console.error('Meta CAPI request error', err);
    res.status(500).json({ error: 'capi_failed' });
  }
};
