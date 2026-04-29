// cosmo/src/agent.js — Cosmo's brain. Plans, pays, calls, returns.
const { payLamports, solscanLink } = require('./wallet');

// ----- Planner -----
// Rule-based router from prompt -> paid endpoint. Trivially swappable for an LLM call:
// see planEndpointWithLLM() below for the Anthropic/OpenAI integration shape.
function planEndpoint(prompt) {
  const p = (prompt || '').toLowerCase();

  if (/\b(weather|temperature|forecast|rain|cold|hot|wind|storm)\b/.test(p)) {
    return { endpoint: '/x402/weather', label: 'weather.x402.dev' };
  }
  if (/\b(price|sol|btc|eth|crypto|market|chart|usd)\b/.test(p)) {
    return { endpoint: '/x402/price', label: 'coingecko.x402.dev' };
  }
  if (/\b(news|happening|update|today|agent|story|headline)\b/.test(p)) {
    return { endpoint: '/x402/news', label: 'agentnews.x402.dev' };
  }
  // default: news
  return { endpoint: '/x402/news', label: 'agentnews.x402.dev' };
}

// Optional LLM-backed planner. Wire ANTHROPIC_API_KEY and replace planEndpoint with this.
// Left as commented stub so the demo runs zero-config out of the box.
/*
async function planEndpointWithLLM(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: 'You are Cosmo, a Solana-native agent. Pick exactly one paid endpoint to satisfy the user prompt. Reply ONLY with valid JSON: {"endpoint":"/x402/weather"|"/x402/price"|"/x402/news","label":"..."}.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  const text = data.content?.[0]?.text || '{}';
  return JSON.parse(text);
}
*/

// ----- Agent loop -----
async function ask(prompt, fetchImpl) {
  const plan = planEndpoint(prompt);
  const port = process.env.PORT || 4019;
  const url = `http://localhost:${port}${plan.endpoint}`;
  const mockMode = process.env.MOCK_MODE === '1' || process.env.MOCK_MODE === 'true';

  const trace = [];
  trace.push({ step: 'plan', prompt, endpoint: plan.endpoint, label: plan.label });

  // Step 1: try the call without payment proof — expect a 402 challenge.
  let res = await fetchImpl(url, { method: 'GET' });
  if (res.status !== 402) {
    return { ok: false, error: `expected 402 from ${plan.endpoint}, got ${res.status}` };
  }
  const challenge = await res.json();
  trace.push({
    step: '402_received',
    recipient: challenge.recipient,
    lamports: challenge.lamports,
    cluster: challenge.cluster,
    mock: mockMode,
  });

  // Step 2: pay the requested lamports on-chain. (Or fake it in mock mode.)
  let sig, link;
  if (mockMode) {
    // 88-char base58-ish signature so it looks real to the UI, with mock_ prefix.
    const rand = () => Math.random().toString(36).slice(2);
    sig = 'MOCK_' + (rand() + rand() + rand() + rand()).slice(0, 80);
    link = `https://solscan.io/tx/${sig}?cluster=devnet  (mock — no real tx)`;
    trace.push({ step: 'paid', sig, link, mock: true });
  } else {
    sig = await payLamports(challenge.recipient, challenge.lamports);
    link = solscanLink(sig);
    trace.push({ step: 'paid', sig, link });
  }

  // Step 3: retry with the payment proof header.
  // In mock mode, x402.js short-circuits verification when sig starts with MOCK_.
  res = await fetchImpl(url, {
    method: 'GET',
    headers: { 'x-payment-tx': sig },
  });
  if (!res.ok) {
    return { ok: false, error: `paid call failed: ${res.status}`, trace };
  }
  const data = await res.json();
  trace.push({ step: 'response', data });

  return {
    ok: true,
    prompt,
    plan,
    receipt: { sig, link, lamports: challenge.lamports, mock: mockMode },
    answer: data,
    trace,
  };
}

module.exports = { ask, planEndpoint };
