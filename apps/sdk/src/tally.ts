import { poseidon2 } from "poseidon-lite"
import { combine, type Share } from "./shamir.js"
import { eciesDecrypt } from "./ecies.js"
import { decodeVotePayload } from "./voter.js"
import { deserializeShare } from "./dealer.js"

/**
 * A submitted vote as read from on-chain events.
 */
export interface SubmittedVote {
    nullifierHash: string
    voteCommitment: string
    encryptedBlob: Uint8Array
}

/**
 * A decrypted, verified vote.
 */
export interface DecryptedVote {
    nullifierHash: string
    vote: bigint
    voteRandomness: bigint
    commitmentValid: boolean
}

/**
 * Final tally result.
 */
export interface TallyResult {
    votesFor: number // vote=1
    votesAgainst: number // vote=0
    totalValid: number
    totalInvalid: number // failed commitment verification
    duplicatesRemoved: number
    decryptedVotes: DecryptedVote[]
}

/**
 * Committee member decrypts their personal share using their private key.
 * This happens on each member's machine — they never expose their private key.
 *
 * @param memberPrivKey — the committee member's personal secp256k1 private key
 * @param encryptedShareData — the ECIES envelope from ElectionSetup.encryptedShares
 */
export function decryptShare(memberPrivKey: Uint8Array, encryptedShareData: Uint8Array): Share {
    const serialized = eciesDecrypt(memberPrivKey, encryptedShareData)
    return deserializeShare(serialized)
}

/**
 * Reconstruct the election private key from t decrypted shares.
 * Returns as a 32-byte Uint8Array (ready for eciesDecrypt).
 *
 * @param shares — at least threshold shares from decryptShare()
 */
export function reconstructElectionKey(shares: Share[]): Uint8Array {
    const secretBigInt = combine(shares)
    const hex = secretBigInt.toString(16).padStart(64, "0")
    const key = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
        key[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return key
}

/**
 * Decrypt a single vote blob and verify its commitment.
 *
 * @param electionPrivKey — reconstructed 32-byte private key
 * @param submitted — on-chain vote data (nullifier, commitment, encrypted blob)
 */
function decryptAndVerifyVote(
    electionPrivKey: Uint8Array,
    submitted: SubmittedVote
): DecryptedVote {
    let payload: { vote: bigint; voteRandomness: bigint }
    try {
        const decrypted = eciesDecrypt(electionPrivKey, submitted.encryptedBlob)
        payload = decodeVotePayload(decrypted)
    } catch {
        // Decryption failed — voter encrypted garbage (self-griefing)
        return {
            nullifierHash: submitted.nullifierHash,
            vote: -1n,
            voteRandomness: 0n,
            commitmentValid: false
        }
    }

    // Verify: Poseidon(vote, randomness) == on-chain voteCommitment
    const recomputed = poseidon2([payload.vote, payload.voteRandomness])
    const commitmentValid = recomputed.toString() === submitted.voteCommitment

    return {
        nullifierHash: submitted.nullifierHash,
        vote: payload.vote,
        voteRandomness: payload.voteRandomness,
        commitmentValid
    }
}

/**
 * Compute the final tally from all submitted votes.
 *
 * 1. Reconstruct election key from shares
 * 2. Decrypt each vote blob
 * 3. Verify each commitment matches on-chain value
 * 4. Deduplicate by nullifier (last submission wins — for future re-voting support)
 * 5. Count votes
 *
 * @param shares — at least threshold decrypted shares
 * @param submittedVotes — all VoteCast events from the contract
 */
export function computeTally(shares: Share[], submittedVotes: SubmittedVote[]): TallyResult {
    // 1. Reconstruct key
    const electionPrivKey = reconstructElectionKey(shares)

    // 2-3. Decrypt and verify all votes
    const decryptedVotes = submittedVotes.map((sv) => decryptAndVerifyVote(electionPrivKey, sv))

    // Zero out the reconstructed key
    electionPrivKey.fill(0)

    // 4. Deduplicate by nullifier (last submission wins)
    const byNullifier = new Map<string, DecryptedVote>()
    let duplicatesRemoved = 0
    for (const dv of decryptedVotes) {
        if (byNullifier.has(dv.nullifierHash)) {
            duplicatesRemoved++
        }
        byNullifier.set(dv.nullifierHash, dv)
    }

    // 5. Count
    const uniqueVotes = Array.from(byNullifier.values())
    let votesFor = 0
    let votesAgainst = 0
    let totalInvalid = 0

    for (const dv of uniqueVotes) {
        if (!dv.commitmentValid) {
            totalInvalid++
        } else if (dv.vote === 1n) {
            votesFor++
        } else if (dv.vote === 0n) {
            votesAgainst++
        } else {
            totalInvalid++ // shouldn't happen — circuit enforces binary
        }
    }

    return {
        votesFor,
        votesAgainst,
        totalValid: votesFor + votesAgainst,
        totalInvalid,
        duplicatesRemoved,
        decryptedVotes: uniqueVotes
    }
}
