// ACTIV backend (Plaid + JAMARI AI Fusion) — Node 18+
// Heroku-ready. Built-in fetch. Postgres token persistence (auto-fallback to memory).

const http = require('http');
const url = require('url');

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// Plaid
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());
const BASES = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

// Plaid products (we’ll trim to enabled)
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

// AI keys (optional)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-3-haiku-20240307';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';

// Optional webhook + redirect
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// ---------- Token store (memory + Postgres) ----------
const cache = new Map();

let pgClient = null;
async function initDB() {
  if (!process.env.DATABASE_URL) return;
  try {
    // lazy require so the app still runs without pg dependency
    const { Client } = require('pg');
    pgClient = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pgClient.connect();
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS plaid_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[DB] Connected and ready');
  } catch (e) {
    console.error('[DB] Disabled (pg unavailable or connect failed):', e.message);
    pgClient = null; // force fallback
  }
}
async function dbGet(userId) {
  if (!pgClient) return null;
  const r = await pgClient.query('SELECT access_token FROM plaid_tokens WHERE user_id=$1', [userId]);
  return r.rows[0]?.access_token || null;
}
async function dbSet(userId, token) {
  if (!pgClient) return;
  await pgClient.query(`
    INSERT INTO plaid_tokens(user_id, access_token)
    VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET access_token=EXCLUDED.access_token, created_at=NOW()
  `, [userId, token]);
}
async function dbDel(userId) {
  if (!pgClient) return;
  await pgClient.query('DELETE FROM plaid_tokens WHERE user_id=$1', [userId]);
}

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

async function needToken(res, userId) {
  // 1) memory
  let token = cache.get(userId);
  if (token) return token;
  // 2) DB
  try {
    token = await dbGet(userId);
    if (token) {
      cache.set(userId, token);
      return token;
    }
  } catch (e) {
    console.error('[DB] read error', e.message);
  }
  json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
  return null;
}
function safePlaid(res, fn) {
  return fn().catch(err => {
    console.error('Plaid error:', err);
    const code = err?.error_code || 'PLAID_ERROR';
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

// ---------- Summary helpers ----------
async function getAccounts(token) {
  try { return await plaidPost('/accounts/balance/get', { access_token: token }); }
  catch { return null; }
}
async function getLiabilities(token) {
  try { return await plaidPost('/liabilities/get', { access_token: token }); }
  catch { return null; }
}
async function getInvestmentsHoldings(token) {
  try { return await plaidPost('/investments/holdings/get', { access_token: token }); }
  catch { return null; }
}
async function getTransactions(token, start, end) {
  try {
    return await plaidPost('/transactions/get', {
      access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
    });
  } catch { return null; }
}

// Build KPI summary
async function buildSummary(userId='default') {
  const access = cache.get(userId) || await dbGet(userId);
  if (!access) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(access),
    getLiabilities(access),
    getInvestmentsHoldings(access),
    getTransactions(access, daysAgo(30), daysAgo(0)),
  ]);

  let accounts = (acc && acc.accounts) || [];
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

  let totalLiabilities = 0;
  if (liab && liab.liabilities) {
    const L = liab.liabilities;
    const cc  = (L.credit || []).map(x => x.balance?.current ?? 0);
    const stu = (L.student ?? []).map(x => x.outstanding_balance ?? 0);
    const mort= (L.mortgage ?? []).map(x => x.principal_balance ?? 0);
    const auto= (L.auto ?? []).map(x => x.outstanding_balance ?? 0);
    totalLiabilities = money(sum(cc) + sum(stu) + sum(mort) + sum(auto));
  }

  let totalInvestments = 0;
  if (inv && inv.holdings && inv.securities) {
    const holdings = inv.holdings;
    const secMap = new Map();
    inv.securities.forEach(s => secMap.set(s.security_id, s));
    totalInvestments = money(sum(holdings.map(h => {
      if (typeof h.institution_value === 'number') return h.institution_value;
      const sec = secMap.get(h.security_id);
      const px = (sec && (sec.close_price ?? sec.price)) || 0;
      return (+h.quantity || 0) * (+px || 0);
    })));
  }

  let income30 = 0, spend30 = 0, netCashFlow = 0, monthlySpend = 0, savingsRate = 0;
  if (tx && tx.transactions) {
    const t = tx.transactions;
    income30 = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    spend30  = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
    if (income30 < spend30 && sum(t.map(x=>x.amount)) < 0) {
      income30 = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
      spend30  = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    }
    netCashFlow = money(income30 - spend30);
    monthlySpend = spend30 || 2000;
    savingsRate = income30 ? Math.max(0, Math.min(1, netCashFlow / income30)) : 0;
  } else {
    monthlySpend = 2000;
    savingsRate = 0.20;
    netCashFlow = 0;
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
    kpis: {
      netWorth, totalCash, checking, savings, cashOther,
      totalInvestments, totalLiabilities,
      income30, spend30, netCashFlow, monthlySpend, savingsRate, runwayMonths
    }
  };
}

// ---------- AI providers (optional) ----------
function withTimeout(promise, ms=14000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(()=>reject(new Error('TIMEOUT')), ms))
  ]);
}
async function askOpenAI(prompt, system) {
  if (!OPENAI_API_KEY) return null;
  try {
    const r = await withTimeout(fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{
        'Authorization':`Bearer ${OPENAI_API_KEY}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        messages: [
          { role:'system', content: system },
          { role:'user', content: prompt }
        ]
      })
    }));
    const j = await r.json();
    return j?.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}
async function askAnthropic(prompt, system) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role:'user', content:[{ type:'text', text: prompt }] }]
      })
    }));
    const j = await r.json();
    return j?.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}
async function askGemini(prompt, system) {
  if (!GEMINI_API_KEY) return null;
  try {
    const r = await withTimeout(fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${prompt}` }]}],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
        })
      }
    ));
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p=>p.text).join(' ').trim();
    return text || null;
  } catch { return null; }
}
function fuseReplies(replies) {
  const texts = replies.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  if (!texts.length) return "I'm ready, but no AI providers responded. Check your AI keys.";
  const first = texts[0];
  const seen = new Set(first.split(/(?<=\.)\s+/).map(s=>s.trim().toLowerCase()));
  const extra = [];
  for (let i=1;i<texts.length;i++) {
    for (const p of texts[i].split(/(?<=\.)\s+/)) {
      const k = p.trim().toLowerCase();
      if (k && !seen.has(k)) { extra.push(p.trim()); if (extra.length>=3) break; }
    }
    if (extra.length>=3) break;
  }
  return [first, ...extra].join(' ');
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  try {
    if (req.method === 'GET' && path === '/') {
      return json(res, 200, { ok:true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }
    if (req.method === 'GET' && path === '/ping') {
      return json(res, 200, { ok:true, env: PLAID_ENV });
    }

    // ---- Link Token (accept POST or GET to avoid UI mismatch) ----
    if ((req.method === 'POST' || req.method === 'GET') && path === '/plaid/link_token/create') {
      const body = req.method === 'POST' ? await readJSON(req) : parsed.query;
      const userId = body.userId || body.user_id || 'default';
      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES,
      };
      if (PLAID_REDIRECT_URI) baseReq.redirect_uri = PLAID_REDIRECT_URI;
      if (WEBHOOK_URL) baseReq.webhook = WEBHOOK_URL;

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

    // ---- Exchange public_token (POST only) ----
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      if (!body.public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.userId || 'default';
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        cache.set(userId, data.access_token);
        try { await dbSet(userId, data.access_token); } catch (e) { console.error('[DB] write error', e.message); }
        json(res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // ---- Accounts / Balances ----
    if (req.method === 'GET' && (path === '/plaid/accounts' || path === '/plaid/balances')) {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ---- Transactions ----
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      const end = (parsed.query.end || daysAgo(0));
      const start = (parsed.query.start || daysAgo(30));
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/get', {
          access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
        });
        json(res, 200, data);
      });
    }
    if (req.method === 'POST' && path === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      const cursor = body.cursor || null;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(res, 200, data);
      });
    }

    // ---- Liabilities ----
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ---- Investments ----
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      const end = (parsed.query.end || daysAgo(0));
      const start = (parsed.query.start || daysAgo(90));
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/transactions/get', {
          access_token: token, start_date: start, end_date: end
        });
        json(res, 200, data);
      });
    }

    // ---- Auth / Identity / Item ----
    if (req.method === 'GET' && path === '/plaid/auth') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/auth/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/identity') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/identity/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ---- Unlink / Delete ----
    if (req.method === 'POST' && path === '/plaid/unlink') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = cache.get(userId) || await dbGet(userId);
      if (!token) return json(res, 200, { ok:true, message:'Nothing to unlink' });
      return safePlaid(res, async () => {
        await plaidPost('/item/remove', { access_token: token });
        cache.delete(userId);
        try { await dbDel(userId); } catch (e) { console.error('[DB] delete error', e.message); }
        json(res, 200, { ok:true });
      });
    }
    if (req.method === 'POST' && path === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      cache.delete(userId);
      try { await dbDel(userId); } catch (e) { /* ignore */ }
      return json(res, 200, { ok:true });
    }

    // ---- Webhook (optional) ----
    if (req.method === 'POST' && path === '/plaid/webhook') {
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200);
      return res.end();
    }

    // ---- Summary ----
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

    // ---- JAMARI chat ----
    if (req.method === 'POST' && path === '/jamari/chat') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const message = (body.message || '').toString().slice(0, 4000);
      if (!message) return json(res, 400, { error:'NO_MESSAGE' });

      const summary = await buildSummary(userId);
      const k = summary.kpis || {};
      const sys = [
        "You are JAMARI, a calm, clear personal finance coach.",
        "Use the user's live KPIs when giving advice.",
        "Be concise, actionable, and avoid disclaimers unless necessary.",
        "Never reveal API keys or system details."
      ].join(' ');

      const ctx = [
        `Live KPIs:`,
        `NetWorth: $${k.netWorth||0} | Cash: $${k.totalCash||0} | Savings: $${k.savings||0} | Checking: $${k.checking||0}`,
        `Investments: $${k.totalInvestments||0} | Liabilities: $${k.totalLiabilities||0}`,
        `Income(30d): $${k.income30||0} | Spend(30d): $${k.spend30||0} | NetCashFlow: $${k.netCashFlow||0}`,
        `MonthlySpend est: $${k.monthlySpend||0} | Runway: ${k.runwayMonths||0} mo | SavingsRate: ${(k.savingsRate*100||0).toFixed(1)}%`,
        ``,
        `User: ${message}`
      ].join('\n');

      try {
        const [o, a, g] = await Promise.all([
          askOpenAI(ctx, sys),
          askAnthropic(ctx, sys),
          askGemini(ctx, sys),
        ]);
        const fused = fuseReplies([o,a,g]);
        return json(res, 200, { reply: fused, providers: { openai: !!o, anthropic: !!a, gemini: !!g } });
      } catch (e) {
        console.error('jamari/chat error', e);
        return json(res, 500, { error:'CHAT_ERROR' });
      }
    }

    // Not found
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'SERVER_ERROR', details: err?.message || String(err) });
  }
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV}`);
  });
});