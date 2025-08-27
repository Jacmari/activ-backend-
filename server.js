// ACTIV Finance Backend – Plaid Link (prod-ready, no extras)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();

// ---------- CORS (fixes OPTIONS preflight issues) ----------
app.use(cors());
app.options("*", cors());            // allow all OPTIONS
app.use(bodyParser.json());

// ---------- Env ----------
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = (process.env.PLAID_ENV || "sandbox").toLowerCase(); // "production" when live
const PORT            = process.env.PORT || 3000;

// Basic checks (won’t crash app)
if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.warn("⚠️  Missing PLAID_CLIENT_ID or PLAID_SECRET in env vars.");
}
if (!["sandbox","development","production"].includes(PLAID_ENV)) {
  console.warn(`⚠️  Unknown PLAID_ENV "${PLAID_ENV}". Falling back to "sandbox".`);
}

// ---------- Plaid client ----------
const config = new Configuration({
  basePath: PlaidEnvironments[["sandbox","development","production"].includes(PLAID_ENV) ? PLAID_ENV : "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});
const client = new PlaidApi(config);

// ---------- Health ----------
app.get("/ping", (_req, res) => {
  res.json({ status: "ok", env: PLAID_ENV, message: "Backend is running 🚀" });
});

// ---------- Create Link Token ----------
app.post("/plaid/link_token/create", async (_req, res) => {
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "demo-user" },
      client_name: "ACTIV FINANCE JAMARI",
      // Only products you’re approved for. Keep it to transactions.
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    return res.json(response.data);
  } catch (err) {
    const e = err?.response?.data || err?.message || err;
    console.error("link_token/create error:", e);
    return res.status(500).json({ error: "Failed to create link_token", details: e });
  }
});

// ---------- Exchange public_token (Plaid -> access_token) ----------
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "public_token missing" });

    const exchange = await client.itemPublicTokenExchange({ public_token });
    // NOTE: store exchange.data.access_token securely in a DB for the user.
    // For your app we just acknowledge success.
    return res.json({ ok: true });
  } catch (err) {
    const e = err?.response?.data || err?.message || err;
    console.error("exchange_public_token error:", e);
    return res.status(500).json({ error: "Failed to exchange public_token", details: e });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ ACTIV backend listening on :${PORT} (env=${PLAID_ENV})`);
});