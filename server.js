// server.js — ACTIV backend (Plaid + JAMARI) — Node 18+
// Works on Heroku. Uses built-in fetch + Postgres for persistent tokens.

const http = require('http');
const url  = require('url');
const { Pool } = require('pg');

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// Plaid
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET || '';
const PLAID_ENV       = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES   = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());
const BASES = {
  sandbox:     'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production:  'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// Preferred Plaid products (auto-trim to only enabled)
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

// Optional: webhook + redirect
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// ---------- Postgres (persistent tokens) ----------
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
let dbReady = false;

async function ensureSchema() {
  if (!pool) return false;
  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL
    );
  `);
  // --- UPGRADE: make sure columns exist even if table already existed
  await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS item_id TEXT;`);
  await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  dbReady = true;
  return true;
}

async function dbGetToken(userId) {
  if (!pool) return null;
  const r = await pool.query('SELECT access_token FROM tokens WHERE user_id = $1', [userId]);
  return r.rows[0]?.access_token || null;
}
async function dbSetToken(userId, accessToken, itemId) {
  if (!pool) return false;
  await pool.query(
    `INSERT INTO tokens (user_id, access_token, item_id, created_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET access_token = EXCLUDED.access_token,
                   item_id = EXCLUDED.item_id,
                   created_at = NOW()`,
    [userId, accessToken, itemId || null]
  );
  return true;
}
async function dbDeleteToken(userId) {
  if (!pool) return false;
  await pool.query('DELETE FROM tokens WHERE user_id = $1', [userId]);
  return true;
}

// ---------- Simple in-memory fallback (just in case DB is down) ----------
const memTokens = new Map();

// ---------- Helpers ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
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
      const out  = await plaidPost('/link/token/create', body);
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
async function needToken(res, userId) {
  const t = (await dbGetToken(userId)) || memTokens.get(userId);
  if (!t) { json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' }); return null; }
  return t;
}
function safePlaid(res, fn) {
  return fn().catch(err => {
    console.error('Plaid/Server error:', err);
    const code = err?.error_code || err?.error || 'PLAID_ERROR';
    const status = (err?.http_status >= 400 && err?.http_status <= 599) ? err.http_status : 500;
    json(res, status, { error: code, details: err });
  });
}
function daysAgo(n) {
  const d = new Date(Date.now() - n*24*3600*1000);
  return d.toISOString().slice(0,10);
}
function sum(arr) { return (arr||[]).reduce((a,b)=>a+(+b||0),0); }
function money(n) { return Math.round((+n||0)*100)/100; }

// ---------- KPI helpers ----------
async function getAccounts(token)            { try { return await plaidPost('/accounts/balance/get', { access_token: token }); } catch { return null; } }
async function getLiabilities(token)         { try { return await plaidPost('/liabilities/get', { access_token: token }); } catch { return null; } }
async function getInvestmentsHoldings(token) { try { return await plaidPost('/investments/holdings/get', { access_token: token }); } catch { return null; } }
async function getTransactions(token, start, end) {
  try {
    return await plaidPost('/transactions/get', {
      access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
    });
  } catch { return null; }
}

async function buildSummary(userId='default') {
  const access = (await dbGetToken(userId)) || memTokens.get(userId);
  if (!access) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(access),
    getLiabilities(access),
    getInvestmentsHoldings(access),
    getTransactions(access, daysAgo(30), daysAgo(0)),
  ]);

  // Accounts / Cash
  const accounts = (acc && acc.accounts) || [];
  const cashAccts = accounts.filter(a => a.type === 'depository');
  const checkingBal = cashAccts.filter(a => a.subtype === 'checking')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);
  const savingBal = cashAccts.filter(a => a.subtype === 'savings')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);
  const otherCash = cashAccts.filter(a => a.subtype !== 'checking' && a.subtype !== 'savings')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);

  const checking = money(sum(checkingBal));
  const savings  = money(sum(savingBal));
  const cashOther= money(sum(otherCash));
  const totalCash= money(checking + savings + cashOther);

  // Liabilities
  let totalLiabilities = 0;
  if (liab && liab.liabilities) {
    const L = liab.liabilities;
    const cc  = (L.credit   || []).map(x => x.balance?.current ?? 0);
    const stu = (L.student  || []).map(x => x.outstanding_balance ?? 0);
    const mort= (L.mortgage || []).map(x => x.principal_balance ?? 0);
    const auto= (L.auto     || []).map(x => x.outstanding_balance ?? 0);
    totalLiabilities = money(sum(cc) + sum(stu) + sum(mort) + sum(auto));
  }

  // Investments
  let totalInvestments = 0;
  if (inv && inv.holdings && inv.securities) {
    const secMap = new Map(inv.securities.map(s => [s.security_id, s]));
    totalInvestments = money(sum(inv.holdings.map(h => {
      if (typeof h.institution_value === 'number') return h.institution_value;
      const sec = secMap.get(h.security_id);
      const px = (sec && (sec.close_price ?? sec.price)) || 0;
      return (+h.quantity || 0) * (+px || 0);
    })));
  }

  // Tx KPIs
  let income30 = 0, spend30 = 0, netCashFlow = 0, monthlySpend = 0, savingsRate = 0;
  if (tx && tx.transactions) {
    const t = tx.transactions;
    income30 = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    spend30  = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
    if (income30 < spend30 && sum(t.map(x=>x.amount)) < 0) { // normalize if signs flipped
      income30 = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
      spend30  = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    }
    netCashFlow = money(income30 - spend30);
    monthlySpend = spend30 || 2000;
    savingsRate = income30 ? Math.max(0, Math.min(1, netCashFlow / income30)) : 0;
  } else {
    monthlySpend = 2000; savingsRate = 0.20; netCashFlow = 0;
  }

  const runwayMonths = monthlySpend ? money(totalCash / monthlySpend) : 0;
  const netWorth = money(totalCash + totalInvestments - totalLiabilities);

  return {
    linked: true,
    userId,
    accounts: accounts.map(a => ({
      account_id: a.account_id,
      name: a.name || a.official_name || 'Account',
      mask: a.mask || '',
      type: a.type,
      subtype: a.subtype,
      available: a.balances?.available ?? null,
      current: a.balances?.current ?? null,
      currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD'
    })),
    kpis: { netWorth, totalCash, checking, savings, cashOther,
            totalInvestments, totalLiabilities,
            income30, spend30, netCashFlow, monthlySpend, savingsRate, runwayMonths }
  };
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  try {
    // Health
    if (req.method === 'GET' && path === '/') {
      // ensure schema on first hit
      if (pool && !dbReady) {
        try { await ensureSchema(); } catch (e) { console.error('ensureSchema error', e); }
      }
      return json(res, 200, { ok:true, env: PLAID_ENV, db: !!pool, dbReady });
    }
    if (req.method === 'GET' && path === '/ping') {
      return json(res, 200, { ok:true, env: PLAID_ENV, db: !!pool, dbReady });
    }

    // Create Link Token
    if (req.method === 'POST' && path === '/plaid/link_token/create') {
      const body = await readJSON(req);
      const userId = body.userId || body.user_id || 'default';
      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
      };
      if (PLAID_REDIRECT_URI) baseReq.redirect_uri = PLAID_REDIRECT_URI;
      if (WEBHOOK_URL)        baseReq.webhook      = WEBHOOK_URL;

      return safePlaid(res, async () => {
        const data = await linkTokenCreateSmart(baseReq, body.products || PREFERRED_PRODUCTS);
        json(res, 200, {
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
      if (!body.public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.userId || 'default';
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        const access = data.access_token;
        const itemId = data.item_id || null;

        let saved = false;
        if (pool) {
          try { await dbSetToken(userId, access, itemId); saved = true; }
          catch (e) { console.error('dbSetToken error', e); }
        }
        if (!saved) memTokens.set(userId, access);

        json(res, 200, { item_id: itemId, stored_for_user: userId, persisted: saved ? 'db' : 'memory' });
      });
    }

    // Accounts / Balances
    if (req.method === 'GET' && (path === '/plaid/accounts' || path === '/plaid/balances')) {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Transactions (range)
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      const end   = (parsed.query.end   || daysAgo(0));
      const start = (parsed.query.start || daysAgo(30));
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/get', {
          access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
        });
        json(res, 200, data);
      });
    }

    // Transactions Sync
    if (req.method === 'POST' && path === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      const cursor = body.cursor || null;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(res, 200, data);
      });
    }

    // Liabilities
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Investments
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      const end   = (parsed.query.end   || daysAgo(0));
      const start = (parsed.query.start || daysAgo(90));
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/transactions/get', {
          access_token: token, start_date: start, end_date: end
        });
        json(res, 200, data);
      });
    }

    // Auth
    if (req.method === 'GET' && path === '/plaid/auth') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/auth/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Identity
    if (req.method === 'GET' && path === '/plaid/identity') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/identity/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Item
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || 'default').toString();
      const token  = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Remove item (two aliases: your FE calls /plaid/item/remove)
    if (req.method === 'POST' && (path === '/plaid/item/remove' || path === '/plaid/unlink')) {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token  = (await dbGetToken(userId)) || memTokens.get(userId);
      if (!token) return json(res, 200, { ok:true, message:'Nothing to unlink' });
      return safePlaid(res, async () => {
        await plaidPost('/item/remove', { access_token: token });
        try { await dbDeleteToken(userId); } catch (_) {}
        memTokens.delete(userId);
        json(res, 200, { ok:true });
      });
    }

    // Webhook (optional)
    if (req.method === 'POST' && path === '/plaid/webhook') {
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200);
      return res.end();
    }

    // Summary KPIs
    if (req.method === 'GET' && path === '/summary') {
      const userId = (parsed.query.userId || 'default').toString();
      try {
        const s = await buildSummary(userId);
        return json(res, 200, s);
      } catch (e) {
        console.error('summary error', e);
        return json(res, 500, { error:'SUMMARY_ERROR' });
      }
    }

    // Not found
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'SERVER_ERROR', details: err });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV} | DB=${!!pool}`);
  if (pool) ensureSchema().catch(e=>console.error('ensureSchema at start failed', e));
});