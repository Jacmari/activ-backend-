// server.js — ACTIV backend (Plaid + JAMARI AI Fusion) — Node 18+, no npm deps.
// Works on Heroku. Uses built-in fetch. Production-safe CORS + error handling.

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

// Preferred Plaid products (auto-trim to only enabled)
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

// AI (optional — any missing key is fine; we’ll use what’s available)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-3-haiku-20240307';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';

// Optional: webhook + redirect
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// ---------- Simple in-memory token store (userId -> access_token) ----------
const tokens = new Map();

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
function uid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2)); }
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
function needToken(res, userId) {
  const token = tokens.get(userId);
  if (!token) json(res, 401, { error: 'NO_LINKED_ITEM_FOR_USER' });
  return token;
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

// ---------- Plaid helpers for summary ----------
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
function sum(arr) { return (arr||[]).reduce((a,b)=>a+(+b||0),0); }
function money(n) { return Math.round((+n||0)*100)/100; }

// Build KPI summary from Plaid data (best-effort)
async function buildSummary(userId='default') {
  const access = tokens.get(userId);
  if (!access) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(access),
    getLiabilities(access),
    getInvestmentsHoldings(access),
    getTransactions(access, daysAgo(30), daysAgo(0)),
  ]);

  // Accounts / Cash
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

  // Liabilities total due (balances outstanding)
  let totalLiabilities = 0;
  if (liab && liab.liabilities) {
    const L = liab.liabilities;
    const cc  = (L.credit || []).map(x => x.balance?.current ?? 0);
    const stu = (L.student ?? []).map(x => x.outstanding_balance ?? 0);
    const mort= (L.mortgage ?? []).map(x => x.principal_balance ?? 0);
    const auto= (L.auto ?? []).map(x => x.outstanding_balance ?? 0);
    totalLiabilities = money(sum(cc) + sum(stu) + sum(mort) + sum(auto));
  }

  // Investments total (institution_value if available)
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

  // Transactions KPIs
  let income30 = 0, spend30 = 0, netCashFlow = 0, monthlySpend = 0, savingsRate = 0;
  if (tx && tx.transactions) {
    const t = tx.transactions;
    // Simple heuristic: positives = income, negatives = spend (ignore zeros)
    income30 = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount))); // many banks invert sign; normalize
    spend30  = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
    // Some institutions already give positives=debits, negatives=credits; normalize if flipped:
    if (income30 < spend30 && sum(t.map(x=>x.amount)) < 0) {
      // alternate interpretation: positives are income
      income30 = money(sum(t.filter(x => x.amount > 0).map(x => x.amount)));
      spend30  = money(sum(t.filter(x => x.amount < 0).map(x => -x.amount)));
    }
    netCashFlow = money(income30 - spend30);
    monthlySpend = spend30 || 2000; // fallback
    savingsRate = income30 ? Math.max(0, Math.min(1, netCashFlow / income30)) : 0;
  } else {
    monthlySpend = 2000;
    savingsRate = 0.20;
    netCashFlow = 0;
  }

  // Runway = cash / monthlySpend
  const runwayMonths = monthlySpend ? money(totalCash / monthlySpend) : 0;

  // Net worth (approx) = cash + investments - liabilities
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

// ---------- AI Providers (best-effort, with timeouts) ----------
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
    const text = j?.choices?.[0]?.message?.content?.trim();
    return text || null;
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
    const text = j?.content?.[0]?.text?.trim();
    return text || null;
  } catch { return null; }
}

async function askGemini(prompt, system) {
  if (!GEMINI_API_KEY) return null;
  try {
    const r = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${system}\n\n${prompt}` }]}],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
      })
    }));
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p=>p.text).join(' ').trim();
    return text || null;
  } catch { return null; }
}

function fuseReplies(replies) {
  const texts = replies.filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  if (!texts.length) return "I'm ready, but no AI providers responded. Check your AI keys.";
  // Simple fusion: keep first, append non-duplicate sentences from others
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

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  try {
    // Health
    if (req.method === 'GET' && path === '/') {
      return json(res, 200, { ok:true, env: PLAID_ENV, countries: COUNTRY_CODES });
    }
    // Frontend calls this
    if (req.method === 'GET' && path === '/ping') {
      return json(res, 200, { ok:true, env: PLAID_ENV });
    }

    // Create Link Token (accept user_id or userId)
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

    // Exchange public_token
    if (req.method === 'POST' && path === '/plaid/exchange_public_token') {
      const body = await readJSON(req);
      if (!body.public_token) return json(res, 400, { error: 'MISSING_PUBLIC_TOKEN' });
      const userId = body.userId || 'default';
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        tokens.set(userId, data.access_token);
        json(res, 200, { item_id: data.item_id, stored_for_user: userId });
      });
    }

    // Accounts + Balances
    if (req.method === 'GET' && path === '/plaid/accounts') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }
    // Alias
    if (req.method === 'GET' && path === '/plaid/balances') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Transactions (range)
    if (req.method === 'GET' && path === '/plaid/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      const end = (parsed.query.end || daysAgo(0));
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
      const token = needToken(res, userId); if (!token) return;
      const cursor = body.cursor || null;
      return safePlaid(res, async () => {
        const data = await plaidPost('/transactions/sync', { access_token: token, cursor, count: 500 });
        json(res, 200, data);
      });
    }

    // Liabilities
    if (req.method === 'GET' && path === '/plaid/liabilities') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/liabilities/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Investments
    if (req.method === 'GET' && path === '/plaid/investments/holdings') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/investments/holdings/get', { access_token: token });
        json(res, 200, data);
      });
    }
    if (req.method === 'GET' && path === '/plaid/investments/transactions') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      const end = (parsed.query.end || daysAgo(0));
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
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/auth/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Identity
    if (req.method === 'GET' && path === '/plaid/identity') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/identity/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Item
    if (req.method === 'GET' && path === '/plaid/item') {
      const userId = (parsed.query.userId || 'default').toString();
      const token = needToken(res, userId); if (!token) return;
      return safePlaid(res, async () => {
        const data = await plaidPost('/item/get', { access_token: token });
        json(res, 200, data);
      });
    }

    // Unlink (called by your frontend "Unlink Bank")
    if (req.method === 'POST' && path === '/plaid/unlink') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      const token = tokens.get(userId);
      if (!token) return json(res, 200, { ok:true, message:'Nothing to unlink' });
      return safePlaid(res, async () => {
        await plaidPost('/item/remove', { access_token: token });
        tokens.delete(userId);
        json(res, 200, { ok:true });
      });
    }

    // Delete account (purge backend memory for this user)
    if (req.method === 'POST' && path === '/user/delete') {
      const body = await readJSON(req);
      const userId = (body.userId || 'default').toString();
      tokens.delete(userId);
      return json(res, 200, { ok:true });
    }

    // Webhook (optional)
    if (req.method === 'POST' && path === '/plaid/webhook') {
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200);
      return res.end();
    }

    // ---------- Summary KPIs ----------
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

    // ---------- JAMARI AI Fusion ----------
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

      const context = [
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

    // Not found
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (err) {
    console.error('Server error:', err);
    json(res, 500, { error: 'SERVER_ERROR', details: err });
  }
});

server.listen(PORT, () => {
  console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV}`);
});