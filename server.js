// server.js — ACTIV Plaid backend (single file, no npm deps). Node 18+.
// Works on Heroku. CORS is bulletproof; accepts user_id or userId.

const http = require('http');
const url  = require('url');

// ------------ ENV ------------
const PORT = process.env.PORT || 3000;
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET || '';
const PLAID_ENV       = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES   = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());

const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// Valid Plaid products (note: "balances" is not a product)
const VALID_PRODUCTS = new Set([
  'auth', 'transactions', 'identity', 'assets', 'investments',
  'liabilities', 'income', 'payment_initiation', 'transfer', 'signal', 'credit_details'
]);
const PREFERRED = ['transactions','auth','identity','liabilities','investments'];

// Simple in-memory token store: userId -> access_token
const tokens = new Map();

// ------------ helpers ------------
function setCors(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  const reqHdrs = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Headers', reqHdrs || 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(req, res, code, obj) {
  setCors(req, res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJSON(req) {
  return new Promise(resolve => {
    let s = ''; req.on('data', c => s += c);
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
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
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) { d.http_status = r.status; throw d; }
  return d;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const cleanProducts = list => (list || PREFERRED).map(s => String(s).trim().toLowerCase()).filter(p => VALID_PRODUCTS.has(p));
const parseInvalidProducts = e => ((e?.error_message || '').match(/\[([^\]]+)\]/) || [,''])[1]
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

async function linkTokenCreateSmart(baseReq, prods) {
  let products = cleanProducts(prods);
  if (!products.length) products = ['transactions'];
  while (products.length) {
    try {
      const out = await plaidPost('/link/token/create', { ...baseReq, products });
      return { ...out, products_used: products };
    } catch (e) {
      const code = e?.error_code || e?.error || '';
      if (code === 'INVALID_PRODUCT') {
        const bad = new Set(parseInvalidProducts(e));
        products = products.filter(p => !bad.has(p));
        if (!products.length) break; else continue;
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
  const t = tokens.get(userId);
  if (!t) json(req, res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
  return t;
}
function safe(req, res, fn) {
  return fn().catch(e => {
    console.error('Plaid/Error:', e);
    const status = (e?.http_status >= 400 && e?.http_status <= 599) ? e.http_status : 500;
    json(req, res, status, { error: e?.error_code || 'PLAID_ERROR', details: e });
  });
}

// ------------ server ------------
const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  try {
    // Health (your UI hits /ping)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/ping')) {
      return json(req, res, 200, { ok: true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }

    // Create Link Token — your UI sends { user_id: 'local-user' } or { userId:'default' }
    if (req.method === 'POST' && pathname === '/plaid/link_token/create') {
      const body = await readJSON(req);
      const userId = body.user_id || body.userId || uid();
      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
      };
      if (process.env.PLAID_REDIRECT_URI) baseReq.redirect_uri = process.env.PLAID_REDIRECT_URI;
      if (process.env.WEBHOOK_URL)        baseReq.webhook      = process.env.WEBHOOK_URL;

      return safe(req, res, async () => {
        const d = await linkTokenCreateSmart(baseReq, body.products);
        json(req, res, 200, { link_token: d.link_token, expiration: d.expiration, userId, products_used: d.products_used });
      });
    }

    // Exchange public_token (after Link success)
    if (req.method === 'POST' && pathname === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      if (!body.public_token) return json(req, res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.user_id || body.userId || 'default';
      return safe(req, res, async () => {
        const d = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        tokens.set(userId, d.access_token);
        json(req, res, 200, { item_id: d.item_id, stored_for_user: userId });
      });
    }

    // Balances / Accounts (your UI calls /plaid/balances)
    if (req.method === 'GET' && (pathname === '/plaid/balances' || pathname === '/plaid/accounts')) {
      const userId = (query.userId || 'default').toString();
      const t = needToken(req, res, userId); if (!t) return;
      return safe(req, res, async () => {
        const d = await plaidPost('/accounts/balance/get', { access_token: t });
        json(req, res, 200, d);
      });
    }

    // Unlink (UI calls /plaid/unlink)
    if (req.method === 'POST' && pathname === '/plaid/unlink') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();
      const t = needToken(req, res, userId); if (!t) return;
      return safe(req, res, async () => {
        const d = await plaidPost('/item/remove', { access_token: t });
        tokens.delete(userId);
        json(req, res, 200, { ok: true, removed: true, plaid: d });
      });
    }

    // Delete account (UI calls /user/delete)
    if (req.method === 'POST' && pathname === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();
      tokens.delete(userId);
      return json(req, res, 200, { ok: true, purged: true, userId });
    }

    // Optional: transactions sync (kept for future)
    if (req.method === 'POST' && pathname === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.user_id || body.userId || 'default').toString();
      const t = needToken(req, res, userId); if (!t) return;
      return safe(req, res, async () => {
        const d = await plaidPost('/transactions/sync', { access_token: t, cursor: body.cursor || null, count: 500 });
        json(req, res, 200, d);
      });
    }

    json(req, res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    console.error('Server error:', e);
    json(req, res, 500, { error: 'SERVER_ERROR', details: e });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend listening on :${PORT} (PLAID ${PLAID_ENV})`);
});