// server.js — ACTIV one-file Plaid backend (Production-ready, no npm deps)
// Node 18+ (uses built-in fetch). Works on Heroku with your current env vars.

const http = require('http');
const url = require('url');

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = (process.env.PLAID_ENV || 'production').toLowerCase();

const COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());

// Valid Plaid products (do NOT include "balances" — not a product)
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);

// Preferred set for your app; we’ll auto-trim anything not enabled
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// ---------- Simple in-memory token store (swap for DB later if needed) ----------
const tokens = new Map(); // userId -> access_token

// ---------- Helpers ----------
function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // IMPORTANT: allow whatever the browser requested (e.g., "content-type,accept")
  const reqHdrs = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Headers', reqHdrs || 'Content-Type, Accept');
}
function json(req, res, code, obj) {
  setCors(req, res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJSON(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
  });
}
async function plaidPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = data || {};
    err.http_status = r.status;
    throw err;
  }
  return data;
}
function uid() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2));
}
function cleanProducts(list) {
  return (list || PREFERRED_PRODUCTS)
    .map(s => String(s).trim().toLowerCase())
    .filter(p => VALID_PRODUCTS.has(p));
}
function parseInvalidProducts(err) {
  const m = (err?.error_message || '').match(/\[([^\]]+)\]/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim().toLowerCase());
}
async function linkTokenCreateSmart(baseReq, prods) {
  let products = cleanProducts(prods);
  if (products.length === 0) products = ['transactions'];
  while (products.length) {
    try {
      const body = { ...baseReq, products };
      const out = await plaidPost('/link/token/create', body);
      return { ...out, products_used: products };
    } catch (e) {
      const code = e?.error_code || e?.error || '';
      if (code === 'INVALID_PRODUCT') {
        const bad = new Set(parseInvalidProducts(e));
        products = products.filter(p => !bad.has(p));
        if (!products.length) break;
        continue;
      }
      if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'PRODUCTS_NOT_ENABLED') {
        products = ['transactions','auth'].filter(p => products.includes(p));
        if (!products.length) products = ['transactions'];
        continue;
      }
      throw e;
    }
  }
  const out = await plaidPost('/link/token/create', { ...baseReq, products: ['transactions'] });
  return { ...out, products_used: ['transactions'] };
}
function needToken(req, res, userId) {
  const token = tokens.get(userId);
  if (!token) json(req, res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
  return token;
}
function safePlaid(req, res, fn) {
  return fn().catch(err => {
    console.error('Plaid error:', err);
    const code = err?.error_code || 'PLAID_ERROR';
    const status = (err?.http_status >= 400 && err?.http_status <= 599) ? err.http_status : 500;
    json(req, res, status, { error: code, details: err });
  });
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  try {
    // Health
    if (req.method === 'GET' && path === '/') {
      return json(req, res, 200, { ok: true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }

    // Create Link Token (smart retry)
    if (req.method === 'POST' && path === '/plaid/link_token/create') {
      const body = await readJSON(req);
      const userId = body.userId || uid();

      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
      };
      if (process.env.PLAID_REDIRECT_URI) baseReq.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (process.env.WEBHOOK_URL) baseReq.webhook = process.env.WEBHOOK_URL;

      return safePlaid(req, res, async () => {
        const data = await linkTokenCreateSmart(baseReq, body.products || PREFERRED_PRODUCTS);
        json(req, res, 200, {
          link_token: data.link_token,
          expiration: data.expiration,
          userId,
          products_used: data.products_used
        });
      });
    }

    // Exchange public_token
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      if (!body.public_token) return json(req, res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.userId || 'default';
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        tokens.set(userId, data.access_token); // never return it
        json(req, res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // Accounts + Balances
    if (req.method === 'GET' && (path === '/plaid/accounts' || path === '/plaid/balances')) {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(req, res, 200, data);
      });
    }

    // Transactions (date range)
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;

      const now = new Date();
      const end = (parsed.query.end || now.toISOString().slice(0,10));
      const start = (parsed.query.start || new Date(now.getTime() - 30*24*3600*1000).toISOString().slice(0,10));

      return safePlaid(req, res, async () => {
        const data = await plaidPost('/transactions/get', {
          access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
        });
        json(req, res, 200, data);
      });
    }

    // Transactions Sync
    if (req.method === 'POST' && path === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      const cursor = body.cursor || null;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(req, res, 200, data);
      });
    }

    // Liabilities
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(req, res, 200, data);
      });
    }

    // Investments
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(req, res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;

      const now = new Date();
      const end = (parsed.query.end || now.toISOString().slice(0,10));
      const start = (parsed.query.start || new Date(now.getTime() - 90*24*3600*1000).toISOString().slice(0,10));

      return safePlaid(req, res, async () => {
        const data = await plaidPost('/investments/transactions/get', {
          access_token: token, start_date: start, end_date: end
        });
        json(req, res, 200, data);
      });
    }

    // Auth
    if (req.method === 'GET' && path === '/plaid/auth') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/auth/get', { access_token: token });
        json(req, res, 200, data);
      });
    }

    // Identity
    if (req.method === 'GET' && path === '/plaid/identity') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/identity/get', { access_token: token });
        json(req, res, 200, data);
      });
    }

    // Item info / remove
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(req, res, 200, data);
      });
    }
    if (req.method === 'POST' && path === '/plaid/item/remove') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = needToken(req, res, userId); if (!token) return;
      return safePlaid(req, res, async () => {
        const data = await plaidPost('/item/remove', { access_token: token });
        tokens.delete(userId);
        json(req, res, 200, data);
      });
    }

    // Webhook (optional)
    if (req.method === 'POST' && path === '/plaid/webhook') {
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200);
      return res.end();
    }

    // Not found
    json(req, res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('Server error:', err);
    json(req, res, 500, { error: 'SERVER_ERROR', details: err });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} (PLAID: ${PLAID_ENV})`);
});