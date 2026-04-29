# Cosmo

> the AGENT demo agent. asks → plans → pays SOL → fetches → returns receipt.
> built by agents. for agents.

Cosmo is a self-contained Node.js app that demonstrates agent commerce in 90 seconds. A user types a prompt; Cosmo picks an API; Cosmo signs and broadcasts a SOL micropayment on devnet to that API's address; Cosmo retrieves the answer and shows the on-chain receipt.

This is the live demo that runs on `byagentforagent.com/cosmo` (or wherever you mount it).

## What it actually does

1. Browser POSTs your prompt to `/api/ask`.
2. Cosmo's planner picks one of three "paid endpoints" (mock x402-style).
3. Cosmo calls the endpoint cold — gets `402 Payment Required` + a recipient + lamport amount.
4. Cosmo signs a Solana SystemProgram transfer for that exact amount and broadcasts to devnet.
5. Cosmo retries the call with `x-payment-tx: <signature>` in the header.
6. The endpoint verifies the tx on-chain (right amount, right recipient, no replay) and serves the data.
7. Browser renders the answer + a Solscan link to the actual on-chain payment.

The mock endpoints (`/x402/weather`, `/x402/price`, `/x402/news`) are hosted on the same Express server. In production they'd be other people's servers; the protocol is identical.

## Quick start — local mock mode (zero config)

Requires Node 18+. No wallet, no funding, no internet to Solana required.

```bash
cd cosmo
npm install
MOCK_MODE=1 npm start
# > cosmo online
# > http://localhost:4019
```

Open the URL, type a question, watch Cosmo simulate the agent loop end-to-end.
Trace shows real-shape data with mock signatures (`MOCK_…` prefix).

## Local devnet mode (real on-chain payments)

```bash
cd cosmo
npm install
cp .env.example .env

# generate a fresh devnet keypair, attempt faucet airdrop, write to .env
npm run fund
# (paste printed COSMO_PRIVATE_KEY + PAYMENT_RECIPIENT into .env if airdrop succeeds)

unset MOCK_MODE   # turn off mock mode for real payments
npm start
```

Each `/api/ask` call now signs and broadcasts a real Solana devnet tx, and
the endpoint verifies the on-chain instruction before serving the response.

## Deploy to Railway (recommended for public demo)

1. Sign up at https://railway.app (GitHub OAuth).
2. New Project → Deploy from GitHub repo → pick `soullight/cosmo`.
3. In **Variables**, add: `MOCK_MODE=1`. Leave everything else default.
4. Railway auto-detects Node, builds with `npm ci`, runs `node src/server.js`.
5. Settings → Networking → **Generate Domain** → public URL like
   `cosmo-production.up.railway.app`.
6. (Optional) custom domain: add `cosmo.byagentforagent.com` → Railway gives
   you a CNAME → paste it at your domain registrar.

Updates auto-deploy on every git push to `main`.

For real-mode public deploy, swap `MOCK_MODE=1` for `COSMO_PRIVATE_KEY` and
`PAYMENT_RECIPIENT` in Railway Variables. Be aware: real-mode + public access
+ unrate-limited = wallet drains fast. Add rate limiting before going real.

## Health check

```bash
curl http://localhost:4019/api/health
```

Returns Cosmo's pubkey, current devnet balance, per-call cost, and cluster.

## File map

```
cosmo/
├── package.json
├── .env.example
├── README.md             ← you are here
├── architecture.md       ← deeper technical notes
├── src/
│   ├── server.js         ← Express boot, mounts everything
│   ├── agent.js          ← Cosmo's brain: planner + agent loop
│   ├── wallet.js         ← Solana ops: connection, keypair, payLamports, solscan link
│   ├── x402.js           ← mock paid endpoints + on-chain payment verification
│   └── scripts/
│       └── fund.js       ← devnet keypair generator + airdrop
└── web/
    └── index.html        ← terminal-aesthetic demo UI
```

## Going to mainnet

Three changes:
1. Set `SOLANA_CLUSTER=mainnet-beta` in `.env`.
2. Fund Cosmo's wallet manually (no faucet on mainnet).
3. Replace the mock `/x402` endpoints with calls to real partner APIs.

The protocol code (challenge → pay → retry → verify) is identical across clusters.

## Scope notes

This is intentionally a demo. It does NOT:
- Implement an LLM-based planner. (Stub is in `agent.js`, commented; swap in 5 lines.)
- Persist transcripts.
- Handle concurrent payments to the same endpoint cleanly.
- Use a real x402 spec — this is a simplified pedagogical version of the same idea.

The point is to make agent commerce feel real to a visitor in 30 seconds. Production-grade payment middleware ships with the AGENT SDK alpha at T+60.
