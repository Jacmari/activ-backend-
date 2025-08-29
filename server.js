// server.js — ACTIV backend (Plaid + JAMARI AI Fusion) with persistence + multi-user support
// Node 18+, no npm deps except pg (Postgres client)

const http = require('http');
const url = require('url');
const { Pool } = require('pg');

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

// Preferred Plaid products
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];

// AI Keys (accept multiple forms)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-3-haiku-20240307';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-1.5-flash';

// Optional: webhook + redirect
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || '';

// ---------- Database (persistent token storage) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      item_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
dbInit();

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
function daysAgo(n) {
  const d = new Date(Date.now() - n*24*3600*1000);
  return d.toISOString().slice(0,10);
}

// ---- Timeout wrapper ----
function fetchWithTimeout(resource, options = {}, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(resource, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

// ---- Plaid POST ----
async function plaidPost(path, body) {
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
    throw err;
  }
  return data;
}

// ---- Persistent Token Storage ----
async function saveToken(userId, accessToken, itemId) {
  await pool.query(
    `INSERT INTO tokens (user_id, access_token, item_id) VALUES ($1,$2,$3)`,
    [userId, accessToken, itemId]
  );
}
async function getToken(userId) {
  const { rows } = await pool.query(
    `SELECT access_token FROM tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.access_token || null;
}
async function deleteToken(userId) {
  await pool.query(`DELETE FROM tokens WHERE user_id=$1`, [userId]);
}

// ---- Plaid Helpers ----
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

// ---- Build KPI Summary ----
async function buildSummary(userId='default') {
  const access = await getToken(userId);
  if (!access) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(access),
    getLiabilities(access),
    getInvestmentsHoldings(access),
    getTransactions(access, daysAgo(30), daysAgo(0)),
  ]);

  let accounts = (acc && acc.accounts) || [];
  const cashAccts = accounts.filter(a => a.type === 'depository');
  const checking = money(sum(cashAccts.filter(a=>a.subtype==='checking').map(a=>a.balances?.available ?? 0)));
  const savings  = money(sum(cashAccts.filter(a=>a.subtype==='savings').map(a=>a.balances?.available ?? 0)));
  const cashOther= money(sum(cashAccts.filter(a=>!['checking','savings'].includes(a.subtype)).map(a=>a.balances?.available ?? 0)));
  const totalCash= money(checking+savings+cashOther);

  let totalLiabilities = 0;
  if (liab && liab.liabilities) {
    const L = liab.liabilities;
    totalLiabilities = money(
      sum((L.credit||[]).map(x=>x.balance?.current ?? 0)) +
      sum((L.student||[]).map(x=>x.outstanding_balance ?? 0)) +
      sum((L.mortgage||[]).map(x=>x.principal_balance ?? 0)) +
      sum((L.auto||[]).map(x=>x.outstanding_balance ?? 0))
    );
  }

  let totalInvestments = 0;
  if (inv && inv.holdings && inv.securities) {
    const secMap = new Map();
    inv.securities.forEach(s=>secMap.set(s.security_id,s));
    totalInvestments = money(sum(inv.holdings.map(h=>{
      if(typeof h.institution_value==='number') return h.institution_value;
      const sec=secMap.get(h.security_id);
      const px=(sec && (sec.close_price??sec.price))||0;
      return (+h.quantity||0)*(+px||0);
    })));
  }

  let income30=0,spend30=0,netCashFlow=0,monthlySpend=0,savingsRate=0;
  if(tx && tx.transactions){
    const t=tx.transactions;
    income30 = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    spend30  = money(sum(t.filter(x=>x.amount>0).map(x=>x.amount)));
    if(income30<spend30 && sum(t.map(x=>x.amount))<0){
      income30 = money(sum(t.filter(x=>x.amount>0).map(x=>x.amount)));
      spend30  = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    }
    netCashFlow=money(income30-spend30);
    monthlySpend=spend30||2000;
    savingsRate=income30?Math.max(0,Math.min(1,netCashFlow/income30)):0;
  }

  const runwayMonths = monthlySpend?money(totalCash/monthlySpend):0;
  const netWorth = money(totalCash+totalInvestments-totalLiabilities);

  return {
    linked:true,
    userId,
    accounts: accounts.map(a=>({
      account_id:a.account_id,
      name:a.name||a.official_name||'Account',
      mask:a.mask||'',
      type:a.type,
      subtype:a.subtype,
      available:a.balances?.available??null,
      current:a.balances?.current??null,
      currency:a.balances?.iso_currency_code||'USD'
    })),
    kpis:{netWorth,totalCash,checking,savings,cashOther,totalInvestments,totalLiabilities,
      income30,spend30,netCashFlow,monthlySpend,savingsRate,runwayMonths}
  };
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req,res)=>{
  cors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const parsed=url.parse(req.url,true);
  const path=parsed.pathname;

  try {
    // Health
    if(req.method==='GET'&&path==='/'){return json(res,200,{ok:true,env:PLAID_ENV});}
    if(req.method==='GET'&&path==='/ping'){return json(res,200,{ok:true});}

    // Create Link Token
    if(req.method==='POST'&&path==='/plaid/link_token/create'){
      const body=await readJSON(req);
      const userId=body.userId||'default';
      const baseReq={user:{client_user_id:userId},client_name:'ACTIV',language:'en',country_codes:COUNTRY_CODES};
      if(PLAID_REDIRECT_URI) baseReq.redirect_uri=PLAID_REDIRECT_URI;
      if(WEBHOOK_URL) baseReq.webhook=WEBHOOK_URL;
      const data=await plaidPost('/link/token/create',{...baseReq,products:PREFERRED_PRODUCTS});
      return json(res,200,{link_token:data.link_token,expiration:data.expiration,userId});
    }

    // Exchange public_token
    if(req.method==='POST'&&path==='/plaid/exchange_public_token'){
      const body=await readJSON(req);
      if(!body.public_token) return json(res,400,{error:'MISSING_PUBLIC_TOKEN'});
      const userId=body.userId||'default';
      const data=await plaidPost('/item/public_token/exchange',{public_token:body.public_token});
      await saveToken(userId,data.access_token,data.item_id);
      return json(res,200,{item_id:data.item_id,stored_for_user:userId});
    }

    // Accounts
    if(req.method==='GET'&&path==='/plaid/accounts'){
      const userId=(parsed.query.userId||'default').toString();
      const token=await getToken(userId); if(!token) return json(res,401,{error:'NO_LINKED_ITEM_FOR_USER'});
      const data=await plaidPost('/accounts/balance/get',{access_token:token});
      return json(res,200,data);
    }

    // Summary
    if(req.method==='GET'&&path==='/summary'){
      const userId=(parsed.query.userId||'default').toString();
      const s=await buildSummary(userId);
      return json(res,200,s);
    }

    // Unlink
    if(req.method==='POST'&&path==='/plaid/unlink'){
      const body=await readJSON(req);
      const userId=body.userId||'default';
      await deleteToken(userId);
      return json(res,200,{ok:true});
    }

    json(res,404,{error:'NOT_FOUND'});
  }catch(e){
    console.error('Server error',e);
    json(res,500,{error:'SERVER_ERROR',details:e});
  }
});

server.listen(PORT,()=>console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV}`));