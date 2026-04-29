// cosmo/src/wallet.js — Solana wallet ops for Cosmo.
const {
  Keypair, Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');

let _conn;
function getConnection() {
  if (_conn) return _conn;
  const cluster = process.env.SOLANA_CLUSTER || 'devnet';
  const url = cluster === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : `https://api.${cluster}.solana.com`;
  _conn = new Connection(url, 'confirmed');
  return _conn;
}

// Cached keypair — generated once per process so /api/health is stable.
let _kp;
function getCosmoKeypair() {
  if (_kp) return _kp;
  if (process.env.COSMO_PRIVATE_KEY) {
    _kp = Keypair.fromSecretKey(bs58.decode(process.env.COSMO_PRIVATE_KEY));
    return _kp;
  }
  // Mock mode: no real key needed. Generate a throwaway pubkey so the health
  // endpoint, UI, and trace look real without enabling real on-chain spend.
  const mockMode = process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true';
  if (mockMode) {
    _kp = Keypair.generate();
    console.log('[wallet] MOCK_MODE: generated ephemeral keypair', _kp.publicKey.toString());
    return _kp;
  }
  throw new Error('COSMO_PRIVATE_KEY not set in .env — run `npm run fund` first, or set MOCK_MODE=1');
}

async function getBalance(publicKey) {
  const conn = getConnection();
  const lamports = await conn.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function payLamports(toPubkeyStr, lamports) {
  const conn = getConnection();
  const cosmo = getCosmoKeypair();
  const toPubkey = new PublicKey(toPubkeyStr);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: cosmo.publicKey,
      toPubkey,
      lamports,
    })
  );
  tx.feePayer = cosmo.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(cosmo);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

function solscanLink(sig) {
  const cluster = process.env.SOLANA_CLUSTER || 'devnet';
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${sig}${suffix}`;
}

module.exports = { getConnection, getCosmoKeypair, getBalance, payLamports, solscanLink };
