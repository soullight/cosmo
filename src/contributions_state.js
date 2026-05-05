// cosmo/src/contributions_state.js — persistent JSONL queue for contribution processing.
// Idempotent: each TX hash is processed exactly once, ever.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'contributions.jsonl');
const SUMMARY_PATH = path.join(__dirname, '..', 'contributions_summary.json');

// Load all processed TX hashes into a Set for O(1) idempotency check.
function loadProcessedSet() {
  if (!fs.existsSync(STATE_PATH)) return new Set();
  const text = fs.readFileSync(STATE_PATH, 'utf8');
  const set = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.tx_hash) set.add(entry.tx_hash);
    } catch (e) {
      // Corrupt line — skip but don't fail
      console.warn('[state] skipping corrupt line:', line.slice(0, 100));
    }
  }
  return set;
}

// Append a contribution record. Each call writes one line + flushes.
function recordContribution(entry) {
  const required = ['tx_hash', 'contributor', 'sol_amount', 'agnt_minted', 'curve_state'];
  for (const k of required) {
    if (entry[k] === undefined) {
      throw new Error(`recordContribution: missing ${k}`);
    }
  }
  const record = {
    tx_hash: entry.tx_hash,
    contributor: entry.contributor,
    sol_amount: entry.sol_amount,
    agnt_minted: entry.agnt_minted,
    curve_state: entry.curve_state,        // { supply_sold_before, supply_sold_after, price_at_time }
    founder_sol: entry.founder_sol || null,
    treasury_sol: entry.treasury_sol || null,
    mint_tx: entry.mint_tx || null,        // tx hash of the AGNT send-back
    narrated_at: entry.narrated_at || null,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(STATE_PATH, JSON.stringify(record) + '\n');
  return record;
}

// Compute aggregate state from all recorded contributions.
// Used by the dashboard + heartbeat for "current curve state".
function computeSummary() {
  if (!fs.existsSync(STATE_PATH)) {
    return { contributors: 0, total_sol: 0, total_agnt_minted: 0, last_tx: null };
  }
  const text = fs.readFileSync(STATE_PATH, 'utf8');
  const contributors = new Set();
  let total_sol = 0;
  let total_agnt = 0;
  let last_tx = null;
  let last_ts = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      contributors.add(e.contributor);
      total_sol += e.sol_amount;
      total_agnt += e.agnt_minted;
      last_tx = e.tx_hash;
      last_ts = e.timestamp;
    } catch (_) {}
  }
  const summary = {
    contributors: contributors.size,
    total_sol,
    total_agnt_minted: total_agnt,
    last_tx,
    last_ts,
  };
  // Cache to disk so dashboard can read without parsing JSONL
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  return summary;
}

// Read the most recent N contributions (for dashboard ticker).
function recentContributions(n = 10) {
  if (!fs.existsSync(STATE_PATH)) return [];
  const text = fs.readFileSync(STATE_PATH, 'utf8');
  const lines = text.split('\n').filter(l => l.trim()).slice(-n);
  return lines.map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean).reverse(); // newest first
}

// Read EVERY contribution since launch, oldest-first (for the cap table).
// The cap table sorts by timestamp ascending — rank 1 is the first contributor.
// JSONL is already in chronological order by append-only design, so we just
// stream it in order. If file size becomes a concern (>500 contributions),
// add a hard cap or pagination at the dashboard layer.
function allContributions() {
  if (!fs.existsSync(STATE_PATH)) return [];
  const text = fs.readFileSync(STATE_PATH, 'utf8');
  const lines = text.split('\n').filter(l => l.trim());
  return lines.map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean); // chronological (oldest first)
}

module.exports = {
  loadProcessedSet,
  recordContribution,
  computeSummary,
  recentContributions,
  allContributions,
  STATE_PATH,
  SUMMARY_PATH,
};
