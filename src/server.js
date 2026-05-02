// cosmo/src/server.js — entry point. Boots Express, mounts x402 + agent + UI.
require('dotenv').config();
const path = require('path');
const express = require('express');

const { ask } = require('./agent');
const { makeRouter } = require('./x402');
const { getCosmoKeypair, getBalance } = require('./wallet');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

// Mock paid endpoints — Cosmo will call its own server's endpoints in this demo.
app.use('/x402', makeRouter(express));

// Cosmo's public-facing agent endpoint.
app.post('/api/ask', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const result = await ask(prompt, fetch);
    res.json(result);
  } catch (e) {
    console.error('[ask error]', e);
    res.status(500).json({ error: e.message });
  }
});

// Healthcheck must ALWAYS return 200 for Railway/Render to mark the service
// healthy. We attach diagnostic info opportunistically — if the wallet or
// network call fails, we report it inside the response body but never as
// a non-2xx status.
app.get('/api/health', async (_req, res) => {
  const out = {
    ok: true,
    service: 'cosmo',
    cluster: process.env.SOLANA_CLUSTER || 'devnet',
    mock_mode: process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true',
    recipient: process.env.PAYMENT_RECIPIENT || null,
    payment_lamports: parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10),
    wallet: null,
    balance_sol: null,
    warnings: [],
  };
  try {
    const kp = getCosmoKeypair();
    out.wallet = kp.publicKey.toString();
    try {
      out.balance_sol = await getBalance(kp.publicKey);
    } catch (balErr) {
      out.warnings.push(`balance_lookup_failed: ${balErr.message}`);
    }
  } catch (kpErr) {
    out.warnings.push(`wallet_unavailable: ${kpErr.message}`);
  }
  res.status(200).json(out);
});

const port = process.env.PORT || 4019;
app.listen(port, () => {
  console.log('');
  console.log('  > cosmo online');
  console.log('  > http://localhost:' + port);
  console.log('  > cluster: ' + (process.env.SOLANA_CLUSTER || 'devnet'));
  console.log('');
});
