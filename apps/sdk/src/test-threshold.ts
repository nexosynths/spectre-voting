/**
 * Phase 2 test: threshold key management + tally
 *
 * Full flow:
 *   1. Dealer sets up election with 5-of-7 committee
 *   2. Voters cast encrypted votes
 *   3. 5 committee members decrypt their shares
 *   4. Reconstruct key, decrypt all votes, verify commitments, tally
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { Identity, Group } from "@semaphore-protocol/core"
import { poseidon2 } from "poseidon-lite"
import { split, combine } from "./shamir.js"
import { setupElection, type CommitteeMember } from "./dealer.js"
import { decryptShare, computeTally, type SubmittedVote } from "./tally.js"
import { prepareVote } from "./voter.js"
import { eciesDecrypt } from "./ecies.js"

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
    if (condition) {
        console.log(`  ✓ ${msg}`)
        passed++
    } else {
        console.log(`  ✗ ${msg}`)
        failed++
    }
}

async function main() {
    console.log("=== Phase 2: Threshold Key Management + Tally ===\n")

    // --- Test 1: Shamir split/combine ---
    console.log("1. Shamir secret sharing")
    {
        const secret = 123456789012345678901234567890n
        const shares = split(secret, 7, 5)

        assert(shares.length === 7, "Split into 7 shares")

        // Reconstruct with exactly 5 shares
        const recovered = combine(shares.slice(0, 5))
        assert(recovered === secret, "5-of-7 reconstruction works")

        // Reconstruct with different 5 shares
        const recovered2 = combine([shares[0], shares[2], shares[3], shares[5], shares[6]])
        assert(recovered2 === secret, "Different 5 shares also reconstruct correctly")

        // Reconstruct with all 7
        const recovered3 = combine(shares)
        assert(recovered3 === secret, "7-of-7 also works")
    }

    // --- Test 2: Election setup with dealer ---
    console.log("\n2. Election setup (dealer)")
    {
        // Create 7 committee members with personal keypairs
        const committeeKeys = Array.from({ length: 7 }, (_, i) => {
            const priv = secp256k1.utils.randomPrivateKey()
            const pub = secp256k1.getPublicKey(priv)
            return { priv, pub }
        })

        const committee: CommitteeMember[] = committeeKeys.map((k, i) => ({
            id: `member-${i}`,
            publicKey: k.pub
        }))

        const election = setupElection(committee, 5)

        assert(election.electionPubKey.length === 33, "Election public key is 33 bytes (compressed)")
        assert(election.encryptedShares.length === 7, "7 encrypted shares generated")
        assert(election.threshold === 5, "Threshold is 5")

        // Each member decrypts their share
        const decryptedShares = committeeKeys.map((k, i) =>
            decryptShare(k.priv, election.encryptedShares[i].encryptedData)
        )

        assert(decryptedShares.length === 7, "All 7 shares decrypted")
        assert(decryptedShares[0].x === 1n, "First share has x=1")
        assert(decryptedShares[6].x === 7n, "Last share has x=7")

        // Reconstruct with 5 shares and verify it matches election public key
        const { reconstructElectionKey } = await import("./tally.js")
        const reconstructedKey = reconstructElectionKey(decryptedShares.slice(0, 5))
        const reconstructedPub = secp256k1.getPublicKey(reconstructedKey)

        assert(
            election.electionPubKey.every((b, i) => b === reconstructedPub[i]),
            "Reconstructed key matches election public key"
        )
    }

    // --- Test 3: Full threshold election + tally ---
    console.log("\n3. Full election flow with threshold tally")
    {
        const PROPOSAL_ID = 99n

        // Committee setup
        const committeeKeys = Array.from({ length: 7 }, () => {
            const priv = secp256k1.utils.randomPrivateKey()
            return { priv, pub: secp256k1.getPublicKey(priv) }
        })
        const committee: CommitteeMember[] = committeeKeys.map((k, i) => ({
            id: `member-${i}`,
            publicKey: k.pub
        }))

        const election = setupElection(committee, 5)

        // Create voters
        const voters = [
            new Identity("voter-A"),
            new Identity("voter-B"),
            new Identity("voter-C"),
            new Identity("voter-D"),
            new Identity("voter-E")
        ]
        const group = new Group()
        voters.forEach((v) => group.addMember(v.commitment))

        // Cast votes: 3 YES (1), 2 NO (0)
        const votes: { identity: Identity; choice: bigint }[] = [
            { identity: voters[0], choice: 1n },
            { identity: voters[1], choice: 0n },
            { identity: voters[2], choice: 1n },
            { identity: voters[3], choice: 0n },
            { identity: voters[4], choice: 1n }
        ]

        const submittedVotes: SubmittedVote[] = []
        for (const v of votes) {
            const prepared = await prepareVote(
                v.identity,
                group,
                PROPOSAL_ID,
                v.choice,
                election.electionPubKey,
                2n // binary: 2 options
            )
            submittedVotes.push({
                baseNullifier: prepared.proof.baseNullifier,
                versionedNullifier: prepared.proof.versionedNullifier,
                voteCommitment: prepared.proof.voteCommitment,
                encryptedBlob: prepared.encryptedBlob
            })
        }

        assert(submittedVotes.length === 5, "5 votes submitted")

        // Committee: 5 of 7 members decrypt their shares
        const shares = committeeKeys.slice(0, 5).map((k, i) =>
            decryptShare(k.priv, election.encryptedShares[i].encryptedData)
        )

        // Compute tally (binary = 2 options)
        const tally = computeTally(shares, submittedVotes, 2)

        assert(tally.optionCounts[0] === 2, "2 votes for option 0 (NO)")
        assert(tally.optionCounts[1] === 3, "3 votes for option 1 (YES)")
        assert(tally.totalValid === 5, "5 total valid votes")
        assert(tally.totalInvalid === 0, "0 invalid votes")
        assert(tally.duplicatesRemoved === 0, "0 duplicates")

        // Verify all commitments were valid
        const allValid = tally.decryptedVotes.every((dv) => dv.commitmentValid)
        assert(allValid, "All vote commitments verified correctly")
    }

    // --- Test 4: Threshold failure ---
    console.log("\n4. Edge cases")
    {
        // 4 of 5 threshold should fail to reconstruct correctly
        const secret = secp256k1.utils.randomPrivateKey()
        let secretBigInt = 0n
        for (const b of secret) secretBigInt = (secretBigInt << 8n) | BigInt(b)

        const shares = split(secretBigInt, 7, 5)

        // Only 4 shares — reconstruction gives wrong value
        const wrongSecret = combine(shares.slice(0, 4))
        assert(wrongSecret !== secretBigInt, "4-of-5 gives wrong secret (insufficient shares)")

        // 5 shares — correct
        const rightSecret = combine(shares.slice(0, 5))
        assert(rightSecret === secretBigInt, "5-of-5 gives correct secret")
    }

    // --- Test 5: Multi-option tally (4 options) ---
    console.log("\n5. Multi-option tally (4 options)")
    {
        const PROPOSAL_ID = 200n
        const NUM_OPTIONS = 4

        // Committee setup (3-of-5)
        const committeeKeys = Array.from({ length: 5 }, () => {
            const priv = secp256k1.utils.randomPrivateKey()
            return { priv, pub: secp256k1.getPublicKey(priv) }
        })
        const committee: CommitteeMember[] = committeeKeys.map((k, i) => ({
            id: `member-${i}`,
            publicKey: k.pub
        }))

        const election = setupElection(committee, 3)

        // Create 6 voters
        const voters = Array.from({ length: 6 }, (_, i) => new Identity(`multi-voter-${i}`))
        const group = new Group()
        voters.forEach((v) => group.addMember(v.commitment))

        // Cast votes across 4 options: [2 votes opt0, 1 vote opt1, 2 votes opt2, 1 vote opt3]
        const voteChoices: bigint[] = [0n, 0n, 1n, 2n, 2n, 3n]
        const submittedVotes: SubmittedVote[] = []

        for (let i = 0; i < voters.length; i++) {
            const prepared = await prepareVote(
                voters[i],
                group,
                PROPOSAL_ID,
                voteChoices[i],
                election.electionPubKey,
                BigInt(NUM_OPTIONS)
            )
            submittedVotes.push({
                baseNullifier: prepared.proof.baseNullifier,
                versionedNullifier: prepared.proof.versionedNullifier,
                voteCommitment: prepared.proof.voteCommitment,
                encryptedBlob: prepared.encryptedBlob
            })
        }

        assert(submittedVotes.length === 6, "6 votes submitted")

        // 3 of 5 members decrypt their shares
        const shares = committeeKeys.slice(0, 3).map((k, i) =>
            decryptShare(k.priv, election.encryptedShares[i].encryptedData)
        )

        // Compute tally with 4 options
        const tally = computeTally(shares, submittedVotes, NUM_OPTIONS)

        assert(tally.optionCounts.length === 4, "4 option counts")
        assert(tally.optionCounts[0] === 2, "Option 0: 2 votes")
        assert(tally.optionCounts[1] === 1, "Option 1: 1 vote")
        assert(tally.optionCounts[2] === 2, "Option 2: 2 votes")
        assert(tally.optionCounts[3] === 1, "Option 3: 1 vote")
        assert(tally.totalValid === 6, "6 total valid votes")
        assert(tally.totalInvalid === 0, "0 invalid votes")
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===`)
    if (failed > 0) process.exit(1)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
