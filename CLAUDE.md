# Spectre — Anonymous ZK Voting Protocol

## Project Overview
Spectre is a fully on-chain anonymous voting protocol using zero-knowledge proofs. Voters prove they're eligible without revealing who they are, and votes are encrypted until tally time. Built on Ethereum (Sepolia testnet), deployed as a Next.js dApp on Vercel.

**Live:** https://spectre-voting-web-app.vercel.app
**GitHub:** https://github.com/nexosynths/spectre-voting

## Tech Stack
- **Smart Contracts:** Solidity 0.8.23, Hardhat, deployed on Sepolia
- **ZK Proofs:** Circom 2.1 (Groth16), snarkjs, 16k constraints
- **Identity:** Semaphore V4 (anonymous group membership)
- **Encryption:** ECIES-secp256k1 (ECDH + HKDF-SHA256 + AES-256-GCM) via @noble/curves
- **Frontend:** Next.js 14, React 18, ethers.js v6
- **Deployment:** Vercel (auto-deploy from GitHub main branch)
- **Monorepo:** Yarn workspaces

## Architecture

### Core Protocol Flow
1. **Admin creates election** → Factory deploys a new SpectreVoting contract + generates ECIES keypair
2. **Admin registers voters** → Adds their Semaphore identity commitments to the on-chain Merkle group
3. **Voter casts vote** → Generates a Groth16 ZK proof (proves group membership + vote commitment without revealing identity), encrypts vote with election public key, submits on-chain
4. **Tally** → Admin (or anyone with the election private key) decrypts all votes client-side, verifies Poseidon commitments, deduplicates by nullifier, displays results

### Key Cryptographic Properties
- **Anonymous:** ZK proof reveals nothing about which group member voted
- **Encrypted:** Votes are ECIES-encrypted; nobody sees results until tally
- **Verifiable:** Poseidon2 commitment binds vote to randomness; on-chain proof verification
- **Sybil-resistant:** Semaphore nullifier prevents double voting (same identity = same nullifier)
- **Front-run resistant:** Encrypted votes can't be read by MEV bots or other voters

### Contract Architecture
- **SpectreVotingFactory** — Deploys new election instances on demand
- **SpectreVoting** — Individual election contract (proposalId, voter registration, vote submission, deadline enforcement)
- **Semaphore V4** — Group membership Merkle tree (used by SpectreVoting for voter registration)
- **Groth16Verifier** — Auto-generated from circom circuit, verifies ZK proofs on-chain

### Client-Side Architecture
- **Browser ZK proofs:** snarkjs generates Groth16 proofs in-browser (~10-30s)
- **Browser ECIES:** @noble/curves handles all encryption client-side
- **No backend:** All state lives on-chain; the frontend is a static site
- **Wallet connection:** Uses window.ethereum (MetaMask, Rabby, etc.)
- **Election metadata:** Titles and custom vote labels stored in localStorage + URL query params for sharing

## Deployed Contracts (Sepolia)
- **SpectreVotingFactory (v2):** `0xF0Bed4ED7Ab29BA73833e681b2a1E2fbe928df75`
- **Semaphore:** `0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D`
- **Groth16Verifier:** `0xC1d7A22595b2661C4989BA268e4583441Cb31BB4`

## Project Structure
```
spectre-voting/
├── apps/
│   ├── contracts/           # Solidity contracts + Hardhat
│   │   ├── contracts/
│   │   │   ├── SpectreVoting.sol         # Core election contract
│   │   │   └── SpectreVotingFactory.sol  # Factory for deploying elections
│   │   ├── test/
│   │   │   └── SpectreVotingFactory.ts   # 17 tests (6 voting + 11 factory)
│   │   ├── tasks/deploy.ts
│   │   └── scripts/deploy-factory-sepolia.ts
│   ├── circuits/            # Circom ZK circuits
│   │   └── SpectreVote.circom           # Vote proof circuit (16k constraints)
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
│       │   │   ├── page.tsx              # Home: identity + election list + create
│       │   │   └── election/[address]/
│       │   │       └── page.tsx          # Election: vote + results + manage
│       │   ├── lib/
│       │   │   ├── contracts.ts          # ABIs + addresses + RPC
│       │   │   ├── ecies.ts              # Browser ECIES (encrypt + decrypt)
│       │   │   └── proof.ts              # Browser ZK proof generation
│       │   ├── context/
│       │   │   └── SpectreContext.tsx     # Wallet + identity state
│       │   └── components/
│       │       ├── Header.tsx
│       │       └── Providers.tsx
│       └── public/
│           └── circuits/
│               ├── SpectreVote.wasm      # Circuit WASM (1.8 MB)
│               └── SpectreVote.zkey      # Proving key (8.1 MB)
```

## Feature Status

### Done
- [x] Groth16 ZK proof circuit (16k constraints)
- [x] SpectreVoting contract with encrypted vote submission
- [x] SpectreVotingFactory for on-demand election deployment
- [x] Voting deadlines with permissionless close after expiry
- [x] Identity commitment validation (zero-check)
- [x] ECIES-secp256k1 encrypted ballots (nullifier excluded for privacy)
- [x] Browser-based ZK proof generation via snarkjs
- [x] Semaphore V4 anonymous group membership
- [x] Client-side tally with Poseidon commitment verification
- [x] Shamir threshold key management in SDK
- [x] Next.js frontend with wallet connection
- [x] Election titles + custom vote labels (Yes/No customizable)
- [x] Share links with metadata in URL params
- [x] Inline identity generation on election page
- [x] Admin-only Manage tab (hidden from voters)
- [x] Step-by-step voter guidance
- [x] Deployed to Vercel (auto-deploy from main)
- [x] 17 passing contract tests

### In Progress — Anonymous Registration (Option B: ZK Re-Key)
The current registration flow requires voters to share their Voter ID with the admin out-of-band, creating a timing correlation attack vector. The admin can observe when each commitment was submitted and link real identities to anonymous votes probabilistically.

**Solution: Two-phase registration with ZK re-keying (inspired by MACI's anonymous poll joining).**

#### Phase 1 — Public Signup
- Voter connects wallet and calls `signUp(identityCommitment)` on the election contract
- This is intentionally public — the admin and everyone can see which wallet registered which commitment
- Signup is time-bounded (registration deadline)

#### Phase 2 — Anonymous Poll Join
- After registration closes and voting opens, the voter generates a **new** identity for the election
- The voter's browser generates a ZK proof:
  - "I know the private key for one of the registered commitments" (proves eligibility)
  - "Here is a nullifier = hash(myPrivateKey, electionId)" (prevents double-joining)
  - "Here is my new commitment for this election" (delinked from signup)
- The proof + new commitment are submitted on-chain
- The contract verifies the proof and adds the new commitment to the voting group
- **The admin cannot link the new voting commitment to the original signup**

#### Why This Works
- Phase 1 is public by design — the admin needs to know who signed up to verify eligibility
- Phase 2 uses a ZK proof to cryptographically break the link between signup identity and voting identity
- Even if the admin watches every transaction, the ZK proof reveals nothing about which Phase 1 commitment the voter owns
- The nullifier prevents a voter from joining twice (same private key + same election = same nullifier)

#### What Needs to Be Built
- [ ] New Circom circuit: `AnonJoin.circom` — proves membership in signup group + outputs nullifier + new commitment
- [ ] Contract changes: `signUp()` function (public), `anonJoin()` function (verifies ZK proof, adds new commitment to voting group)
- [ ] Frontend: Two-step flow — "Sign Up" button (Phase 1) → waiting state → "Join Anonymously" button (Phase 2)
- [ ] Separate registration and voting periods (registration closes before voting opens)

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
     |                                    |-- "Sign Up" → relayer submits tx (pays gas)
     |                                    |
     |-- Closes registration              |
     |                                    |
     |                                    |-- "Vote" → browser generates ZK re-key proof (local)
     |                                    |-- Relayer submits anon join + vote tx (pays gas)
     |                                    |-- Voter sees: "Your vote has been cast" ✓
     |
     |-- Tallies results
```

#### Key Components
- **Relayer API:** Thin backend that wraps voter transactions and submits them from a funded wallet. Accepts signed payloads from the frontend.
- **Email-based invite:** Admin enters employee emails. System sends links with embedded invite tokens.
- **No wallet required:** Voter's browser generates ZK identity silently. Relayer pays all gas.
- **Same ZK re-key circuit:** The re-key proof is pure client-side math — works identically whether the voter has a wallet or the relayer submits for them.
- **Authentication:** Invite token (single-use, tied to email) gates Phase 1 signup. Could use OAuth/SSO for enterprise identity verification.

#### Privacy Preservation
- Relayer sees Phase 1 signup (public by design) but cannot link it to Phase 2 anonymous join (ZK proof)
- Email invite tokens are consumed at signup — no link to the anonymous voting commitment
- Enterprise admin has the same privacy boundary as the crypto-native flow: knows who was invited, cannot see who voted for what

#### Open Questions (Revisit Later)
- Relayer trust model: should it be centralized (company-run) or decentralized?
- How to handle relayer censorship (relayer refuses to submit certain transactions)?
- Rate limiting / anti-spam without revealing voter identity
- SSO integration for employee identity verification at signup
- Cost model: who pays for relayer gas? (likely the election creator / company)

### Other Next Up
- [ ] Mobile responsive polish
- [ ] Multi-option voting (beyond Yes/No)
- [ ] On-chain result commitment (publish Poseidon root of tally)
- [ ] Better error messages for common failures
- [ ] Loading skeletons
- [ ] E2E test on Sepolia with multiple voters
- [ ] Mainnet deployment

## Development

### Prerequisites
- Node.js 20+ (via nvm)
- Yarn
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
npx hardhat test
```

### Deploy contracts
```bash
cd apps/contracts
npx hardhat run scripts/deploy-factory-sepolia.ts --network sepolia
```

## Known Issues & Workarounds
- **RPC block range limit:** Public Sepolia RPC rejects getLogs spanning >50k blocks. All queryFilter calls are limited to recent 49k blocks.
- **Election metadata is client-side:** Titles and vote labels are stored in localStorage + URL params, not on-chain. They're cosmetic — the contract only stores a uint256 proposalId.
- **Identity tied to browser:** ZK identity lives in localStorage. Clearing browser data loses it. Backup key available under Advanced section.
- **snarkjs webpack warning:** Expected warning about dynamic require in web-worker — doesn't affect functionality.

## Security Notes
- **Testnet only** — Sepolia deployer private key is in git history. Never use for mainnet.
- **Threat model completed** — 22 findings assessed, 3 real issues fixed (commitment validation, payload privacy, voting deadline).
- **Client-side key management** — Election private keys stored in localStorage. For production, consider hardware wallet or threshold decryption.
- **No formal audit** — This is a proof of concept, not audited production code.

## Developer Context
- Built as a proof of concept for anonymous encrypted voting
- Prioritize clean UX and iterate — protocol is solid, onboarding needs work
- The SDK has more features than the frontend exposes (threshold keys, etc.)
