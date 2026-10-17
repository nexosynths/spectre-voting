# Spectre

Anonymous voting on Base, using zero-knowledge proofs.

> **Research prototype. Unaudited. Don't use it for votes that matter.**
> Spectre is an experiment in private on-chain voting. It hasn't had an external security review, and its current privacy guarantees are weaker than the long-term goal. Read [Trust model](#trust-model) and [Known limitations](#known-limitations) before using it.

**Demo:** [spectre-voting-web-app.vercel.app](https://spectre-voting-web-app.vercel.app)

## How it works

```
 SIGNUP (public)          VOTE (anonymous)           TALLY
 ┌─────────────┐         ┌──────────────────┐       ┌──────────────────┐
 │ Voter signs  │   ZK    │ New anonymous    │  ZK   │ Key holder       │
 │ up with      │ ──────> │ identity created │ ────> │ decrypts ballots,│
 │ identity     │ re-key  │ (delinked from   │ vote  │ checks them,     │
 │ commitment   │  proof  │  signup)         │ proof │ publishes result │
 └─────────────┘         └──────────────────┘       └──────────────────┘
```

1. **Signup.** Voters register an identity commitment. This step is public.
2. **Anonymous join.** A ZK proof moves the voter into a separate voting group without revealing which signup they were.
3. **Vote.** A second ZK proof shows the voter is in the voting group and binds an encrypted ballot to the proof. Ballots are ECIES-encrypted to the election key.
4. **Tally.** Whoever holds the election key decrypts the ballots, checks each one against its on-chain commitment, and publishes the result. That's the admin, or a threshold committee.

## Trust model

| Question | Today | What you're trusting |
|---|---|---|
| Who can vote? | Admin registration, or a signup gate | The admin, and the relay service that checks gates |
| Can my ballot be linked to me? | Not through the ZK proofs, if you vote through the gasless relay | The relay operator not to log IPs; you not voting from your signup wallet |
| Can anyone read ballots before voting closes? | Ballots are encrypted to the election key | Whoever holds that key (the admin, or the committee plus the admin's browser that generated and split the key) |
| Is the published result correct? | The admin publishes it on-chain | The key holder; others can re-check once the key is published |
| Can I be forced to prove how I voted? | Yes. Not coercion-resistant | — |

## Known limitations

- The election key holder can decrypt individual ballots and can see results before voting closes. Ballots stay anonymous only if they can't be linked to a voter.
- In wallet mode, signup and vote are sent from the same wallet, so they can be linked. Token-gated elections currently require wallet mode. Use gasless mode for anonymity.
- You can change your vote (up to 6 submissions). But resubmissions are linkable to each other and a voter can reveal their own ballot, so this does not provide coercion resistance.
- Signup gates (invite codes, allowlist, email domain, GitHub org, token/NFT) are checked by the relay service, not by the contract.
- The circuits and contracts are unaudited. The cryptography (BN254, secp256k1) isn't post-quantum.
- `main` includes vote-overwriting changes that aren't deployed to Base yet. The live demo runs an earlier build without them.

## Features

- **Identity delinking:** two Semaphore groups plus the AnonJoin circuit separate signup from voting (effective in gasless mode)
- **Encrypted ballots:** ECIES-secp256k1, sealed to the election key until tally
- **Multi-option voting:** 2–10 options per election
- **Threshold decryption (optional):** t-of-n committee; the key is generated and split in the admin's browser
- **Gasless voting:** a relay submits transactions, so voters only need a link
- **Vote changes:** up to 6 submissions, last one counts
- **Signup gates:** open, invite codes, allowlist, email domain, GitHub org, token/NFT, admin-only
- **On-chain metadata:** election titles, options and config stored in contract events

## Tech stack

- **Contracts:** Solidity 0.8.23, Hardhat, deployed on [Base](https://base.org) (L2)
- **ZK proofs:** Circom 2.2.3 (Groth16), snarkjs, with two circuits:
  - AnonJoin (~14K constraints): anonymous identity re-key
  - SpectreVote (~10.5K constraints): vote proof with option and version range checks
- **Identity:** Semaphore V4 (anonymous group membership via Merkle trees)
- **Encryption:** ECIES-secp256k1 (ECDH + HKDF-SHA256 + AES-256-GCM) via @noble/curves
- **Frontend:** Next.js 14, React 18, ethers.js v6, deployed on Vercel

## Project structure

```
spectre-voting/
├── apps/
│   ├── contracts/       # Solidity contracts + Hardhat tests
│   ├── circuits/        # Circom ZK circuits (AnonJoin + SpectreVote)
│   ├── sdk/             # TypeScript SDK (prove, tally, ECIES, Shamir)
│   └── web-app/         # Next.js frontend (deployed to Vercel)
└── ...
```

## Quick start

```bash
git clone https://github.com/nexosynths/spectre-voting.git
cd spectre-voting
yarn
yarn dev  # starts Next.js on localhost:3000
```

## Run tests

```bash
cd apps/contracts
npx hardhat test
```

## Deployed contracts (Base mainnet)

These were deployed before the vote-overwriting change on `main`.

| Contract | Address |
|---|---|
| SpectreVotingFactory | `0x1581c010cC06942ADEEc85baa9a3D19a7e82A21e` |
| SpectreVoteVerifier | `0xD0B778a60E57be0681f660E9c9319274EB10272E` |
| AnonJoinVerifier | `0x753126E842baa748e46384c115e1CF6952c01522` |
| Semaphore V4 | `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D` |

## Open problems

- Remove the single key holder (distributed key generation or time-lock encryption)
- A tally anyone can verify without the key (homomorphic aggregation plus proofs of correct decryption)
- Eligibility checked on-chain (Merkle snapshots, email or SSO proofs) instead of by the relay
- Coercion resistance without a trusted coordinator, which is still an open research problem
- Post-quantum primitives
- External review and audit before any real use

## License

MIT
