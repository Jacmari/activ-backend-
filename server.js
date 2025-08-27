// server.js
'use strict';

const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(express.json());

// -------- CORS (no extra package needed) ----------
app.use((req, res, next) => {
  // Allow your web app to call this backend
  res.setHeader('Access-Control-Allow-Origin', '*'); // you can restrict to your domain later
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -------- Env vars (from Heroku Config Vars) ----------
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET    = process.env.PLAID_SECRET || '';
// default to production since you’re live; set PLAID_ENV to "sandbox" if you want to test
const PLAID_ENV = (process.env.PLAID_ENV || 'production').toLowerCase(); // 'production' | 'sandbox' | 'development'

// Map to Plaid SDK env
const VALID_ENVS = { production: 'production', sandbox: 'sandbox', development: 'development' };
const envKey = VALID_ENVS[PLAID_ENV] || 'production';

// -------- Plaid client ----------
let client;
try {
  const config = new Configuration({
    basePath: PlaidEnvironments[envKey],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  });
  client = new PlaidApi(config);
} catch (e) {
  console.error('Plaid client init error:', e);
}

// In-memory store for exchanged access tokens (for demo/tracking only).
// For real production, persist securely in a DB keyed by your user id.
const TOKENS = new Map();

// -------- Health check ----------
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running 🚀', env: envKey });
});

// -------- Create Link Token (transactions only) ----------
app.post('/plaid/link_token/create', async (req, res) => {
  try {
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
      return res.status(500).json({ error: 'PLAID_CLIENT_ID/PLAID_SECRET not set' });
    }
    const userId =
      (req.body && (req.body.user_id || req.body.client_user_id)) ||
      req.header('x-user-id') ||
      'local-user';

    const request = {
      user: { client_user_id: String(userId) },
      client_name: 'ACTIV FINANCE JAMARI',
      // IMPORTANT: only request what you’re approved for
      products: ['transactions'],
      language: 'en',
      country_codes: ['US'],
      // If Plaid asked you to set a redirect_uri for OAuth, add:
      // redirect_uri: process.env.PLAID_REDIRECT_URI
    };

    const response = await client.linkTokenCreate(request);
    res.json(response.data);
  } catch (err) {
    const data = err?.response?.data;
    console.error('Link token error:', data || err);
    res.status(400).json({
      error: 'Failed to create link_token',
      details: data || String(err),
    });
  }
});

// -------- Exchange Public Token for Access Token ----------
app.post('/plaid/exchange_public_token', async (req, res) => {
  try {
    const public_token = req.body?.public_token;
    if (!public_token) return res.status(400).json({ error: 'public_token required' });

    const response = await client.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;

    // Store in memory for this demo (replace with DB in real app)
    TOKENS.set(item_id, access_token);

    res.json({ ok: true, item_id });
  } catch (err) {
    const data = err?.response?.data;
    console.error('Exchange error:', data || err);
    res.status(400).json({
      error: 'Failed to exchange public_token',
      details: data || String(err),
    });
  }
});

// -------- (Optional) simple accounts fetch to verify it works ----------
app.get('/plaid/accounts/:item_id', async (req, res) => {
  try {
    const access_token = TOKENS.get(req.params.item_id);
    if (!access_token) return res.status(404).json({ error: 'Unknown item_id' });
    const response = await client.accountsGet({ access_token });
    res.json(response.data);
  } catch (err) {
    const data = err?.response?.data;
    console.error('Accounts error:', data || err);
    res.status(400).json({ error: 'Failed to fetch accounts', details: data || String(err) });
  }
});

// -------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ACTIV backend listening on port ${PORT} (Plaid env: ${envKey})`);
});