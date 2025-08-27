// server.js — ACTIV Plaid backend (Production-ready, no npm deps)
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

// You are approved for these. Do NOT include "balances" (it's an endpoint, not a product).
const APPROVED_PRODUCTS = ['transactions','investments','liabilities'];

const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// ---------- Simple in-memory token store (swap for DB later) ----------
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
function needToken(res, userId) {
  const token = tokens.get(userId);
  if (!token) json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER', userId });
  return token;
}
function safePlaid(res, fn) {
  return fn().catch(err => {
    console.error('Plaid error:', err);
    const code = err?.error_code || err?.error || 'PLAID_ERROR';
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
    // Health
    if (req.method === 'GET' && path === '/') {
      return json(res, 200, { ok: true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }
    // IMPORTANT: your front end calls /ping for “Test Backend”
    if (req.method === 'GET' && path === '/ping') {
      return json(res, 200, { ok: true, env: PLAID_ENV });
    }

    // Create Link Token — accepts userId or user_id; uses your approved products
    if (req.method === 'POST' && path === '/plaid/link_token/create') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();

      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
        products: APPROVED_PRODUCTS, // transactions, investments, liabilities
      };
      if (process.env.PLAID_REDIRECT_URI) baseReq.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (process.env.WEBHOOK_URL) baseReq.webhook = process.env.WEBHOOK_URL;

      return safePlaid(res, async () => {
        const data = await plaidPost('/link/token/create', baseReq);
        json(res, 200, {
          link_token: data.link_token,
          expiration: data.expiration,
          userId,
          products_used: baseReq.products
        });
      });
    }

    // Exchange public_token (called right after successful Link)
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      if (!body.public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = (body.userId || body.user_id || 'default').toString();
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        tokens.set(userId, data.access_token);
        json(res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // Accounts + Balances
    if (req.method === 'GET' && path === '/plaid/accounts') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }
    // Alias for balances (your front end calls this)
    if (req.method === 'GET' && path === '/plaid/balances') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Transactions (date range)
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      const now = new Date();
      const end = (parsed.query.end || now.toISOString().slice(0,10));
      const start = (parsed.query.start || new Date(now.getTime() - 30*24*3600*1000).toISOString().slice(0,10));
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/get', {
          access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
        });
        json(res, 200, data);
      });
    }

    // Transactions Sync (incremental)
    if (req.method === 'POST' && path === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      const cursor = body.cursor || null;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(res, 200, data);
      });
    }

    // Recurring Transactions (add-on)
    if (req.method === 'GET' && path === '/plaid/transactions/recurring') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/recurring/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ---- LIABILITIES ----
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ---- INVESTMENTS ----
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      const now = new Date();
      const end = (parsed.query.end || now.toISOString().slice(0,10));
      const start = (parsed.query.start || new Date(now.getTime() - 90*24*3600*1000).toISOString().slice(0,10));
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/transactions/get', {
          access_token: token, start_date: start, end_date: end
        });
        json(res, 200, data);
      });
    }

    // ---- Enrich (optional; send an array of transactions to enrich) ----
    if (req.method === 'POST' && path === '/plaid/transactions/enrich') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      // Note: Enrich doesn’t require access_token in body; it enriches the provided txns.
      // See Plaid docs for exact fields; here we just pass through what client sent.
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/enrich', { transactions: body.transactions || [] });
        json(res, 200, data);
      });
    }

    // ---- AUTH / IDENTITY (if you enable later) ----
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || parsed.query.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Remove item (official endpoint)
    if (req.method === 'POST' && path === '/plaid/item/remove') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/remove', { access_token: token });
        tokens.delete(userId);
        json(res, 200, data);
      });
    }

    // ---- Compatibility with your Settings buttons ----
    // Unlink Bank (alias for item/remove)
    if (req.method === 'POST' && path === '/plaid/unlink') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/remove', { access_token: token });
        tokens.delete(userId);
        json(res, 200, { ok: true, removed: true, details: data });
      });
    }

    // Cancel Account (purge user data on backend)
    if (req.method === 'POST' && path === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.userId || body.user_id || 'default').toString();
      tokens.delete(userId);
      return json(res, 200, { ok: true, userId, purged: true });
    }

    // Webhook (optional)
    if (req.method === 'POST' && path === '/plaid/webhook') {
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200);
      return res.end();
    }

    // Not found
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'SERVER_ERROR', details: err });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} (PLAID: ${PLAID_ENV})`);
});