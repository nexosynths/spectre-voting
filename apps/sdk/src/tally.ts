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
 * Final tally result (multi-option).
 */
export interface TallyResult {
    optionCounts: number[] // count per option index (e.g., [3, 2, 1] for 3 options)
    totalValid: number
    totalInvalid: number // failed commitment verification or out-of-range vote
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
 * 5. Count votes per option
 *
 * @param shares — at least threshold decrypted shares
 * @param submittedVotes — all VoteCast events from the contract
 * @param numOptions — number of valid vote options (e.g., 2 for Yes/No, 4 for multi-choice)
 */
export function computeTally(shares: Share[], submittedVotes: SubmittedVote[], numOptions: number = 2): TallyResult {
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

    // 5. Count per option
    const uniqueVotes = Array.from(byNullifier.values())
    const optionCounts = new Array(numOptions).fill(0)
    let totalInvalid = 0

    for (const dv of uniqueVotes) {
        if (!dv.commitmentValid || dv.vote < 0n || Number(dv.vote) >= numOptions) {
            totalInvalid++
        } else {
            optionCounts[Number(dv.vote)]++
        }
    }

    const totalValid = optionCounts.reduce((a: number, b: number) => a + b, 0)

    return {
        optionCounts,
        totalValid,
        totalInvalid,
        duplicatesRemoved,
        decryptedVotes: uniqueVotes
    }
}

/**
 * Compute the Poseidon commitment for a tally result.
 *
 * Hash chain: h = poseidon2(totalValid, totalInvalid)
 *             for each count in optionCounts: h = poseidon2(h, count)
 *
 * This matches the algorithm the contract expects. Anyone can verify
 * by reading the raw results from the contract and recomputing this hash.
 */
export function computeTallyCommitment(
    optionCounts: number[],
    totalValid: number,
    totalInvalid: number
): bigint {
    let hash = poseidon2([BigInt(totalValid), BigInt(totalInvalid)])
    for (const count of optionCounts) {
        hash = poseidon2([hash, BigInt(count)])
    }
    return hash
}

/**
 * Verify an on-chain tally commitment by recomputing the Poseidon hash.
 * Returns true if the recomputed hash matches the stored commitment.
 */
export function verifyTallyCommitment(
    optionCounts: number[],
    totalValid: number,
    totalInvalid: number,
    expectedCommitment: bigint
): boolean {
    return computeTallyCommitment(optionCounts, totalValid, totalInvalid) === expectedCommitment
}
