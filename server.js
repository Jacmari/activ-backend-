// server.js — ACTIV one-file Plaid backend (Heroku friendly, no npm deps)
// Node 18+ (uses global fetch). CORS open for your mobile/web app.
// Matches your front-end endpoints exactly.

const http = require('http');
const url = require('url');

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET || '';
const PLAID_ENV       = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES   = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());

const BASES = {
  sandbox:      'https://sandbox.plaid.com',
  development:  'https://development.plaid.com',
  production:   'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// ---------- In-memory store (swap to DB later if needed) ----------
const tokens = new Map(); // userId -> access_token

// ---------- Helpers ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
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
async function plaidPost(path, body, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
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
  } finally {
    clearTimeout(t);
  }
}
function uid() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2));
}
function needToken(res, userId) {
  const token = tokens.get(userId);
  if (!token) json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
  return token;
}
function safe(res, fn) {
  return fn().catch(err => {
    const code = err?.error_code || err?.error || (err?.name === 'AbortError' ? 'TIMEOUT' : 'PLAID_ERROR');
    const status = (err?.http_status >= 400 && err?.http_status <= 599) ? err.http_status : 500;
    json(res, status, { error: code, details: err });
  });
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  try {
    // Health / ping for your UI
    if (req.method === 'GET' && (path === '/' || path === '/ping')) {
      return json(res, 200, { ok: true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }

    // Create Link Token — your UI sends { user_id: 'default' }
    if (req.method === 'POST' && path === '/plaid/link_token/create') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();

      const productsIn = Array.isArray(body.products) ? body.products : ['transactions','auth','identity','liabilities','investments'];
      // Filter out invalid names just in case
      const VALID = new Set(['auth','transactions','identity','assets','investments','liabilities','income','payment_initiation','transfer','signal','credit_details']);
      const products = productsIn.map(p => String(p||'').toLowerCase()).filter(p => VALID.has(p));
      const productsFinal = products.length ? products : ['transactions'];

      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
        products: productsFinal,
      };
      if (process.env.PLAID_REDIRECT_URI) baseReq.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (process.env.WEBHOOK_URL)       baseReq.webhook      = process.env.WEBHOOK_URL;

      return safe(res, async () => {
        const data = await plaidPost('/link/token/create', baseReq);
        json(res, 200, {
          link_token: data.link_token,
          expiration: data.expiration,
          user_id: userId,
          products_used: productsFinal,
        });
      });
    }

    // Exchange public_token from Plaid Link
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      const public_token = body.public_token;
      if (!public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = (body.user_id || body.userId || 'default').toString();

      return safe(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token });
        tokens.set(userId, data.access_token); // store server-side only
        json(res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // Balances (alias for accounts/balance/get) — your front-end calls this
    if (req.method === 'GET' && (path === '/plaid/balances' || path === '/plaid/accounts')) {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safe(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Unlink (remove item) — your Settings button calls /plaid/unlink
    if (req.method === 'POST' && path === '/plaid/unlink') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safe(res, async () => {
        const data = await plaidPost('/item/remove', { access_token: token });
        tokens.delete(userId);
        json(res, 200, data);
      });
    }

    // Delete user — your Settings button calls /user/delete
    if (req.method === 'POST' && path === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();
      const token = tokens.get(userId);
      return safe(res, async () => {
        if (token) {
          try { await plaidPost('/item/remove', { access_token: token }); } catch (_) {}
        }
        tokens.delete(userId);
        json(res, 200, { ok: true, purged: true, user_id: userId });
      });
    }

    // Not found
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    json(res, 500, { error: 'SERVER_ERROR', details: err?.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} [PLAID ${PLAID_ENV}]`);
});