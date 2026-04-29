# Cosmo — architecture notes

## The flow, in one diagram

```
        ┌────────────────┐
        │   Browser UI   │   (web/index.html — terminal aesthetic)
        └───────┬────────┘
                │ POST /api/ask  { prompt }
                ▼
        ┌────────────────┐
        │   server.js    │   Express boot
        └───────┬────────┘
                │  ask(prompt, fetch)
                ▼
        ┌────────────────┐
        │   agent.js     │   Cosmo's brain
        │                │
        │  planEndpoint  │ ─────► /x402/<route>
        │       │        │       (mock paid API)
        │   loop:        │
        │   1. GET → 402 │
        │   2. payLamports
        │   3. GET + sig │
        │   4. response  │
        └───────┬────────┘
                │
                ▼
        ┌────────────────┐
        │   wallet.js    │   @solana/web3.js
        │  Connection    │   ─► devnet RPC
        │  Keypair       │   ─► Cosmo's wallet
        │  payLamports   │   ─► SystemProgram.transfer + sendRawTransaction
        └────────────────┘

        ┌─────────────────────────────────────────┐
        │           x402.js (mock APIs)           │
        │                                         │
        │  GET /x402/weather  → 402 if no header  │
        │                     → verifyPayment(sig)│
        │                     → 200 { data }      │
        │                                         │
        │  /x402/price, /x402/news same shape     │
        └─────────────────────────────────────────┘
```

## Components

### `wallet.js`
Thin wrapper around `@solana/web3.js`. Three exports that matter:
- `getConnection()` — memoized RPC connection per cluster.
- `payLamports(toPubkey, lamports)` — signs and broadcasts a SystemProgram transfer, awaits `confirmed`, returns the signature.
- `solscanLink(sig)` — formats a Solscan URL with the right cluster query param so the receipt link goes to the right block explorer.

### `agent.js`
Two parts:
- `planEndpoint(prompt)` — rule-based router from prompt text to one of three paid endpoints. The LLM-backed version is left as a commented stub directly above; swapping it in is a one-line change in `ask()`. Reason for the rule-based default: the demo runs zero-config without an Anthropic/OpenAI key.
- `ask(prompt, fetchImpl)` — the four-step agent loop. Each step pushes to a `trace` array so the UI can show the work. `fetchImpl` is dependency-injected so this module can be unit-tested without a server.

### `x402.js`
The mock paid endpoints. Three routes (`/x402/weather`, `/x402/price`, `/x402/news`), all built on a shared `gated()` helper that:
1. Returns 402 with payment instructions if the `x-payment-tx` header is absent.
2. If the header is present, calls `verifyPayment(sig, recipient, lamports)`:
   - Fetches the tx from the RPC.
   - Walks the account-key list to find the recipient index.
   - Compares pre/post balance delta to the required lamports.
   - Adds the sig to an in-memory replay set on success.
3. Returns the data + a paid-receipt block on success.

This is **not** a real x402 spec implementation — it's a pedagogically simple version of the same idea. The real spec involves wallet challenges, signed payment requests, and proper receipt formats. The AGENT SDK ships the production version at T+60.

### `server.js`
Boots Express, mounts `/x402/*` (the gated APIs) and `/api/ask` (Cosmo's public endpoint), serves the static UI. Health endpoint at `/api/health` returns Cosmo's pubkey, current balance, per-call cost, and cluster — used by the UI to show the live status block.

### `web/index.html`
Single-file frontend. Terminal aesthetic matching the AGENT landing page (same color palette, same typeface, same scanlines overlay). Three example-prompt chips for instant demos. Renders the agent's trace as a series of `[plan]`, `[402]`, `[paid]` log lines plus the on-chain receipt link. No frameworks, no build step, no dependencies — drops into any static-hosted environment.

## Why this design (and not the alternatives)

**Why Express, not Next/Hono/Fastify.** Demo simplicity. Anyone reading this code understands Express in 2 minutes; no router DSL to learn.

**Why local mock endpoints, not real third-party APIs.** Two reasons. First, the demo runs zero-config — no API keys to manage. Second, the educational point is the *protocol* (challenge/pay/retry/verify), which is identical regardless of who hosts the endpoint. Real partner APIs slot in trivially when ready.

**Why rule-based planner by default.** Cosmo should work the moment you `npm start`. An LLM call adds an API key step, latency, and a network dep. The LLM stub is right there in `agent.js`, ready to uncomment.

**Why devnet by default.** Free SOL via faucet. Fast. Real transactions, real signatures, real on-chain verification — just on a chain where mistakes don't cost money. Mainnet flip is a one-line `.env` change.

**Why a single self-send for `PAYMENT_RECIPIENT` in the demo.** Cosmo pays itself for the demo, which keeps the wallet balance roughly stable across calls (only fees are spent). For a real launch, `PAYMENT_RECIPIENT` is the API provider's wallet, and Cosmo's balance decreases over time as it pays for actual data — exactly the dynamic we want to show.

## Wiring into the AGENT landing page

The landing page (`agent_landing.html`) currently shows a synthetic agent feed in the hero. Two upgrade paths:

1. **Iframe Cosmo's UI** as a section called "Cosmo · live" — the cleanest, no-state-sharing path.
2. **Replay Cosmo's transactions** in real time on the landing-page feed by polling Solana RPC for transactions involving Cosmo's wallet, and rendering them in the same `>> agent_X paid Y SOL to Z` format. More work, but the hero feed becomes literally true instead of synthetic.

Recommendation: ship (1) for launch, swap to (2) at T+30 when there's enough Cosmo activity to look alive.

## Production hardening checklist (post-launch)

The demo is missing these for production readiness:
- [ ] Replay protection backed by Redis/Postgres, not in-memory `Set`.
- [ ] Rate limiting per IP and per Cosmo wallet.
- [ ] Proper x402 spec compliance (see x402.org or the AGENT SDK alpha).
- [ ] Idempotency keys for retries.
- [ ] Structured logging + on-chain audit log.
- [ ] Cosmo's keys in a secure enclave (HSM / cloud KMS) — not in `.env`.
- [ ] Health endpoint behind auth.
- [ ] Real LLM planner with function calling and confidence scoring.
- [ ] Multiple Cosmo wallets for parallel concurrency, balance-managed.
- [ ] CORS lockdown, CSP headers, all the boring web hygiene.

None of these block the demo. All of these block running Cosmo as a real production service. The AGENT SDK alpha ships the patterns for most of them.
