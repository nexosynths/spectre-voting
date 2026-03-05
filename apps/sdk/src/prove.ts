import { Identity, Group } from "@semaphore-protocol/core"
import { poseidon2, poseidon3 } from "poseidon-lite"
// @ts-ignore — snarkjs has no types
import { groth16 } from "snarkjs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MAX_DEPTH = 20

// Default artifact paths (relative to SDK src/)
const DEFAULT_WASM = path.resolve(__dirname, "../../circuits/build/SpectreVote_js/SpectreVote.wasm")
const DEFAULT_ZKEY = path.resolve(__dirname, "../../circuits/build/SpectreVote.zkey")

export interface SpectreProof {
    pA: [string, string]
    pB: [[string, string], [string, string]]
    pC: [string, string]
    merkleRoot: string
    baseNullifier: string
    versionedNullifier: string
    voteCommitment: string
    proposalId: string
    numOptions: string
}

export interface ProofArtifacts {
    wasmPath: string
    zkeyPath: string
}

/**
 * Compute the vote commitment: Poseidon(vote, weight, randomness)
 */
export function computeVoteCommitment(vote: bigint, weight: bigint, randomness: bigint): bigint {
    return poseidon3([vote, weight, randomness])
}

/**
 * Compute the base nullifier: Poseidon(proposalId, secretScalar)
 * Deterministic per voter per election. Used for tally deduplication.
 */
export function computeBaseNullifier(proposalId: bigint, secretScalar: bigint): bigint {
    return poseidon2([proposalId, secretScalar])
}

/**
 * Compute a versioned nullifier: Poseidon(proposalId, secretScalar, version)
 * Unique per voter per election per version. Used on-chain for replay prevention.
 */
export function computeVersionedNullifier(proposalId: bigint, secretScalar: bigint, version: bigint): bigint {
    return poseidon3([proposalId, secretScalar, version])
}

/** @deprecated Use computeBaseNullifier instead */
export const computeNullifier = computeBaseNullifier

/**
 * Generate a SpectreVote ZK proof.
 *
 * Proves: identity membership + valid vote commitment + correct nullifier
 *
 * @param identity — Semaphore Identity (wraps secret key)
 * @param group — Semaphore Group (local mirror of on-chain Merkle tree)
 * @param proposalId — election/proposal identifier
 * @param vote — vote option index (0 to numOptions-1)
 * @param voteRandomness — blinding factor for vote commitment
 * @param numOptions — total number of vote options (default 2 for backwards compat)
 * @param weight — voting weight (default 1 for non-weighted elections)
 * @param version — vote version for overwriting (0 = first vote, max 5)
 * @param artifacts — optional custom paths to wasm/zkey
 */
export async function generateSpectreProof(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint,
    numOptions: bigint = 2n,
    weight: bigint = 1n,
    version: bigint = 0n,
    artifacts?: Partial<ProofArtifacts>
): Promise<SpectreProof> {
    if (vote < 0n || vote >= numOptions) {
        throw new Error(`Vote must be in range [0, ${numOptions})`)
    }
    if (version < 0n || version > 5n) {
        throw new Error(`Version must be in range [0, 5]`)
    }

    const wasmPath = artifacts?.wasmPath ?? DEFAULT_WASM
    const zkeyPath = artifacts?.zkeyPath ?? DEFAULT_ZKEY

    // Merkle proof from group (leaves are weighted: Poseidon(commitment, weight))
    const weightedLeaf = poseidon2([identity.commitment, weight])
    const leafIndex = group.indexOf(weightedLeaf)
    if (leafIndex === -1) {
        throw new Error("Identity not found in group")
    }
    const merkleProof = group.generateMerkleProof(leafIndex)

    // Pad siblings to MAX_DEPTH
    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) {
        siblings.push("0")
    }

    // Circuit inputs
    const input = {
        secret: identity.secretScalar.toString(),
        weight: weight.toString(),
        merkleProofLength: merkleProof.siblings.length,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings: siblings,
        proposalId: proposalId.toString(),
        vote: vote.toString(),
        voteRandomness: voteRandomness.toString(),
        numOptions: numOptions.toString(),
        version: version.toString()
    }

    // Generate Groth16 proof
    const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath)

    // Pack proof points for Solidity verifier
    // Note: pB coordinates are swapped (snarkjs → Solidity convention)
    // Public signals: [merkleRoot, baseNullifier, versionedNullifier, voteCommitment, proposalId, numOptions]
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ],
        pC: [proof.pi_c[0], proof.pi_c[1]],
        merkleRoot: publicSignals[0],
        baseNullifier: publicSignals[1],
        versionedNullifier: publicSignals[2],
        voteCommitment: publicSignals[3],
        proposalId: publicSignals[4],
        numOptions: publicSignals[5]
    }
}
