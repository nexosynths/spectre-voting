/**
 * Browser-compatible ZK proof generation for SpectreVote circuit.
 *
 * Uses snarkjs (loaded dynamically) to generate Groth16 proofs.
 * Circuit artifacts (wasm + zkey) are served from /public/circuits/.
 */

import { Identity, Group } from "@semaphore-protocol/core"

const MAX_DEPTH = 20
const WASM_URL = "/circuits/SpectreVote.wasm"
const ZKEY_URL = "/circuits/SpectreVote.zkey"

export interface SpectreProof {
    pA: [string, string]
    pB: [[string, string], [string, string]]
    pC: [string, string]
    merkleRoot: string
    nullifierHash: string
    voteCommitment: string
    proposalId: string
}

/**
 * Generate a SpectreVote ZK proof in the browser.
 *
 * Proves: identity membership + valid vote commitment + correct nullifier
 * The proof takes ~10-30s in the browser depending on device.
 */
export async function generateProofInBrowser(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint
): Promise<SpectreProof> {
    if (vote !== 0n && vote !== 1n) {
        throw new Error("Vote must be 0 or 1")
    }

    // Dynamic import — snarkjs is heavy and only needed client-side
    const snarkjs = await import("snarkjs")

    // Build Merkle proof from group
    const leafIndex = group.indexOf(identity.commitment)
    if (leafIndex === -1) {
        throw new Error("Your identity is not registered in this election's voter group")
    }
    const merkleProof = group.generateMerkleProof(leafIndex)

    // Pad siblings to MAX_DEPTH (circuit expects fixed-size array)
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
        voteRandomness: voteRandomness.toString(),
    }

    // Generate Groth16 proof (snarkjs fetches wasm + zkey via HTTP in browser)
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_URL, ZKEY_URL)

    // Pack proof points for Solidity verifier
    // Note: pB coordinates are swapped (snarkjs convention → Solidity convention)
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        pC: [proof.pi_c[0], proof.pi_c[1]],
        merkleRoot: publicSignals[0],
        nullifierHash: publicSignals[1],
        voteCommitment: publicSignals[2],
        proposalId: publicSignals[3],
    }
}
