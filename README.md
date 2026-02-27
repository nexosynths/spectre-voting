# Spectre

Anonymous encrypted voting on Ethereum using zero-knowledge proofs.

Voters prove they're eligible without revealing who they are. Votes are encrypted until tally. One person, one vote — enforced by math, not trust.

**Live demo:** [spectre-voting-web-app.vercel.app](https://spectre-voting-web-app.vercel.app)

## How It Works

1. **Admin creates an election** — deploys a contract, sets a title and deadline
2. **Voters generate anonymous identities** — ZK identity stays in the browser
3. **Admin registers voters** — adds their identity commitments to the on-chain group
4. **Voters cast votes** — browser generates a ZK proof + encrypts the vote, submits on-chain
5. **Admin tallies** — decrypts all votes client-side, results displayed with cryptographic verification

Nobody can see how you voted. Nobody can vote twice. No server. No backend. Just math and Ethereum.

## Tech

- **ZK Proofs:** Groth16 via Circom + snarkjs (browser-generated)
- **Identity:** Semaphore V4 (anonymous group membership)
- **Encryption:** ECIES-secp256k1 (ECDH + HKDF-SHA256 + AES-256-GCM)
- **Contracts:** Solidity 0.8.23 on Sepolia
- **Frontend:** Next.js 14 on Vercel

## Quick Start

```bash
git clone https://github.com/nexosynths/spectre-voting.git
cd spectre-voting
yarn
yarn dev
```

## Run Tests

```bash
cd apps/contracts
npx hardhat test   # 17 tests
```

## License

MIT
