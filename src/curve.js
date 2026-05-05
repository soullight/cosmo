// cosmo/src/curve.js — AGNT bonding curve math.
//
// Moderate calibration:
//   price(u) = BASE × (K + √u)
//   where u = supply_sold / TOTAL_SUPPLY
//
// At full curve (u = 0.8): ~15,000 SOL collected total.
// Founder draw: 35% of every incoming SOL.
//
// THE CURVE IS PUBLIC AND IMMUTABLE. Hash committed on-chain at launch.

const BASE = 2.42e-5;          // SOL per token at u=1.0 (moderate)
const K = 0.18;                // floor constant — first contributor doesn't get infinity
const TOTAL_SUPPLY = 1_000_000_000;
const MAX_SOLD_FRACTION = 0.8; // 80% mintable via curve; 20% reserve held by agent

// Price per token (SOL) at a given supply-sold fraction u ∈ [0, 0.8].
function priceAt(u) {
  if (u < 0) u = 0;
  if (u > MAX_SOLD_FRACTION) u = MAX_SOLD_FRACTION;
  return BASE * (K + Math.sqrt(u));
}

// Cumulative SOL collected when supply_sold = U (0..MAX_SOLD_FRACTION).
function totalSolAt(U) {
  if (U <= 0) return 0;
  if (U > MAX_SOLD_FRACTION) U = MAX_SOLD_FRACTION;
  return TOTAL_SUPPLY * BASE * (K * U + (2 / 3) * Math.pow(U, 1.5));
}

// Given a SOL contribution at the current state, how many AGNT does it buy?
// Uses binary search to invert the integral (closed-form is messy with the √).
function tokensForSol(solAmount, currentSupplySold) {
  const currentU = currentSupplySold / TOTAL_SUPPLY;
  if (currentU >= MAX_SOLD_FRACTION) {
    return { tokensMinted: 0, newSupplySold: currentSupplySold, soldOut: true };
  }

  // Total SOL we want collected after this contribution
  const targetTotal = totalSolAt(currentU) + solAmount;

  // Binary search for U such that totalSolAt(U) = targetTotal
  let low = currentU;
  let high = MAX_SOLD_FRACTION;
  let nextU = (low + high) / 2;
  for (let i = 0; i < 80; i++) {
    const integral = totalSolAt(nextU);
    if (Math.abs(integral - targetTotal) < 1e-9) break;
    if (integral < targetTotal) low = nextU;
    else                       high = nextU;
    nextU = (low + high) / 2;
  }

  // If we can't fulfill the entire contribution at the current curve (i.e. it
  // would exceed MAX_SOLD_FRACTION), cap at the maximum mintable.
  const cappedU = Math.min(nextU, MAX_SOLD_FRACTION);
  const tokensMinted = (cappedU - currentU) * TOTAL_SUPPLY;
  const newSupplySold = cappedU * TOTAL_SUPPLY;
  const partial = nextU > MAX_SOLD_FRACTION;

  return {
    tokensMinted,
    newSupplySold,
    partial,
    soldOut: cappedU >= MAX_SOLD_FRACTION,
  };
}

// Human-readable curve state at a supply-sold count.
function curveState(supplySold) {
  const u = supplySold / TOTAL_SUPPLY;
  return {
    supplySold,
    fractionSold: u,
    pricePerToken: priceAt(u),
    tokensPerSol: 1 / priceAt(u),
    totalSolCollected: totalSolAt(u),
    soldOut: u >= MAX_SOLD_FRACTION,
  };
}

module.exports = {
  priceAt,
  totalSolAt,
  tokensForSol,
  curveState,
  // Constants exposed for transparency
  BASE,
  K,
  TOTAL_SUPPLY,
  MAX_SOLD_FRACTION,
};
