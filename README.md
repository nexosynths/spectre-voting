# Spectre

Anonymous voting on Base, powered by zero-knowledge proofs.

Your identity is cryptographically separated from your vote. Votes are encrypted until the election ends. Results are mathematically verifiable. No one can see how you voted — not even the admin.

**Live:** [spectre-voting-web-app.vercel.app](https://spectre-voting-web-app.vercel.app)

## How It Works

```
 SIGNUP (public)          VOTE (anonymous)           TALLY (verifiable)
 ┌─────────────┐         ┌──────────────────┐       ┌──────────────────┐
 │ Voter signs  │   ZK    │ New anonymous    │  ZK   │ Decrypt votes,   │
 │ up with      │ ──────> │ identity created │ ────> │ verify proofs,   │
 │ identity     │ re-key  │ (delinked from   │ vote  │ count results    │
 │ commitment   │  proof  │  signup)         │ proof │                  │
 └─────────────┘         └──────────────────┘       └──────────────────┘
       |                         |                          |
   Admin sees             Nobody can link             Anyone can verify
   who signed up          signup to vote              results are correct
```

1. **Signup** — Voters register with an identity commitment (public)
2. **Anonymous join** — A ZK proof cryptographically separates the voter's identity from their registration. The admin can see who signed up but cannot link any signup to any vote.
3. **Vote** — A second ZK proof proves eligibility and binds the encrypted vote. Ballots are ECIES-encrypted until the election ends.
4. **Tally** — Votes are decrypted client-side, Poseidon commitments verified, results displayed. Anyone can independently confirm the count.

## What Makes It Different

| | Spectre | MACI | Snapshot |
|---|---|---|---|
| Admin can see votes | No | Yes (coordinator decrypts) | Yes (no encryption) |
| Identity delinking | Mandatory ZK re-key | Optional | None |
| Encrypted ballots | Yes (ECIES) | Coordinator sees all | No |
| On-chain verification | Yes (Groth16) | Yes | No |
| Wallet required to vote | Optional (gasless mode) | Yes | Yes |

## Features

- **ZK re-key identity delinking** — Two Semaphore groups + AnonJoin circuit break the link between signup and vote
- **End-to-end encrypted ballots** — ECIES-secp256k1, sealed until tally
- **Multi-option voting** — 2-10 options per election, circuit-enforced range check
- **Threshold decryption** — Optional t-of-n committee mode (on-chain coordination)
- **Gasless voting** — Server-side relay submits transactions, voters just open a link
- **Signup gates** — Open access, invite codes, allowlist, token gate, admin-only
- **On-chain metadata** — Election titles, options, and config stored in contract events
- **Live countdown timers** — Signup and voting deadlines with real-time display

## Tech Stack

- **Contracts:** Solidity 0.8.23, Hardhat, deployed on [Base](https://base.org) (L2)
- **ZK Proofs:** Circom 2.2.3 (Groth16), snarkjs — two circuits:
  - AnonJoin (14K constraints) — anonymous identity re-key
  - SpectreVote (10K constraints) — vote proof with multi-option range check
- **Identity:** Semaphore V4 (anonymous group membership via Merkle trees)
- **Encryption:** ECIES-secp256k1 (ECDH + HKDF-SHA256 + AES-256-GCM) via @noble/curves
- **Frontend:** Next.js 14, React 18, ethers.js v6, deployed on Vercel

## Project Structure

```
spectre-voting/
├── apps/
│   ├── contracts/       # Solidity contracts + Hardhat tests (64 tests)
│   ├── circuits/        # Circom ZK circuits (AnonJoin + SpectreVote)
│   ├── sdk/             # TypeScript SDK (prove, tally, ECIES, Shamir)
│   └── web-app/         # Next.js frontend (deployed to Vercel)
└── ...
```

## Quick Start

```bash
git clone https://github.com/nexosynths/spectre-voting.git
cd spectre-voting
yarn
yarn dev  # starts Next.js on localhost:3000
```

## Run Tests

```bash
cd apps/contracts
npx hardhat test   # 64 tests
```

## Deployed Contracts (Base Mainnet)

| Contract | Address |
|---|---|
| SpectreVotingFactory | `0x1581c010cC06942ADEEc85baa9a3D19a7e82A21e` |
| SpectreVoteVerifier | `0xfCDE99ac31eE5cb3Bd4DD2cD9E0D49f9c8240564` |
| AnonJoinVerifier | `0xD11fF7e4739736769703f88501c1c4681675676d` |
| Semaphore V4 | `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D` |

## Architecture Deep Dive

The protocol uses two separate Semaphore groups per election — a signup group and a voting group. The AnonJoin ZK circuit proves membership in the signup group and outputs a new, delinked commitment for the voting group. This mandatory re-key means the admin can verify eligibility (who signed up) but mathematically cannot determine who cast which vote.

Votes are ECIES-encrypted with the election public key. In threshold mode, decryption requires t-of-n committee members to submit their shares on-chain. The tally happens entirely client-side — no server ever sees individual votes.

For gasless elections, a server-side relay submits transactions on behalf of voters. Voters generate ZK proofs in-browser and send them to the relay, which submits on-chain. The relay cannot censor votes — the frontend independently verifies each vote appears on-chain.

## Roadmap

- **Vote overwriting** — Coercion resistance via versioned nullifiers (in progress)
- **Pedersen commitments** — Homomorphic tally without coordinator
- **Commitment re-randomization** — Structural receipt-freeness
- **Weighted / quadratic voting** — DAO governance support
- **Token gate** — ERC-20/721 balance-based eligibility

## License

MIT
