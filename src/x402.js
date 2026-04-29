// cosmo/src/x402.js — mock x402-style paid endpoints. Returns 402 until a valid Solana tx is presented.
const { PublicKey, SystemProgram } = require('@solana/web3.js');
const { getConnection } = require('./wallet');

// In-memory replay protection for demo. Production: persistent store.
const usedSigs = new Set();

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

  async function gated(req, res, payload) {
    const sig = req.header('x-payment-tx');
    if (!sig) return challenge(req, res);
    const lamports = parseInt(process.env.PAYMENT_LAMPORTS || '1000000', 10);

    // Mock mode: accept any signature starting with MOCK_ without on-chain verify.
    const mockMode = process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true';
    if (mockMode && sig.startsWith('MOCK_')) {
      return res.json({ ...payload, paid: { sig, lamports, mock: true } });
    }

    const recipient = new PublicKey(process.env.PAYMENT_RECIPIENT);
    const v = await verifyPayment(sig, recipient, lamports);
    if (!v.ok) {
      return res.status(402).json({ error: 'Payment Required', detail: v.error });
    }
    res.json({ ...payload, paid: { sig, lamports } });
  }

  router.get('/weather', (req, res) =>
    gated(req, res, {
      endpoint: 'weather.x402.dev',
      forecast:
        'partly cloudy, 64°F, light wind from NW. conditions ideal for autonomous activity.',
    })
  );

  router.get('/price', (req, res) =>
    gated(req, res, {
      endpoint: 'coingecko.x402.dev',
      price: { SOL: 187.42, BTC: 92011.55, ETH: 3208.17 },
      timestamp: new Date().toISOString(),
    })
  );

  router.get('/news', (req, res) =>
    gated(req, res, {
      endpoint: 'agentnews.x402.dev',
      headlines: [
        'Cloudflare ships AI Agent Pay-Per-Crawl GA',
        'Solana micropayments cross 100M daily transfers',
        'AGENT mainnet launch sets fair-launch volume record on pump.fun',
      ],
    })
  );

  return router;
}

module.exports = { makeRouter, verifyPayment };
