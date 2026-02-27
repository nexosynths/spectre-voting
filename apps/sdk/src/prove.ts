import { Identity, Group } from "@semaphore-protocol/core"
import { poseidon2 } from "poseidon-lite"
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
    nullifierHash: string
    voteCommitment: string
    proposalId: string
}

export interface ProofArtifacts {
    wasmPath: string
    zkeyPath: string
}

/**
 * Compute the vote commitment: Poseidon(vote, randomness)
 */
export function computeVoteCommitment(vote: bigint, randomness: bigint): bigint {
    return poseidon2([vote, randomness])
}

/**
 * Compute the nullifier hash: Poseidon(proposalId, secretScalar)
 */
export function computeNullifier(proposalId: bigint, secretScalar: bigint): bigint {
    return poseidon2([proposalId, secretScalar])
}

/**
 * Generate a SpectreVote ZK proof.
 *
 * Proves: identity membership + valid vote commitment + correct nullifier
 *
 * @param identity — Semaphore Identity (wraps secret key)
 * @param group — Semaphore Group (local mirror of on-chain Merkle tree)
 * @param proposalId — election/proposal identifier
 * @param vote — 0 or 1
 * @param voteRandomness — blinding factor for vote commitment
 * @param artifacts — optional custom paths to wasm/zkey
 */
export async function generateSpectreProof(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint,
    artifacts?: Partial<ProofArtifacts>
): Promise<SpectreProof> {
    if (vote !== 0n && vote !== 1n) {
        throw new Error("Vote must be 0 or 1")
    }

    const wasmPath = artifacts?.wasmPath ?? DEFAULT_WASM
    const zkeyPath = artifacts?.zkeyPath ?? DEFAULT_ZKEY

    // Merkle proof from group
    const leafIndex = group.indexOf(identity.commitment)
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
        merkleProofLength: merkleProof.siblings.length,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings: siblings,
        proposalId: proposalId.toString(),
        vote: vote.toString(),
        voteRandomness: voteRandomness.toString()
    }

    // Generate Groth16 proof
    const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath)

    // Pack proof points for Solidity verifier
    // Note: pB coordinates are swapped (snarkjs → Solidity convention)
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ],
        pC: [proof.pi_c[0], proof.pi_c[1]],
        merkleRoot: publicSignals[0],
        nullifierHash: publicSignals[1],
        voteCommitment: publicSignals[2],
        proposalId: publicSignals[3]
    }
}
