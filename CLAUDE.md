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

### Next Up
- [ ] Mobile responsive polish
- [ ] Gas relayer (voters don't need ETH)
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
