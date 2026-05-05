// cosmo/src/server.js — entry point. Boots Express, mounts x402 + agent + UI.
require('dotenv').config();
const path = require('path');
const express = require('express');

const { ask } = require('./agent');
const { makeRouter } = require('./x402');
const { getCosmoKeypair, getBalance } = require('./wallet');
const { computeSummary, recentContributions, allContributions } = require('./contributions_state');
const { priceAt, curveState, TOTAL_SUPPLY, MAX_SOLD_FRACTION, BASE, K } = require('./curve');
const { Connection, PublicKey } = require('@solana/web3.js');

// On-chain SPL balance lookup for vault + treasury wallets. Cached separately
// from the rest of /curve_state.json because RPC calls are the slowest part
// (typically 100-500ms vs <1ms for the JSONL read).
let _chainCache = null;
let _chainCachedAt = 0;
const CHAIN_TTL_MS = 30 * 1000;

async function fetchVaultBalances() {
  const now = Date.now();
  if (_chainCache && (now - _chainCachedAt) < CHAIN_TTL_MS) return _chainCache;

  const mint = process.env.AGNT_TOKEN_MINT;
  const vault = process.env.AGNT_VAULT_WALLET;
  const treasury = process.env.AGNT_TREASURY_WALLET;
  // Pre-mint: nothing to query yet; return nulls so dashboard shows "[live, populated at mint]"
  if (!mint || !vault) {
    _chainCache = { vault_agnt: null, treasury_agnt: null, fetched_at: new Date().toISOString() };
    _chainCachedAt = now;
    return _chainCache;
  }

  const cluster = process.env.SOLANA_CLUSTER || 'mainnet-beta';
  const rpcUrl = cluster === 'mainnet-beta'
    ? (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com')
    : `https://api.${cluster}.solana.com`;
  const conn = new Connection(rpcUrl, 'confirmed');
  const splToken = require('@solana/spl-token');
  const mintPk = new PublicKey(mint);

  async function balanceOf(walletAddr) {
    if (!walletAddr) return null;
    try {
      const ata = await splToken.getAssociatedTokenAddress(mintPk, new PublicKey(walletAddr));
      const info = await conn.getTokenAccountBalance(ata);
      return parseFloat(info.value.uiAmountString);
    } catch (e) {
      // Pre-funding the ATA doesn't exist yet — null is the right answer
      return null;
    }
  }

  const [vault_agnt, treasury_agnt] = await Promise.all([
    balanceOf(vault),
    balanceOf(treasury),
  ]);

  _chainCache = { vault_agnt, treasury_agnt, fetched_at: new Date().toISOString() };
  _chainCachedAt = now;
  return _chainCache;
}

const app = express();
app.use(express.json());

// CORS — the public curve dashboard lives at byagentforagent.com and fetches
// /curve_state.json from this origin. Read-only public data; safe to allow all.
app.use((req, res, next) => {
  if (req.path === '/curve_state.json' || req.path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

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
// healthy. In mock mode we synthesize live-looking values so the public demo
// page shows populated stats — the alternative (null fields) reads as a dead
// service. The synthesized values are clearly labeled (cluster gets "(demo)",
// balance_label gets "(mock)") so we're not pretending mock is real.
app.get('/api/health', async (_req, res) => {
  const inMockMode = process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true';
  const lamports = parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10);
  const cluster = process.env.SOLANA_CLUSTER || 'devnet';

  const out = {
    ok: true,
    service: 'cosmo',
    cluster: inMockMode ? `${cluster} (demo)` : cluster,
    mock_mode: inMockMode,
    recipient: process.env.PAYMENT_RECIPIENT || null,
    payment_lamports: lamports,
    per_call_cost_sol: (lamports / 1_000_000_000).toFixed(4),
    cosmo: null,        // wallet pubkey (page reads this name)
    wallet: null,       // alias for backwards compat
    balance_sol: null,
    balance_label: null,
    warnings: [],
  };

  try {
    const kp = getCosmoKeypair();
    const pk = kp.publicKey.toString();
    out.cosmo = pk;
    out.wallet = pk;
    try {
      const bal = await getBalance(kp.publicKey);
      out.balance_sol = bal;
      out.balance_label = bal.toFixed(3) + ' SOL';
    } catch (balErr) {
      // In mock mode, synthesize 5 SOL so the demo footer reads as alive.
      if (inMockMode) {
        out.balance_sol = 5.000;
        out.balance_label = '5.000 SOL (mock)';
      } else {
        out.warnings.push(`balance_lookup_failed: ${balErr.message}`);
      }
    }
  } catch (kpErr) {
    out.warnings.push(`wallet_unavailable: ${kpErr.message}`);
  }

  // Mock-mode safety net: if anything above didn't populate, synthesize so the
  // demo page never sees nulls.
  if (inMockMode) {
    if (out.balance_sol === null) {
      out.balance_sol = 5.000;
      out.balance_label = '5.000 SOL (mock)';
    }
  }

  res.status(200).json(out);
});

// Live curve state for the public dashboard. Reads contributions.jsonl,
// computes derived values (price, fraction sold, tokens-per-SOL), returns JSON.
// Cached for 5 seconds to avoid re-parsing on every dashboard tick.
let _curveStateCache = null;
let _curveStateCachedAt = 0;
const CURVE_STATE_TTL_MS = 5000;

app.get('/curve_state.json', async (_req, res) => {
  try {
    const now = Date.now();
    if (_curveStateCache && (now - _curveStateCachedAt) < CURVE_STATE_TTL_MS) {
      return res.json(_curveStateCache);
    }
    const summary = computeSummary();
    const recent = recentContributions(10);
    const all = allContributions(); // chronological, oldest-first — for the cap table
    const supplySold = summary.total_agnt_minted || 0;
    const state = curveState(supplySold);
    const chain = await fetchVaultBalances();

    const lastEntry = recent[0] || null;
    const slimContrib = (r) => ({
      tx_hash: r.tx_hash,
      contributor: r.contributor,
      sol_amount: r.sol_amount,
      agnt_minted: r.agnt_minted,
      timestamp: r.timestamp,
    });

    const payload = {
      // Core metrics (off-chain, from contributions.jsonl)
      total_sol: summary.total_sol,
      total_agnt_minted: summary.total_agnt_minted,
      contributors: summary.contributors,
      fraction_sold: state.fractionSold,
      fraction_of_curve_filled: state.fractionSold / MAX_SOLD_FRACTION,

      // Derived curve state
      current_price_per_token: state.pricePerToken,
      current_tokens_per_sol: state.tokensPerSol,
      sold_out: state.soldOut,

      // On-chain truth (verified against the chain, not the bot's records)
      // vault_agnt = curve-mintable supply remaining (vault holds 800M post-mint, decreases as curve fills)
      // treasury_agnt = the 200M reserve held by Squads multisig (static; never moves except for declared LP)
      // Both null pre-mint.
      vault_agnt_balance: chain.vault_agnt,
      treasury_agnt_balance: chain.treasury_agnt,
      chain_fetched_at: chain.fetched_at,

      // Last contribution
      last_tx: summary.last_tx,
      last_ts: summary.last_ts,
      last_sol: lastEntry ? lastEntry.sol_amount : null,

      // Curve constants (committed; never change)
      curve: { base: BASE, k: K, total_supply: TOTAL_SUPPLY, max_sold_fraction: MAX_SOLD_FRACTION },

      // Wallet config (only exposed if explicitly set; pre-launch returns null)
      receiving_wallet: process.env.AGNT_RECEIVING_WALLET || null,
      founder_wallet: process.env.AGNT_FOUNDER_WALLET || null,
      treasury_wallet: process.env.AGNT_TREASURY_WALLET || null,
      vault_wallet: process.env.AGNT_VAULT_WALLET || null,

      // Cap table — every contribution since launch, chronological (oldest-first).
      // Dashboard sorts/ranks from this. Pre-launch: empty array.
      contributions: all.map(slimContrib),

      // Recent contributions, newest-first (kept for backwards compat with anything
      // else that reads `recent`; cap table reads `contributions`).
      recent: recent.map(slimContrib),

      updated_at: new Date().toISOString(),
    };

    _curveStateCache = payload;
    _curveStateCachedAt = now;
    res.json(payload);
  } catch (e) {
    console.error('[curve_state error]', e);
    res.status(500).json({ error: e.message });
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
