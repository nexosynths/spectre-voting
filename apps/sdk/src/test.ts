/**
 * End-to-end SDK test: full voter flow
 *
 * 1. Create identities + group
 * 2. Generate election keypair
 * 3. Prepare vote (ZK proof + ECIES encrypt)
 * 4. Decrypt the encrypted blob (simulating committee)
 * 5. Verify decrypted data matches proof outputs
 */

import { Identity, Group } from "@semaphore-protocol/core"
import { poseidon2 } from "poseidon-lite"
import { generateSpectreProof, computeVoteCommitment } from "./prove.js"
import { eciesEncrypt, eciesDecrypt, generateElectionKeypair } from "./ecies.js"
import { prepareVote, decodeVotePayload } from "./voter.js"
// @ts-ignore
import { groth16 } from "snarkjs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VKEY_PATH = path.resolve(__dirname, "../../circuits/build/verification_key.json")

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
    console.log("=== Spectre SDK End-to-End Test ===\n")

    // --- Setup ---
    const PROPOSAL_ID = 42n
    const voter1 = new Identity("voter-secret-1")
    const voter2 = new Identity("voter-secret-2")

    const group = new Group()
    group.addMember(voter1.commitment)
    group.addMember(voter2.commitment)

    const electionKeys = generateElectionKeypair()

    console.log("1. ECIES encryption round-trip")
    {
        const plaintext = new Uint8Array([1, 2, 3, 4, 5])
        const envelope = eciesEncrypt(electionKeys.publicKey, plaintext)
        const decrypted = eciesDecrypt(electionKeys.privateKey, envelope)

        assert(
            plaintext.length === decrypted.length &&
                plaintext.every((b, i) => b === decrypted[i]),
            "Encrypt → decrypt round-trip matches"
        )
        assert(envelope.length === 33 + 12 + 5 + 16, `Envelope size correct (${envelope.length} bytes)`)
    }

    console.log("\n2. ZK proof generation + off-chain verification")
    {
        const vote = 1n
        const randomness = 123456789n

        const proof = await generateSpectreProof(voter1, group, PROPOSAL_ID, vote, randomness)

        assert(proof.proposalId === PROPOSAL_ID.toString(), "proposalId matches")
        assert(proof.merkleRoot === group.root.toString(), "merkleRoot matches group")

        // Verify vote commitment
        const expectedCommitment = computeVoteCommitment(vote, randomness)
        assert(proof.voteCommitment === expectedCommitment.toString(), "voteCommitment matches Poseidon(vote, randomness)")

        // Off-chain verify with snarkjs
        const { readFileSync } = await import("fs")
        const vkey = JSON.parse(readFileSync(VKEY_PATH, "utf-8"))
        const publicSignals = [proof.merkleRoot, proof.nullifierHash, proof.voteCommitment, proof.proposalId]

        // Reconstruct raw proof for snarkjs verify
        const rawProof = {
            pi_a: [proof.pA[0], proof.pA[1], "1"],
            pi_b: [
                [proof.pB[0][1], proof.pB[0][0]],
                [proof.pB[1][1], proof.pB[1][0]],
                ["1", "0"]
            ],
            pi_c: [proof.pC[0], proof.pC[1], "1"],
            protocol: "groth16",
            curve: "bn128"
        }
        const valid = await groth16.verify(vkey, publicSignals, rawProof)
        assert(valid === true, "Proof verifies off-chain via snarkjs")
    }

    console.log("\n3. Full voter flow: prepareVote → decrypt → verify")
    {
        const prepared = await prepareVote(
            voter2,
            group,
            PROPOSAL_ID,
            0n as 0n,
            electionKeys.publicKey
        )

        assert(prepared.proof.proposalId === PROPOSAL_ID.toString(), "Prepared proof has correct proposalId")
        assert(prepared.payload.vote === 0n, "Payload records vote=0")

        // Committee decrypts
        const decrypted = eciesDecrypt(electionKeys.privateKey, prepared.encryptedBlob)
        const decoded = decodeVotePayload(decrypted)

        assert(decoded.vote === prepared.payload.vote, "Decrypted vote matches original")
        assert(
            decoded.voteRandomness === prepared.payload.voteRandomness,
            "Decrypted randomness matches original"
        )
        assert(decoded.nullifierHash === prepared.payload.nullifierHash, "Decrypted nullifier matches proof")

        // Committee verifies: Poseidon(decrypted_vote, decrypted_randomness) == on-chain voteCommitment
        const recomputedCommitment = poseidon2([decoded.vote, decoded.voteRandomness])
        assert(
            recomputedCommitment.toString() === prepared.proof.voteCommitment,
            "Recomputed commitment matches proof's voteCommitment"
        )
    }

    console.log("\n4. Edge cases")
    {
        // Invalid vote value should throw
        let threw = false
        try {
            await generateSpectreProof(voter1, group, PROPOSAL_ID, 2n, 0n)
        } catch {
            threw = true
        }
        assert(threw, "vote=2 throws error")

        // Non-member should throw
        threw = false
        const stranger = new Identity("stranger")
        try {
            await generateSpectreProof(stranger, group, PROPOSAL_ID, 1n, 0n)
        } catch {
            threw = true
        }
        assert(threw, "Non-member identity throws error")
    }

    // --- Summary ---
    console.log(`\n=== ${passed} passed, ${failed} failed ===`)
    if (failed > 0) process.exit(1)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
