// cosmo/src/scripts/fund.js — generate Cosmo's keypair, request a devnet airdrop.
require('dotenv').config();
const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

(async () => {
  const kp = Keypair.generate();
  const sk = bs58.encode(kp.secretKey);
  const pk = kp.publicKey.toString();

  console.log('');
  console.log('// Generated new Cosmo keypair.');
  console.log('public key  :', pk);
  console.log('private key :', sk);
  console.log('');
  console.log('// Add to .env:');
  console.log('COSMO_PRIVATE_KEY=' + sk);
  console.log('PAYMENT_RECIPIENT=' + pk + '   # for demo, self-send is fine');
  console.log('');

  const cluster = process.env.SOLANA_CLUSTER || 'devnet';
  if (cluster !== 'devnet') {
    console.log('// Not on devnet — skipping airdrop. Fund the wallet manually.');
    return;
  }

  const conn = new Connection(`https://api.${cluster}.solana.com`, 'confirmed');
  console.log('// Requesting 2 SOL airdrop on devnet...');
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    const balance = await conn.getBalance(kp.publicKey);
    console.log('// Airdrop confirmed. Balance:', balance / LAMPORTS_PER_SOL, 'SOL');
  } catch (e) {
    console.log('// Airdrop failed (devnet faucet rate-limits are common).');
    console.log('// Try again in a minute, or use https://faucet.solana.com');
    console.log('// Error:', e.message);
  }
})();
