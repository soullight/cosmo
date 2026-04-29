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

app.get('/api/health', async (_req, res) => {
  try {
    const kp = getCosmoKeypair();
    const balance = await getBalance(kp.publicKey);
    res.json({
      ok: true,
      cluster: process.env.SOLANA_CLUSTER || 'devnet',
      cosmo: kp.publicKey.toString(),
      balance_sol: balance,
      recipient: process.env.PAYMENT_RECIPIENT,
      payment_lamports: parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 4019;
app.listen(port, () => {
  console.log('');
  console.log('  > cosmo online');
  console.log('  > http://localhost:' + port);
  console.log('  > cluster: ' + (process.env.SOLANA_CLUSTER || 'devnet'));
  console.log('');
});
