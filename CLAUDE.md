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
| Multi-option (circuit) | Yes | No | No | No | No |
| Production deployed | Testnet | Unaudited | Yes (920k users) | Research PoC | Yes |

### Contract Architecture
- **SpectreVotingFactory** — Deploys new election instances. Takes three verifier addresses (Semaphore, VoteVerifier, JoinVerifier). Creates elections with configurable signup deadline, voting deadline, and number of options.
- **SpectreVoting** — Individual election contract. Three-phase state machine (signupOpen/votingOpen flags). Two Semaphore groups (signupGroupId, votingGroupId). Two ZK verifiers (SpectreVoteVerifier, AnonJoinVerifier). Functions: `signUp()`, `registerVoter()`, `registerVoters()`, `closeSignup()`, `anonJoin()`, `castVote()`, `closeVoting()`.
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
- **Election metadata:** Titles and option labels stored in localStorage + URL query params (`?t=Title&labels=Opt1,Opt2,Opt3`) for sharing

## Deployed Contracts (Sepolia)
- **SpectreVotingFactory (v3):** `0x7eAA40146720E35A4ED979A87B634B06eb61dBD8`
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
│   │   │   └── SpectreVotingFactory.ts   # 26 tests (three-phase flow, ZK proofs, multi-option)
│   │   ├── tasks/deploy.ts
│   │   └── scripts/deploy-factory-sepolia.ts
│   ├── circuits/            # Circom ZK circuits
│   │   └── src/
│   │       ├── AnonJoin.circom           # Anonymous join proof (14k constraints)
│   │       └── SpectreVote.circom        # Vote proof with numOptions (10k constraints)
│   ├── sdk/                 # TypeScript SDK
│   │   └── src/
│   │       ├── voter.ts     # Vote preparation + payload encoding
│   │       ├── tally.ts     # Decrypt + verify + count
│   │       ├── ecies.ts     # ECIES encrypt/decrypt (Node.js)
│   │       ├── threshold.ts # Shamir secret sharing for committee keys
│   │       └── test.ts      # SDK integration tests
│   └── web-app/             # Next.js frontend (deployed to Vercel)
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx              # Home: identity + create election + election list
│       │   │   └── election/[address]/
│       │   │       └── page.tsx          # Election: phase-aware vote + results + manage
│       │   ├── lib/
│       │   │   ├── contracts.ts          # ABIs + addresses + RPC (v3 contracts)
│       │   │   ├── ecies.ts              # Browser ECIES (encrypt + decrypt)
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
- [x] 26 passing contract tests (three-phase flow, ZK proofs, multi-option, deadlines)
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
- [x] Wallet-scoped identity (each wallet gets its own Semaphore identity)
- [x] Wallet switching support (accountsChanged updates signer + loads correct identity)

### Next Up
- [ ] **Gated signup toggle** — `selfSignupAllowed` bool on contract. When false, only admin can register voters. Needed for controlled elections (board votes, shareholder votes).
- [ ] **Relayer service** — Accept signed proofs from voters, submit on-chain transactions from a funded wallet. Eliminates wallet/gas requirement for voters. Biggest UX unlock for non-crypto users.
- [ ] **L2 deployment** — Base or Arbitrum for cheap gas + fast confirms.
- [ ] **Threshold decryption** — Shamir 3-of-5 key splitting for election key. No single party can see results early.
- [ ] **Better error messages** — Decode contract custom errors (NullifierAlreadyUsed, MerkleRootMismatch, etc.) into human-readable messages in the UI.
- [ ] **Mobile responsive polish**
- [ ] **On-chain result commitment** — Publish Poseidon root of tally for auditability.
- [ ] **Mainnet deployment**

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
npx hardhat test  # 26 tests, ~10s
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
- **Election metadata is client-side:** Titles and option labels are stored in localStorage + URL params, not on-chain. They're cosmetic — the contract only stores a uint256 proposalId and uint256 numOptions.
- **Identity tied to browser:** ZK identity lives in localStorage (scoped to wallet address). Clearing browser data loses it. Backup key available under Advanced section.
- **snarkjs webpack warning:** Expected warning about dynamic require in web-worker — doesn't affect functionality.
- **Circom bare includes:** `@zk-kit/circuits` uses bare `include "poseidon.circom"` requiring an extra `-l` flag pointing to `circomlib/circuits/` directory.
- **Groth16Verifier name collision:** snarkjs generates all verifiers as `contract Groth16Verifier`. Must manually rename to `AnonJoinVerifier` / `SpectreVoteVerifier` after generation.
- **Self-signup is open:** Currently anyone who finds the contract address can call `signUp()`. For controlled elections, admin should use `registerVoter()` / `registerVoters()` and close signup quickly. Gated signup toggle is planned.

## Security Notes
- **Testnet only** — Sepolia deployer private key is in git history. Never use for mainnet.
- **Threat model completed** — 22 findings assessed, 3 real issues fixed (commitment validation, payload privacy, voting deadline).
- **Client-side key management** — Election private keys stored in localStorage. For production, use threshold decryption.
- **No formal audit** — This is a proof of concept, not audited production code.
- **Identity scoping** — Identities are scoped to wallet address to prevent cross-wallet leakage. Voting identities are scoped to both election address and wallet address.

## Developer Context
- Built as a proof of concept for anonymous encrypted voting with ZK re-key identity delinking
- Closest existing protocols: MACI v3 (anonymous poll joining, unaudited) and aMACI (DoraHacks, optional re-key)
- Core protocol is complete and end-to-end tested; next priorities are access control (gated signup) and UX (relayer for gas-free voting)
- Prioritize clean UX and iterate — the cryptographic foundation is solid
