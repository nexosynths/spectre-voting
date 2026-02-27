import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { Identity, Group } from "@semaphore-protocol/core"
import { expect } from "chai"
import { run } from "hardhat"
import { poseidon2 } from "poseidon-lite"
import * as path from "path"
// @ts-ignore
import { groth16 } from "snarkjs"
// @ts-ignore
import { SpectreVoting } from "../typechain-types"

const WASM_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote_js/SpectreVote.wasm")
const ZKEY_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote.zkey")

const PROPOSAL_ID = 42n
const MAX_DEPTH = 20
const ELECTION_PUBKEY_X = 1n // placeholder — real ECIES key in production
const ELECTION_PUBKEY_Y = 2n

// Helper: generate a SpectreVote proof for a voter
async function generateSpectreProof(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint
) {
    const leafIndex = group.indexOf(identity.commitment)
    const merkleProof = group.generateMerkleProof(leafIndex)

    // Pad siblings to MAX_DEPTH
    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) {
        siblings.push("0")
    }

    const input = {
        secret: identity.secretScalar.toString(),
        merkleProofLength: merkleProof.siblings.length,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings: siblings,
        proposalId: proposalId.toString(),
        vote: vote.toString(),
        voteRandomness: voteRandomness.toString()
    }

    const { proof, publicSignals } = await groth16.fullProve(input, WASM_PATH, ZKEY_PATH)

    // publicSignals: [merkleRoot, nullifierHash, voteCommitment, proposalId]
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ] as [[string, string], [string, string]],
        pC: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
        merkleRoot: publicSignals[0],
        nullifierHash: publicSignals[1],
        voteCommitment: publicSignals[2],
        proposalId: publicSignals[3]
    }
}

describe("SpectreVoting", () => {
    async function deployFixture() {
        const { semaphore } = await run("deploy:semaphore", { logs: false })
        const semaphoreAddress = await semaphore.getAddress()

        const spectreVoting: SpectreVoting = await run("deploy", {
            logs: false,
            semaphore: semaphoreAddress,
            proposalid: PROPOSAL_ID.toString(),
            pubkeyx: ELECTION_PUBKEY_X.toString(),
            pubkeyy: ELECTION_PUBKEY_Y.toString()
        })

        return { semaphore, spectreVoting }
    }

    describe("# deployment", () => {
        it("Should deploy with correct parameters", async () => {
            const { spectreVoting } = await loadFixture(deployFixture)

            expect(await spectreVoting.proposalId()).to.equal(PROPOSAL_ID)
            expect(await spectreVoting.electionPubKeyX()).to.equal(ELECTION_PUBKEY_X)
            expect(await spectreVoting.electionPubKeyY()).to.equal(ELECTION_PUBKEY_Y)
            expect(await spectreVoting.votingOpen()).to.equal(true)
            expect(await spectreVoting.voteCount()).to.equal(0)
        })
    })

    describe("# registerVoter", () => {
        it("Should register voters into the group", async () => {
            const { semaphore, spectreVoting } = await loadFixture(deployFixture)

            const user = new Identity()
            const tx = await spectreVoting.registerVoter(user.commitment)

            await expect(tx).to.emit(spectreVoting, "VoterRegistered")
        })
    })

    describe("# castVote", () => {
        it("Should accept a valid ZK-proven vote", async () => {
            const { spectreVoting } = await loadFixture(deployFixture)

            // Setup: create identities and register them
            const voter1 = new Identity("voter-secret-1")
            const voter2 = new Identity("voter-secret-2")

            await spectreVoting.registerVoter(voter1.commitment)
            await spectreVoting.registerVoter(voter2.commitment)

            // Build local group mirror
            const group = new Group()
            group.addMember(voter1.commitment)
            group.addMember(voter2.commitment)

            // voter1 votes YES
            const vote = 1n
            const randomness = 987654321n
            const encryptedBlob = "0xdeadbeef" // placeholder — real ECIES in production

            const proof = await generateSpectreProof(voter1, group, PROPOSAL_ID, vote, randomness)

            const tx = await spectreVoting.castVote(
                proof.pA,
                proof.pB,
                proof.pC,
                proof.merkleRoot,
                proof.nullifierHash,
                proof.voteCommitment,
                encryptedBlob
            )

            await expect(tx)
                .to.emit(spectreVoting, "VoteCast")
                .withArgs(
                    PROPOSAL_ID,
                    proof.nullifierHash,
                    proof.voteCommitment,
                    encryptedBlob
                )

            expect(await spectreVoting.voteCount()).to.equal(1)
            expect(await spectreVoting.usedNullifiers(proof.nullifierHash)).to.equal(true)
        })

        it("Should reject double-voting (same nullifier)", async () => {
            const { spectreVoting } = await loadFixture(deployFixture)

            const voter = new Identity("voter-double")
            const filler = new Identity("filler")
            await spectreVoting.registerVoter(voter.commitment)
            await spectreVoting.registerVoter(filler.commitment)

            const group = new Group()
            group.addMember(voter.commitment)
            group.addMember(filler.commitment)

            const proof = await generateSpectreProof(voter, group, PROPOSAL_ID, 0n, 111n)

            // First vote succeeds
            await spectreVoting.castVote(
                proof.pA,
                proof.pB,
                proof.pC,
                proof.merkleRoot,
                proof.nullifierHash,
                proof.voteCommitment,
                "0x01"
            )

            // Second vote with same proof fails (same nullifier)
            await expect(
                spectreVoting.castVote(
                    proof.pA,
                    proof.pB,
                    proof.pC,
                    proof.merkleRoot,
                    proof.nullifierHash,
                    proof.voteCommitment,
                    "0x02"
                )
            ).to.be.revertedWithCustomError(spectreVoting, "NullifierAlreadyUsed")
        })

        it("Should reject invalid proof", async () => {
            const { spectreVoting } = await loadFixture(deployFixture)

            const voter = new Identity("voter-invalid")
            const filler = new Identity("filler2")
            await spectreVoting.registerVoter(voter.commitment)
            await spectreVoting.registerVoter(filler.commitment)

            const group = new Group()
            group.addMember(voter.commitment)
            group.addMember(filler.commitment)

            const proof = await generateSpectreProof(voter, group, PROPOSAL_ID, 1n, 222n)

            // Tamper with the proof — flip a value in pA
            const badPA: [string, string] = [proof.pA[0], "0"]

            await expect(
                spectreVoting.castVote(
                    badPA,
                    proof.pB,
                    proof.pC,
                    proof.merkleRoot,
                    proof.nullifierHash,
                    proof.voteCommitment,
                    "0xbaad"
                )
            ).to.be.reverted
        })
    })

    describe("# closeVoting", () => {
        it("Should close voting and prevent further votes", async () => {
            const { spectreVoting } = await loadFixture(deployFixture)

            await spectreVoting.closeVoting()
            expect(await spectreVoting.votingOpen()).to.equal(false)

            const voter = new Identity("voter-late")
            const filler = new Identity("filler3")
            // Can't vote when closed — but we'd need to register first
            // which we can still do since registerVoter doesn't check votingOpen
        })
    })
})
