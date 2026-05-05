// cosmo/src/x402.js — mock x402-style paid endpoints. Returns 402 until a valid Solana tx is presented.
//
// Mock mode (MOCK_MODE=1): the SOL transfer is faked (any sig starting with
// MOCK_ passes verification) but the upstream data fetched and returned is
// REAL. The premise of the demo is "agents pay for live data" — fake data
// inside a fake-payment wrapper undermines that. So we keep mock payments
// (can't drain bot's SOL on every visitor) and pull real data underneath.
//
// Upstream sources (free, no auth, browser CORS not required since we fetch server-side):
//   /price   → CoinGecko free tier (60s cache)
//   /weather → wttr.in (60s cache, San Francisco default)
//   /news    → existing news.js fetchTopicalHeadline (already used for koan substrate)

const { PublicKey, SystemProgram } = require('@solana/web3.js');
const { getConnection } = require('./wallet');
const { fetchTopicalHeadline } = require('./news');

// In-memory replay protection for demo. Production: persistent store.
const usedSigs = new Set();

// Per-endpoint cache to keep upstream API call rates well under free-tier limits.
const _cache = new Map();
async function cached(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && (now - hit.at) < ttlMs) return hit.value;
  const value = await fetcher();
  _cache.set(key, { at: now, value });
  return value;
}

async function fetchPriceData() {
  return cached('price', 60_000, async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
    if (!r.ok) throw new Error('coingecko ' + r.status);
    const d = await r.json();
    return {
      endpoint: 'api.coingecko.com',
      price: {
        SOL: d.solana?.usd ?? null,
        BTC: d.bitcoin?.usd ?? null,
        ETH: d.ethereum?.usd ?? null,
      },
      change_24h_pct: {
        SOL: d.solana?.usd_24h_change?.toFixed(2) ?? null,
        BTC: d.bitcoin?.usd_24h_change?.toFixed(2) ?? null,
        ETH: d.ethereum?.usd_24h_change?.toFixed(2) ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  });
}

async function fetchWeatherData() {
  return cached('weather', 60_000, async () => {
    // wttr.in's free geocoding is noisy on city-name lookups (returns wrong
    // nearest_area for many inputs), so we use lat/lon for SF (37.7749,-122.4194)
    // which routes deterministically. The agent itself has no location — what
    // we report is "weather right now over the bay" which is the closest thing
    // to ambient weather an autonomous entity has.
    const r = await fetch('https://wttr.in/37.7749,-122.4194?format=j1');
    if (!r.ok) throw new Error('wttr.in ' + r.status);
    const d = await r.json();
    const cur = (d.current_condition && d.current_condition[0]) || {};
    return {
      endpoint: 'wttr.in',
      forecast: `${cur.weatherDesc?.[0]?.value || 'unknown'}, ${cur.temp_F || '?'}°F, wind ${cur.winddir16Point || ''} ${cur.windspeedMiles || '?'}mph`,
      humidity_pct: cur.humidity,
      timestamp: new Date().toISOString(),
    };
  });
}

async function fetchNewsData() {
  return cached('news', 60_000, async () => {
    const headline = await fetchTopicalHeadline();
    return {
      endpoint: headline?.source || 'multi-source aggregator',
      headlines: headline ? [headline.title] : [],
      source_url: headline?.url || null,
      timestamp: new Date().toISOString(),
    };
  });
}

// Verify by inspecting the transfer instruction itself, not the post-pre balance
// delta. Balance-delta math fails for self-pay (sender == recipient nets to -fee)
// and is fragile for multi-instruction txs.
async function verifyPayment(sig, expectedRecipient, expectedLamports) {
  const conn = getConnection();
  if (usedSigs.has(sig)) return { ok: false, error: 'tx_replayed' };

  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) return { ok: false, error: 'tx_not_found' };
  if (tx.meta?.err) return { ok: false, error: 'tx_failed_onchain' };

  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys || message.accountKeys;
  const recipientStr = expectedRecipient.toString();
  const systemProgramStr = SystemProgram.programId.toString();

  // Walk every instruction; find a System Transfer to the recipient with
  // lamports >= expected.
  const instructions = message.compiledInstructions || message.instructions || [];
  let paid = 0;
  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex].toString();
    if (programId !== systemProgramStr) continue;
    // SystemProgram.transfer encoding: u32 LE = 2 (Transfer), then u64 LE lamports.
    // ix.data may be Uint8Array (compiled) or base58 string (legacy).
    let data = ix.data;
    if (typeof data === 'string') {
      // legacy: base58 string
      const bs58 = require('bs58');
      data = bs58.decode(data);
    }
    if (data.length < 12) continue;
    const tag = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    if (tag !== 2) continue; // not a Transfer

    // Toaccount index in SystemProgram.Transfer is keys[1]
    const toIdx = ix.accountKeyIndexes ? ix.accountKeyIndexes[1] : ix.accounts[1];
    const toKey = accountKeys[toIdx].toString();
    if (toKey !== recipientStr) continue;

    // lamports as little-endian u64 starting at offset 4
    let lamports = 0n;
    for (let i = 0; i < 8; i++) {
      lamports |= BigInt(data[4 + i]) << BigInt(8 * i);
    }
    paid += Number(lamports);
  }

  if (paid < expectedLamports) {
    return { ok: false, error: `underpaid_${paid}_lt_${expectedLamports}` };
  }

  usedSigs.add(sig);
  return { ok: true, paid };
}

function makeRouter(express) {
  const router = express.Router();

  function challenge(_req, res) {
    res.status(402).json({
      error: 'Payment Required',
      recipient: process.env.PAYMENT_RECIPIENT,
      lamports: parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10),
      cluster: process.env.SOLANA_CLUSTER || 'devnet',
      instructions:
        'send the lamports to recipient on the indicated cluster, then retry with header x-payment-tx: <signature>',
    });
  }

  // gated() now accepts either a static payload OR an async fetcher. Fetcher
  // only runs after payment verification (or mock-mode bypass), so the 402
  // challenge response never triggers an upstream API call.
  async function gated(req, res, payloadOrFetcher) {
    const sig = req.header('x-payment-tx');
    if (!sig) return challenge(req, res);
    const lamports = parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10);

    const mockMode = process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true';

    // Resolve payload AFTER payment passes (real data fetch is the actual cost
    // the agent is "paying" for, even when SOL transfer is mocked).
    let paid;
    if (mockMode && sig.startsWith('MOCK_')) {
      paid = { sig, lamports, mock: true };
    } else {
      const recipient = new PublicKey(process.env.PAYMENT_RECIPIENT);
      const v = await verifyPayment(sig, recipient, lamports);
      if (!v.ok) {
        return res.status(402).json({ error: 'Payment Required', detail: v.error });
      }
      paid = { sig, lamports };
    }

    let payload;
    try {
      payload = (typeof payloadOrFetcher === 'function')
        ? await payloadOrFetcher()
        : payloadOrFetcher;
    } catch (e) {
      console.error('[x402] upstream fetch failed:', e.message);
      return res.status(502).json({ error: 'upstream_unavailable', detail: e.message, paid });
    }
    res.json({ ...payload, paid });
  }

  router.get('/weather', (req, res) => gated(req, res, fetchWeatherData));
  router.get('/price',   (req, res) => gated(req, res, fetchPriceData));
  router.get('/news',    (req, res) => gated(req, res, fetchNewsData));

  return router;
}

module.exports = { makeRouter, verifyPayment };
