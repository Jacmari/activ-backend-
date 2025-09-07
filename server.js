// server.js — ACTIV backend (Plaid + JAMARI AI Fusion + Manual Wealth/Debt + Family)
// Node 18+ (built-in fetch). Works on Heroku. Uses Postgres if DATABASE_URL present.
// CORS safe. Production timeouts. No auth/identity product requests. Frontend-compatible.

// ----------------------- CORE REQS -----------------------
const http = require('http');
const url  = require('url');

// ----------------------- ENV -----------------------------
const PORT = process.env.PORT || 3000;

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET || '';
const PLAID_ENV       = (process.env.PLAID_ENV || 'production').toLowerCase();
const COUNTRY_CODES   = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',').map(s => s.trim().toUpperCase());

// Preferred Plaid products (exclude auth/identity to avoid enablement errors)
const VALID_PRODUCTS = new Set([
  'transactions','liabilities','investments','assets',
  'income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','liabilities','investments'];

const BASES = {
  sandbox:     'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production:  'https://production.plaid.com',
};
const BASE = BASES[PLAID_ENV] || BASES.production;

const WEBHOOK_URL        = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// AI keys (alias detection)
function envPick(names){ for (const n of names){ if (process.env[n]) return process.env[n]; } return ''; }
const OPENAI_API_KEY    = envPick(['OPENAI_API_KEY','OPEN_API_KEY']) || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = envPick(['ANTHROPIC_API_KEY','CLAUDE_API_KEY']) || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';
const GEMINI_API_KEY    = envPick(['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_API_KEY']) || '';
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// ----------------------- DB (optional Postgres) ----------
let pgPool = null;
const { Pool } = (() => { try { return require('pg'); } catch { return {}; } })();

if (Pool && process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.DATABASE_SSL === 'false') ? false : { rejectUnauthorized: false }
  });

  // Bootstrap tables
  (async () => {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS tokens (
          user_id TEXT NOT NULL,
          item_id TEXT,
          access_token TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS manual_holdings (
          user_id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS manual_debts (
          user_id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS family_links (
          owner_user_id   TEXT NOT NULL,
          invited_user_id TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (owner_user_id, invited_user_id)
        );
      `);
      console.log('DB ready');
    } catch (e) {
      console.error('DB init error:', e);
    }
  })();
}

// Fallback in-memory cache if no DB
const memTokens = new Map();

// ----------------------- Helpers -------------------------
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
function fetchWithTimeout(resource, options = {}, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(resource, { ...options, signal: controller.signal }).finally(() => clearTimeout(t));
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
function daysAgo(n) {
  const d = new Date(Date.now() - n*24*3600*1000);
  return d.toISOString().slice(0,10);
}
function sum(arr){ return (arr||[]).reduce((a,b)=>a+(+b||0),0); }
function money(n){ return Math.round((+n||0)*100)/100; }

// DB helpers
async function dbOne(q, params=[]) {
  if (!pgPool) return null;
  const r = await pgPool.query(q, params);
  return r.rows[0] || null;
}
async function dbAny(q, params=[]) {
  if (!pgPool) return [];
  const r = await pgPool.query(q, params);
  return r.rows;
}
async function storeToken(userId, accessToken, itemId) {
  memTokens.set(userId, accessToken);
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO tokens (user_id, item_id, access_token) VALUES ($1,$2,$3)`,
      [userId, itemId || null, accessToken]
    );
  }
}
async function latestTokenForUser(userId) {
  if (pgPool) {
    const row = await dbOne(
      `SELECT access_token FROM tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (row?.access_token) return row.access_token;
  }
  return memTokens.get(userId) || null;
}

// ----------------------- Plaid wrapper -------------------
async function plaidPost(path, body) {
  const started = Date.now();
  try {
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
      body: JSON.stringify(body),
    }, 12000);

    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) {
      const err = data || {};
      err.http_status = r.status;
      err.ms = Date.now() - started;
      throw err;
    }
    return data;
  } catch (e) {
    const isAbort = (e && (e.name === 'AbortError' || e.message === 'The operation was aborted'));
    const out = {
      error: isAbort ? 'UPSTREAM_TIMEOUT' : (e?.error_code || e?.error || 'PLAID_ERROR'),
      details: e,
      ms: Date.now() - started,
      path,
    };
    console.error('plaidPost fail:', out);
    throw out;
  }
}
function safePlaid(res, fn) {
  return fn().catch(err => {
    console.error('Plaid error:', err);
    const code = err?.error || err?.error_code || 'PLAID_ERROR';
    const status = (err?.http_status >= 400 && err?.http_status <= 599) ? err.http_status : 500;
    json(res, status, { error: code, details: err });
  });
}

// ----------------------- Plaid helpers -------------------
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

// ----------------------- Manual data (DB) ----------------
async function getManualHoldings(userId) {
  if (!pgPool) return null;
  const row = await dbOne(`SELECT data FROM manual_holdings WHERE user_id=$1`, [userId]);
  return row?.data || null;
}
async function getManualDebts(userId) {
  if (!pgPool) return null;
  const row = await dbOne(`SELECT data FROM manual_debts WHERE user_id=$1`, [userId]);
  return row?.data || null;
}

// ----------------------- Summary (Plaid + Manual) --------
async function buildSummary(userId='default') {
  const token  = await latestTokenForUser(userId);
  const linked = !!token;

  const [acc, liab, inv, tx, mh, md] = await Promise.all([
    linked ? getAccounts(token) : null,
    linked ? getLiabilities(token) : null,
    linked ? getInvestmentsHoldings(token) : null,
    linked ? getTransactions(token, daysAgo(30), daysAgo(0)) : null,
    getManualHoldings(userId),
    getManualDebts(userId),
  ]);

  // Accounts / Cash (Plaid only)
  let accounts = (acc && acc.accounts) || [];
  const cashAccts = accounts.filter(a => a.type === 'depository');
  const checkingBal = cashAccts.filter(a => a.subtype === 'checking')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);
  const savingBal = cashAccts.filter(a => a.subtype === 'savings')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);
  const otherCash = cashAccts.filter(a => a.subtype !== 'checking' && a.subtype !== 'savings')
    .map(a => a.balances?.available ?? a.balances?.current ?? 0);

  const checking     = money(sum(checkingBal));
  const savings      = money(sum(savingBal));
  const cashOther    = money(sum(otherCash));
  const totalCashPlaid = money(checking + savings + cashOther);

  // Manual holdings valuation (very simple: sum value or qty*price + cash)
  let manualInvestments = 0;
  if (mh && mh.accounts) {
    manualInvestments = money(sum(
      (mh.accounts||[]).map(a=>{
        const cash  = +a.cash || 0;
        const holds = sum((a.holdings||[]).map(h=>{
          const qty   = +h.quantity || 0;
          const price = +h.price    || 0;
          const val   = +h.value || (qty * price);
          return val || 0;
        }));
        return cash + holds;
      })
    ));
  }

  // Plaid investments
  let plaidInvestments = 0;
  if (inv && inv.holdings && inv.securities) {
    const holdings = inv.holdings;
    const secMap = new Map();
    inv.securities.forEach(s => secMap.set(s.security_id, s));
    plaidInvestments = money(sum(holdings.map(h => {
      if (typeof h.institution_value === 'number') return h.institution_value;
      const sec = secMap.get(h.security_id);
      const px  = (sec && (sec.close_price ?? sec.price)) || 0;
      return (+h.quantity || 0) * (+px || 0);
    })));
  }

  // Liabilities (Plaid)
  let totalLiabPlaid = 0;
  if (liab && liab.liabilities) {
    const L = liab.liabilities;
    const cc   = (L.credit   || []).map(x => x.balance?.current ?? 0);
    const stu  = (L.student  || []).map(x => x.outstanding_balance ?? 0);
    const mort = (L.mortgage || []).map(x => x.principal_balance ?? 0);
    const auto = (L.auto     || []).map(x => x.outstanding_balance ?? 0);
    totalLiabPlaid = money(sum(cc) + sum(stu) + sum(mort) + sum(auto));
  }

  // Manual debts (sum balances)
  let manualDebts = 0;
  if (md && Array.isArray(md.items)) {
    manualDebts = money(sum((md.items||[]).map(d => +d.balance || 0)));
  }

  // Transactions KPIs
  let income30 = 0, spend30 = 0, netCashFlow = 0, monthlySpend = 0, savingsRate = 0;
  if (tx && tx.transactions) {
    const t = tx.transactions;
    // Normalize
    income30 = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    spend30  = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
    if (income30 < spend30 && sum(t.map(x=>x.amount)) < 0) {
      income30 = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
      spend30  = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    }
    netCashFlow  = money(income30 - spend30);
    monthlySpend = spend30 || 2000;
    savingsRate  = income30 ? Math.max(0, Math.min(1, netCashFlow / income30)) : 0;
  } else {
    monthlySpend = 2000;
    savingsRate  = 0.20;
    netCashFlow  = 0;
  }

  // Combined
  const totalInvestments = money(plaidInvestments + manualInvestments);
  const totalLiabilities = money(totalLiabPlaid + manualDebts);

  const totalCash    = totalCashPlaid;
  const runwayMonths = monthlySpend ? money(totalCash / monthlySpend) : 0;
  const netWorth     = money(totalCash + totalInvestments - totalLiabilities);

  return {
    linked,
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
    manual: { holdings: mh || null, debts: md || null },
    kpis: {
      netWorth,
      totalCash,
      checking,
      savings,
      cashOther,
      totalInvestments,
      plaidInvestments,
      manualInvestments,
      totalLiabilities,
      plaidLiabilities: totalLiabPlaid,
      manualLiabilities: manualDebts,
      income30, spend30, netCashFlow, monthlySpend, savingsRate, runwayMonths
    }
  };
}

// ----------------------- AI (JAMARI Fusion) ---------------
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
      headers:{ 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.3, messages: [
        { role:'system', content: system }, { role:'user', content: prompt }
      ]})
    }));
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch { return null; }
}
async function askAnthropic(prompt, system) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type':'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, system, messages: [{ role:'user', content:[{ type:'text', text: prompt }] }] })
    }));
    const j = await r.json();
    const text = j?.content?.[0]?.text?.trim();
    return text || null;
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
  let extra = [];
  for (let i=1;i<texts.length;i++){
    const parts = texts[i].split(/(?<=\.)\s+/);
    for (const p of parts){
      const k = p.trim().toLowerCase();
      if (k && !seen.has(k)) { extra.push(p.trim()); if (extra.length>=3) break; }
    }
    if (extra.length>=3) break;
  }
  return [first, ...extra].join(' ');
}

// ----------------------- HTTP Server ---------------------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  try {
    // Health
    if (req.method === 'GET' && path === '/') {
      return json(res, 200, { ok:true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }
    if (req.method === 'GET' && path === '/ping') {
      return json(res, 200, { ok:true, env: PLAID_ENV });
    }

    // ----- Plaid: create Link token -----
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

    // ----- Plaid: update Link token to add investments to existing Item -----
    if (req.method === 'POST' && path === '/plaid/link_token/update') {
      const body = await readJSON(req);
      const userId = body.userId || 'default';
      const access_token = await latestTokenForUser(userId);
      if (!access_token) return json(res, 400, { error: 'NO_ACCESS_TOKEN' });

      return safePlaid(res, async () => {
        const reqBody = {
          access_token,
          user: { client_user_id: userId },
          products: ['investments'],
          client_name: 'ACTIV',
          language: 'en',
          country_codes: COUNTRY_CODES,
        };
        if (PLAID_REDIRECT_URI) reqBody.redirect_uri = PLAID_REDIRECT_URI;
        const out = await plaidPost('/link/token/create', reqBody); // update mode (has access_token)
        json(res, 200, { link_token: out.link_token, expiration: out.expiration });
      });
    }

    // ----- Plaid: exchange public_token -----
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      const public_token = body.public_token;
      if (!public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.userId || 'default';

      return safePlaid(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token });
        await storeToken(userId, data.access_token, data.item_id);
        json(res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // ----- Plaid: accounts/balances -----
    if (req.method === 'GET' && (path === '/plaid/accounts' || path === '/plaid/balances')) {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ----- Plaid: transactions (range) -----
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      const end   = (parsed.query.end || daysAgo(0));
      const start = (parsed.query.start || daysAgo(30));
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/get', {
          access_token: token, start_date: start, end_date: end, options: { count: 250, offset: 0 }
        });
        json(res, 200, data);
      });
    }

    // ----- Plaid: transactions/sync -----
    if (req.method === 'POST' && path === '/plaid/transactions/sync') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      const cursor = body.cursor || null;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(res, 200, data);
      });
    }

    // ----- Plaid: liabilities -----
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      return safePlaid(res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ----- Plaid: investments holdings/transactions -----
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      const end   = (parsed.query.end || daysAgo(0));
      const start = (parsed.query.start || daysAgo(90));
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/transactions/get', {
          access_token: token, start_date: start, end_date: end
        });
        json(res, 200, data);
      });
    }

    // ----- Plaid: item info -----
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // ----- Plaid: unlink/remove item (two aliases supported) -----
    if (req.method === 'POST' && (path === '/plaid/unlink' || path === '/plaid/item/remove')) {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = await latestTokenForUser(userId);
      if (!token) return json(res, 200, { ok:true, message:'Nothing to unlink' });
      return safePlaid(res, async () => {
        await plaidPost('/item/remove', { access_token: token });
        memTokens.delete(userId);
        if (pgPool) await pgPool.query(`DELETE FROM tokens WHERE user_id=$1`, [userId]);
        json(res, 200, { ok:true });
      });
    }

    // ----- User delete (purge backend memory and DB for this user) -----
    if (req.method === 'POST' && path === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      memTokens.delete(userId);
      if (pgPool) await pgPool.query(`DELETE FROM tokens WHERE user_id=$1`, [userId]);
      return json(res, 200, { ok:true });
    }

    // ----- Manual Holdings (Wealth) -----
    if (req.method === 'GET' && path === '/wealth/manual') {
      const userId = (parsed.query.userId || 'default').toString();
      const data = await getManualHoldings(userId);
      return json(res, 200, { userId, data: data || { accounts: [] } });
    }
    if (req.method === 'POST' && path === '/wealth/manual') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const data = body.data && typeof body.data === 'object' ? body.data : { accounts: [] };
      await pgPool.query(`
        INSERT INTO manual_holdings (user_id, data, updated_at)
        VALUES ($1,$2,NOW())
        ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()
      `, [userId, data]);
      return json(res, 200, { ok:true });
    }
    if (req.method === 'DELETE' && path === '/wealth/manual') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      await pgPool.query(`DELETE FROM manual_holdings WHERE user_id=$1`, [userId]);
      return json(res, 200, { ok:true });
    }

    // ----- Manual Debts (Liabilities) -----
    if (req.method === 'GET' && path === '/debt/manual') {
      const userId = (parsed.query.userId || 'default').toString();
      const row = await getManualDebts(userId);
      return json(res, 200, { userId, data: row || { items: [] } });
    }
    if (req.method === 'POST' && path === '/debt/manual') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const data = body.data && typeof body.data === 'object' ? body.data : { items: [] };
      await pgPool.query(`
        INSERT INTO manual_debts (user_id, data, updated_at)
        VALUES ($1,$2,NOW())
        ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()
      `, [userId, data]);
      return json(res, 200, { ok:true });
    }
    if (req.method === 'DELETE' && path === '/debt/manual') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      await pgPool.query(`DELETE FROM manual_debts WHERE user_id=$1`, [userId]);
      return json(res, 200, { ok:true });
    }

    // ----- Family (invite/accept/links/household) -----
    // Frontend sends: invite { userId, email }, accept { userId, code }
    if (req.method === 'POST' && path === '/family/invite') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body  = await readJSON(req);
      const owner = (body.owner_user_id || body.userId || 'default').toString();
      const invited = (body.invited_user_id || body.email || '').toString();
      if (!invited) return json(res, 400, { error:'MISSING_INVITED' });
      await pgPool.query(`
        INSERT INTO family_links (owner_user_id, invited_user_id, status, created_at)
        VALUES ($1,$2,'pending',NOW())
        ON CONFLICT (owner_user_id, invited_user_id) DO UPDATE SET status='pending'
      `, [owner, invited]);
      return json(res, 200, { ok:true });
    }
    if (req.method === 'POST' && path === '/family/accept') {
      if (!pgPool) return json(res, 400, { error:'PERSISTENCE_NOT_CONFIGURED' });
      const body  = await readJSON(req);
      const invitee = (body.invited_user_id || body.userId || '').toString(); // the person accepting
      const code    = (body.code || '').toString(); // optional code (we accept either)
      if (!invitee && !code) return json(res, 400, { error:'MISSING_PARAMS' });

      // Accept any pending where invited_user_id matches invitee or code
      await pgPool.query(`
        UPDATE family_links
        SET status='accepted'
        WHERE status='pending' AND (invited_user_id=$1 OR invited_user_id=$2)
      `, [invitee, code]);
      return json(res, 200, { ok:true });
    }
    if (req.method === 'GET' && path === '/family/links') {
      if (!pgPool) return json(res, 200, { links: [] });
      const userId = (parsed.query.userId || 'default').toString();
      const rows = await dbAny(`
        SELECT owner_user_id, invited_user_id, status, created_at
        FROM family_links
        WHERE owner_user_id=$1 OR invited_user_id=$1
      `, [userId]);
      return json(res, 200, { links: rows });
    }
    // Frontend expects /family/household
    if (req.method === 'GET' && path === '/family/household') {
      if (!pgPool) return json(res, 200, { householdId: null, members: [] });
      const userId = (parsed.query.userId || 'default').toString();
      const links = await dbAny(`
        SELECT owner_user_id, invited_user_id, status
        FROM family_links
        WHERE (owner_user_id=$1 OR invited_user_id=$1) AND status='accepted'
      `, [userId]);
      const set = new Set([userId]);
      links.forEach(l => { set.add(l.owner_user_id); set.add(l.invited_user_id); });
      const members = Array.from(set).map(u => ({ userId: u, email: u, role: (u===userId?'you':'member') }));
      const householdId = members.length > 1 ? ('hh_' + Buffer.from(members.sort().join('|')).toString('base64').slice(0,12)) : null;
      return json(res, 200, { householdId, members });
    }

    // ----- Summary KPIs (combined Plaid + Manual) -----
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

    // ----- JAMARI AI Fusion -----
    if (req.method === 'POST' && path === '/jamari/chat') {
      const body = await readJSON(req);
      const userId  = (body.userId || 'default').toString();
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

      const context = [
        `Live KPIs:`,
        `NetWorth: $${k.netWorth||0} | Cash: $${k.totalCash||0} | Savings: $${k.savings||0} | Checking: $${k.checking||0}`,
        `Investments (total): $${k.totalInvestments||0} (Plaid: $${k.plaidInvestments||0} | Manual: $${k.manualInvestments||0})`,
        `Liabilities (total): $${k.totalLiabilities||0} (Plaid: $${k.plaidLiabilities||0} | Manual: $${k.manualLiabilities||0})`,
        `Income(30d): $${k.income30||0} | Spend(30d): $${k.spend30||0} | NetCashFlow: $${k.netCashFlow||0}`,
        `MonthlySpend est: $${k.monthlySpend||0} | Runway: ${k.runwayMonths||0} mo | SavingsRate: ${(k.savingsRate*100||0).toFixed(1)}%`,
        ``,
        `User: ${message}`
      ].join('\n');

      try {
        const [o, a, g] = await Promise.all([
          askOpenAI(context, sys),
          askAnthropic(context, sys),
          askGemini(context, sys),
        ]);
        const fused = fuseReplies([o,a,g]);
        return json(res, 200, { reply: fused, providers: { openai: !!o, anthropic: !!a, gemini: !!g } });
      } catch (e) {
        console.error('jamari/chat error', e);
        return json(res, 500, { error:'CHAT_ERROR' });
      }
    }

    // ----- Webhook (optional) -----
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
    json(res, 500, { error: 'SERVER_ERROR', details: err?.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV}`);
});

// ----------------------- Link token helper ----------------
async function linkTokenCreateSmart(baseReq, prods) {
  let products = cleanProducts(prods);
  if (products.length === 0) products = ['transactions'];
  let attempts = 0;
  while (products.length && attempts < 4) {
    attempts++;
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
        products = ['transactions','liabilities','investments'].filter(p => products.includes(p));
        if (!products.length) products = ['transactions'];
        continue;
      }
      throw e;
    }
  }
  const fallback = await plaidPost('/link/token/create', { ...baseReq, products: ['transactions'] });
  return { ...fallback, products_used: ['transactions'] };
}