# Spectre — Anonymous ZK Voting Protocol

## Project Overview
Spectre is a fully on-chain anonymous voting protocol using zero-knowledge proofs. It combines **ZK re-key anonymous registration** (cryptographic identity delinking between signup and voting) with **end-to-end encrypted ballots** and **multi-option voting** — a combination no other deployed protocol achieves.

Voters sign up publicly (eligibility check), then use a ZK proof to anonymously re-key into a separate voting group. The admin can see who signed up but **cannot link any signup identity to any vote**. Votes are ECIES-encrypted until tally time.

**Live:** https://spectre-voting-web-app.vercel.app
**GitHub:** https://github.com/nexosynths/spectre-voting

## Tech Stack
- **Smart Contracts:** Solidity 0.8.23, Hardhat, deployed on Sepolia
- **ZK Proofs:** Circom 2.2.3 (Groth16), snarkjs, two circuits (AnonJoin: 14k constraints, SpectreVote: 10k constraints)
- **Identity:** Semaphore V4 (anonymous group membership via Merkle trees)
- **Encryption:** ECIES-secp256k1 (ECDH + HKDF-SHA256 + AES-256-GCM) via @noble/curves
- **Frontend:** Next.js 14, React 18, ethers.js v6
- **Deployment:** Vercel (auto-deploy from GitHub main branch)
- **Monorepo:** Yarn 4 workspaces (deps hoisted to root node_modules/)

## Architecture

### Three-Phase Election Flow
1. **Signup (Phase 1)** — Admin creates election via Factory. Voters self-signup by calling `signUp(identityCommitment)`. This is intentionally public — the admin can see who registered. The signup group Merkle tree records all commitments.
2. **Anonymous Join + Vote (Phase 2)** — Admin closes signup, opening voting. Each voter generates a ZK proof (AnonJoin circuit) proving they're in the signup group WITHOUT revealing which member. The proof outputs a new, delinked commitment added to a separate voting group. Then the voter generates a second ZK proof (SpectreVote circuit) proving voting group membership + a vote commitment, encrypts their vote with the election public key, and submits on-chain. Two wallet confirmations required.
3. **Tally (Phase 3)** — Admin (or anyone with the election private key) closes voting, decrypts all votes client-side, verifies Poseidon commitments, deduplicates by nullifier, and displays per-option results.

### Key Cryptographic Properties
- **Identity delinking:** AnonJoin ZK proof cryptographically breaks the link between signup identity and voting identity (two separate Semaphore groups)
- **Mandatory re-key:** Unlike aMACI (DoraHacks), the re-key is not optional — you cannot vote without going through AnonJoin
- **End-to-end encrypted:** Votes are ECIES-encrypted; the admin never sees individual votes, not even during processing (unlike MACI where the coordinator decrypts)
- **Circuit-enforced multi-option:** LessThan(8) range check inside the ZK circuit prevents invalid votes at the proof level, not just contract level
- **Sybil-resistant:** Semaphore nullifiers prevent double voting (join nullifier for AnonJoin, vote nullifier for SpectreVote)
- **Verifiable:** Poseidon2 commitment binds vote to randomness; Groth16 proofs verified on-chain by two separate verifier contracts

### How It Compares
| Property | Spectre | MACI v3 | aMACI (DoraHacks) | Aztec/Nouns | Snapshot/Shutter |
|---|---|---|---|---|---|
| Identity delinking | Yes (mandatory) | Yes (anon poll join) | Optional | No | No |
| Admin can't see votes | Yes (ECIES) | No (coordinator decrypts) | Partially | Yes (time-lock) | During voting only |
| Threshold decryption | Yes (t-of-n optional) | No | No | No | Partial (Shutter) |
| Multi-option (circuit) | Yes | No | No | No | No |
| Production deployed | Testnet | Unaudited | Yes (920k users) | Research PoC | Yes |

### Election Lifecycle (Threshold Committee Mode)

```
                    SETUP                          VOTING                    RESULTS
 ┌─────────────────────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐
 │                                 │  │                      │  │                         │
 │  1. CREATE ELECTION             │  │  5. VOTE             │  │  8. DECRYPT SHARES      │
 │     Admin sets question,        │  │     Each voter picks │  │     Committee members   │
 │     options, and committee      │  │     an option and    │  │     submit decrypted    │
 │     members (wallet addresses)  │  │     submits (2 tx:   │  │     shares on-chain     │
 │              │                  │  │     ZK re-key +      │  │     (2 of 3 needed)     │
 │              v                  │  │     encrypted vote)  │  │            │            │
 │  2. COMMITTEE KEYS              │  │           │          │  │            v            │
 │     Each committee member       │  │           v          │  │  9. TALLY               │
 │     generates a keypair and     │  │  6. CLOSE VOTING     │  │     Auto-decrypts all   │
 │     registers their public      │  │     Admin ends the   │  │     votes and counts    │
 │     key on-chain                │  │     voting period    │  │     results              │
 │              │                  │  │                      │  │            │            │
 │              v                  │  └──────────────────────┘  │            v            │
 │  3. FINALIZE COMMITTEE          │                            │  10. COMMIT ON-CHAIN     │
 │     Admin runs dealer ceremony  │                            │      Admin publishes     │
 │     to generate election key    │                            │      results + hash      │
 │     and encrypted shares        │                            │      (anyone can verify) │
 │              │                  │                            │                         │
 │              v                  │                            └─────────────────────────┘
 │  4. OPEN VOTING                 │
 │     Admin closes signup,        │
 │     voters register, then       │
 │     voting opens                │
 │                                 │
 └─────────────────────────────────┘

 WHO DOES WHAT:
 ─────────────────────────────────────────────────────
 Admin:       1 → 3 → 4 → 6 → 10
 Committee:   2 → 8
 Voters:      (register during 4) → 5
```

**Key points:**
- Committee members and voters can be the same people
- Votes are anonymous — ZK proof breaks the link between signup and vote
- Votes are encrypted until step 9 — nobody sees results early
- Results are verifiable — anyone can re-derive the tally from on-chain data and check it matches the committed hash

### Contract Architecture
- **SpectreVotingFactory** — Deploys new election instances. Takes three verifier addresses (Semaphore, VoteVerifier, JoinVerifier). Creates elections with configurable signup deadline, voting deadline, number of options, and opaque `bytes metadata` (emitted in `ElectionDeployed` event for on-chain discoverability).
- **SpectreVoting** — Individual election contract. Three-phase state machine (signupOpen/votingOpen flags). Two Semaphore groups (signupGroupId, votingGroupId). Two ZK verifiers (SpectreVoteVerifier, AnonJoinVerifier). Functions: `signUp()`, `registerVoter()`, `registerVoters()`, `closeSignup()`, `anonJoin()`, `castVote()`, `closeVoting()`, `commitTallyResult()`. Optional on-chain committee coordination: `setupCommittee()`, `registerCommitteeKey()`, `finalizeCommittee()`, `submitDecryptedShare()`, `getCommitteeMembers()`, `getDecryptedShare()`.
- **Semaphore V4** — Group membership Merkle tree (two groups per election: signup + voting)
- **SpectreVoteVerifier** — Groth16 verifier for vote proofs (5 public signals: merkleRoot, nullifierHash, voteCommitment, proposalId, numOptions)
- **AnonJoinVerifier** — Groth16 verifier for anonymous join proofs (4 public signals: signupMerkleRoot, joinNullifier, newCommitment, electionId)

### Circuit Architecture
- **AnonJoin.circom** (14,094 constraints) — Proves signup group membership + outputs delinked commitment for voting group. Uses @zk-kit binary-merkle-root for Merkle proof, Poseidon2 for commitment and nullifier derivation.
- **SpectreVote.circom** (9,912 constraints) — Proves voting group membership + binds encrypted vote to proof via Poseidon commitment. Includes LessThan(8) range check for multi-option voting (vote < numOptions).
- Both circuits fit within 2^15 (32,768) ptau constraint limit.
- Compiled with: `circom src/X.circom --r1cs --wasm --sym -o build -l /path/to/node_modules -l /path/to/node_modules/circomlib/circuits` (two `-l` flags needed because @zk-kit uses bare includes)

### Client-Side Architecture
- **Browser ZK proofs:** snarkjs generates Groth16 proofs in-browser (~10-30s per proof, two proofs for join+vote)
- **Browser ECIES:** @noble/curves handles all encryption client-side
- **No backend:** All state lives on-chain; the frontend is a static site
- **Wallet connection:** Uses window.ethereum (MetaMask, Rabby, etc.) with accountsChanged listener for wallet switching
- **Identity scoping:** Semaphore identities stored per-wallet-address in localStorage (`spectre-identity-${address}`). Voting identities stored per-election-per-wallet (`spectre-voting-identity-${election}-${address}`).
- **Election metadata:** Stored on-chain in `ElectionDeployed` event as opaque `bytes` (UTF-8 JSON). Frontend reads from event (async), caches in localStorage. Falls back to URL query params for old elections.

## Deployed Contracts (Sepolia)
- **SpectreVotingFactory (v5):** `0xf548704Da5F00e709B28c8B1499E358A9984aefB`
- **SpectreVoteVerifier:** `0xe4a2be410766bCB37Df956334869135fe80AF36d`
- **AnonJoinVerifier:** `0xdeE4c3F80332119f59940c363947865bbF7d0585`
- **Semaphore:** `0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D`

## Project Structure
```
spectre-voting/
├── apps/
│   ├── contracts/           # Solidity contracts + Hardhat
│   │   ├── contracts/
│   │   │   ├── SpectreVoting.sol         # Core election contract (three-phase, two groups, two verifiers)
│   │   │   ├── SpectreVotingFactory.sol  # Factory for deploying elections
│   │   │   ├── SpectreVoteVerifier.sol   # Groth16 vote proof verifier (5 public signals)
│   │   │   └── AnonJoinVerifier.sol      # Groth16 join proof verifier (4 public signals)
│   │   ├── test/
│   │   │   └── SpectreVotingFactory.ts   # 63 tests (three-phase flow, ZK proofs, multi-option, gated signup, tally, metadata, on-chain committee)
│   │   ├── tasks/deploy.ts
│   │   └── scripts/deploy-factory-sepolia.ts
│   ├── circuits/            # Circom ZK circuits
│   │   └── src/
│   │       ├── AnonJoin.circom           # Anonymous join proof (14k constraints)
│   │       └── SpectreVote.circom        # Vote proof with numOptions (10k constraints)
│   ├── sdk/                 # TypeScript SDK
│   │   └── src/
│   │       ├── voter.ts     # Vote preparation + payload encoding (multi-option)
│   │       ├── prove.ts     # ZK proof generation (numOptions support)
│   │       ├── tally.ts     # Decrypt + verify + count (optionCounts[])
│   │       ├── ecies.ts     # ECIES encrypt/decrypt (Node.js)
│   │       ├── shamir.ts    # Shamir secret sharing (split/combine)
│   │       ├── dealer.ts    # Dealer ceremony (setupElection, share serialization)
│   │       ├── test.ts      # SDK integration tests
│   │       └── test-threshold.ts # Threshold + multi-option tally tests (28 tests)
│   └── web-app/             # Next.js frontend (deployed to Vercel)
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx              # Home: identity + create election + election list
│       │   │   └── election/[address]/
│       │   │       └── page.tsx          # Election: phase-aware vote + results + manage
│       │   ├── lib/
│       │   │   ├── contracts.ts          # ABIs + addresses + RPC (v5 contracts)
│       │   │   ├── ecies.ts              # Browser ECIES (encrypt + decrypt)
│       │   │   ├── threshold.ts          # Browser Shamir + dealer + share reconstruction
│       │   │   ├── errors.ts             # Human-readable contract error decoder
│       │   │   ├── proof.ts              # Browser SpectreVote proof generation
│       │   │   └── anonJoinProof.ts      # Browser AnonJoin proof generation
│       │   ├── context/
│       │   │   └── SpectreContext.tsx     # Wallet + identity state (per-wallet scoping)
│       │   └── components/
│       │       ├── Header.tsx
│       │       └── Providers.tsx
│       └── public/
│           └── circuits/
│               ├── SpectreVote.wasm      # Vote circuit WASM (1.8 MB)
│               ├── SpectreVote.zkey      # Vote proving key (8.1 MB)
│               ├── AnonJoin.wasm         # Join circuit WASM (1.9 MB)
│               └── AnonJoin.zkey         # Join proving key (10 MB)
```

## Feature Status

### Done (v5 — On-Chain Threshold Committee Coordination)
- [x] On-chain committee lifecycle — `setupCommittee()`, `registerCommitteeKey()`, `finalizeCommittee()`, `submitDecryptedShare()` on SpectreVoting contract
- [x] Self-sovereign key generation — committee members generate their own secp256k1 keypairs on the election page, private keys stay in browser localStorage
- [x] On-chain key registration — 33-byte compressed pubkeys registered on-chain via `registerCommitteeKey()`
- [x] Restructured dealer ceremony — admin fetches all registered pubkeys from chain, runs dealer locally, calls `finalizeCommittee()` to set election pubkey + emit encrypted shares
- [x] On-chain share submission — after voting closes, committee members decrypt + submit shares via `submitDecryptedShare()` (stored in contract storage + events)
- [x] Auto-tally — frontend reads submitted shares from chain, reconstructs key in browser when threshold met, decrypts votes automatically
- [x] closeSignup guard — prevents opening voting before committee is finalized (`committeeThreshold > 0 && !committeeFinalized`)
- [x] Backward compatible — `committeeThreshold == 0` means single-key mode, all existing behavior preserved
- [x] Committee tab on election page — phase-aware UI for key registration, dealer finalization, share submission
- [x] Zero copy-paste — entire committee lifecycle is on-chain, no out-of-band messaging
- [x] Committee key backup/import — private key displayed with Copy button, Import Key for restoring on different browser
- [x] Bug fixes: vote button disabled logic (`canVote` derived value), zero pubkey validation in `finalizeCommittee()`, finalized check in `submitDecryptedShare()`, parallel RPC calls
- [x] Auto-connect wallet on page load via `eth_accounts` (no popup)
- [x] 63 passing contract tests (+26 new committee tests), 28 passing SDK tests
- [x] Deployed v5 factory to Sepolia with bug fixes

### Done (v4 — Access Control + Threshold Encryption)
- [x] Gated signup toggle — `selfSignupAllowed` bool on contract; when false, only admin can register voters via `registerVoter()`/`registerVoters()`
- [x] Optional threshold encryption — admin chooses single-key (default) or t-of-n committee mode at election creation
- [x] Dealer ceremony UI — committee member setup with name + secp256k1 pubkey, "Generate Keypair" convenience button
- [x] Shamir secret sharing in browser — split/combine over secp256k1 scalar field, ECIES-encrypted shares per committee member
- [x] Share distribution modal — copy encrypted shares for each committee member after election creation
- [x] Threshold tally UI — "Decrypt Your Share" (committee member decrypts their share) + "Collect Shares & Tally" (coordinator collects t shares)
- [x] SDK multi-option tally — `TallyResult.optionCounts[]` replaces `votesFor/votesAgainst`, `computeTally()` takes `numOptions` param
- [x] SDK prove/voter updated for v3 circuit — `numOptions` passed as circuit input (27 inputs total)
- [x] Human-readable error messages — `friendlyError()` decodes 28 contract custom errors into user-friendly strings
- [x] Mobile responsive polish — viewport meta, 600px media query (44px touch targets, iOS zoom prevention, flex-wrap on input rows, readable hex font sizes)
- [x] On-chain tally result commitment — `commitTallyResult()` stores raw results + Poseidon hash chain commitment; immutable, phase-guarded, admin-only
- [x] On-chain election metadata — `bytes _metadata` param on `createElection()`, emitted in `ElectionDeployed` event; frontend reads from event (async), caches in localStorage; threshold encrypted shares now survive browser clears; clean share URLs (no query params)

### Done (v3 — ZK Re-Key + Multi-Option)
- [x] AnonJoin ZK circuit — proves signup group membership, outputs delinked commitment + join nullifier
- [x] SpectreVote ZK circuit — updated with numOptions public input + LessThan(8) range check
- [x] Three-phase election flow (signup → anonymous join + vote → closed)
- [x] Two Semaphore groups per election (signupGroupId + votingGroupId)
- [x] Two Groth16 verifier contracts (SpectreVoteVerifier + AnonJoinVerifier)
- [x] Self-signup during Phase 1 + admin registration (registerVoter/registerVoters)
- [x] Signup deadline + voting deadline with permissionless close after expiry
- [x] Multi-option voting (2-10 options per election, circuit-enforced)
- [x] Phase-aware election page UI (signup → voting → closed)
- [x] Per-election per-wallet voting identity (delinked from signup identity)
- [x] Dynamic option labels (add/remove during election creation)
- [x] Per-option tally with colored progress bars + winner detection
- [x] Deployed v3 contracts to Sepolia + end-to-end verified with 3 wallets

### Done (v1-v2 — Foundation)
- [x] Groth16 ZK proof circuit
- [x] SpectreVoting contract with encrypted vote submission
- [x] SpectreVotingFactory for on-demand election deployment
- [x] ECIES-secp256k1 encrypted ballots
- [x] Browser-based ZK proof generation via snarkjs
- [x] Semaphore V4 anonymous group membership
- [x] Client-side tally with Poseidon commitment verification
- [x] Shamir threshold key management in SDK
- [x] Next.js frontend with wallet connection
- [x] Election titles + custom vote labels
- [x] Share links with metadata in URL params
- [x] Inline identity generation on election page
- [x] Admin-only Manage tab (hidden from voters)
- [x] Step-by-step voter guidance
- [x] Deployed to Vercel (auto-deploy from main)
- [x] Per-election identity (fresh Semaphore identity per election — no cross-election participation tracking)
- [x] Wallet switching support (accountsChanged updates signer + loads correct identity)

### v6 — Proof-Only Relayer (Gasless Voting) (COMPLETE)

- [x] API route: `/api/relay` — server-side tx submission, rate limiting, pre-checks
- [x] Client module: `lib/relayer.ts` — relay calls, tx polling, anti-censorship verification
- [x] Gasless voting path on election page (relay signup → anonJoin → castVote)
- [x] Per-election voter access toggle: "Wallet required" vs "Gasless" at election creation
- [x] Anonymous identity for walletless voters (UUID-scoped in localStorage)
- [x] Anti-censorship: client independently verifies VoteCast event on-chain via public RPC
- [x] IP-timing decorrelation: random delay between anonJoin and castVote in production
- [x] Relayer wallet: `0x2f30dF147C922cFce314D47ecA240953eCFc622f` (Sepolia, funded)

Biggest UX unlock: voters generate ZK proofs in browser, a server-side funded wallet submits on-chain transactions. No wallet or gas needed for voters.

#### Architecture
```
Browser → generate proof → POST /api/relay → server verifies proof → server wallet signs tx → chain
                                                                  ↓
                                           Frontend verifies VoteCast event on-chain (anti-censorship)
```

#### Scope
- **Relayable actions**: `signUp`, `anonJoin`, `castVote` (no `msg.sender` checks on these)
- **NOT relayed**: Admin actions (closeSignup, closeVoting, commitTallyResult, committee mgmt)
- **Per-election toggle**: Admin chooses "Wallet required" vs "Gasless" at election creation
- **Hosting**: Vercel API routes in existing Next.js app (zero new infra)
- **Fallback**: Direct wallet submission always available

#### Key Implementation Details
- Single `POST /api/relay` endpoint with `action` field dispatching to signUp/anonJoin/castVote
- Server-side Groth16 proof verification (snarkjs) before spending gas — prevents gas draining attacks
- Client-side on-chain verification after relay — frontend confirms `VoteCast` event independently via public RPC (anti-censorship)
- Random 5-30s delay between anonJoin and castVote relay calls (IP-timing decorrelation)
- Rate limiting: 3 relay calls per IP per election (1 signup + 1 anonJoin + 1 castVote)
- Identity without wallet: anonymous UUID stored in localStorage, scoped per-election
- Relayer wallet: funded testnet wallet, private key as Vercel env var (`RELAYER_PRIVATE_KEY`)

#### Threat Model Summary
| Risk | Severity | Mitigation |
|------|----------|------------|
| Selective vote censorship | CRITICAL | Client-side on-chain verification after relay |
| IP-timing deanonymization | HIGH | Random delay between anonJoin and castVote |
| Gas draining via invalid proofs | HIGH | Server-side Groth16 proof verification |
| Relayer + admin collusion | CRITICAL | Independent relayer operator for real elections |
| Relayer outage | CRITICAL | Direct wallet fallback always available |
| Junk signup spam | MEDIUM | Rate limiting + gated signup for relayed elections |
| Relayer key stolen | MEDIUM | Minimal balance + no on-chain role = limited blast radius |

**Trust assumptions added by relayer:** Liveness (relayer will submit tx), timeliness (relayer will submit promptly), transport privacy (relayer won't correlate IPs with proofs). Does NOT affect proof soundness or vote integrity — ZK proofs verified on-chain regardless of who submits.

**Gas costs per voter (all 3 txs):** ~700K-1M gas. Sepolia: free (faucet). L2 mainnet: ~$0.01-0.10. L1 mainnet: ~$50-70 (use L2).

#### Files
- `apps/web-app/src/app/api/relay/route.ts` — API route
- `apps/web-app/src/lib/relayer.ts` — Client module
- `apps/web-app/src/app/election/[address]/page.tsx` — Gasless voting path
- `apps/web-app/src/context/SpectreContext.tsx` — Walletless identity
- `apps/web-app/src/app/page.tsx` — Voter access mode toggle

### Later
- [ ] **L2 deployment** — Base or Arbitrum for cheap gas + fast confirms
- [ ] **Mainnet deployment**

### Future — Modular Signup Gates (Flexible Voter Eligibility)

Currently signup is binary: open (anyone) or admin-only (gated). A modular gate system would let elections use pluggable eligibility criteria without changing the core contract.

#### Design Sketch
- **`ISignupGate` interface** — single `canSignup(election, voter, proof) → bool` method
- **Election contract** — stores optional `signupGate` address, checks it during `signup()`. `address(0)` = open signup (current behavior)
- **Gate implementations** (deploy once, reuse across elections):
  - **MerkleAllowlistGate** — admin publishes Merkle root of eligible addresses, voters prove inclusion. Handles 10k+ voter lists with one tx instead of batch-registering on-chain. Highest impact.
  - **TokenGate** — must hold minimum ERC-20 balance
  - **NFTGate** — must hold specific NFT (DAO membership, credential, etc.)
  - **AttestationGate** — EAS attestation, Gitcoin Passport score, World ID proof of humanity
- **Replaces `selfSignupAllowed` boolean** — no gate = open, gate = criteria-based, no self-signup function = admin-only

#### Why Not Now
Build this after real usage reveals whether admin-only + open signup is sufficient. Merkle gate is the clear first candidate if/when needed.

### Future — Enterprise Abstraction (Gas-Free Voter Experience)

For non-crypto enterprise use cases (company votes, shareholder votes, board elections), the voter should never see a wallet, pay gas, or know blockchain is involved.

#### Proposed Architecture
```
Enterprise Admin                     Employee/Voter
     |                                    |
     |-- Creates election (wallet) -----> |
     |-- Sends invite email ------------> |
     |                                    |-- Clicks link
     |                                    |-- Browser generates identity (auto)
     |                                    |-- "Sign Up" -> relayer submits tx (pays gas)
     |                                    |
     |-- Closes registration              |
     |                                    |
     |                                    |-- "Vote" -> browser generates ZK re-key proof (local)
     |                                    |-- Relayer submits anon join + vote tx (pays gas)
     |                                    |-- Voter sees: "Your vote has been cast"
     |
     |-- Tallies results (threshold decryption with trustees)
```

#### Key Components
- **Relayer API:** Thin backend that wraps voter transactions and submits them from a funded wallet. Accepts ZK proofs from the frontend.
- **Email-based invite:** Admin enters employee emails. System sends links with embedded invite tokens.
- **No wallet required:** Voter's browser generates ZK identity silently. Relayer pays all gas.
- **Same ZK re-key circuit:** The re-key proof is pure client-side math — works identically whether the voter has a wallet or the relayer submits for them.
- **Authentication:** Invite token (single-use, tied to email) gates Phase 1 signup. Could use OAuth/SSO for enterprise identity verification.
- **Threshold decryption:** 3-of-5 trustees must cooperate to tally. No single person can see results early.

## Development

### Prerequisites
- Node.js 20+ (via nvm: `/Users/nexosynths/.nvm/versions/node/v20.20.0/bin`)
- Yarn 4
- Circom 2.2.3 (`/Users/nexosynths/.cargo/bin/circom`)
- MetaMask or Rabby wallet

### Setup
```bash
git clone https://github.com/nexosynths/spectre-voting.git
cd spectre-voting
yarn
```

### Run locally
```bash
yarn dev  # starts Next.js on localhost:3000
```

### Run contract tests
```bash
cd apps/contracts
npx hardhat test  # 61 tests, ~11s
```

### Compile circuits
```bash
cd apps/circuits
circom src/AnonJoin.circom --r1cs --wasm --sym -o build \
  -l ../../node_modules \
  -l ../../node_modules/circomlib/circuits
```
Note: Two `-l` flags are required because `@zk-kit/circuits` uses bare `include "poseidon.circom"` (not prefixed with `circomlib/circuits/`).

### Deploy contracts
```bash
cd apps/contracts
npx hardhat run scripts/deploy-factory-sepolia.ts --network sepolia
```

### Trusted setup (after circuit changes)
```bash
cd apps/circuits
snarkjs groth16 setup build/AnonJoin.r1cs pot/powersOfTau28_hez_final_15.ptau build/AnonJoin.zkey
snarkjs zkey contribute build/AnonJoin.zkey build/AnonJoin_final.zkey
snarkjs zkey export solidityverifier build/AnonJoin_final.zkey ../contracts/contracts/AnonJoinVerifier.sol
# Then rename contract from Groth16Verifier to AnonJoinVerifier in the .sol file
# Copy .wasm and .zkey to web-app/public/circuits/
```

## Known Issues & Workarounds
- **RPC block range limit:** Public Sepolia RPC rejects getLogs spanning >50k blocks. All queryFilter calls are limited to recent 49k blocks.
- **Election metadata on-chain (v3.2+):** Titles, option labels, and threshold info stored as `bytes` in `ElectionDeployed` event. Old elections (pre-v3.2) fall back to localStorage + URL params.
- **Identity tied to browser:** ZK identity lives in localStorage (scoped to wallet address). Clearing browser data loses it. Backup key available under Advanced section.
- **snarkjs webpack warning:** Expected warning about dynamic require in web-worker — doesn't affect functionality.
- **Circom bare includes:** `@zk-kit/circuits` uses bare `include "poseidon.circom"` requiring an extra `-l` flag pointing to `circomlib/circuits/` directory.
- **Groth16Verifier name collision:** snarkjs generates all verifiers as `contract Groth16Verifier`. Must manually rename to `AnonJoinVerifier` / `SpectreVoteVerifier` after generation.
- **Threshold meta now on-chain (v3.2+):** Threshold committee info and encrypted shares are emitted in the `ElectionDeployed` event. Shares survive browser clears. Old elections (pre-v3.2) still rely on localStorage.

## Security Notes
- **Testnet only** — Sepolia deployer private key is in git history. Never use for mainnet.
- **Threat model completed** — 22 findings assessed, 3 real issues fixed (commitment validation, payload privacy, voting deadline).
- **Client-side key management** — Single-key election private keys stored in localStorage. Threshold elections store encrypted shares in localStorage (no master key retained). For production, use threshold mode.
- **No formal audit** — This is a proof of concept, not audited production code.
- **Identity scoping** — Identities are scoped to wallet address to prevent cross-wallet leakage. Voting identities are scoped to both election address and wallet address.

## Developer Context
- Built as a proof of concept for anonymous encrypted voting with ZK re-key identity delinking
- Closest existing protocols: MACI v3 (anonymous poll joining, unaudited) and aMACI (DoraHacks, optional re-key)
- Core protocol is complete and end-to-end tested; next priority is UX (relayer for gas-free voting)
- Prioritize clean UX and iterate — the cryptographic foundation is solid
