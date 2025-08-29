// ACTIV backend — Plaid + JAMARI, with Postgres token persistence.
// Node 18+. Works on Heroku. Creates its own table if missing.
// CORS-safe, timeouts/retries, and best-effort AI fusion.

const http = require('http');
const url = require('url');
const { Pool } = require('pg');

// ---------------- ENV ----------------
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
const PLAID_BASE = BASES[PLAID_ENV] || BASES.production;

// Optional
const WEBHOOK_URL       = process.env.WEBHOOK_URL || '';
const PLAID_REDIRECT_URI= process.env.PLAID_REDIRECT_URI || '';

// AI keys (optional)
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// DB
const DATABASE_URL = process.env.DATABASE_URL || '';
const pg = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

// ---------------- In-memory cache (warm w/ DB) ----------------
const memTokens = new Map(); // userId -> { access_token, item_id, institution_name }

// ---------------- Helpers ----------------
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
  return new Promise((resolve)=> {
    let data=''; req.on('data',ch=>data+=ch);
    req.on('end',()=>{ try{ resolve(JSON.parse(data||'{}')); }catch{ resolve({}); }});
  });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchWithTimeout(url, opts={}, ms=12000){
  return Promise.race([
    fetch(url, opts),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMEOUT')), ms))
  ]);
}
async function plaidPost(path, body, {retries=2} = {}) {
  const payload = JSON.stringify(body);
  let attempt=0, lastErr=null;
  while (attempt <= retries) {
    try {
      const r = await fetchWithTimeout(`${PLAID_BASE}${path}`, {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
          'PLAID-SECRET': PLAID_SECRET
        },
        body: payload
      }, 12000);
      const text = await r.text();
      let data; try{ data = text ? JSON.parse(text) : {}; }catch{ data = { raw:text }; }
      if (!r.ok) {
        const err = data || {};
        err.http_status = r.status;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // backoff on throttles/network
      const code = e?.error_code || e?.error || '';
      if (code === 'RATE_LIMIT_EXCEEDED' || e?.message === 'TIMEOUT' || e?.http_status >= 500) {
        attempt++;
        if (attempt <= retries) await sleep(400 * attempt);
        else break;
      } else break;
    }
  }
  throw lastErr || new Error('PLAID_REQUEST_FAILED');
}

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2); }
const VALID_PRODUCTS = new Set([
  'auth','transactions','identity','assets','investments',
  'liabilities','income','payment_initiation','transfer','signal','credit_details'
]);
const PREFERRED_PRODUCTS = ['transactions','auth','identity','liabilities','investments'];
function cleanProducts(list){
  return (list||PREFERRED_PRODUCTS)
    .map(s=>String(s).trim().toLowerCase()).filter(p=>VALID_PRODUCTS.has(p));
}
function parseInvalidProducts(err){
  const m=(err?.error_message||'').match(/\[([^\]]+)\]/);
  if(!m) return []; return m[1].split(',').map(s=>s.trim().toLowerCase());
}
async function linkTokenCreateSmart(baseReq, prods){
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
        products = products.filter(p=>!bad.has(p));
        if (!products.length) break;
        continue;
      }
      if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'PRODUCTS_NOT_ENABLED') {
        products = ['transactions','auth'].filter(p=>products.includes(p));
        if (!products.length) products = ['transactions'];
        continue;
      }
      throw e;
    }
  }
  const out = await plaidPost('/link/token/create', { ...baseReq, products:['transactions'] });
  return { ...out, products_used:['transactions'] };
}

function errOut(res, err){
  console.error('Plaid error:', err);
  const code = err?.error_code || err?.error || 'PLAID_ERROR';
  const status = (err?.http_status >= 400 && err?.http_status <= 599) ? err.http_status : 500;
  json(res, status, { error: code, details: err });
}

function daysAgo(n){
  const d=new Date(Date.now()-n*24*3600*1000);
  return d.toISOString().slice(0,10);
}
function money(n){ return Math.round((+n||0)*100)/100; }
function sum(a){ return (a||[]).reduce((x,y)=>x+(+y||0),0); }

// ---------------- DB: schema + helpers ----------------
const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  user_id          TEXT PRIMARY KEY,
  access_token     TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  institution_name TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
`;
async function dbInit() {
  if (!pg) return false;
  await pg.query(CREATE_SQL);
  return true;
}
async function dbSetToken({user_id, access_token, item_id, institution_name}) {
  if (!pg) { memTokens.set(user_id, { access_token, item_id, institution_name }); return; }
  await pg.query(
    `INSERT INTO tokens (user_id,access_token,item_id,institution_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET access_token=EXCLUDED.access_token,item_id=EXCLUDED.item_id,institution_name=EXCLUDED.institution_name`,
     [user_id, access_token, item_id, institution_name||null]
  );
  memTokens.set(user_id, { access_token, item_id, institution_name });
}
async function dbGetToken(user_id) {
  if (memTokens.has(user_id)) return memTokens.get(user_id);
  if (!pg) return null;
  const r = await pg.query(`SELECT access_token,item_id,institution_name FROM tokens WHERE user_id=$1`, [user_id]);
  const row = r.rows[0];
  if (!row) return null;
  const val = { access_token: row.access_token, item_id: row.item_id, institution_name: row.institution_name||null };
  memTokens.set(user_id, val);
  return val;
}
async function dbDelToken(user_id) {
  memTokens.delete(user_id);
  if (pg) await pg.query(`DELETE FROM tokens WHERE user_id=$1`, [user_id]);
}

// ---------------- Plaid convenience ----------------
async function getAccounts(access_token){
  try{ return await plaidPost('/accounts/balance/get', { access_token }); }catch{ return null; }
}
async function getLiabilities(access_token){
  try{ return await plaidPost('/liabilities/get', { access_token }); }catch{ return null; }
}
async function getInvestmentsHoldings(access_token){
  try{ return await plaidPost('/investments/holdings/get', { access_token }); }catch{ return null; }
}
async function getTransactions(access_token, start, end){
  try{
    return await plaidPost('/transactions/get', {
      access_token, start_date:start, end_date:end, options:{ count:250, offset:0 }
    });
  }catch{ return null; }
}

// ---------------- Summary builder ----------------
async function buildSummary(userId='default'){
  const tok = await dbGetToken(userId);
  if (!tok?.access_token) return { linked:false };

  const [acc, liab, inv, tx] = await Promise.all([
    getAccounts(tok.access_token),
    getLiabilities(tok.access_token),
    getInvestmentsHoldings(tok.access_token),
    getTransactions(tok.access_token, daysAgo(30), daysAgo(0)),
  ]);

  const accounts=(acc?.accounts)||[];
  const cash = accounts.filter(a=>a.type==='depository');
  const chk = cash.filter(a=>a.subtype==='checking').map(a=>a.balances?.available ?? a.balances?.current ?? 0);
  const sav = cash.filter(a=>a.subtype==='savings').map(a=>a.balances?.available ?? a.balances?.current ?? 0);
  const other = cash.filter(a=>!['checking','savings'].includes(a.subtype))
                    .map(a=>a.balances?.available ?? a.balances?.current ?? 0);

  const checking=money(sum(chk)), savings=money(sum(sav)), cashOther=money(sum(other));
  const totalCash=money(checking+savings+cashOther);

  let totalLiabilities=0;
  if (liab?.liabilities){
    const L=liab.liabilities;
    totalLiabilities = money(sum((L.credit||[]).map(x=>x.balance?.current ?? 0))
      + sum((L.student||[]).map(x=>x.outstanding_balance ?? 0))
      + sum((L.mortgage||[]).map(x=>x.principal_balance ?? 0))
      + sum((L.auto||[]).map(x=>x.outstanding_balance ?? 0)));
  }

  let totalInvestments=0;
  if (inv?.holdings && inv?.securities){
    const secMap=new Map(); inv.securities.forEach(s=>secMap.set(s.security_id,s));
    totalInvestments = money(sum(inv.holdings.map(h=>{
      if (typeof h.institution_value==='number') return h.institution_value;
      const sec=secMap.get(h.security_id); const px=sec?.close_price ?? sec?.price ?? 0;
      return (+h.quantity||0) * (+px||0);
    })));
  }

  let income30=0, spend30=0, netCashFlow=0, monthlySpend=0, savingsRate=0;
  if (tx?.transactions){
    const t=tx.transactions;
    income30 = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    spend30  = money(sum(t.filter(x=>x.amount>0).map(x=> x.amount)));
    if (income30 < spend30 && sum(t.map(x=>x.amount)) < 0){
      income30 = money(sum(t.filter(x=>x.amount>0).map(x=>x.amount)));
      spend30  = money(sum(t.filter(x=>x.amount<0).map(x=>-x.amount)));
    }
    netCashFlow = money(income30 - spend30);
    monthlySpend = spend30||2000;
    savingsRate = income30 ? Math.max(0, Math.min(1, netCashFlow/income30)) : 0;
  } else {
    monthlySpend = 2000; savingsRate=0.20; netCashFlow=0;
  }

  const runwayMonths = monthlySpend ? money(totalCash/monthlySpend) : 0;
  const netWorth = money(totalCash + totalInvestments - totalLiabilities);

  return {
    linked: true,
    userId,
    accounts: accounts.map(a=>({
      account_id: a.account_id,
      name: a.name || a.official_name || 'Account',
      mask: a.mask || '',
      type: a.type, subtype: a.subtype,
      available: a.balances?.available ?? null,
      current:   a.balances?.current   ?? null,
      currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || 'USD'
    })),
    kpis: { netWorth,totalCash,checking,savings,cashOther,totalInvestments,totalLiabilities,
            income30,spend30,netCashFlow,monthlySpend,savingsRate,runwayMonths }
  };
}

// ---------------- AI Fusion (optional) ----------------
function withTimeout(p,ms=14000){ return Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error('TIMEOUT')),ms))]); }
async function askOpenAI(prompt, system){
  if(!OPENAI_API_KEY) return null;
  try{
    const r=await withTimeout(fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({ model:OPENAI_MODEL, temperature:0.3,
        messages:[{role:'system',content:system},{role:'user',content:prompt}]})
    }));
    const j=await r.json(); return j?.choices?.[0]?.message?.content?.trim()||null;
  }catch{ return null; }
}
async function askAnthropic(prompt, system){
  if(!ANTHROPIC_API_KEY) return null;
  try{
    const r=await withTimeout(fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify({ model:ANTHROPIC_MODEL, max_tokens:1024, system,
        messages:[{role:'user',content:[{type:'text',text:prompt}]}] })
    }));
    const j=await r.json(); return j?.content?.[0]?.text?.trim()||null;
  }catch{ return null; }
}
async function askGemini(prompt, system){
  if(!GEMINI_API_KEY) return null;
  try{
    const r=await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ contents:[{parts:[{text:`${system}\n\n${prompt}` }]}],
        generationConfig:{temperature:0.3,maxOutputTokens:1024} })
    }));
    const j=await r.json();
    return (j?.candidates?.[0]?.content?.parts||[]).map(p=>p.text).join(' ').trim()||null;
  }catch{ return null; }
}
function fuseReplies(list){
  const texts=list.filter(Boolean).map(s=>String(s).trim()).filter(Boolean);
  if(!texts.length) return "I'm ready, but no AI providers responded. Check your AI keys.";
  const first=texts[0], seen=new Set(first.split(/(?<=\.)\s+/).map(s=>s.trim().toLowerCase()));
  const extra=[]; for(let i=1;i<texts.length;i++){for(const p of texts[i].split(/(?<=\.)\s+/)){const k=p.trim().toLowerCase();if(k&&!seen.has(k)){extra.push(p.trim()); if(extra.length>=3) break;}} if(extra.length>=3) break;}
  return [first,...extra].join(' ');
}

// ---------------- Server ----------------
const server = http.createServer(async (req, res)=>{
  cors(res);
  if (req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url,true);
  const path   = parsed.pathname;

  try {
    // Health
    if (req.method==='GET' && path==='/') {
      return json(res,200,{ ok:true, env:PLAID_ENV, db:!!pg, dbReady: !!pg });
    }
    if (req.method==='GET' && path==='/ping') { return json(res,200,{ ok:true, env:PLAID_ENV }); }

    // Diagnostics (safe)
    if (req.method==='GET' && path==='/diag'){
      return json(res,200,{
        env: PLAID_ENV, has_client_id: !!PLAID_CLIENT_ID, has_secret: !!PLAID_SECRET,
        countries: COUNTRY_CODES, db: !!pg
      });
    }

    // ---- Plaid: Link Token
    if (req.method==='POST' && path==='/plaid/link_token/create'){
      const body = await readJSON(req);
      const userId = body.userId || body.user_id || 'default';
      const baseReq = {
        user: { client_user_id: userId },
        client_name: 'ACTIV',
        language: 'en',
        country_codes: COUNTRY_CODES
      };
      if (PLAID_REDIRECT_URI) baseReq.redirect_uri = PLAID_REDIRECT_URI;
      if (WEBHOOK_URL) baseReq.webhook = WEBHOOK_URL;

      try{
        const data = await linkTokenCreateSmart(baseReq, body.products||PREFERRED_PRODUCTS);
        return json(res,200,{ link_token:data.link_token, expiration:data.expiration, userId, products_used:data.products_used });
      }catch(e){ return errOut(res,e); }
    }

    // ---- Exchange public_token -> store token
    if (req.method==='POST' && path==='/plaid/exchange_public_token'){
      const body = await readJSON(req);
      const public_token = body.public_token;
      const userId = body.userId || 'default';
      if (!public_token) return json(res,400,{ error:'MISSING_PUBLIC_TOKEN' });
      try{
        const data = await plaidPost('/item/public_token/exchange', { public_token });
        // Try to fetch institution name for convenience (best-effort)
        let instName=null;
        try {
          const item = await plaidPost('/item/get', { access_token: data.access_token });
          if (item?.item?.institution_id) {
            const inst = await plaidPost('/institutions/get_by_id', { institution_id: item.item.institution_id, country_codes: COUNTRY_CODES });
            instName = inst?.institution?.name || null;
          }
        } catch(_) {}
        await dbInit().catch(()=>{});
        await dbSetToken({ user_id:userId, access_token:data.access_token, item_id:data.item_id, institution_name:instName });
        return json(res,200,{ item_id:data.item_id, stored_for_user:userId, institution_name:instName });
      }catch(e){ return errOut(res,e); }
    }

    // ---- Data endpoints (require access token)
    async function withToken(res, userId, fn){
      const t = await dbGetToken(userId);
      if (!t?.access_token) return json(res,401,{ error:'NO_LINKED_ITEM_FOR_USER' });
      try{ const out = await fn(t.access_token); return json(res,200,out); }
      catch(e){ return errOut(res,e); }
    }

    if (req.method==='GET' && path==='/plaid/accounts'){
      const userId = (parsed.query.userId || 'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/accounts/balance/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/balances'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/accounts/balance/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/transactions'){
      const userId=(parsed.query.userId||'default').toString();
      const start = parsed.query.start || daysAgo(30);
      const end   = parsed.query.end   || daysAgo(0);
      return withToken(res,userId, async (access_token)=> await plaidPost('/transactions/get',{ access_token, start_date:start, end_date:end, options:{ count:250, offset:0 }}));
    }

    if (req.method==='POST' && path==='/plaid/transactions/sync'){
      const body = await readJSON(req);
      const userId=(body.userId||'default').toString();
      const cursor = body.cursor || null;
      return withToken(res,userId, async (access_token)=> await plaidPost('/transactions/sync',{ access_token, cursor, count:500 }));
    }

    if (req.method==='GET' && path==='/plaid/liabilities'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/liabilities/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/investments/holdings'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/investments/holdings/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/investments/transactions'){
      const userId=(parsed.query.userId||'default').toString();
      const start = parsed.query.start || daysAgo(90);
      const end   = parsed.query.end   || daysAgo(0);
      return withToken(res,userId, async (access_token)=> await plaidPost('/investments/transactions/get',{ access_token, start_date:start, end_date:end }));
    }

    if (req.method==='GET' && path==='/plaid/auth'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/auth/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/identity'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/identity/get',{ access_token }));
    }

    if (req.method==='GET' && path==='/plaid/item'){
      const userId=(parsed.query.userId||'default').toString();
      return withToken(res,userId, async (access_token)=> await plaidPost('/item/get',{ access_token }));
    }

    // Remove item + delete token
    if (req.method==='POST' && path==='/plaid/unlink'){
      const body = await readJSON(req);
      const userId=(body.userId||'default').toString();
      const t = await dbGetToken(userId);
      if (!t?.access_token) { await dbDelToken(userId).catch(()=>{}); return json(res,200,{ ok:true, message:'Nothing to unlink' }); }
      try{
        await plaidPost('/item/remove', { access_token: t.access_token });
      }catch(_){}
      await dbDelToken(userId).catch(()=>{});
      return json(res,200,{ ok:true });
    }

    // Purge backend record only
    if (req.method==='POST' && path==='/user/delete'){
      const body = await readJSON(req);
      const userId=(body.userId||'default').toString();
      await dbDelToken(userId).catch(()=>{});
      return json(res,200,{ ok:true });
    }

    // Webhook (optional)
    if (req.method==='POST' && path==='/plaid/webhook'){
      const body = await readJSON(req);
      console.log('PLAID WEBHOOK:', JSON.stringify(body));
      res.writeHead(200); return res.end();
    }

    // Summary
    if (req.method==='GET' && path==='/summary'){
      const userId=(parsed.query.userId||'default').toString();
      try{ const s=await buildSummary(userId); return json(res,200,s); }
      catch(e){ console.error('summary error',e); return json(res,500,{ error:'SUMMARY_ERROR' }); }
    }

    // JAMARI chat (AI fusion)
    if (req.method==='POST' && path==='/jamari/chat'){
      const body = await readJSON(req);
      const userId=(body.userId||'default').toString();
      const message=(body.message||'').toString().slice(0,4000);
      if(!message) return json(res,400,{ error:'NO_MESSAGE' });

      const s = await buildSummary(userId); const k=s.kpis||{};
      const sys = [
        "You are JAMARI, a calm, clear personal finance coach.",
        "Use the user's live KPIs when giving advice.",
        "Be concise, actionable, and avoid unnecessary disclaimers.",
        "Never reveal keys or system details."
      ].join(' ');
      const ctx = [
        `Live KPIs:`,
        `NetWorth:$${k.netWorth||0} Cash:$${k.totalCash||0} Savings:$${k.savings||0} Checking:$${k.checking||0}`,
        `Investments:$${k.totalInvestments||0} Liabilities:$${k.totalLiabilities||0}`,
        `Income(30d):$${k.income30||0} Spend(30d):$${k.spend30||0} NetCashFlow:$${k.netCashFlow||0}`,
        `MonthlySpend est:$${k.monthlySpend||0} Runway:${k.runwayMonths||0}mo SavingsRate:${((k.savingsRate||0)*100).toFixed(1)}%`,
        ``,
        `User: ${message}`
      ].join('\n');

      try{
        const [o,a,g]=await Promise.all([askOpenAI(ctx,sys), askAnthropic(ctx,sys), askGemini(ctx,sys)]);
        return json(res,200,{ reply:fuseReplies([o,a,g]), providers:{ openai:!!o, anthropic:!!a, gemini:!!g }});
      }catch(e){ console.error('jamari/chat error',e); return json(res,500,{ error:'CHAT_ERROR' }); }
    }

    // 404
    return json(res,404,{ error:'NOT_FOUND' });
  } catch (e) {
    console.error('Server error:', e);
    return json(res,500,{ error:'SERVER_ERROR', details: String(e?.message||e) });
  }
});

(async ()=>{
  try {
    if (pg) await dbInit();
  } catch(e){ console.error('DB init failed (will use memory fallback):', e); }
  server.listen(PORT, ()=> {
    console.log(`ACTIV backend running on :${PORT} | PLAID_ENV=${PLAID_ENV} | DB=${!!pg}`);
  });
})();