# Spectre — Anonymous ZK Voting Protocol

## Project Overview
Spectre is a fully on-chain anonymous voting protocol using zero-knowledge proofs. It combines **ZK re-key anonymous registration** (cryptographic identity delinking between signup and voting) with **end-to-end encrypted ballots** and **multi-option voting** — a combination no other deployed protocol achieves.

Voters sign up publicly (eligibility check), then use a ZK proof to anonymously re-key into a separate voting group. The admin can see who signed up but **cannot link any signup identity to any vote**. Votes are ECIES-encrypted until tally time.

**Live:** https://spectre-voting-web-app.vercel.app
**GitHub:** https://github.com/nexosynths/spectre-voting

## Tech Stack
- **Smart Contracts:** Solidity 0.8.23, Hardhat, deployed on Base mainnet (L2)
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

## Deployed Contracts (Base Mainnet)
- **SpectreVotingFactory:** `0x175Ac98818aF9F752FCb9a3462599e0fD45F37C3`
- **SpectreVoteVerifier:** `0xfCDE99ac31eE5cb3Bd4DD2cD9E0D49f9c8240564`
- **AnonJoinVerifier:** `0xD11fF7e4739736769703f88501c1c4681675676d`
- **Semaphore V4 (official):** `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D`

### Previous Deployment (Sepolia — deprecated)
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
│       │   │   ├── anonJoinProof.ts      # Browser AnonJoin proof generation
│       │   │   ├── relayer.ts            # Gasless relay client (anti-censorship)
│       │   │   └── inviteCodes.ts        # Invite code + allowlist: generation, hashing, validation, CSV export
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

### Done (v7.0 — Invite Codes Signup Gate)
- [x] New `lib/inviteCodes.ts` — code generation (8-char lowercase hex, 4 random bytes), keccak256 hashing, client-side validation, CSV export with per-code share links, localStorage persistence
- [x] Signup gate selector on election creation (now 4-option with v7.1 allowlist added)
- [x] Admin configures code count (2–250) at creation → codes generated, hashes committed on-chain in metadata
- [x] Post-creation codes modal with Copy All + Download CSV + per-code copy buttons
- [x] Relay API (`route.ts`): server-side invite code validation — format check, hash match against on-chain metadata, used-code tracking (in-memory), cold-start rehydration via signup event count, mark-before-submit with rollback on tx failure
- [x] Election metadata cache in relay to avoid re-fetching `ElectionDeployed` events
- [x] Election page: invite code input UI (monospace, centered, hex-filtered, maxLength 8) with real-time client-side validation (green "Code valid" / red error)
- [x] URL auto-fill: `?code=xxx` param auto-populates invite code input
- [x] Admin Manage tab: scrollable code list with per-code "Copy link" buttons (appends `?code=xxx`), Copy All Codes + Download CSV
- [x] Invite-code elections force gasless mode (relay is the only practical signup path)
- [x] Backward compatible: old elections without `gateType` work exactly as before
- [x] No contract changes — all validation at application layer

#### Metadata Format
```json
{
  "gateType": "invite-codes",
  "gaslessEnabled": true,
  "inviteCodes": { "totalCodes": 20, "codeHashes": ["0x4a3b...", "..."] }
}
```

#### Edge Cases
- **Cold start**: Relay rehydrates by counting `VoterSignedUp` events. If signups >= totalCodes, rejects all new codes.
- **Race condition**: `markCodeUsed()` runs synchronously before async tx. Node.js single-threaded event loop prevents interleaving.
- **Tx failure**: Code un-marked in catch block, allowing retry.
- **Direct contract bypass**: Accepted trade-off. Invite-code elections are gasless by default; the relay is the only practical signup path.
- **Admin loses codes**: Only stored in creating browser's localStorage. CSV download encouraged.

#### Files
- `apps/web-app/src/lib/inviteCodes.ts` — Code generation, hashing, validation, CSV, localStorage
- `apps/web-app/src/lib/relayer.ts` — Optional `code` param on `relaySignUp()`
- `apps/web-app/src/app/api/relay/route.ts` — Server-side code validation + metadata cache
- `apps/web-app/src/app/page.tsx` — 3-option gate selector + codes modal
- `apps/web-app/src/app/election/[address]/page.tsx` — Code input UI + admin code viewer

### Done (v7.1 — Allowlist Signup Gate)
- [x] Allowlist functions in `lib/inviteCodes.ts` — `hashIdentifier()`, `hashIdentifiers()`, `validateIdentifier()` (thin wrappers over existing `hashCode`/`validateCode`), `storeAdminAllowlist()`, `getAdminAllowlist()` (scoped localStorage key), `allowlistToCsv()` (URL-encoded `?id=` links)
- [x] 4-option signup gate selector on election creation: Open / Invite Codes / Allowlist / Admin Only
- [x] Admin configures allowlist via textarea (one identifier per line), live count display, deduplication
- [x] Post-creation allowlist modal with Copy All + Download CSV + per-identifier copy buttons
- [x] Relay API (`route.ts`): server-side allowlist validation — normalize + keccak256 hash, match against on-chain metadata, used-identifier tracking (reuses invite code `markCodeUsed`/`isCodeUsed` infrastructure), cold-start rehydration, rollback on tx failure
- [x] `relaySignUp()` extended with optional `identifier` param (alongside existing `code`)
- [x] Election page: allowlist identifier input UI (normal text field, no format restriction) with real-time client-side validation (green "You're on the list" / red "Not on the allowlist")
- [x] URL auto-fill: `?id=xxx` param (URL-decoded) auto-populates identifier input
- [x] Admin Manage tab: scrollable identifier list with per-entry "Copy link" buttons (appends `?id=encodeURIComponent(identifier)`), Copy All Identifiers + Download CSV
- [x] Allowlist elections force gasless mode (same as invite codes)
- [x] Header badge: shows `Allowlist (N)` for allowlist elections
- [x] Backward compatible: existing invite code, open, and admin-only elections unchanged
- [x] No contract changes — all validation at application layer

#### Metadata Format
```json
{
  "gateType": "allowlist",
  "gaslessEnabled": true,
  "allowlist": { "totalEntries": 15, "identifierHashes": ["0xabc...", "0xdef...", "..."] }
}
```

#### Edge Cases
- Same as invite codes: cold-start rehydration, race condition prevention, tx failure rollback, direct contract bypass accepted trade-off
- **No ownership verification**: Same trust model as invite codes — anyone who knows an identifier can use it. Human-readable but not cryptographically bound to the person.
- **Admin loses identifiers**: Only stored in creating browser's localStorage. CSV download encouraged.

#### Files
- `apps/web-app/src/lib/inviteCodes.ts` — Allowlist hashing, validation, CSV, localStorage (extends invite code module)
- `apps/web-app/src/lib/relayer.ts` — Optional `identifier` param on `relaySignUp()`
- `apps/web-app/src/app/api/relay/route.ts` — Server-side allowlist validation (parallel to invite code block)
- `apps/web-app/src/app/page.tsx` — 4-option gate selector + allowlist textarea + modal
- `apps/web-app/src/app/election/[address]/page.tsx` — Identifier input UI + admin allowlist viewer

### Done (v6 — Proof-Only Relayer / Gasless Voting)

- [x] API route: `/api/relay` — server-side tx submission, rate limiting, pre-checks
- [x] Client module: `lib/relayer.ts` — relay calls, tx polling, anti-censorship verification
- [x] Gasless voting path on election page (relay signup → anonJoin → castVote)
- [x] Per-election voter access toggle: "Wallet required" vs "Gasless" at election creation
- [x] Anonymous identity for walletless voters (UUID-scoped in localStorage)
- [x] Anti-censorship: client independently verifies VoteCast event on-chain via public RPC
- [x] IP-timing decorrelation: random delay between anonJoin and castVote in production
- [x] Relayer wallet: `0x38044De3F50dEf9BfBa7c1e98C449E271421E726` (Base mainnet, funded)

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

### Next Up — v7: Modular Signup Gates (continued)

Invite codes (v7.0) and allowlist (v7.1) shipped. The contract doesn't change — all gates control who can call `signUp()`. The ZK voting protocol downstream is identical regardless of which gate is used.

#### Remaining Gate Types

**1. Email Domain Gate (v7.2 — NEXT)**
- Prove you have an @company.com email (verification code sent to email)
- Rule is public and algorithmic — admin sets the domain, not individual people
- Requires email sending service (SendGrid, Resend, etc.)
- **Tradeoff:** Trust the email provider. Email provider sees who verified.

**2. OAuth Group Gate (v7.3)**
- Must be in a Google Workspace org, GitHub team, or Slack channel
- Each provider is its own integration (different OAuth APIs)
- Rule is algorithmic — "members of this org" not "these specific people"
- **Tradeoff:** Trust the identity provider. IdP logs + election metadata = potential deanonymization.

**3. Token/NFT Gate (v7.4)**
- Must hold specific ERC-20 balance or NFT
- On-chain check only — no external dependencies
- Wallet infrastructure already exists
- **Tradeoff:** Requires voter to have a wallet (doesn't work with gasless)

**4. ZK Credential Proofs (v7.5 — long-term)**
- Voter proves eligibility via ZK proof of an external credential (Zupass, ZK Passport, EAS attestation)
- No identity provider sees the voter authenticated — fully private eligibility
- **Tradeoff:** Requires credential infrastructure to exist and be adopted. Emerging tech.

#### Threat Model — Eligibility

Every gate answers: "who can vote?" Every gate requires trusting *something*:
| Gate | Trust Assumption | Sybil Resistance | Wallet Needed |
|------|------------------|-------------------|---------------|
| Open | None — anyone can join | None | No (gasless) |
| Invite codes | Admin distributes fairly | Strong (1 code = 1 vote) | No (gasless) |
| Allowlist | Admin list is accurate | Strong | No (gasless) |
| Email domain | Email provider honest | Medium (shared accounts) | No (gasless) |
| OAuth group | Identity provider honest | Strong | No (gasless) |
| Token gate | Token distribution fair | Medium (tokens can be bought) | Yes |
| ZK credentials | Credential issuer honest | Strong | No (gasless) |

**No system exists where eligibility is both fully trustless AND sybil-resistant.** The admin/gate just decides which trust assumption fits the context.

#### Architecture

The election creation form becomes a decision tree:
- Admin picks gate type → configures parameters → creates election
- Election metadata stores gate config (type, parameters)
- Signup page renders the right UI based on gate type (code input, email input, OAuth button, etc.)
- Gate validation happens server-side (API route) or on-chain (token gate)
- On successful validation → identity commitment registered in signup group (same as today)

### Next Up — Identity & Security

**1. Seed Backup Prompt (v8.0 — NEXT)**
- After signup, prompt voter to save their seed phrase (like wallet creation flows)
- Show seed, require confirmation (re-enter or checkbox "I saved this")
- Without the seed, voter loses their identity if browser data is cleared
- Currently seeds are silently saved to localStorage with no user awareness

**2. Seed Import / Recovery (v8.1)**
- Allow voter to input an existing seed to recover their identity
- "I have a seed" option on the election page alongside signup
- Enables voting from a different browser/device

**3. Hardware Wallet / Custom Seed (v8.2)**
- Connect hardware wallet (Ledger, Trezor) to derive identity deterministically
- Or input a custom seed for advanced users
- Hardware-grade security for high-stakes elections

### Next Up — Business Infrastructure

**1. Relay Admin Actions (v9.0)**
- Relay closeSignup, closeVoting, commitTallyResult so admins don't need wallets either
- Admin experience becomes fully wallet-free
- Prerequisite for Stripe payments (admin can't have a wallet requirement)

**2. Email Auth + Stripe Payments (v9.1)**
- Email signup for admins (Supabase/NextAuth)
- Stripe checkout: admin pays per election ($2-5)
- No crypto needed for anyone — blockchain invisible
- This is when Spectre becomes a real business

**3. Free Tier + Paid Tiers (v9.2)**
- Free: 1 election, 10 voters (demos)
- Paid: per-election or $29/mo unlimited
- Enterprise: white-label, custom domain, API access

### Later — Signup Gates (continued)

**Email Domain Gate (v7.2)**
- Prove you have an @company.com email (verification code sent to email)
- Requires email sending service (SendGrid, Resend, etc.)

**OAuth Group Gate (v7.3)**
- Must be in a Google Workspace org, GitHub team, or Slack channel

**Token/NFT Gate (v7.4)**
- Must hold specific ERC-20 balance or NFT — on-chain check only

**ZK Credential Proofs (v7.5 — long-term)**
- ZK proof of external credential (Zupass, ZK Passport, EAS attestation)

---

### Long Term — Platform Evolution

Spectre evolves from a ZK voting protocol into a **private verifiable action protocol**. Voting is the flagship use case, but the same ZK primitives support any application where users prove a credential and perform an action without revealing identity.

#### Core ZK Primitives

The protocol is built on four reusable cryptographic operations:

1. **Set membership** — Merkle tree inclusion proof. User proves their credential key exists as a leaf in a tree of eligible participants without revealing which leaf.
2. **Action binding** — ZK circuit binds the membership proof to a specific payload (vote choice, report content hash, endorsement metadata). Proof and action cannot be separated.
3. **Nullifier generation** — Deterministic nullifier from `hash(private_key + scope_id)`. Prevents double-actions within a scope without revealing identity. Scope can be a proposal ID, report hash, market epoch, etc.
4. **Coercion resistance** — Decoy proof generation. Produces valid-looking but invalid proofs indistinguishable from real proofs. Critical for whistleblowing and high-stakes voting.

#### 90-Day Build Priorities

1. **Homepage UX cleanup** — Simplify the current voting app interface
2. **Core engine extraction** — Refactor voting-specific circuit logic into parametric modules. Separate credential engine, action circuit, nullifier engine from the voting application layer
3. **Intent API** — Thin wrapper over core engine. Current UI should call this API instead of circuits directly
4. **Spectre Report MVP** — Anonymous enterprise whistleblowing product:
   - One OAuth credential bridge (Okta or Google Workspace)
   - Web-based report submission with client-side proof generation (WASM)
   - Simple relayer for on-chain submission (Paymaster-funded, gasless)
   - Anonymous mailbox for follow-up (nullifier-derived mailbox IDs)
   - Minimal admin interface for aggregate statistics

#### Core Architecture: Modular Separation

Four independent layers:

1. **Infrastructure Layer** — EVM settlement (Ethereum L1, Base L2), off-chain storage (IPFS/Arweave), sealed-sender relays, credential registry bridges (oracles to external identity sources)
2. **Core Engine** — Reusable ZK primitives:
   - Credential Engine — Merkle tree construction, set membership proofs, key management. Static snapshots (DAO governance) + dynamic accumulators (employee directories). 100% reusable
   - Action Circuit — Parametric ZK circuit binding proof-of-membership to arbitrary payload with configurable nullifier logic. ~90% reusable
   - Nullifier Engine — Deterministic nullifier generation from private key + scope identifier. ~95% reusable
   - Coercion Resistance Layer — Decoy proof generation (valid-looking but invalid proofs under duress). 100% reusable
3. **Intent & Agent Layer** — Programmatic interface for AI agents and developers:
   - Intent API — REST/gRPC translating `{ scope, action, credential }` into full ZK action flows (proof + submission). Single integration point for web, mobile, agents, CLI
   - Delegated Auth — EIP-712 typed intent signatures. User pre-signs specific action; agent can only submit that exact action
   - x402 Payment Bridge — Proof computation costs and gas fees via Coinbase x402 machine-to-machine payment protocol
4. **Application Layer** — Each use case is a parameter config on the shared core:
   - Governance Voting (live) — Vote choice payload, one-vote-per-proposal nullifier, on-chain submission, static credential tree
   - Anonymous Whistleblowing (proposed) — Content hash payload, per-report-hash nullifier, sealed-sender encrypted delivery, dynamic credential tree with revocation, anonymous mailbox
   - Private Reputation (proposed) — Endorsement metadata payload, per-endorser-per-recipient nullifier, on-chain verifiable credential, threshold aggregation proofs
   - Private Predictions (proposed) — Position commitment payload, per-market-per-epoch nullifier, delayed reveal, MEV resistance
   - Healthcare Credentialing (concept) — Credential attestation payload, optional nullifier, verifiable presentation, dynamic tree for license renewals

#### Credential Vault

**Problem:** Wallet-based identity links all user actions on-chain. Same address voting in a DAO and submitting a whistleblower report = trivially correlated.

**Solution:** Local-first encrypted keystore with BIP-32 master key deriving child keys per bridge (`m/spectre'/bridge_id'/credential_index'`). Each credential is independent — activities across applications produce cryptographically unlinkable nullifiers. Nothing stored on server or on-chain.

**Credential Bridges** (translate real-world identity into ZK-compatible credential key):
- Token-Gated Bridge (live) — ERC-20/721/1155 balances at snapshot block → Merkle tree of qualifying addresses
- OAuth/SAML Bridge (building next) — Corporate SSO (Okta, Azure AD, Google Workspace) → one-way credential key derivation → Merkle leaf added → mapping discarded. Bridge runs in TEE
- Professional Registry Bridge (concept) — Oracle queries medical boards, bar associations, engineering boards → proves active license without revealing name/number
- Civic Identity Bridge (concept) — Government ID systems (digital ID, passport NFC) → attests citizenship, residency, age bracket
- Attestation Aggregator (proposed) — On-chain history + off-chain attestations (EAS, Verax, Gitcoin Passport) → composite reputation credentials

#### ERC-4337 Smart Contract Wallet Integration

Credential logic as ERC-4337 smart account modules (via ERC-7579). Wallet validation checks credential proofs before operations reach chain. Invalid ops rejected without spending gas.

**Four ERC-7579 Modules:**
1. **Validator (Type 1)** — Runs during UserOp validation: parse operation type → extract ZK proof → verify Groth16 on-chain → check Merkle root freshness → check nullifier uniqueness → check session key constraints. Reject before execution if any check fails
2. **Executor (Type 2)** — Automated rules ("auto-vote NO if I haven't voted by quorum"), cross-protocol credential queries, agent batch actions. Only pre-authorized actions
3. **Hook (Type 4)** — Pre/post checks: signer tier requirements (DAO voting → passkey, employer credential → hardware wallet), cross-scope rate limiting, credential usage logging, emergency freeze, cross-credential isolation
4. **Fallback Handler (Type 3)** — External discovery: which credentials installed, eligibility for scopes, supported modules

**Session Keys:** User grants agent a scoped session key ("vote on my behalf in scope X, credential Y, for Z hours, up to N actions"). Agent signs UserOps autonomously within bounds. One delegation per session instead of one signature per action.

**Paymaster:** Spectre-operated Paymaster sponsors gas for credential actions. Users never need ETH. Scope operators fund their channel's Paymaster. Costs settle in USDC via x402.

**Wallet Frontend:** Rabby (supports smart contract wallets, hardware pairing, 122+ EVM chains).

#### AI Agent Integration

1. User provides natural language intent ("vote yes on proposal #47")
2. Agent resolves scope, checks eligibility via Intent API
3. Agent constructs EIP-712 intent → user's wallet for one signature (or session key)
4. Agent generates ZK proof (proving service or locally)
5. Agent submits UserOp through 4337 bundler
6. Smart wallet Validator/Hook modules enforce all credential rules on-chain

**Trust boundary:** Agent never holds credential keys or master key. Vault retrieves correct key internally, signs intent, returns signed intent. Compromised agent can only submit specific user-approved actions.

#### Economic Model

**Cost per action (Base L2):** $0.01–$0.05 all-in (Groth16 verification <$0.01, proof generation $0.001–$0.01, Merkle root update <$0.01, bundler fee 5–15% of gas).

**Revenue:** Credential issuance fees ($1–5/attestation), proof service fees (x402), premium application modules, Paymaster margins.

**Token strategy:** Launch without native token. Pay operators in USDC via x402. Introduce token only when decentralized governance/proving needed and real economic activity justifies it.

#### Build Phases

1. **Core Engine Extraction + Intent API (4-6 weeks)** — Refactor voting circuits into parametric modules, build Intent API wrapper, decouple frontend from cryptographic layer
2. **Agent Integration Layer (3-4 weeks)** — EIP-712 intent signing, delegated proof generation, meta-transaction relay, Coinbase AgentKit integration, session keys
3. **Credential Bridge Expansion (4-6 weeks)** — OAuth/SAML bridge, dynamic Merkle tree management (join/leave), credential vault mobile app with secure enclave
4. **ERC-4337 Module Development (6-8 weeks)** — ERC-7579 modules (Validator, Executor, Hook, Fallback), target Safe + ZeroDev, Paymaster on Base L2, session key infra
5. **Anonymous Communication Layer (3-5 weeks)** — Sealed-sender relay, anonymous mailboxes (nullifier-derived IDs), multi-message session continuity for whistleblowing
6. **Additional Application Modules (2-3 weeks each)** — Private reputation, prediction markets, healthcare credentialing

#### Enterprise & Web2 Abstraction Layer

The enterprise abstraction layer sits on top of the protocol and presents Spectre as a **compliance, governance, and credentialing platform**. Blockchain is the trust infrastructure underneath (like Stripe uses banking rails) — buyer and user never interact with it directly.

**Core enterprise value props** (no blockchain understanding required):
- **Zero-knowledge anonymity** — No stored identity mappings anywhere. Mathematically impossible to reconstruct, not just policy-protected
- **Tamper-proof audit trail** — Immutable ledger. Organization cannot retroactively alter records
- **Mathematically guaranteed ballot secrecy** — Enforced by cryptographic proof, not access controls
- **Coercion resistance** — Decoy proofs under duress. No competitor offers this

**Abstraction mapping:**
- Credential Bridge → SSO Integration ("Connect Identity Provider" settings page)
- Credential Vault → Mobile App / Browser Session (SSO login, no seed phrases or wallets shown)
- ZK Proof Generation → "Securing your submission..." loading indicator
- Blockchain Submission → Invisible backend (relayer submits via Paymaster, user sees "Report submitted successfully")
- Smart Contract Verification → Compliance Dashboard (aggregate stats, audit trail)
- Anonymous Mailbox → Secure Messaging Inbox (in-app encrypted messaging)

**Three Enterprise Product Lines** (same Spectre protocol, different buyers):

1. **Spectre Report — Anonymous Compliance Reporting**
   - Target: CCO, General Counsel, VP Ethics & Compliance
   - Competes with: NAVEX Global (EthicsPoint), OneTrust Ethics, SAI Global
   - Differentiator: Anonymity is mathematically guaranteed, not policy-based. Even Spectre can't identify reporters
   - Features: SSO integration, ZK-verified org membership, encrypted anonymous mailbox, coercion resistance, tamper-proof ledger
   - Compliance: EU Whistleblower Directive (2019/1937), SOX Section 301, Dodd-Frank, SEC Rule 21F
   - Pricing: $5/employee/year, $10K minimum (annual license, tiered by employee count)

2. **Spectre Govern — Private Governance Voting**
   - Target: Corporate Secretary, Board Chair, Association/Union/Cooperative leadership
   - Competes with: Diligent (Insights), Broadridge, Simply Voting, ElectionBuddy, Lumi
   - Differentiator: Ballot secrecy mathematically enforced. One-person-one-vote without identity exposure
   - Features: Private ballot casting, nullifier-based 1p1v, real-time quorum tracking, configurable rules (majority/supermajority/ranked choice), proxy + weighted voting, board portal integration
   - Use cases: Corporate boards, unions, cooperatives, professional associations, HOAs, non-profits
   - Pricing: $500–$5K per election (one-off) or $10K–$50K/year (recurring governance)

3. **Spectre Verify — Private Credential Verification**
   - Target: Credentialing Officer (hospitals), HR Director, Compliance Manager, Licensing Board
   - Competes with: Verity, CredentialMyDoc, NPDB, Equifax Workforce Solutions
   - Differentiator: Selective disclosure — prove "board-certified orthopedic surgeon in NY" without revealing name, license number, or any other credential
   - Features: Selective credential disclosure, professional registry integration, real-time status verification, bias-free hiring, anonymous peer review, expiration tracking
   - Use cases: Healthcare credentialing, legal qualification, financial services compliance, anonymous peer review, security clearance verification
   - Pricing: $2–$10 per verification or annual org subscription

**Go-to-Market:**
- Crypto-native (DAOs, DeFi): Lead with protocol architecture, ZK voting, wallet integration, on-chain verification
- Enterprise compliance/governance: Never lead with blockchain. Lead with compliance/security story. "Blockchain" only appears in technical architecture docs for security team due diligence, framed as "tamper-proof immutable infrastructure layer"
- Healthcare/legal/professional: Lead with credential verification and privacy story

**Regulatory posture:**
- GDPR: Inherently friendly — no PII processed/stored. On-chain data is only cryptographic proofs and nullifiers
- Data residency: ZK proofs generated client-side. Public blockchain not subject to data residency for non-PII
- SOC 2 / ISO 27001: Required for Spectre-operated infrastructure (relayers, dashboards). On-chain components independently verifiable

**Enterprise build priority:**
1. Admin Dashboard + SSO Bridge — minimum viable enterprise product
2. White-Label Mobile App — primary end-user interface
3. Relayer Service + Paymaster — gasless, invisible blockchain submission
4. Compliance Reporting Module — required for regulated industry sales
5. API Gateway — enables Spectre Verify and third-party integrations

**Revenue potential:** Global ethics/compliance market ~$60B (12–15% growth), whistleblower reporting ~$3B, corporate governance ~$4B, credential verification ~$15B. ZK architecture is a genuine technical moat — competitors cannot retrofit mathematical anonymity onto database-backed systems.

#### Key Design Principles

- **Parametric, not monolithic** — Core circuits are shared templates. New use case = new parameter set, not rewriting cryptography
- **Unlinkable by default** — Different bridges produce cryptographically independent nullifiers. Only the user can link their own credentials
- **Agent-abstracted** — Smart contracts and ZK circuits identical whether proof came from browser UI or AI agent
- **Progressive security** — Mobile secure enclave → optional hardware wallet → smart wallet enforces signer tiers on-chain
- **Invisible infrastructure** — Users never need to understand Merkle trees, ZK circuits, or gas fees. Long-term UX: tell your agent what to do, approve once, done

### Done — Infrastructure
- [x] **Base mainnet deployment** — ~$0.001/tx, 2s blocks, production-ready

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
npx hardhat test  # 63 tests, ~11s
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
- **Identity scoping** — Identities are scoped per-election (election address + wallet/anonymous ID) to prevent cross-election participation tracking. Voting identities are also per-election.

## Developer Context
- Built as a proof of concept for anonymous encrypted voting with ZK re-key identity delinking
- Closest existing protocols: MACI v3 (anonymous poll joining, unaudited) and aMACI (DoraHacks, optional re-key)
- Core protocol, gasless relay, invite codes, and allowlist signup gates complete; next priority is remaining modular signup gates (email domain, OAuth, token gate)
- Prioritize clean UX and iterate — the cryptographic foundation is solid
- Relayer wallet: `0x38044De3F50dEf9BfBa7c1e98C449E271421E726` (Base mainnet, `RELAYER_PRIVATE_KEY` env var on Vercel)
