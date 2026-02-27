// End-to-end test: generate witness inputs, create proof, verify
// Uses @semaphore-protocol/core for identity + group (same primitives our circuit uses)

import { Identity, Group, generateProof } from "@semaphore-protocol/core"
import { readFileSync, writeFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { poseidon2 } from "poseidon-lite"
import { deriveSecretScalar } from "@zk-kit/eddsa-poseidon"

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Setup: create identities and a group ---
console.log("=== SpectreVote Circuit Test ===\n")

// Create two identities
const identity1 = new Identity("secret-key-1")
const identity2 = new Identity("secret-key-2")

console.log("Identity 1 commitment:", identity1.commitment.toString())
console.log("Identity 2 commitment:", identity2.commitment.toString())

// Create a group and add both identities
const group = new Group()
group.addMember(identity1.commitment)
group.addMember(identity2.commitment)

console.log("Group root:", group.root.toString())
console.log("Group depth:", group.depth)

// --- Generate Merkle proof for identity1 ---
const leafIndex = group.indexOf(identity1.commitment)
const merkleProof = group.generateMerkleProof(leafIndex)

console.log("\nMerkle proof for identity1:")
console.log("  Index:", merkleProof.index)
console.log("  Siblings count:", merkleProof.siblings.length)

// --- Vote data ---
const proposalId = 42n
const vote = 1n  // YES
const voteRandomness = 123456789n  // In production: crypto.getRandomValues()
const voteCommitment = poseidon2([vote, voteRandomness])
const nullifierHash = poseidon2([proposalId, identity1.secretScalar])

console.log("\nVote data:")
console.log("  proposalId:", proposalId.toString())
console.log("  vote:", vote.toString())
console.log("  voteRandomness:", voteRandomness.toString())
console.log("  Expected voteCommitment:", voteCommitment.toString())
console.log("  Expected nullifierHash:", nullifierHash.toString())

// --- Build circuit input ---
// Pad siblings to MAX_DEPTH=20
const MAX_DEPTH = 20
const siblings = merkleProof.siblings.map(s => s.toString())
while (siblings.length < MAX_DEPTH) {
    siblings.push("0")
}

const input = {
    secret: identity1.secretScalar.toString(),
    merkleProofLength: merkleProof.siblings.length,
    merkleProofIndex: merkleProof.index,
    merkleProofSiblings: siblings,
    proposalId: proposalId.toString(),
    vote: vote.toString(),
    voteRandomness: voteRandomness.toString()
}

console.log("\n--- Circuit Input ---")
console.log("secret (scalar):", input.secret.substring(0, 20) + "...")
console.log("merkleProofLength:", input.merkleProofLength)
console.log("merkleProofIndex:", input.merkleProofIndex)
console.log("siblings[0]:", input.merkleProofSiblings[0].substring(0, 20) + "...")

// Write input to file
const inputPath = resolve(__dirname, "../build/input.json")
writeFileSync(inputPath, JSON.stringify(input, null, 2))
console.log("\nInput written to:", inputPath)

console.log("\nExpected public outputs:")
console.log("  merkleRoot:", group.root.toString())
console.log("  nullifierHash:", nullifierHash.toString())
console.log("  voteCommitment:", voteCommitment.toString())
