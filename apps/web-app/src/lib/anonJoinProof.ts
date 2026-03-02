/**
 * Browser-compatible ZK proof generation for AnonJoin circuit.
 *
 * Proves: "I own an identity in the signup group (without revealing which),
 *          here is my new delinked voting commitment."
 *
 * Uses snarkjs (loaded dynamically) to generate Groth16 proofs.
 * Circuit artifacts (wasm + zkey) are served from /public/circuits/.
 */

import { Identity, Group } from "@semaphore-protocol/core"
import { poseidon2 } from "poseidon-lite"

const MAX_DEPTH = 20
const WASM_URL = "/circuits/AnonJoin.wasm"
const ZKEY_URL = "/circuits/AnonJoin.zkey"

export interface AnonJoinProof {
    pA: [string, string]
    pB: [[string, string], [string, string]]
    pC: [string, string]
    signupMerkleRoot: string
    joinNullifier: string
    newCommitment: string
    electionId: string
}

/**
 * Generate an AnonJoin ZK proof in the browser.
 *
 * Proves membership in the signup group and outputs a new delinked
 * voting commitment. The proof takes ~10-30s depending on device.
 *
 * @param signupIdentity — the voter's signup-phase identity (in signup group)
 * @param votingIdentity — the voter's NEW voting-phase identity (will be added to voting group)
 * @param signupGroup — the signup group (mirrors on-chain signup Merkle tree)
 * @param electionId — proposalId of the election (scopes the join nullifier)
 * @param weight — voting weight (default 1 for non-weighted elections)
 */
export async function generateAnonJoinProof(
    signupIdentity: Identity,
    votingIdentity: Identity,
    signupGroup: Group,
    electionId: bigint,
    weight: bigint = 1n
): Promise<AnonJoinProof> {
    // Dynamic import — snarkjs is heavy and only needed client-side
    const snarkjs = await import("snarkjs")

    // Build Merkle proof from signup group (leaves are weighted: Poseidon(commitment, weight))
    const weightedLeaf = poseidon2([signupIdentity.commitment, weight])
    const leafIndex = signupGroup.indexOf(weightedLeaf)
    if (leafIndex === -1) {
        throw new Error("Your signup identity is not registered in this election's signup group")
    }
    const merkleProof = signupGroup.generateMerkleProof(leafIndex)

    // Pad siblings to MAX_DEPTH (circuit expects fixed-size array)
    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) {
        siblings.push("0")
    }

    // Circuit inputs
    const input = {
        secret: signupIdentity.secretScalar.toString(),
        newSecret: votingIdentity.secretScalar.toString(),
        weight: weight.toString(),
        merkleProofLength: merkleProof.siblings.length,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings: siblings,
        electionId: electionId.toString(),
    }

    // Generate Groth16 proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_URL, ZKEY_URL)

    // Pack proof points for Solidity verifier
    // publicSignals: [signupMerkleRoot, joinNullifier, newCommitment, electionId]
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        pC: [proof.pi_c[0], proof.pi_c[1]],
        signupMerkleRoot: publicSignals[0],
        joinNullifier: publicSignals[1],
        newCommitment: publicSignals[2],
        electionId: publicSignals[3],
    }
}
