// cosmo/src/contribution_bot.js — the heart of the AGNT launch.
//
// Watches the receiving wallet for incoming SOL. For each new transaction:
//   1. Check idempotency (don't double-process)
//   2. Calculate AGNT allocation per the published curve
//   3. Send AGNT from operational wallet to the contributor
//   4. Split incoming SOL: 35% to founder wallet, 65% to treasury multisig
//   5. Record contribution to persistent state
//   6. Trigger diodegenes narration via X
//
// Idempotency: every TX hash is recorded in contributions.jsonl. On startup,
// the bot scans the wallet for missed TXs and processes them.
//
// CURVE COMMITMENT: the formula in src/curve.js is hashed and posted on-chain
// at launch. Any change to the curve constants would invalidate the hash.

require('dotenv').config();

const {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const { tokensForSol, curveState, BASE, K, MAX_SOLD_FRACTION, TOTAL_SUPPLY } = require('./curve');
const {
  loadProcessedSet, recordContribution, computeSummary,
} = require('./contributions_state');
const { readPending: readNarrationPending } = require('./narration_drain');
const heartbeat = require('./heartbeat');

// Pause flag set when the operational wallet runs out of AGNT. Cleared on
// the next successful contribution. The bot keeps running but stops touching
// new TXs while paused — they accumulate as unprocessed and replay once the
// vault refills the operational wallet.
let _opWalletPaused = false;
let _lastOpWalletAlertAt = 0;
const OP_WALLET_ALERT_INTERVAL_MS = 30 * 60 * 1000; // re-alert at most every 30 min

// ─── env ──────────────────────────────────────────────────────────
const REQUIRED = [
  'AGNT_RECEIVING_WALLET',     // public address — where contributors send SOL
  'AGNT_OPERATIONAL_PRIVKEY',  // hot wallet that sends AGNT to contributors (base58)
  'AGNT_TOKEN_MINT',           // SPL mint address for AGNT
  'AGNT_FOUNDER_WALLET',       // public address — receives 35% of incoming SOL
  'AGNT_TREASURY_WALLET',      // public address (Squads multisig) — receives 65%
];
const FOUNDER_DRAW_PCT = parseFloat(process.env.AGNT_FOUNDER_DRAW || '0.35');
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const POLL_INTERVAL_MS = parseInt(process.env.AGNT_POLL_INTERVAL_MS || '15000', 10);

const DRY_RUN = process.env.AGNT_BOT_DRY_RUN === '1';

// ─── boot validation ──────────────────────────────────────────────
function checkEnv() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[boot] FATAL — missing env:', missing.join(', '));
    process.exit(2);
  }
}

// ─── solana ───────────────────────────────────────────────────────
function rpcUrl() {
  const cluster = SOLANA_CLUSTER;
  return cluster === 'mainnet-beta'
    ? (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com')
    : `https://api.${cluster}.solana.com`;
}

function loadOperationalKeypair() {
  return Keypair.fromSecretKey(bs58.decode(process.env.AGNT_OPERATIONAL_PRIVKEY));
}

// ─── core processing ──────────────────────────────────────────────

// Fetch recent transactions for the receiving wallet (single-page; used in
// the steady-state polling loop).
async function fetchRecentTxs(conn, receivingPubkey, limit = 50) {
  const sigs = await conn.getSignaturesForAddress(receivingPubkey, { limit });
  return sigs;
}

// Boot-time catch-up: paginate through ALL signatures until we hit one we've
// already processed. This protects against the case where the bot was down for
// long enough that >50 contributions queued up. Without pagination, we'd
// silently skip every contribution older than the most recent 50.
//
// Solana's getSignaturesForAddress returns newest-first and supports a
// `before` cursor (the signature to paginate before). We walk backwards in
// pages of 1000 until either:
//   - we hit a signature already in `processed`, OR
//   - the address has no more signatures.
//
// Returns the list of unprocessed signatures, oldest-first (so the main loop
// can replay them in chronological order).
async function fetchCatchUpTxs(conn, receivingPubkey, processedSet, pageSize = 1000) {
  const unprocessed = [];
  let before = undefined;
  let pages = 0;
  const MAX_PAGES = 20; // hard cap: 20k signatures. Beyond this, manual recovery.

  while (pages < MAX_PAGES) {
    const opts = { limit: pageSize };
    if (before) opts.before = before;
    const sigs = await conn.getSignaturesForAddress(receivingPubkey, opts);
    pages++;
    if (sigs.length === 0) break;

    let hitProcessed = false;
    for (const sigInfo of sigs) {
      if (processedSet.has(sigInfo.signature)) {
        hitProcessed = true;
        break; // Everything older has also been processed (newest-first ordering)
      }
      unprocessed.push(sigInfo);
    }
    if (hitProcessed) break;

    // Page cursor for next iteration: the oldest signature we just saw
    before = sigs[sigs.length - 1].signature;

    // If page wasn't full, we've reached the end of history
    if (sigs.length < pageSize) break;
  }

  if (pages >= MAX_PAGES) {
    console.warn(`[catchup] hit MAX_PAGES (${MAX_PAGES} × ${pageSize} = ${MAX_PAGES * pageSize} sigs); older history unscanned`);
  }

  // Reverse so we process chronologically (oldest first → narrations land in order)
  return unprocessed.reverse();
}

// Pull a transaction's parsed details — sender, amount.
async function parseTx(conn, sig, receivingPubkey) {
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return null;

  // Find a SystemProgram transfer to the receiving wallet
  const ixs = tx.transaction.message.instructions;
  for (const ix of ixs) {
    if (ix.programId?.toString() === SystemProgram.programId.toString() &&
        ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info;
      if (info.destination === receivingPubkey.toString()) {
        return {
          sig,
          contributor: info.source,
          lamports: parseInt(info.lamports, 10),
          sol: parseInt(info.lamports, 10) / LAMPORTS_PER_SOL,
          slot: tx.slot,
        };
      }
    }
  }
  return null;
}

// Send AGNT tokens from operational wallet to contributor.
// Returns mint TX hash.
//
// Throws OP_WALLET_EMPTY if the operational wallet doesn't have enough AGNT
// to fulfill this transfer. Caller (processContribution → main loop) MUST
// catch this distinctly: do NOT mark the contribution as processed (so it
// retries on next poll once the vault refills the operational wallet).
async function sendAgnt(conn, opKeypair, contributorAddress, amountAgnt, mint) {
  if (DRY_RUN) {
    return 'DRY_' + Math.random().toString(36).slice(2, 14);
  }
  const splToken = require('@solana/spl-token');
  const contributor = new PublicKey(contributorAddress);
  const mintPubkey = new PublicKey(mint);

  const opTokenAccount = await splToken.getAssociatedTokenAddress(mintPubkey, opKeypair.publicKey);
  const contribTokenAccount = await splToken.getAssociatedTokenAddress(mintPubkey, contributor);

  // Read mint decimals + operational balance up-front so we can fail fast on
  // supply exhaustion before constructing/signing/broadcasting a TX.
  const mintInfo = await splToken.getMint(conn, mintPubkey);
  const decimals = mintInfo.decimals;
  const amountBase = BigInt(Math.floor(amountAgnt * Math.pow(10, decimals)));

  let opBalanceBase;
  try {
    const opAccount = await splToken.getAccount(conn, opTokenAccount);
    opBalanceBase = opAccount.amount; // BigInt
  } catch (e) {
    // Operational ATA doesn't exist — same condition as zero balance.
    throw new Error(`OP_WALLET_EMPTY: operational ATA does not exist (${e.message})`);
  }
  if (opBalanceBase < amountBase) {
    const have = Number(opBalanceBase) / Math.pow(10, decimals);
    throw new Error(`OP_WALLET_EMPTY: have ${have} AGNT, need ${amountAgnt}`);
  }

  const tx = new Transaction();
  // Create recipient ATA if needed
  try {
    await splToken.getAccount(conn, contribTokenAccount);
  } catch (_) {
    tx.add(splToken.createAssociatedTokenAccountInstruction(
      opKeypair.publicKey, contribTokenAccount, contributor, mintPubkey
    ));
  }

  tx.add(splToken.createTransferInstruction(
    opTokenAccount,
    contribTokenAccount,
    opKeypair.publicKey,
    amountBase
  ));

  const sig = await conn.sendTransaction(tx, [opKeypair]);
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// Split the incoming SOL between founder + treasury wallets.
async function splitSol(conn, opKeypair, totalLamports, founderAddr, treasuryAddr) {
  if (DRY_RUN) {
    return { founderTx: 'DRY_FOUNDER', treasuryTx: 'DRY_TREASURY' };
  }
  const founderLamports = Math.floor(totalLamports * FOUNDER_DRAW_PCT);
  const treasuryLamports = totalLamports - founderLamports;

  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: opKeypair.publicKey,
    toPubkey: new PublicKey(founderAddr),
    lamports: founderLamports,
  }));
  tx.add(SystemProgram.transfer({
    fromPubkey: opKeypair.publicKey,
    toPubkey: new PublicKey(treasuryAddr),
    lamports: treasuryLamports,
  }));
  const sig = await conn.sendTransaction(tx, [opKeypair]);
  await conn.confirmTransaction(sig, 'confirmed');
  return { splitTx: sig, founderLamports, treasuryLamports };
}

// Trigger the diodegenes narration via the existing autonomous loop's review pipeline.
// For v1, we just write a draft to a file the loop polls. v2: direct hook.
async function narrate(contribution) {
  const fs = require('fs');
  const path = require('path');
  const queuePath = path.join(__dirname, '..', 'narration_queue.jsonl');
  const entry = {
    type: 'contribution',
    tx_hash: contribution.tx_hash,            // idempotency key for narration_drain
    sol: contribution.sol_amount,
    contributor: contribution.contributor,
    agnt: contribution.agnt_minted,
    curve_state_after: contribution.curve_state.supply_sold_after,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
}

// Distinguish OP_WALLET_EMPTY from other failures. Returns true if the error
// indicates the operational wallet is out of AGNT (caller must NOT mark the
// TX as processed; it'll retry on next poll).
function isOpWalletEmpty(err) {
  return err && typeof err.message === 'string' && err.message.startsWith('OP_WALLET_EMPTY');
}

async function alertOpWalletEmpty(reason) {
  if (_opWalletPaused) {
    // Throttle alerts so we don't spam Discord every 15s while paused
    if (Date.now() - _lastOpWalletAlertAt < OP_WALLET_ALERT_INTERVAL_MS) return;
  }
  _opWalletPaused = true;
  _lastOpWalletAlertAt = Date.now();
  console.error('[ALERT] operational wallet empty —', reason);
  try {
    const s = computeSummary();
    let queue_depth;
    try { queue_depth = readNarrationPending().length; } catch (_) { queue_depth = '?'; }
    await heartbeat.pulse({
      event: 'OP_WALLET_EMPTY',
      severity: 'CRITICAL',
      reason,
      contributions_processed: s.contributors,
      narration_queue_depth: queue_depth,
      action_required: 'fund operational wallet from vault, then watch logs for retry',
    });
  } catch (e) {
    console.warn('[alert] heartbeat pulse failed:', e.message);
  }
}

function clearOpWalletPause() {
  if (_opWalletPaused) {
    console.log('[recovery] operational wallet refilled — resuming processing');
    _opWalletPaused = false;
    try {
      heartbeat.pulse({ event: 'OP_WALLET_REFILLED', severity: 'INFO', resumed_at: new Date().toISOString() });
    } catch (_) {}
  }
}

// Process a single new transaction end-to-end.
async function processContribution(conn, opKeypair, parsed) {
  const summary = computeSummary();
  const currentSupplySold = summary.total_agnt_minted;
  const stateBefore = curveState(currentSupplySold);

  const result = tokensForSol(parsed.sol, currentSupplySold);
  if (result.tokensMinted === 0) {
    console.warn('[skip] curve sold out, no tokens to mint for', parsed.sig);
    return;
  }

  // 1. Send AGNT to contributor
  const mintTx = await sendAgnt(
    conn, opKeypair, parsed.contributor, result.tokensMinted, process.env.AGNT_TOKEN_MINT
  );

  // 2. Split SOL between founder + treasury
  const splitResult = await splitSol(
    conn, opKeypair, parsed.lamports,
    process.env.AGNT_FOUNDER_WALLET, process.env.AGNT_TREASURY_WALLET
  );

  // 3. Record contribution
  const stateAfter = curveState(result.newSupplySold);
  recordContribution({
    tx_hash: parsed.sig,
    contributor: parsed.contributor,
    sol_amount: parsed.sol,
    agnt_minted: result.tokensMinted,
    curve_state: {
      supply_sold_before: currentSupplySold,
      supply_sold_after: result.newSupplySold,
      price_at_time: stateBefore.pricePerToken,
    },
    founder_sol: parsed.sol * FOUNDER_DRAW_PCT,
    treasury_sol: parsed.sol * (1 - FOUNDER_DRAW_PCT),
    mint_tx: mintTx,
  });

  // 4. Queue narration (the autonomous loop picks this up and posts via diodegenes)
  await narrate({
    tx_hash: parsed.sig,
    sol_amount: parsed.sol,
    contributor: parsed.contributor,
    agnt_minted: result.tokensMinted,
    curve_state: { supply_sold_after: result.newSupplySold },
  });

  console.log(`[done] ${parsed.sol} SOL from ${parsed.contributor.slice(0,8)}… → ${Math.round(result.tokensMinted)} AGNT (mint: ${mintTx.slice(0,8)}…)`);
  clearOpWalletPause();
}

// Wallets we control — incoming SOL from these is NEVER a contribution. It's
// either an operational refill, a balance-sheet rebalance, or a config artifact
// (e.g. funding fees from Vault during the mint sitting). Without this filter,
// the bot would treat its own internal capital movements as contributions and
// try to mint AGNT to itself + split SOL to itself, which on bootstrap funding
// fails atomically (splitSol can't pay rent) and leaks AGNT into Vault on retry.
function buildExcludedWallets() {
  const set = new Set();
  for (const key of [
    'AGNT_VAULT_WALLET',
    'AGNT_FOUNDER_WALLET',
    'AGNT_TREASURY_WALLET',
    'AGNT_RECEIVING_WALLET',
  ]) {
    const v = process.env[key];
    if (v) set.add(v);
  }
  return set;
}

// ─── main loop ────────────────────────────────────────────────────
async function main() {
  checkEnv();
  console.log(`[boot] AGNT contribution bot online (cluster=${SOLANA_CLUSTER}, dry_run=${DRY_RUN})`);

  const conn = new Connection(rpcUrl(), 'confirmed');
  const opKeypair = loadOperationalKeypair();
  const receivingPubkey = new PublicKey(process.env.AGNT_RECEIVING_WALLET);
  const excludedWallets = buildExcludedWallets();
  console.log(`[boot] excluded-wallet filter active: ${excludedWallets.size} addresses`);

  // Heartbeat (1/hour pings to Discord) — enriched with operational health
  heartbeat.start(60 * 60 * 1000, () => {
    const s = computeSummary();
    let queue_depth;
    try { queue_depth = readNarrationPending().length; } catch (_) { queue_depth = '?'; }
    const last_processed_ago = s.last_ts
      ? Math.floor((Date.now() - new Date(s.last_ts).getTime()) / 60000) + 'min ago'
      : 'none yet';
    return {
      contributors: s.contributors,
      total_sol: (s.total_sol || 0).toFixed(2),
      total_agnt: Math.round(s.total_agnt_minted || 0),
      last_processed: last_processed_ago,
      narration_queue_depth: queue_depth,
      op_wallet_paused: _opWalletPaused ? 'YES' : 'no',
    };
  });

  // Idempotency: load all already-processed TX hashes
  let processed = loadProcessedSet();
  console.log(`[boot] ${processed.size} contributions already processed`);

  // Boot-time catch-up: paginate through history to find any contributions
  // that landed while the bot was down. Without this, an outage longer than
  // ~50 contributions would silently drop the older ones.
  console.log('[boot] running catch-up scan…');
  try {
    const catchUp = await fetchCatchUpTxs(conn, receivingPubkey, processed);
    console.log(`[boot] catch-up: ${catchUp.length} unprocessed signature(s) found`);
    for (const sigInfo of catchUp) {
      const parsed = await parseTx(conn, sigInfo.signature, receivingPubkey);
      if (!parsed || parsed.lamports < 1000) {
        // Mark non-contribution TXs (memos, dust, failed) as processed so we
        // don't re-scan them every boot.
        processed.add(sigInfo.signature);
        continue;
      }
      // Internal-wallet filter: if the source is one of our own wallets, this
      // is a refill/rebalance/setup TX, NOT a contribution. Mark processed and
      // skip. Without this filter, the bot misidentifies its own funding as
      // contributions and leaks AGNT to itself on partial-failure retries.
      if (excludedWallets.has(parsed.contributor)) {
        console.log(`[skip] internal-wallet TX ${sigInfo.signature.slice(0,8)}… from ${parsed.contributor.slice(0,8)}… (${parsed.sol} SOL — refill/rebalance, not a contribution)`);
        processed.add(sigInfo.signature);
        continue;
      }
      try {
        await processContribution(conn, opKeypair, parsed);
        processed.add(sigInfo.signature);
      } catch (e) {
        if (isOpWalletEmpty(e)) {
          await alertOpWalletEmpty(`during catch-up at ${sigInfo.signature.slice(0,8)}…: ${e.message}`);
          // Stop catch-up — every subsequent TX would also fail. Resume on next boot poll.
          console.error('[catchup] paused — operational wallet empty');
          break;
        }
        console.error('[catchup] processing', sigInfo.signature, ':', e.message);
      }
    }
    console.log('[boot] catch-up scan complete');
  } catch (e) {
    console.error('[boot] catch-up scan failed:', e.message);
  }

  // Polling loop (steady-state — only looks at the most recent page)
  while (true) {
    try {
      const sigs = await fetchRecentTxs(conn, receivingPubkey, 50);
      // Process oldest-first within the page (so narrations land in chronological order)
      for (const sigInfo of sigs.reverse()) {
        if (processed.has(sigInfo.signature)) continue;
        const parsed = await parseTx(conn, sigInfo.signature, receivingPubkey);
        if (!parsed || parsed.lamports < 1000) {
          processed.add(sigInfo.signature);
          continue;
        }
        // Internal-wallet filter (same as catch-up loop)
        if (excludedWallets.has(parsed.contributor)) {
          console.log(`[skip] internal-wallet TX ${sigInfo.signature.slice(0,8)}… from ${parsed.contributor.slice(0,8)}… (${parsed.sol} SOL — refill/rebalance)`);
          processed.add(sigInfo.signature);
          continue;
        }
        try {
          await processContribution(conn, opKeypair, parsed);
          processed.add(sigInfo.signature);
        } catch (e) {
          if (isOpWalletEmpty(e)) {
            await alertOpWalletEmpty(`steady-state at ${sigInfo.signature.slice(0,8)}…: ${e.message}`);
            // Don't mark processed — TX retries on next poll. Break the inner
            // loop so we don't burn calls trying every queued TX while paused.
            break;
          }
          console.error('[err] processing', sigInfo.signature, ':', e.message);
        }
      }
    } catch (e) {
      console.error('[loop] poll error:', e.message);
    }
    // Back off polling cadence while paused to avoid hammering RPC + alert webhook
    const sleepMs = _opWalletPaused ? Math.max(POLL_INTERVAL_MS, 60_000) : POLL_INTERVAL_MS;
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('[fatal]', e);
    process.exit(1);
  });
}

module.exports = { main, processContribution };
