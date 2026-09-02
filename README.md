<div align="center">

# SpendArc

**Agent Spending Control Plane**

Policy-checked spend vaults for autonomous agents on **Arc testnet**. Anyone gets their own vault
in minutes: pick a leash, fund it with USDC, and hand any AI agent a scoped API key. The agent holds
nothing - a funded vault enforces caps, allowlists, daily limits and dedup on-chain, while a
server-side policy gate blocks off-policy calls before they ever touch the chain.

[Architecture](./architecture.md) · [Security](./security.md) · [Adversarial Testing](./adversarialtesting.md) · [Judge's Guide](./JUDGES.md)

`Arc testnet 5042002` · `Solidity` · `Foundry` · `Next.js` · `viem` · `MIT`

</div>

---

## The idea

Autonomous agents need to move money to act - pay a vendor, settle a task, swap on a DEX. Hand one an
unrestricted key and a single prompt injection, hallucinated action, or runaway loop can drain it.

SpendArc gives the agent a wallet that **holds nothing** and can only ever move value **inside policy**.
The product is self-serve:

1. **Create your vault.** One signature deploys a vault owned by *your* wallet (via the
   `SpendArcVaultFactory`, one vault per wallet). It is pre-configured with the leash you chose -
   max per transaction, daily cap, expiry - and pre-allowlisted to USDC and your own address.
2. **Fund it.** The built-in faucet tops up testnet gas + USDC; you deposit USDC into the vault.
   The agent can only spend what is in the vault - it never holds a balance itself.
3. **Hand your agent a key.** Register the agent and mint a one-time API key. Any AI agent (opencode,
   ChatGPT, Claude) introspects its leash and makes payments inside it. The visitor owns the vault, so
   tightening the leash or allowlisting a **third-party service** are signed in *their* wallet, then
   mirrored to the server. Each allowed service can carry its own **per-service budget** (per-tx and
   daily) enforced by the server fence on top of the vault's leash.

Operators get a **fleet control plane** on top of the self-serve flow: every agent wallet in one view,
per-agent leashes and balances, a full audit trail of every approved/blocked decision, and policy
changes (lower a leash, revoke an agent) applied per agent from a single console.

Every payment is enforced by **two independent fences**:

- **Fence 1 - control plane (server).** Every payment request is checked against the app's policy store
  (active, not expired, per-tx cap, daily cap, per-service budgets, recipient and token allowlists) before
  anything is sent to
  the chain. An off-policy request is answered with a structured `BLOCKED` decision and never broadcast.
- **Fence 2 - contract layer (`SpendArcVault`).** Any `executeSpend` call is re-checked against the full
  on-chain policy (active, expiry, token allowed, target allowed, per-tx cap, daily cap, dedup via a unique
  `actionId`) **before** a single micro-unit of USDC moves. Blocked actions emit an on-chain
  `AgentActionBlocked` record and move nothing - no revert, no state change.

Neither fence substitutes the other. See **[architecture.md](./architecture.md)** for the full design and
**[security.md](./security.md)** for the guarantees and threat model.

## Live on Arc testnet 5042002

RPC `https://rpc.testnet.arc.network` · Explorer `https://testnet.arcscan.app`

| Contract | Address |
|----------|---------|
| **SpendArcVaultFactory** | [`0x47ad98eec8c771d514e5576f7738d43ea91ef7c2`](https://testnet.arcscan.app/address/0x47ad98eec8c771d514e5576f7738d43ea91ef7c2) |
| **SpendArcVault (reference)** | [`0x0b860c25Dc6b2Df451AA66cFCdc7D6c6D7802F66`](https://testnet.arcscan.app/address/0x0b860c25Dc6b2Df451AA66cFCdc7D6c6D7802F66) |
| **Operator / faucet** | [`0x3F5b96A494061F7338Da529e3047809Ac6a7FB84`](https://testnet.arcscan.app/address/0x3F5b96A494061F7338Da529e3047809Ac6a7FB84) |
| **USDC (testnet)** | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |

Every visitor gets their own vault from the factory. The reference vault above is the shared/demo vault.

### Proven on-chain artifacts

Each demo run produces fresh, verifiable artifacts. The two historical receipts below are the classic
same-agent-one-variable proof (an approved spend and a blocked spend against the same per-tx cap):

- **Approved spend** (1.5 USDC, under the 5 USDC per-tx cap): tx
  [`0xa1295391…`](https://testnet.arcscan.app/tx/0xa12953915fba548cb16128bb53fa5c51c406f7d051a922db8dc0b2be3678ad5b)
- **Blocked-by-policy** (6 USDC vs the 5 USDC cap - `AgentActionBlocked`, nothing moved): tx
  [`0x892fa9cf…`](https://testnet.arcscan.app/tx/0x892fa9cf430c86a1fa5266ca2ca1b9617694ce1579fa223e672bf67c652fc81b)

The current run's artifacts (vault address, create-vault tx, deposit tx, visitor-signed
`setAllowedService`/`setAgentPolicy` txs, approved + blocked spend txs) are collected in the
recording flow. The marketing site reads the latest approved + blocked actions live on every
page load.

## Try it as a judge (no setup required)

Open the live app and walk through the full flow in your own wallet - connect, create a
vault with a leash, grab faucet funds, deposit USDC, register an agent, and hand the leash
to a real AI agent. Every step is real and on-chain. See **[JUDGES.md](./JUDGES.md)** for
the step-by-step walkthrough.

## Repository layout

```
src/                      Solidity - SpendArcVaultFactory.sol, SpendArcVault.sol
test/                     Foundry suite (unit + fork tests)
script/                   deploy scripts (DeployFactoryArc, DeployArc, ...)
client/                   TypeScript agent client (viem)
web/                      Next.js frontend (marketing + dashboard + API routes)
lib/                      vendored deps (OpenZeppelin, forge-std)
JUDGES.md                 how to use the product on the live UI (for judges)
QA.md                     the full end-to-end test flow
```

## Quick start

```bash
# Contracts - build + test (Foundry)
forge build
forge test

# Frontend - marketing + dashboard + API
cd web && npm install && npm run dev   # http://localhost:3000
```

Copy `web/.env.example` to `web/.env.local` and fill in the Arc RPC, the factory and reference vault
addresses, the Privy app ID, and the two signer keys (`EXECUTOR_PRIVATE_KEY` broadcasts vault spends;
`VAULT_OWNER_PRIVATE_KEY` funds the faucet and configures the shared vault). The dashboard is fully
live in read-only mode without them; owner-write controls need the owner wallet connected.

The faucet grants **3 USDC + 0.05 ETH gas** per visitor (`/api/fund`) - enough for a full demo run.
The demo is recorded against a fresh wallet each time, because the factory allows one vault per owner.

## Documentation

- **[architecture.md](./architecture.md)** - the two fences, components, the payment lifecycle.
- **[security.md](./security.md)** - guarantees, threat model, and key management.
- **[adversarialtesting.md](./adversarialtesting.md)** - the test strategy: unit, differential fuzz,
  fork-against-real-chain, and on-chain acceptance.
- **[JUDGES.md](./JUDGES.md)** - how to use the product on the live UI, step by step.
- **[QA.md](./QA.md)** - the full end-to-end test flow.

## License

[MIT](./LICENSE).
