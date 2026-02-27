import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { Identity, Group } from "@semaphore-protocol/core"
import { expect } from "chai"
import { ethers, run } from "hardhat"
import { poseidon2 } from "poseidon-lite"
import * as path from "path"
// @ts-ignore
import { groth16 } from "snarkjs"

const WASM_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote_js/SpectreVote.wasm")
const ZKEY_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote.zkey")

const PROPOSAL_ID = 100n
const MAX_DEPTH = 20
const ELECTION_PUBKEY_X = 111n
const ELECTION_PUBKEY_Y = 222n

// Helper: generate a SpectreVote proof
async function generateSpectreProof(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint
) {
    const leafIndex = group.indexOf(identity.commitment)
    const merkleProof = group.generateMerkleProof(leafIndex)

    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) siblings.push("0")

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

describe("SpectreVotingFactory", () => {
    async function deployFixture() {
        const [deployer, alice, bob] = await ethers.getSigners()

        // Deploy shared infrastructure
        const { semaphore } = await run("deploy:semaphore", { logs: false })
        const semaphoreAddress = await semaphore.getAddress()

        const VerifierFactory = await ethers.getContractFactory("Groth16Verifier")
        const verifier = await VerifierFactory.deploy()
        const verifierAddress = await verifier.getAddress()

        // Deploy factory
        const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
        const factory = await FactoryFactory.deploy(semaphoreAddress, verifierAddress)

        return { factory, semaphore, verifier, semaphoreAddress, verifierAddress, deployer, alice, bob }
    }

    describe("# deployment", () => {
        it("Should store semaphore and verifier addresses", async () => {
            const { factory, semaphoreAddress, verifierAddress } = await loadFixture(deployFixture)

            expect(await factory.semaphore()).to.equal(semaphoreAddress)
            expect(await factory.verifier()).to.equal(verifierAddress)
            expect(await factory.electionCount()).to.equal(0)
        })
    })

    describe("# createElection", () => {
        it("Should deploy a new SpectreVoting and register in the directory", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID,
                ELECTION_PUBKEY_X,
                ELECTION_PUBKEY_Y,
                0 // no deadline
            )

            const receipt = await tx.wait()

            // Check registry
            expect(await factory.electionCount()).to.equal(1)
            const electionAddr = await factory.elections(0)
            expect(await factory.isElection(electionAddr)).to.equal(true)

            // Check event
            await expect(tx).to.emit(factory, "ElectionDeployed").withArgs(
                electionAddr,
                alice.address,
                PROPOSAL_ID,
                ELECTION_PUBKEY_X,
                ELECTION_PUBKEY_Y
            )
        })

        it("Should set the caller as admin (not the factory)", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, 0)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr)

            // Admin should be alice, not the factory
            expect(await election.admin()).to.equal(alice.address)
            expect(await election.proposalId()).to.equal(PROPOSAL_ID)
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should allow multiple elections from different admins", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(1n, 0n, 0n, 0)
            await factory.connect(bob).createElection(2n, 0n, 0n, 0)
            await factory.connect(alice).createElection(3n, 0n, 0n, 0)

            expect(await factory.electionCount()).to.equal(3)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")

            const e1 = SpectreVoting.attach(await factory.elections(0))
            const e2 = SpectreVoting.attach(await factory.elections(1))
            const e3 = SpectreVoting.attach(await factory.elections(2))

            expect(await e1.admin()).to.equal(alice.address)
            expect(await e2.admin()).to.equal(bob.address)
            expect(await e3.admin()).to.equal(alice.address)

            expect(await e1.proposalId()).to.equal(1n)
            expect(await e2.proposalId()).to.equal(2n)
            expect(await e3.proposalId()).to.equal(3n)
        })
    })

    describe("# getElections", () => {
        it("Should return paginated election list", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            // Create 5 elections
            for (let i = 0; i < 5; i++) {
                await factory.connect(alice).createElection(BigInt(i + 1), 0n, 0n, 0)
            }

            // Full list
            const all = await factory.getElections(0, 100)
            expect(all.length).to.equal(5)

            // First page
            const page1 = await factory.getElections(0, 2)
            expect(page1.length).to.equal(2)

            // Second page
            const page2 = await factory.getElections(2, 2)
            expect(page2.length).to.equal(2)

            // Last page (partial)
            const page3 = await factory.getElections(4, 10)
            expect(page3.length).to.equal(1)

            // Out of bounds
            const empty = await factory.getElections(10, 10)
            expect(empty.length).to.equal(0)
        })
    })

    describe("# end-to-end via factory", () => {
        it("Should create election, register voters, and accept a valid vote", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            // Alice creates an election via factory
            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, 0)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr).connect(alice)

            // Register voters (alice is admin)
            const voter1 = new Identity("factory-voter-1")
            const voter2 = new Identity("factory-voter-2")

            await election.registerVoter(voter1.commitment)
            await election.registerVoter(voter2.commitment)

            // Build local group mirror
            const group = new Group()
            group.addMember(voter1.commitment)
            group.addMember(voter2.commitment)

            // voter1 votes YES
            const proof = await generateSpectreProof(voter1, group, PROPOSAL_ID, 1n, 777n)

            const tx = await election.castVote(
                proof.pA,
                proof.pB,
                proof.pC,
                proof.merkleRoot,
                proof.nullifierHash,
                proof.voteCommitment,
                "0xfeed"
            )

            await expect(tx).to.emit(election, "VoteCast")
            expect(await election.voteCount()).to.equal(1)
        })
    })

    describe("# commitment validation", () => {
        it("Should reject zero identity commitment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, 0)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr).connect(alice)

            await expect(
                election.registerVoter(0)
            ).to.be.revertedWithCustomError(election, "InvalidCommitment")
        })

        it("Should reject zero commitment in bulk registration", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, 0)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr).connect(alice)

            const voter = new Identity("valid-voter")
            await expect(
                election.registerVoters([voter.commitment, 0])
            ).to.be.revertedWithCustomError(election, "InvalidCommitment")
        })
    })

    describe("# voting deadline", () => {
        it("Should store deadline and allow voting before it", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            // Set deadline 1 hour from now
            const block = await ethers.provider.getBlock("latest")
            const deadline = block!.timestamp + 3600

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, deadline)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr).connect(alice)

            expect(await election.votingDeadline()).to.equal(deadline)
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should allow anyone to close voting after deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            // Set deadline 1 hour from now
            const block = await ethers.provider.getBlock("latest")
            const deadline = block!.timestamp + 3600

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, deadline)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr)

            // Bob (non-admin) cannot close before deadline
            await expect(
                election.connect(bob).closeVoting()
            ).to.be.revertedWithCustomError(election, "NotAdmin")

            // Fast forward past deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [deadline + 1])
            await ethers.provider.send("evm_mine", [])

            // Now bob (non-admin) CAN close
            await election.connect(bob).closeVoting()
            expect(await election.votingOpen()).to.equal(false)
        })

        it("Should reject votes after deadline", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            const block = await ethers.provider.getBlock("latest")
            const deadline = block!.timestamp + 3600

            await factory.connect(alice).createElection(PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y, deadline)
            const electionAddr = await factory.elections(0)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting")
            const election = SpectreVoting.attach(electionAddr).connect(alice)

            // Register voters
            const voter = new Identity("deadline-voter")
            const filler = new Identity("deadline-filler")
            await election.registerVoter(voter.commitment)
            await election.registerVoter(filler.commitment)

            // Build group + proof BEFORE deadline
            const group = new Group()
            group.addMember(voter.commitment)
            group.addMember(filler.commitment)
            const proof = await generateSpectreProof(voter, group, PROPOSAL_ID, 1n, 888n)

            // Fast forward past deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [deadline + 1])
            await ethers.provider.send("evm_mine", [])

            // Trying to vote after deadline should fail
            await expect(
                election.castVote(
                    proof.pA, proof.pB, proof.pC,
                    proof.merkleRoot, proof.nullifierHash, proof.voteCommitment,
                    "0xdead"
                )
            ).to.be.revertedWithCustomError(election, "VotingDeadlinePassed")
        })
    })
})
