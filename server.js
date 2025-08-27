// server.js
// ACTIV • FINANCE • JAMARI — Plaid minimal backend (link + exchange + balances)

const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(express.json());

// ---------- CORS ----------
const WEB_ORIGIN = process.env.WEB_ORIGIN || '*';
app.use(cors({ origin: WEB_ORIGIN }));

// ---------- ENV ----------
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = (process.env.PLAID_ENV || 'sandbox').toLowerCase(); // 'sandbox' | 'development' | 'production'

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('Missing PLAID_CLIENT_ID or PLAID_SECRET');
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});
const client = new PlaidApi(configuration);

// ---------- SIMPLE TOKEN STORE (single user demo) ----------
// For production, store per-user in a real DB.
let ACCESS_TOKEN = null;

// ---------- HEALTH ----------
app.get('/ping', (_req, res) => res.json({ ok: true, env: PLAID_ENV }));

// ---------- LINK TOKEN ----------
app.post('/plaid/link_token/create', async (req, res) => {
  try {
    const userId = (req.body && req.body.user_id) || 'local-user';
    const resp = await client.linkTokenCreate({
      user: { client_user_id: String(userId) },
      client_name: 'ACTIV • FINANCE • JAMARI',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: resp.data.link_token });
  } catch (err) {
    const e = err?.response?.data || err?.message || err;
    console.error('link_token/create error:', e);
    res.status(500).json({ error: 'LINK_TOKEN_CREATE_FAILED', details: e });
  }
});

// ---------- EXCHANGE PUBLIC TOKEN ----------
app.post('/plaid/exchange_public_token', async (req, res) => {
  try {
    const { public_token } = req.body || {};
    if (!public_token) return res.status(400).json({ error: 'public_token missing' });

    const exchange = await client.itemPublicTokenExchange({ public_token });
    ACCESS_TOKEN = exchange.data.access_token; // save (single-user)
    res.json({ ok: true });
  } catch (err) {
    const e = err?.response?.data || err?.message || err;
    console.error('exchange_public_token error:', e);
    res.status(500).json({ error: 'PUBLIC_TOKEN_EXCHANGE_FAILED', details: e });
  }
});

// ---------- BALANCES ----------
app.get('/plaid/balances', async (_req, res) => {
  try {
    if (!ACCESS_TOKEN) return res.status(400).json({ error: 'NOT_LINKED' });
    const r = await client.accountsBalanceGet({ access_token: ACCESS_TOKEN });
    const accounts = (r.data.accounts || []).map(a => ({
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      available: a.balances?.available ?? null,
      current: a.balances?.current ?? null,
      iso_currency_code: a.balances?.iso_currency_code ?? 'USD',
    }));
    res.json({ accounts });
  } catch (err) {
    const e = err?.response?.data || err?.message || err;
    console.error('balances error:', e);
    res.status(500).json({ error: 'BALANCES_FAILED', details: e });
  }
});

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JAMARI backend listening on ${PORT} (env=${PLAID_ENV})`);
});