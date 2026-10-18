# Spectre

Anonymous voting on Base, using zero-knowledge proofs.

> **Research prototype. Unaudited. Don't use it for votes that matter.**
> Spectre is an experiment in private on-chain voting. It hasn't had an external security review. Read [Trust model](#trust-model) and [Known limitations](#known-limitations) before using it.

**Status:** this version (v9) changes how ballots are protected and how signup gates are enforced. Its contracts aren't deployed yet; see [Deploying](#deploying). The earlier deployment listed at the bottom had known privacy problems and isn't supported by this frontend.

## How it works

```
 SIGNUP                    VOTE (anonymous)                 COUNT (after the deadline)
 ┌──────────────┐   ZK    ┌──────────────────┐    ZK      ┌────────────────────────┐
 │ Voter gets   │ ──────> │ New anonymous    │ ─────────> │ Anyone opens the       │
 │ registered   │ re-key  │ identity, not    │ vote proof │ ballots with the drand │
 │ (public)     │  proof  │ linked to signup │ + sealed   │ beacon and recounts    │
 └──────────────┘         └──────────────────┘   ballot   └────────────────────────┘
```

1. **Signup (public), until the signup deadline.** An identity commitment is added to the election's signup group.
   - *Open elections:* anyone signs up, from their own wallet, or through the relay if the organizer chose gasless signup.
   - *Gated elections* (invite codes, allowlist, email domain, GitHub org, token): the contract only accepts registrations from the organizer or the election's **registrar**, which is the Spectre relay. The relay checks the gate, then registers the voter with a one-time key for that credential, so each code, email address, account or wallet registers once.
   - *Admin-only elections:* the organizer registers each voter.
   - Every election has a cap on registrations (`maxVoters`) and on voting weight (`maxWeight`), fixed at creation.
2. **Anonymous join.** Voting opens when signup ends: at the signup deadline (the first join after it opens voting on-chain), or earlier if the organizer ends signup. A ZK proof moves the voter into a separate voting group without revealing which signup they were.
3. **Vote.** A second ZK proof shows the voter is in the voting group and commits to their choice. The ballot is **time-locked with [drand](https://drand.love)** to the first beacon round 30 minutes after the voting deadline. Joins and ballots are always submitted by the relay, never from the voter's wallet. The voter's browser then reads the chain and checks that its ballot landed exactly as sent.
4. **Count.** Once ballots unseal, anyone can fetch that drand round (verified against drand's public key), read every ballot up to one block, check the number found matches the contract's count, open them, check each one against its on-chain commitment, and count each voter's latest valid ballot. The organizer can also record the count on-chain; anyone can check it against a recount.

## Trust model

| Question | Answer | What you're trusting |
|---|---|---|
| Who can vote? | Open: anyone. Gated: only voters the organizer or the relay registers, one per credential, up to the election's voter cap | The relay to apply the gate correctly; the organizer |
| Can my ballot be linked to me? | Not on-chain: the ZK re-key separates signup from vote, and the relay submits joins and ballots. **The relay operator can link them:** it sees your IP address when you sign up (and, in gated elections, your code, email, account or wallet) and when you vote, and ballots are public once they unseal | The relay operator. Voting from a different network than you signed up from (a VPN or Tor) limits this. See also weights and small groups below |
| Can anyone read ballots early? | Nobody holds a decryption key. Ballots open only when drand publishes the round 30 minutes after the deadline | drand's League of Entropy (a threshold network of independent operators) not to release that round early |
| Can the organizer end the vote early? | No. Voting closes at the deadline set at creation. The organizer can end signup early, which only opens voting sooner | — |
| Is my ballot counted? | The relay could drop your ballot, or submit your proof with different contents, which voids that ballot (it can't change your vote). Your browser checks what landed and tells you; a voided ballot doesn't cancel an earlier valid one, and you can vote again | The relay to submit ballots; you to read the check |
| Is the result correct? | Anyone can recount from the on-chain ballots. The recount refuses to run if the RPC returns fewer ballots than the contract recorded, or if the drand beacon doesn't verify | The ballots on-chain and the drand beacon |
| Can I be forced to prove how I voted? | Yes. Spectre is not coercion-resistant | — |

## Known limitations

- **Ballots become public 30 minutes after the deadline.** They're listed by anonymous voter tags, not by who cast them, but anyone can see each tag's final choice. Vote changes by the same voter are linkable to each other.
- **The relay operator can deanonymize voters.** It receives each signup, join and ballot from the voter's IP address, and in gated elections the credential at signup, so once ballots are public it can match people to votes. A random delay between joining and voting hides timing from outside observers, not from the relay. Run the relay yourself or with someone voters trust, and tell voters they can vote over a VPN or Tor.
- **The relay is trusted for eligibility** in gated elections, and its key can register voters up to each election's `maxVoters` (at weights up to `maxWeight`). If that key leaks, the organizer should call `setRegistrar(0)`. Gated elections need a long, stable `GATE_KEY_SECRET`; changing it would let used credentials register again.
- **Voting depends on the relay.** Joins and ballots aren't sent from voters' own wallets, because that would link the wallet to the ballot. The relay could drop ballots, or void them by replacing their contents; each voter's browser checks what landed and asks them to vote again. Binding the ballot's contents into the proof would stop the replacement; that needs a circuit change (see below).
- **The relay pays for every join and ballot.** It pays for signups only in gated elections and in open elections that chose gasless. Someone who registers many identities can still spend its balance; keep it funded modestly and watch it.
- **Not coercion-resistant.** You can change your vote up to five times before the deadline, but a voter can still reveal their own ballot to someone pressuring them.
- **Gates have limits.** Email: `+tag` aliases (and Gmail dots) count as one address, but separate aliases an organization hands out (first.last@ and flast@) count separately. Allowlists are published as unsalted hashes, so anyone who guesses an entry can confirm it, and anyone who knows an entry can use it. Token gates count balances at the block when the election was created; the relay needs an archive RPC (`RELAY_RPC_URL`) to read them.
- **Weighted (token) elections:** weights are visible at signup and in opened ballots, so a voter with an unusual weight can be linked from signup to ballot.
- **Small elections:** with only a few voters, the result itself can reveal how individuals voted.
- **Pending circuit change:** the vote circuit's range checks need tightening, and it should commit to the ballot's contents. Both need a new trusted setup. Until then the tally treats out-of-range ballots as invalid, and voters' browsers catch replaced ballots.
- Rate limits, email verification codes and the relay's nonce tracking live in memory on each serverless instance.
- The circuits and contracts are unaudited. The cryptography (BN254, BLS12-381) isn't post-quantum.
- The TypeScript SDK in `apps/sdk` still targets the earlier ballot format.

## Features

- **Identity delinking:** two Semaphore groups plus the AnonJoin circuit separate signup from voting
- **Time-locked ballots:** drand tlock (quicknet), no election key
- **Public recount:** anyone can count once ballots unseal; the recount checks it has every ballot and a verified beacon; the organizer's on-chain record is checked against it
- **Fixed deadlines:** nobody can close voting early, and voting opens on its own when signup ends
- **Ballot checks:** each voter's browser confirms its ballot landed on-chain unchanged
- **Multi-option voting:** 2–10 options per election
- **Gasless voting:** a relay submits transactions, so voters only need a link
- **Vote changes:** up to 6 submissions; the latest valid one counts
- **Signup gates:** open, invite codes, allowlist, email domain, GitHub org, token/NFT, admin-only, enforced on-chain through a registrar role
- **On-chain metadata:** election titles, options and config stored in contract events

## Tech stack

- **Contracts:** Solidity 0.8.23, Hardhat, for [Base](https://base.org) (L2)
- **ZK proofs:** Circom 2.2.3 (Groth16), snarkjs, with two circuits:
  - AnonJoin (~14K constraints): anonymous identity re-key
  - SpectreVote (~10.5K constraints): vote proof with option and version range checks
- **Identity:** Semaphore V4 (anonymous group membership via Merkle trees)
- **Ballots:** drand time-lock encryption via [tlock-js](https://github.com/drand/tlock-js)
- **Frontend:** Next.js 14, React 18, ethers.js v6, deployed on Vercel

## Project structure

```
spectre-voting/
├── apps/
│   ├── contracts/       # Solidity contracts, Hardhat tests, deploy script
│   ├── circuits/        # Circom ZK circuits (AnonJoin + SpectreVote)
│   ├── sdk/             # TypeScript SDK (earlier ballot format)
│   └── web-app/         # Next.js frontend and relay (deployed to Vercel)
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

The proof tests expect the circuit build files in `apps/circuits/build/` (copy them from `apps/web-app/public/circuits/` if you haven't compiled the circuits).

## Deploying

Deploy the contracts and the frontend together; this frontend doesn't work with the earlier contracts.

1. Deploy PoseidonT3, both verifiers and the factory:
   ```bash
   cd apps/contracts
   npx hardhat run scripts/deploy-factory.ts --network base
   ```
2. Put the factory address and its deploy block in `apps/web-app/src/lib/contracts.ts` (`CONTRACTS.FACTORY`, `FACTORY_DEPLOY_BLOCK`). Until then the app shows a "not configured" notice.
3. Relay environment variables:
   - `RELAYER_PRIVATE_KEY`: the relay's key, funded on Base.
   - `GATE_KEY_SECRET`: required for gated elections. At least 32 random characters, and never change it while any gated election is running. Without it the app won't create gated elections and the relay refuses gated signups.
   - `RELAY_RPC_URL` (recommended): a dedicated Base RPC for the relay. Token-gated elections need an archive node, to read balances at the snapshot block.
   - `EMAIL_HMAC_SECRET` (plus `RESEND_API_KEY`) for the email gate, and `GITHUB_HMAC_SECRET` (plus the GitHub OAuth app settings) for the GitHub gate.

## Earlier deployment (Base mainnet, not supported)

These contracts predate v9. In them the admin holds the ballot key, wallet-mode ballots are linkable to wallets, and signup gates aren't enforced on-chain.

| Contract | Address |
|---|---|
| SpectreVotingFactory | `0x1581c010cC06942ADEEc85baa9a3D19a7e82A21e` |
| SpectreVoteVerifier | `0xD0B778a60E57be0681f660E9c9319274EB10272E` |
| AnonJoinVerifier | `0x753126E842baa748e46384c115e1CF6952c01522` |
| Semaphore V4 | `0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D` |

## Open problems

- A tally that doesn't reveal individual ballots (homomorphic aggregation plus proofs of correct decryption). Today, opened ballots plus the relay's view of IP addresses are what let the relay operator link voters to votes
- Submitting without a single trusted relay: several independent relays, or a network-level privacy layer (OHTTP, Tor) between voters and the relay
- Eligibility checked on-chain (Merkle snapshots, email or SSO proofs) instead of by the relay
- Coercion resistance without a trusted coordinator, which is still an open research problem
- Post-quantum primitives
- External review and audit before any real use

## License

MIT
