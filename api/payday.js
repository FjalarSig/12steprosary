'use strict';

// Minimal Payday (payday.is) API client. Used by the Rapyd webhook to issue the
// official VAT invoice after a payment is captured. Server-to-server auth:
// clientId + clientSecret -> 24h Bearer token. Docs: https://apidoc.payday.is/
//
// Config (env):
//   PAYDAY_CLIENT_ID, PAYDAY_CLIENT_SECRET  - OAuth application credentials
//   PAYDAY_BASE_URL       - https://api.payday.is (prod) | https://api.test.payday.is (sandbox)
//   PAYDAY_PAYMENT_TYPE_ID - guid of the "paid" payment type; when set, invoices
//                            are booked as already paid (the Rapyd payment).

const BASE_URL = (process.env.PAYDAY_BASE_URL || 'https://api.payday.is').replace(/\/+$/, '');
const CLIENT_ID = process.env.PAYDAY_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYDAY_CLIENT_SECRET;
const PAYMENT_TYPE_ID = process.env.PAYDAY_PAYMENT_TYPE_ID || '';

const COMMON_HEADERS = { 'Content-Type': 'application/json', 'Api-Version': 'alpha' };

// Keep every call short so a slow/broken Payday never stalls the Rapyd webhook.
const REQUEST_TIMEOUT_MS = 8000;

function withTimeout() {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function paymentTypeConfigured() {
  return Boolean(PAYMENT_TYPE_ID);
}

// --- Bearer token (cached in module scope, reused across warm invocations) ---
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    signal: withTimeout(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    const err = new Error('payday_auth_failed');
    err.detail = data;
    throw err;
  }
  cachedToken = data.accessToken;
  // expiresIn is seconds (86400). Refresh a minute early.
  cachedTokenExpiry = now + (Number(data.expiresIn || 3600) - 60) * 1000;
  return cachedToken;
}

async function authed(path, { method = 'GET', body, accept } = {}) {
  const token = await getToken();
  const headers = { ...COMMON_HEADERS, Authorization: `Bearer ${token}` };
  if (accept) headers.Accept = accept;
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: withTimeout(),
  });
}

// --- Customers -------------------------------------------------------------
async function findCustomerIdByEmail(email) {
  if (!email) return null;
  const res = await authed(`/customers/search/?query=${encodeURIComponent(email)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data) ? data : data.customers || [];
  const match =
    list.find((c) => (c.email || '').toLowerCase() === email.toLowerCase()) || list[0];
  return match ? match.id : null;
}

async function createCustomer({ name, email, address, zipCode, city, country, language }) {
  const res = await authed('/customers', {
    method: 'POST',
    body: {
      name,
      email: email || undefined,
      address: address || undefined,
      zipCode: zipCode || undefined,
      city: city || undefined,
      country: country || undefined,
      language: language || undefined,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const err = new Error('payday_customer_failed');
    err.detail = data;
    throw err;
  }
  return data.id;
}

// Reuse an existing customer (matched on email) or create a new one. No ssn is
// sent, so Payday treats these as foreign-style customers - fine for B2C retail.
async function upsertCustomer(customer) {
  const existing = await findCustomerIdByEmail(customer.email).catch(() => null);
  if (existing) return existing;
  return createCustomer(customer);
}

// --- Invoices ------------------------------------------------------------
function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// lines: [{ description, quantity, unitPriceIncludingVat, vatPercentage }]
// Prices are VAT-inclusive; vatPercentage is 24 for Iceland, 0 for exports.
// sendEmail:true — Payday emails the customer the finished, numbered invoice PDF
// itself. (The POST response has no invoice number; Payday assigns it a little
// later, so we can't fetch a usable PDF synchronously to attach ourselves.)
async function createInvoice({ customerId, description, lines, markPaid }) {
  const d = today();
  const body = {
    customer: { id: customerId },
    description,
    invoiceDate: d,
    dueDate: d,
    finalDueDate: d,
    currencyCode: 'ISK',
    createClaim: false,
    sendEmail: true,
    lines: lines.map((l) => {
      const line = {
        description: l.description,
        quantity: l.quantity,
        unitPriceIncludingVat: l.unitPriceIncludingVat,
        vatPercentage: l.vatPercentage,
        discountPercentage: 0,
      };
      // Link the line to a registered Payday product (for sales/stock reports).
      // The line still carries its own price + vatPercentage, which win over the
      // product's — needed so USA export lines can be 0% on a 24% product.
      if (l.productId) line.productId = l.productId;
      if (l.sku) line.sku = l.sku;
      return line;
    }),
  };
  if (markPaid && PAYMENT_TYPE_ID) {
    body.paidDate = d;
    body.paymentType = PAYMENT_TYPE_ID;
  }

  const res = await authed('/invoices', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const err = new Error('payday_invoice_failed');
    err.detail = data;
    throw err;
  }
  return data; // { id, number, amountIncludingVat, amountVat, ... }
}

async function getInvoicePdf(id) {
  const res = await authed(`/invoices/${id}/pdf`, { accept: 'application/pdf' });
  if (!res.ok) {
    const err = new Error('payday_pdf_failed');
    err.detail = { status: res.status };
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 4).toString('latin1') !== '%PDF') {
    const err = new Error('payday_pdf_not_pdf');
    err.detail = { preview: buf.slice(0, 200).toString('utf8') };
    throw err;
  }
  return buf;
}

module.exports = {
  isConfigured,
  paymentTypeConfigured,
  getToken,
  upsertCustomer,
  createInvoice,
  getInvoicePdf,
};
