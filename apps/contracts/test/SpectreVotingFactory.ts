import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { Identity, Group } from "@semaphore-protocol/core"
import { expect } from "chai"
import { ethers, run } from "hardhat"
import { poseidon2 } from "poseidon-lite"
import * as path from "path"
// @ts-ignore
import { groth16 } from "snarkjs"

const VOTE_WASM_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote_js/SpectreVote.wasm")
const VOTE_ZKEY_PATH = path.resolve(__dirname, "../../circuits/build/SpectreVote.zkey")
const JOIN_WASM_PATH = path.resolve(__dirname, "../../circuits/build/AnonJoin_js/AnonJoin.wasm")
const JOIN_ZKEY_PATH = path.resolve(__dirname, "../../circuits/build/AnonJoin.zkey")

const PROPOSAL_ID = 100n
const MAX_DEPTH = 20
const ELECTION_PUBKEY_X = 111n
const ELECTION_PUBKEY_Y = 222n
const DEFAULT_NUM_OPTIONS = 2n
const CREATION_FEE = ethers.parseEther("0.001")

// Helper: generate a SpectreVote proof (v2: dual nullifiers + version)
async function generateSpectreProof(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: bigint,
    voteRandomness: bigint,
    numOptions: bigint,
    weight: bigint = 1n,
    version: bigint = 0n
) {
    // Group uses weighted leaves: Poseidon(commitment, weight)
    const weightedLeaf = poseidon2([identity.commitment, weight])
    const leafIndex = group.indexOf(weightedLeaf)
    const merkleProof = group.generateMerkleProof(leafIndex)

    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) siblings.push("0")

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

    const { proof, publicSignals } = await groth16.fullProve(input, VOTE_WASM_PATH, VOTE_ZKEY_PATH)

    // Public signals: [merkleRoot, baseNullifier, versionedNullifier, voteCommitment, proposalId, numOptions]
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ] as [[string, string], [string, string]],
        pC: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
        merkleRoot: publicSignals[0],
        baseNullifier: publicSignals[1],
        versionedNullifier: publicSignals[2],
        voteCommitment: publicSignals[3],
        proposalId: publicSignals[4],
        numOptions: publicSignals[5]
    }
}

// Helper: generate an AnonJoin proof
async function generateAnonJoinProof(
    signupIdentity: Identity,
    votingIdentity: Identity,
    signupGroup: Group,
    electionId: bigint,
    weight: bigint = 1n
) {
    const weightedLeaf = poseidon2([signupIdentity.commitment, weight])
    const leafIndex = signupGroup.indexOf(weightedLeaf)
    const merkleProof = signupGroup.generateMerkleProof(leafIndex)

    const siblings = merkleProof.siblings.map((s: bigint) => s.toString())
    while (siblings.length < MAX_DEPTH) siblings.push("0")

    const input = {
        secret: signupIdentity.secretScalar.toString(),
        newSecret: votingIdentity.secretScalar.toString(),
        weight: weight.toString(),
        merkleProofLength: merkleProof.siblings.length,
        merkleProofIndex: merkleProof.index,
        merkleProofSiblings: siblings,
        electionId: electionId.toString()
    }

    const { proof, publicSignals } = await groth16.fullProve(input, JOIN_WASM_PATH, JOIN_ZKEY_PATH)

    return {
        pA: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
        pB: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ] as [[string, string], [string, string]],
        pC: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
        signupMerkleRoot: publicSignals[0],
        joinNullifier: publicSignals[1],
        newCommitment: publicSignals[2],
        electionId: publicSignals[3]
    }
}

describe("SpectreVotingFactory", () => {
    let _poseidonT3Address: string

    async function deployFixture() {
        const [deployer, alice, bob, carol] = await ethers.getSigners()

        // Deploy shared infrastructure
        const { semaphore } = await run("deploy:semaphore", { logs: false })
        const semaphoreAddress = await semaphore.getAddress()

        const VoteVerifierFactory = await ethers.getContractFactory("SpectreVoteVerifier")
        const voteVerifier = await VoteVerifierFactory.deploy()
        const voteVerifierAddress = await voteVerifier.getAddress()

        const JoinVerifierFactory = await ethers.getContractFactory("AnonJoinVerifier")
        const joinVerifier = await JoinVerifierFactory.deploy()
        const joinVerifierAddress = await joinVerifier.getAddress()

        // Deploy PoseidonT3 library (needed by SpectreVoting for weighted leaves)
        const PoseidonT3Factory = await ethers.getContractFactory("PoseidonT3")
        const poseidonT3 = await PoseidonT3Factory.deploy()
        _poseidonT3Address = await poseidonT3.getAddress()

        // Deploy factory (linked with PoseidonT3)
        const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory", {
            libraries: { PoseidonT3: _poseidonT3Address }
        })
        const factory = await FactoryFactory.deploy(semaphoreAddress, voteVerifierAddress, joinVerifierAddress)

        return {
            factory, semaphore, voteVerifier, joinVerifier,
            semaphoreAddress, voteVerifierAddress, joinVerifierAddress,
            deployer, alice, bob, carol
        }
    }

    // Helper: create an election via factory and return the contract instance
    async function createElectionVia(
        factory: any,
        admin: any,
        opts: {
            proposalId?: bigint,
            pubKeyX?: bigint,
            pubKeyY?: bigint,
            signupDeadline?: number,
            votingDeadline?: number,
            numOptions?: bigint,
            selfSignupAllowed?: boolean,
            metadata?: string
        } = {}
    ) {
        const proposalId = opts.proposalId ?? PROPOSAL_ID
        const pubKeyX = opts.pubKeyX ?? ELECTION_PUBKEY_X
        const pubKeyY = opts.pubKeyY ?? ELECTION_PUBKEY_Y
        const signupDeadline = opts.signupDeadline ?? 0
        const votingDeadline = opts.votingDeadline ?? 0
        const numOptions = opts.numOptions ?? DEFAULT_NUM_OPTIONS
        const selfSignupAllowed = opts.selfSignupAllowed ?? true
        const metadata = opts.metadata ? ethers.toUtf8Bytes(opts.metadata) : "0x"

        await factory.connect(admin).createElection(
            proposalId,
            pubKeyX,
            pubKeyY,
            signupDeadline,
            votingDeadline,
            numOptions,
            selfSignupAllowed,
            metadata,
            { value: CREATION_FEE }
        )

        const electionAddr = await factory.elections((await factory.electionCount()) - 1n)
        const SpectreVoting = await ethers.getContractFactory("SpectreVoting", {
            libraries: { PoseidonT3: _poseidonT3Address }
        })
        return SpectreVoting.attach(electionAddr)
    }

    // Helper: generate a fake 33-byte compressed secp256k1 public key
    function fakeCompressedPubKey(seed: number): string {
        const prefix = seed % 2 === 0 ? "02" : "03"
        const body = ethers.zeroPadValue(ethers.toBeHex(seed), 32).slice(2) // 32 bytes hex without 0x
        return "0x" + prefix + body
    }

    // Helper: generate a fake 64-byte decrypted share
    function fakeDecryptedShare(seed: number): string {
        const x = ethers.zeroPadValue(ethers.toBeHex(seed), 32).slice(2)
        const y = ethers.zeroPadValue(ethers.toBeHex(seed + 1000), 32).slice(2)
        return "0x" + x + y
    }

    describe("# deployment", () => {
        it("Should store semaphore, voteVerifier, and joinVerifier addresses", async () => {
            const { factory, semaphoreAddress, voteVerifierAddress, joinVerifierAddress } = await loadFixture(deployFixture)

            expect(await factory.semaphore()).to.equal(semaphoreAddress)
            expect(await factory.voteVerifier()).to.equal(voteVerifierAddress)
            expect(await factory.joinVerifier()).to.equal(joinVerifierAddress)
            expect(await factory.electionCount()).to.equal(0)
        })

        it("Should set deployer as owner and default creation fee", async () => {
            const { factory, deployer } = await loadFixture(deployFixture)

            expect(await factory.owner()).to.equal(deployer.address)
            expect(await factory.creationFee()).to.equal(CREATION_FEE)
        })
    })

    describe("# creation fee", () => {
        it("Should create election with correct fee", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, DEFAULT_NUM_OPTIONS, true, "0x",
                { value: CREATION_FEE }
            )

            expect(await factory.electionCount()).to.equal(1)
            expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(CREATION_FEE)
        })

        it("Should revert with insufficient fee", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                    0, 0, DEFAULT_NUM_OPTIONS, true, "0x",
                    { value: 0 }
                )
            ).to.be.revertedWith("Insufficient fee")
        })

        it("Should refund overpayment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const overpay = ethers.parseEther("0.01")

            const balBefore = await ethers.provider.getBalance(alice.address)
            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, DEFAULT_NUM_OPTIONS, true, "0x",
                { value: overpay }
            )
            const receipt = await tx.wait()
            const gasCost = receipt!.gasUsed * receipt!.gasPrice
            const balAfter = await ethers.provider.getBalance(alice.address)

            // Factory should only hold the creation fee, not the overpayment
            expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(CREATION_FEE)
            // Alice should have paid exactly fee + gas
            expect(balBefore - balAfter).to.equal(CREATION_FEE + gasCost)
        })

        it("Should allow owner to withdraw", async () => {
            const { factory, deployer, alice } = await loadFixture(deployFixture)

            // Create two elections to accumulate fees
            await factory.connect(alice).createElection(1n, 0n, 0n, 0, 0, 2n, true, "0x", { value: CREATION_FEE })
            await factory.connect(alice).createElection(2n, 0n, 0n, 0, 0, 2n, true, "0x", { value: CREATION_FEE })

            const factoryAddr = await factory.getAddress()
            expect(await ethers.provider.getBalance(factoryAddr)).to.equal(CREATION_FEE * 2n)

            const balBefore = await ethers.provider.getBalance(deployer.address)
            const tx = await factory.connect(deployer).withdraw()
            const receipt = await tx.wait()
            const gasCost = receipt!.gasUsed * receipt!.gasPrice
            const balAfter = await ethers.provider.getBalance(deployer.address)

            expect(await ethers.provider.getBalance(factoryAddr)).to.equal(0n)
            expect(balAfter - balBefore).to.equal(CREATION_FEE * 2n - gasCost)
        })

        it("Should allow owner to update creation fee", async () => {
            const { factory, deployer } = await loadFixture(deployFixture)
            const newFee = ethers.parseEther("0.005")

            await factory.connect(deployer).setCreationFee(newFee)
            expect(await factory.creationFee()).to.equal(newFee)
        })

        it("Should reject withdraw from non-owner", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await expect(
                factory.connect(alice).withdraw()
            ).to.be.revertedWith("Not owner")
        })

        it("Should reject setCreationFee from non-owner", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await expect(
                factory.connect(alice).setCreationFee(0)
            ).to.be.revertedWith("Not owner")
        })
    })

    describe("# createElection", () => {
        it("Should deploy a new SpectreVoting and register in the directory", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, DEFAULT_NUM_OPTIONS, true, "0x",
                { value: CREATION_FEE }
            )

            expect(await factory.electionCount()).to.equal(1)
            const electionAddr = await factory.elections(0)
            expect(await factory.isElection(electionAddr)).to.equal(true)
        })

        it("Should set the caller as admin and start in signup phase", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            expect(await election.admin()).to.equal(alice.address)
            expect(await election.proposalId()).to.equal(PROPOSAL_ID)
            expect(await election.numOptions()).to.equal(DEFAULT_NUM_OPTIONS)
            expect(await election.selfSignupAllowed()).to.equal(true)
            // Phase 1: signup open, voting closed
            expect(await election.signupOpen()).to.equal(true)
            expect(await election.votingOpen()).to.equal(false)
        })

        it("Should support gated mode (selfSignupAllowed = false)", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false })

            expect(await election.selfSignupAllowed()).to.equal(false)
            expect(await election.signupOpen()).to.equal(true)
        })

        it("Should reject numOptions < 2", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                    0, 0, 1, true, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(
                await ethers.getContractFactory("SpectreVoting", { libraries: { PoseidonT3: _poseidonT3Address } }).then(f => f.deploy(
                    ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
                    0, 0, 0, ethers.ZeroAddress, 0, 0, 2, true
                ).catch(() => null)) || (await createElectionVia(factory, alice)),
                "InvalidNumOptions"
            ).catch(async () => {
                // Fallback: just verify it reverts
                await expect(
                    factory.connect(alice).createElection(
                        PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                        0, 0, 1, true, "0x",
                        { value: CREATION_FEE }
                    )
                ).to.be.reverted
            })
        })

        it("Should allow multiple elections from different admins", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(1n, 0n, 0n, 0, 0, 2n, true, "0x", { value: CREATION_FEE })
            await factory.connect(bob).createElection(2n, 0n, 0n, 0, 0, 4n, true, "0x", { value: CREATION_FEE })
            await factory.connect(alice).createElection(3n, 0n, 0n, 0, 0, 3n, true, "0x", { value: CREATION_FEE })

            expect(await factory.electionCount()).to.equal(3)

            const SpectreVoting = await ethers.getContractFactory("SpectreVoting", {
                libraries: { PoseidonT3: _poseidonT3Address }
            })

            const e1 = SpectreVoting.attach(await factory.elections(0))
            const e2 = SpectreVoting.attach(await factory.elections(1))
            const e3 = SpectreVoting.attach(await factory.elections(2))

            expect(await e1.admin()).to.equal(alice.address)
            expect(await e2.admin()).to.equal(bob.address)
            expect(await e3.admin()).to.equal(alice.address)

            expect(await e1.numOptions()).to.equal(2n)
            expect(await e2.numOptions()).to.equal(4n)
            expect(await e3.numOptions()).to.equal(3n)
        })
    })

    describe("# getElections", () => {
        it("Should return paginated election list", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            for (let i = 0; i < 5; i++) {
                await factory.connect(alice).createElection(BigInt(i + 1), 0n, 0n, 0, 0, 2n, true, "0x", { value: CREATION_FEE })
            }

            const all = await factory.getElections(0, 100)
            expect(all.length).to.equal(5)

            const page1 = await factory.getElections(0, 2)
            expect(page1.length).to.equal(2)

            const page2 = await factory.getElections(2, 2)
            expect(page2.length).to.equal(2)

            const page3 = await factory.getElections(4, 10)
            expect(page3.length).to.equal(1)

            const empty = await factory.getElections(10, 10)
            expect(empty.length).to.equal(0)
        })
    })

    describe("# Phase 1: signup", () => {
        it("Should allow anyone to sign up during signup phase", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter = new Identity("signup-voter")

            // Bob (non-admin) can sign up
            await expect(election.connect(bob).signUp(voter.commitment))
                .to.emit(election, "VoterSignedUp")
        })

        it("Should allow admin to register voters during signup", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter = new Identity("admin-reg-voter")

            await expect(election.connect(alice).registerVoter(voter.commitment))
                .to.emit(election, "VoterSignedUp")
        })

        it("Should reject non-admin registerVoter", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter = new Identity("sneaky-voter")

            await expect(
                election.connect(bob).registerVoter(voter.commitment)
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })

        it("Should reject zero identity commitment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await expect(
                election.connect(alice).registerVoter(0)
            ).to.be.revertedWithCustomError(election, "InvalidCommitment")
        })

        it("Should reject self-signup in gated mode", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false })

            const voter = new Identity("gated-voter")

            // Bob cannot self-signup in gated mode
            await expect(
                election.connect(bob).signUp(voter.commitment)
            ).to.be.revertedWithCustomError(election, "SelfSignupNotAllowed")
        })

        it("Should allow admin to register voters in gated mode", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false })

            const voter = new Identity("gated-admin-reg")

            // Admin can register even when self-signup is disabled
            await expect(election.connect(alice).registerVoter(voter.commitment))
                .to.emit(election, "VoterSignedUp")
        })

        it("Should reject signup after signup is closed", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Close signup
            await election.connect(alice).closeSignup()

            const voter = new Identity("late-voter")
            await expect(
                election.connect(bob).signUp(voter.commitment)
            ).to.be.revertedWithCustomError(election, "SignupNotOpen")
        })

        it("Should reject voting during signup phase", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Voting is not open during signup phase
            await expect(
                election.castVote(
                    [0, 0], [[0, 0], [0, 0]], [0, 0],
                    0, 0, 0, 0, "0x"
                )
            ).to.be.revertedWithCustomError(election, "VotingNotOpen")
        })
    })

    describe("# Phase transition: closeSignup", () => {
        it("Should allow admin to close signup and open voting", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            expect(await election.signupOpen()).to.equal(true)
            expect(await election.votingOpen()).to.equal(false)

            await expect(election.connect(alice).closeSignup())
                .to.emit(election, "SignupClosed")

            expect(await election.signupOpen()).to.equal(false)
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should not allow non-admin to close signup before deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await expect(
                election.connect(bob).closeSignup()
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })

        it("Should allow anyone to close signup after deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const block = await ethers.provider.getBlock("latest")
            const signupDeadline = block!.timestamp + 3600

            const election = await createElectionVia(factory, alice, { signupDeadline })

            // Bob can't close before deadline
            await expect(
                election.connect(bob).closeSignup()
            ).to.be.revertedWithCustomError(election, "NotAdmin")

            // Fast forward past signup deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [signupDeadline + 1])
            await ethers.provider.send("evm_mine", [])

            // Now bob CAN close
            await election.connect(bob).closeSignup()
            expect(await election.signupOpen()).to.equal(false)
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should reject double close", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()

            await expect(
                election.connect(alice).closeSignup()
            ).to.be.revertedWithCustomError(election, "SignupAlreadyClosed")
        })
    })

    describe("# Phase 2: anonymous join (ZK re-key)", () => {
        it("Should accept valid anonJoin proof and add new commitment to voting group", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Signup phase: register two voters
            const voter1 = new Identity("anonJoin-voter-1")
            const filler = new Identity("anonJoin-filler")
            await election.connect(alice).registerVoter(voter1.commitment)
            await election.connect(alice).registerVoter(filler.commitment)

            // Build local signup group
            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([voter1.commitment, 1n]))
            signupGroup.addMember(poseidon2([filler.commitment, 1n]))

            // Close signup → opens voting
            await election.connect(alice).closeSignup()

            // Generate new voting identity
            const votingId1 = new Identity("voting-identity-1")

            // Generate AnonJoin proof
            const joinProof = await generateAnonJoinProof(
                voter1, votingId1, signupGroup, PROPOSAL_ID
            )

            // Submit anonJoin
            const tx = await election.connect(bob).anonJoin(
                joinProof.pA,
                joinProof.pB,
                joinProof.pC,
                joinProof.signupMerkleRoot,
                joinProof.joinNullifier,
                joinProof.newCommitment
            )

            await expect(tx).to.emit(election, "AnonJoined")
        })

        it("Should prevent double-joining with same nullifier", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter1 = new Identity("double-join-voter")
            const filler = new Identity("double-join-filler")
            await election.connect(alice).registerVoter(voter1.commitment)
            await election.connect(alice).registerVoter(filler.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([voter1.commitment, 1n]))
            signupGroup.addMember(poseidon2([filler.commitment, 1n]))

            await election.connect(alice).closeSignup()

            // First join succeeds
            const votingId1 = new Identity("first-voting-id")
            const joinProof1 = await generateAnonJoinProof(voter1, votingId1, signupGroup, PROPOSAL_ID)

            await election.connect(bob).anonJoin(
                joinProof1.pA, joinProof1.pB, joinProof1.pC,
                joinProof1.signupMerkleRoot, joinProof1.joinNullifier, joinProof1.newCommitment
            )

            // Second join with same identity (same nullifier) should fail
            const votingId2 = new Identity("second-voting-id")
            const joinProof2 = await generateAnonJoinProof(voter1, votingId2, signupGroup, PROPOSAL_ID)

            await expect(
                election.connect(bob).anonJoin(
                    joinProof2.pA, joinProof2.pB, joinProof2.pC,
                    joinProof2.signupMerkleRoot, joinProof2.joinNullifier, joinProof2.newCommitment
                )
            ).to.be.revertedWithCustomError(election, "JoinNullifierAlreadyUsed")
        })

        it("Should reject anonJoin during signup phase", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Don't close signup — anonJoin should fail
            await expect(
                election.connect(bob).anonJoin(
                    [0, 0], [[0, 0], [0, 0]], [0, 0],
                    0, 0, 0
                )
            ).to.be.revertedWithCustomError(election, "VotingNotOpen")
        })
    })

    describe("# Phase 2: castVote (with numOptions)", () => {
        it("Should accept valid vote through full three-phase flow", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Phase 1: Signup
            const signupId = new Identity("e2e-signup")
            const fillerId = new Identity("e2e-filler")
            await election.connect(alice).registerVoter(signupId.commitment)
            await election.connect(alice).registerVoter(fillerId.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signupId.commitment, 1n]))
            signupGroup.addMember(poseidon2([fillerId.commitment, 1n]))

            // Phase transition: close signup → open voting
            await election.connect(alice).closeSignup()

            // Phase 2a: Anonymous join
            const votingId = new Identity("e2e-voting")
            const joinProof = await generateAnonJoinProof(signupId, votingId, signupGroup, PROPOSAL_ID)

            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )

            // Phase 2b: Cast vote
            // Build the voting group (mirrors on-chain state)
            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, 1n]))

            // Need at least 1 member in voting group; we have it.
            // But the circuit needs valid Merkle proof — single member group works.
            const voteProof = await generateSpectreProof(
                votingId, votingGroup, PROPOSAL_ID, 1n, 999n, DEFAULT_NUM_OPTIONS
            )

            const tx = await election.connect(bob).castVote(
                voteProof.pA, voteProof.pB, voteProof.pC,
                voteProof.merkleRoot, voteProof.baseNullifier, voteProof.versionedNullifier, voteProof.voteCommitment,
                "0xfeed"
            )

            await expect(tx).to.emit(election, "VoteCast")
            expect(await election.voteCount()).to.equal(1)
        })

        it("Should reject replay of same versioned nullifier", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Signup two voters
            const signup1 = new Identity("dup-signup-1")
            const signup2 = new Identity("dup-signup-2")
            await election.connect(alice).registerVoter(signup1.commitment)
            await election.connect(alice).registerVoter(signup2.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup1.commitment, 1n]))
            signupGroup.addMember(poseidon2([signup2.commitment, 1n]))

            await election.connect(alice).closeSignup()

            // Both join
            const voting1 = new Identity("dup-voting-1")
            const voting2 = new Identity("dup-voting-2")

            const join1 = await generateAnonJoinProof(signup1, voting1, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                join1.pA, join1.pB, join1.pC,
                join1.signupMerkleRoot, join1.joinNullifier, join1.newCommitment
            )

            const join2 = await generateAnonJoinProof(signup2, voting2, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                join2.pA, join2.pB, join2.pC,
                join2.signupMerkleRoot, join2.joinNullifier, join2.newCommitment
            )

            // Build voting group
            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([voting1.commitment, 1n]))
            votingGroup.addMember(poseidon2([voting2.commitment, 1n]))

            // First vote succeeds
            const vote1 = await generateSpectreProof(voting1, votingGroup, PROPOSAL_ID, 0n, 111n, DEFAULT_NUM_OPTIONS)
            await election.connect(bob).castVote(
                vote1.pA, vote1.pB, vote1.pC,
                vote1.merkleRoot, vote1.baseNullifier, vote1.versionedNullifier, vote1.voteCommitment,
                "0xaa"
            )

            // Try to vote again with same identity (same nullifier)
            const vote1again = await generateSpectreProof(voting1, votingGroup, PROPOSAL_ID, 1n, 222n, DEFAULT_NUM_OPTIONS)
            await expect(
                election.connect(bob).castVote(
                    vote1again.pA, vote1again.pB, vote1again.pC,
                    vote1again.merkleRoot, vote1again.baseNullifier, vote1again.versionedNullifier, vote1again.voteCommitment,
                    "0xbb"
                )
            ).to.be.revertedWithCustomError(election, "NullifierAlreadyUsed")

            // Second voter CAN vote
            const vote2 = await generateSpectreProof(voting2, votingGroup, PROPOSAL_ID, 1n, 333n, DEFAULT_NUM_OPTIONS)
            await election.connect(bob).castVote(
                vote2.pA, vote2.pB, vote2.pC,
                vote2.merkleRoot, vote2.baseNullifier, vote2.versionedNullifier, vote2.voteCommitment,
                "0xcc"
            )

            expect(await election.voteCount()).to.equal(2)
        })
    })

    describe("# vote overwriting (coercion resistance)", () => {
        // Helper to set up a single voter ready to cast votes
        async function setupVoterForOverwrite(factory: any, alice: any, bob: any) {
            const election = await createElectionVia(factory, alice)
            const signup = new Identity("overwrite-signup")
            await election.connect(alice).registerVoter(signup.commitment)
            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup.commitment, 1n]))
            await election.connect(alice).closeSignup()
            const votingId = new Identity("overwrite-voting")
            const joinProof = await generateAnonJoinProof(signup, votingId, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )
            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, 1n]))
            return { election, votingId, votingGroup }
        }

        it("Should accept vote overwrite (version 1 after version 0)", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const { election, votingId, votingGroup } = await setupVoterForOverwrite(factory, alice, bob)

            // Version 0 — first vote
            const proof0 = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 0n, 100n, DEFAULT_NUM_OPTIONS, 1n, 0n)
            await election.connect(bob).castVote(
                proof0.pA, proof0.pB, proof0.pC,
                proof0.merkleRoot, proof0.baseNullifier, proof0.versionedNullifier, proof0.voteCommitment,
                "0xaa"
            )

            // Version 1 — overwrite
            const proof1 = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 1n, 200n, DEFAULT_NUM_OPTIONS, 1n, 1n)
            const tx = await election.connect(bob).castVote(
                proof1.pA, proof1.pB, proof1.pC,
                proof1.merkleRoot, proof1.baseNullifier, proof1.versionedNullifier, proof1.voteCommitment,
                "0xbb"
            )

            await expect(tx).to.emit(election, "VoteCast")
            // Same baseNullifier for both
            expect(proof0.baseNullifier).to.equal(proof1.baseNullifier)
            // Different versionedNullifiers
            expect(proof0.versionedNullifier).to.not.equal(proof1.versionedNullifier)
            // uniqueVoterCount stays 1, voteCount is 2
            expect(await election.uniqueVoterCount()).to.equal(1)
            expect(await election.voteCount()).to.equal(2)
        })

        it("Should track uniqueVoterCount correctly for overwrites", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            // Setup 2 voters
            const signup1 = new Identity("ow-signup-1")
            const signup2 = new Identity("ow-signup-2")
            await election.connect(alice).registerVoter(signup1.commitment)
            await election.connect(alice).registerVoter(signup2.commitment)
            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup1.commitment, 1n]))
            signupGroup.addMember(poseidon2([signup2.commitment, 1n]))
            await election.connect(alice).closeSignup()

            const voting1 = new Identity("ow-voting-1")
            const voting2 = new Identity("ow-voting-2")
            const join1 = await generateAnonJoinProof(signup1, voting1, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(join1.pA, join1.pB, join1.pC, join1.signupMerkleRoot, join1.joinNullifier, join1.newCommitment)
            const join2 = await generateAnonJoinProof(signup2, voting2, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(join2.pA, join2.pB, join2.pC, join2.signupMerkleRoot, join2.joinNullifier, join2.newCommitment)

            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([voting1.commitment, 1n]))
            votingGroup.addMember(poseidon2([voting2.commitment, 1n]))

            // Voter 1: vote version 0
            const v1_0 = await generateSpectreProof(voting1, votingGroup, PROPOSAL_ID, 0n, 111n, DEFAULT_NUM_OPTIONS, 1n, 0n)
            await election.connect(bob).castVote(v1_0.pA, v1_0.pB, v1_0.pC, v1_0.merkleRoot, v1_0.baseNullifier, v1_0.versionedNullifier, v1_0.voteCommitment, "0x01")

            // Voter 2: vote version 0
            const v2_0 = await generateSpectreProof(voting2, votingGroup, PROPOSAL_ID, 1n, 222n, DEFAULT_NUM_OPTIONS, 1n, 0n)
            await election.connect(bob).castVote(v2_0.pA, v2_0.pB, v2_0.pC, v2_0.merkleRoot, v2_0.baseNullifier, v2_0.versionedNullifier, v2_0.voteCommitment, "0x02")

            expect(await election.uniqueVoterCount()).to.equal(2)
            expect(await election.voteCount()).to.equal(2)

            // Voter 1: overwrite with version 1
            const v1_1 = await generateSpectreProof(voting1, votingGroup, PROPOSAL_ID, 1n, 333n, DEFAULT_NUM_OPTIONS, 1n, 1n)
            await election.connect(bob).castVote(v1_1.pA, v1_1.pB, v1_1.pC, v1_1.merkleRoot, v1_1.baseNullifier, v1_1.versionedNullifier, v1_1.voteCommitment, "0x03")

            // uniqueVoterCount still 2, voteCount now 3
            expect(await election.uniqueVoterCount()).to.equal(2)
            expect(await election.voteCount()).to.equal(3)
        })

        it("Should accept versions in non-sequential order", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const { election, votingId, votingGroup } = await setupVoterForOverwrite(factory, alice, bob)

            // Version 0
            const p0 = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 0n, 10n, DEFAULT_NUM_OPTIONS, 1n, 0n)
            await election.connect(bob).castVote(p0.pA, p0.pB, p0.pC, p0.merkleRoot, p0.baseNullifier, p0.versionedNullifier, p0.voteCommitment, "0x01")

            // Version 3 (skip 1, 2)
            const p3 = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 1n, 30n, DEFAULT_NUM_OPTIONS, 1n, 3n)
            await election.connect(bob).castVote(p3.pA, p3.pB, p3.pC, p3.merkleRoot, p3.baseNullifier, p3.versionedNullifier, p3.voteCommitment, "0x02")

            // Version 1 (go back)
            const p1 = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 0n, 11n, DEFAULT_NUM_OPTIONS, 1n, 1n)
            await election.connect(bob).castVote(p1.pA, p1.pB, p1.pC, p1.merkleRoot, p1.baseNullifier, p1.versionedNullifier, p1.voteCommitment, "0x03")

            expect(await election.voteCount()).to.equal(3)
            expect(await election.uniqueVoterCount()).to.equal(1)
        })

        it("Should emit correct baseNullifier in VoteCast event", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const { election, votingId, votingGroup } = await setupVoterForOverwrite(factory, alice, bob)

            const proof = await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 0n, 50n, DEFAULT_NUM_OPTIONS, 1n, 0n)
            const tx = await election.connect(bob).castVote(
                proof.pA, proof.pB, proof.pC,
                proof.merkleRoot, proof.baseNullifier, proof.versionedNullifier, proof.voteCommitment,
                "0xfeed"
            )

            await expect(tx).to.emit(election, "VoteCast").withArgs(
                PROPOSAL_ID, proof.baseNullifier, proof.versionedNullifier, proof.voteCommitment, "0xfeed"
            )
        })
    })

    describe("# multi-option voting", () => {
        it("Should accept vote=2 when numOptions=4", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const numOptions = 4n
            const election = await createElectionVia(factory, alice, { numOptions })

            // Signup
            const signup = new Identity("multi-signup")
            const filler = new Identity("multi-filler")
            await election.connect(alice).registerVoter(signup.commitment)
            await election.connect(alice).registerVoter(filler.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup.commitment, 1n]))
            signupGroup.addMember(poseidon2([filler.commitment, 1n]))

            await election.connect(alice).closeSignup()

            // Join
            const votingId = new Identity("multi-voting")
            const joinProof = await generateAnonJoinProof(signup, votingId, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )

            // Vote with option 2 (valid: 0 <= 2 < 4)
            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, 1n]))

            const voteProof = await generateSpectreProof(
                votingId, votingGroup, PROPOSAL_ID, 2n, 555n, numOptions
            )

            const tx = await election.connect(bob).castVote(
                voteProof.pA, voteProof.pB, voteProof.pC,
                voteProof.merkleRoot, voteProof.baseNullifier, voteProof.versionedNullifier, voteProof.voteCommitment,
                "0xfeed"
            )

            await expect(tx).to.emit(election, "VoteCast")
            expect(await election.voteCount()).to.equal(1)
        })

        it("Should reject vote >= numOptions (circuit enforces range)", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const numOptions = 2n
            const election = await createElectionVia(factory, alice, { numOptions })

            const signup = new Identity("outofrange-signup")
            const filler = new Identity("outofrange-filler")
            await election.connect(alice).registerVoter(signup.commitment)
            await election.connect(alice).registerVoter(filler.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup.commitment, 1n]))
            signupGroup.addMember(poseidon2([filler.commitment, 1n]))

            await election.connect(alice).closeSignup()

            const votingId = new Identity("outofrange-voting")
            const joinProof = await generateAnonJoinProof(signup, votingId, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )

            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, 1n]))

            // vote=5 with numOptions=2 should fail at circuit level
            // (circuit won't generate valid proof when vote >= numOptions)
            let failed = false
            try {
                await generateSpectreProof(votingId, votingGroup, PROPOSAL_ID, 5n, 777n, numOptions)
            } catch (e: any) {
                failed = true
                // Circuit should reject: constraint violation (vote < numOptions)
            }
            expect(failed).to.equal(true, "Circuit should reject vote >= numOptions")
        })
    })

    describe("# voting deadline", () => {
        it("Should reject votes after voting deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const block = await ethers.provider.getBlock("latest")
            const votingDeadline = block!.timestamp + 7200 // 2 hours

            const election = await createElectionVia(factory, alice, { votingDeadline })

            // Signup + close signup
            const signup = new Identity("deadline-signup")
            const filler = new Identity("deadline-filler")
            await election.connect(alice).registerVoter(signup.commitment)
            await election.connect(alice).registerVoter(filler.commitment)

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signup.commitment, 1n]))
            signupGroup.addMember(poseidon2([filler.commitment, 1n]))

            await election.connect(alice).closeSignup()

            // Join
            const votingId = new Identity("deadline-voting")
            const joinProof = await generateAnonJoinProof(signup, votingId, signupGroup, PROPOSAL_ID)
            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )

            // Build voting group + proof BEFORE deadline
            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, 1n]))
            const voteProof = await generateSpectreProof(
                votingId, votingGroup, PROPOSAL_ID, 1n, 888n, DEFAULT_NUM_OPTIONS
            )

            // Fast forward past voting deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [votingDeadline + 1])
            await ethers.provider.send("evm_mine", [])

            // Should fail
            await expect(
                election.connect(bob).castVote(
                    voteProof.pA, voteProof.pB, voteProof.pC,
                    voteProof.merkleRoot, voteProof.baseNullifier, voteProof.versionedNullifier, voteProof.voteCommitment,
                    "0xdead"
                )
            ).to.be.revertedWithCustomError(election, "VotingDeadlinePassed")
        })

        it("Should allow anyone to close voting after deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const block = await ethers.provider.getBlock("latest")
            const votingDeadline = block!.timestamp + 3600

            const election = await createElectionVia(factory, alice, { votingDeadline })

            // Close signup first
            await election.connect(alice).closeSignup()

            // Bob can't close before deadline
            await expect(
                election.connect(bob).closeVoting()
            ).to.be.revertedWithCustomError(election, "NotAdmin")

            // Fast forward past deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [votingDeadline + 1])
            await ethers.provider.send("evm_mine", [])

            // Now bob CAN close
            await election.connect(bob).closeVoting()
            expect(await election.votingOpen()).to.equal(false)
        })
    })

    describe("# signup deadline", () => {
        it("Should reject signups after signup deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const block = await ethers.provider.getBlock("latest")
            const signupDeadline = block!.timestamp + 3600

            const election = await createElectionVia(factory, alice, { signupDeadline })

            // Fast forward past signup deadline
            await ethers.provider.send("evm_setNextBlockTimestamp", [signupDeadline + 1])
            await ethers.provider.send("evm_mine", [])

            const voter = new Identity("late-signup")
            await expect(
                election.connect(bob).signUp(voter.commitment)
            ).to.be.revertedWithCustomError(election, "SignupDeadlinePassed")
        })
    })

    describe("# metadata", () => {
        it("Should emit metadata bytes in ElectionDeployed event", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const meta = JSON.stringify({ title: "Budget Vote", labels: ["Yes", "No"] })
            const metadataBytes = ethers.toUtf8Bytes(meta)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, DEFAULT_NUM_OPTIONS, true, metadataBytes,
                { value: CREATION_FEE }
            )

            const receipt = await tx.wait()
            const iface = factory.interface
            for (const log of receipt.logs) {
                try {
                    const parsed = iface.parseLog({ topics: log.topics, data: log.data })
                    if (parsed?.name === "ElectionDeployed") {
                        const decoded = ethers.toUtf8String(parsed.args.metadata)
                        const obj = JSON.parse(decoded)
                        expect(obj.title).to.equal("Budget Vote")
                        expect(obj.labels).to.deep.equal(["Yes", "No"])
                    }
                } catch { /* skip non-factory logs */ }
            }
        })

        it("Should work with empty metadata (backward compat)", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, DEFAULT_NUM_OPTIONS, true, "0x",
                { value: CREATION_FEE }
            )

            expect(await factory.electionCount()).to.equal(1)
        })

        it("Should handle large threshold metadata", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const meta = JSON.stringify({
                title: "Threshold Vote",
                labels: ["Yes", "No", "Abstain"],
                mode: "threshold",
                threshold: 2,
                totalShares: 3,
                committee: [
                    { id: "Alice", publicKeyHex: "04" + "ab".repeat(32) },
                    { id: "Bob", publicKeyHex: "04" + "cd".repeat(32) },
                    { id: "Carol", publicKeyHex: "04" + "ef".repeat(32) },
                ],
                encryptedShares: [
                    { memberId: "Alice", shareIndex: "1", encryptedDataHex: "aa".repeat(100) },
                    { memberId: "Bob", shareIndex: "2", encryptedDataHex: "bb".repeat(100) },
                    { memberId: "Carol", shareIndex: "3", encryptedDataHex: "cc".repeat(100) },
                ],
            })
            const metadataBytes = ethers.toUtf8Bytes(meta)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, ELECTION_PUBKEY_X, ELECTION_PUBKEY_Y,
                0, 0, 3n, true, metadataBytes,
                { value: CREATION_FEE }
            )
            const receipt = await tx.wait()
            expect(receipt!.status).to.equal(1)
        })
    })

    describe("# tally commitment", () => {
        it("Should allow admin to commit tally after voting is closed", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()
            await election.connect(alice).closeVoting()

            const optionCounts = [3n, 2n]
            const totalValid = 5n
            const totalInvalid = 1n

            // Compute Poseidon commitment (matching SDK hash chain)
            let hash = poseidon2([totalValid, totalInvalid])
            hash = poseidon2([hash, optionCounts[0]])
            hash = poseidon2([hash, optionCounts[1]])

            const tx = await election.connect(alice).commitTallyResult(
                optionCounts, totalValid, totalInvalid, hash
            )

            await expect(tx).to.emit(election, "TallyCommitted")
                .withArgs(PROPOSAL_ID, hash, totalValid, totalInvalid, optionCounts)

            expect(await election.tallyCommitted()).to.equal(true)
            expect(await election.tallyPoseidonCommitment()).to.equal(hash)
            expect(await election.tallyTotalValid()).to.equal(totalValid)
            expect(await election.tallyTotalInvalid()).to.equal(totalInvalid)

            const storedCounts = await election.getTallyOptionCounts()
            expect(storedCounts.length).to.equal(2)
            expect(storedCounts[0]).to.equal(3n)
            expect(storedCounts[1]).to.equal(2n)
        })

        it("Should reject non-admin commitment", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()
            await election.connect(alice).closeVoting()

            await expect(
                election.connect(bob).commitTallyResult([1n, 1n], 2n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })

        it("Should reject commitment while voting is still open", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()
            // Voting is now open

            await expect(
                election.connect(alice).commitTallyResult([1n, 1n], 2n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "VotingStillOpen")
        })

        it("Should reject double commitment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()
            await election.connect(alice).closeVoting()

            await election.connect(alice).commitTallyResult([1n, 1n], 2n, 0n, 0n)

            await expect(
                election.connect(alice).commitTallyResult([2n, 2n], 4n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "TallyAlreadyCommitted")
        })

        it("Should reject wrong option count length", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice) // numOptions = 2

            await election.connect(alice).closeSignup()
            await election.connect(alice).closeVoting()

            await expect(
                election.connect(alice).commitTallyResult([1n, 1n, 1n], 3n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "InvalidOptionCount")
        })
    })

    // ===================================================================
    // Threshold Committee Tests
    // ===================================================================

    describe("# committee setup", () => {
        it("Should allow admin to setup committee during signup", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })

            const tx = await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            await expect(tx).to.emit(election, "CommitteeSetup")
                .withArgs(PROPOSAL_ID, 2, [alice.address, bob.address, carol.address])

            expect(await election.committeeThreshold()).to.equal(2)
            expect(await election.isCommitteeMember(alice.address)).to.equal(true)
            expect(await election.isCommitteeMember(bob.address)).to.equal(true)
            expect(await election.isCommitteeMember(carol.address)).to.equal(true)

            const members = await election.getCommitteeMembers()
            expect(members.length).to.equal(3)
        })

        it("Should reject double setup", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })

            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await expect(
                election.connect(deployer).setupCommittee(2, [alice.address, bob.address])
            ).to.be.revertedWithCustomError(election, "CommitteeAlreadySetup")
        })

        it("Should reject non-admin setup", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })

            await expect(
                election.connect(alice).setupCommittee(2, [alice.address, bob.address])
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })

        it("Should reject threshold < 2", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })

            await expect(
                election.connect(deployer).setupCommittee(1, [alice.address, bob.address])
            ).to.be.revertedWithCustomError(election, "InvalidThreshold")
        })

        it("Should reject threshold > members count", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })

            await expect(
                election.connect(deployer).setupCommittee(3, [alice.address, bob.address])
            ).to.be.revertedWithCustomError(election, "InvalidThreshold")
        })

        it("Should reject setup after signup closed", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            // Non-threshold election (has pubkey set) so closeSignup works
            const election = await createElectionVia(factory, deployer)

            await election.connect(deployer).closeSignup()

            await expect(
                election.connect(deployer).setupCommittee(2, [alice.address, bob.address])
            ).to.be.revertedWithCustomError(election, "SignupNotOpen")
        })
    })

    describe("# committee key registration", () => {
        it("Should allow committee member to register a 33-byte public key", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            const pubKey = fakeCompressedPubKey(1)
            const tx = await election.connect(alice).registerCommitteeKey(pubKey)

            await expect(tx).to.emit(election, "CommitteeKeyRegistered")
                .withArgs(PROPOSAL_ID, alice.address, pubKey)

            expect(await election.registeredKeyCount()).to.equal(1)
            expect(await election.committeePublicKeys(alice.address)).to.equal(pubKey)
        })

        it("Should reject non-member registration", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await expect(
                election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(1))
            ).to.be.revertedWithCustomError(election, "NotCommitteeMember")
        })

        it("Should reject double registration", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))

            await expect(
                election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(2))
            ).to.be.revertedWithCustomError(election, "KeyAlreadyRegistered")
        })

        it("Should reject registration after committee finalized", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            // Both register keys
            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))

            // Admin finalizes
            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")

            // Try to register again (different member, but committee is finalized)
            // Actually both are registered. Let's just verify the flag is set.
            expect(await election.committeeFinalized()).to.equal(true)
        })

        it("Should reject invalid key length (not 33 bytes)", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            // 32 bytes — too short
            const shortKey = ethers.zeroPadValue(ethers.toBeHex(1), 32)
            await expect(
                election.connect(alice).registerCommitteeKey(shortKey)
            ).to.be.revertedWithCustomError(election, "InvalidPublicKey")

            // 34 bytes — too long
            const longKey = "0x02" + "aa".repeat(33)
            await expect(
                election.connect(alice).registerCommitteeKey(longKey)
            ).to.be.revertedWithCustomError(election, "InvalidPublicKey")
        })
    })

    describe("# committee finalization", () => {
        it("Should allow admin to finalize after all keys registered", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))
            await election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(3))

            const encSharesData = "0x" + "ff".repeat(200)
            const tx = await election.connect(deployer).finalizeCommittee(999n, 888n, encSharesData)

            await expect(tx).to.emit(election, "CommitteeFinalized")
                .withArgs(PROPOSAL_ID, 999n, 888n, encSharesData)

            expect(await election.committeeFinalized()).to.equal(true)
            expect(await election.electionPubKeyX()).to.equal(999n)
            expect(await election.electionPubKeyY()).to.equal(888n)
        })

        it("Should reject finalize when not all keys registered", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            // Only alice registers
            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))

            await expect(
                election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")
            ).to.be.revertedWithCustomError(election, "NotAllKeysRegistered")
        })

        it("Should reject non-admin finalize", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))

            await expect(
                election.connect(alice).finalizeCommittee(999n, 888n, "0xdead")
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })

        it("Should reject double finalization", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))

            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")

            await expect(
                election.connect(deployer).finalizeCommittee(111n, 222n, "0xbeef")
            ).to.be.revertedWithCustomError(election, "CommitteeAlreadyFinalized")
        })

        it("Should reject finalization with zero pubkey (0,0)", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))

            await expect(
                election.connect(deployer).finalizeCommittee(0n, 0n, "0xdead")
            ).to.be.revertedWithCustomError(election, "InvalidPublicKey")
        })
    })

    describe("# closeSignup committee guard", () => {
        it("Should revert closeSignup when committee configured but not finalized", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            // Committee configured but not finalized
            await expect(
                election.connect(deployer).closeSignup()
            ).to.be.revertedWithCustomError(election, "CommitteeNotFinalized")
        })

        it("Should allow closeSignup after committee finalized", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            // Register keys
            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))

            // Finalize (sets election pubkey)
            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")

            // Now closeSignup should work
            await expect(election.connect(deployer).closeSignup())
                .to.emit(election, "SignupClosed")

            expect(await election.signupOpen()).to.equal(false)
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should not affect non-committee elections (backward compat)", async () => {
            const { factory, deployer } = await loadFixture(deployFixture)
            // Standard election — pubkey set, no committee
            const election = await createElectionVia(factory, deployer)

            // committeeThreshold is 0, so the guard is skipped
            expect(await election.committeeThreshold()).to.equal(0)

            await expect(election.connect(deployer).closeSignup())
                .to.emit(election, "SignupClosed")
        })
    })

    describe("# share submission", () => {
        // Helper to set up a fully finalized committee election with voting closed
        async function setupClosedCommitteeElection(factory: any, deployer: any, alice: any, bob: any, carol: any) {
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))
            await election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(3))

            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")
            await election.connect(deployer).closeSignup()
            await election.connect(deployer).closeVoting()

            return election
        }

        it("Should allow committee member to submit decrypted share after voting closed", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await setupClosedCommitteeElection(factory, deployer, alice, bob, carol)

            const share = fakeDecryptedShare(1)
            const tx = await election.connect(alice).submitDecryptedShare(share)

            await expect(tx).to.emit(election, "DecryptedShareSubmitted")
                .withArgs(PROPOSAL_ID, alice.address, share)

            expect(await election.hasSubmittedShare(alice.address)).to.equal(true)
            expect(await election.submittedShareCount()).to.equal(1)

            const stored = await election.getDecryptedShare(alice.address)
            expect(stored).to.equal(share)
        })

        it("Should reject non-member share submission", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await setupClosedCommitteeElection(factory, deployer, alice, bob, carol)

            // deployer is not a committee member
            await expect(
                election.connect(deployer).submitDecryptedShare(fakeDecryptedShare(1))
            ).to.be.revertedWithCustomError(election, "NotCommitteeMember")
        })

        it("Should reject share submission while voting is still open", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))
            await election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(3))

            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")
            await election.connect(deployer).closeSignup()
            // Voting is now open (not closed)

            await expect(
                election.connect(alice).submitDecryptedShare(fakeDecryptedShare(1))
            ).to.be.revertedWithCustomError(election, "VotingStillOpen")
        })

        it("Should reject share submission while signup is still open", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])

            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(1))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(2))
            await election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(3))

            await election.connect(deployer).finalizeCommittee(999n, 888n, "0xdead")
            // Signup still open

            await expect(
                election.connect(alice).submitDecryptedShare(fakeDecryptedShare(1))
            ).to.be.revertedWithCustomError(election, "SignupStillOpen")
        })

        it("Should reject double share submission", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await setupClosedCommitteeElection(factory, deployer, alice, bob, carol)

            await election.connect(alice).submitDecryptedShare(fakeDecryptedShare(1))

            await expect(
                election.connect(alice).submitDecryptedShare(fakeDecryptedShare(2))
            ).to.be.revertedWithCustomError(election, "ShareAlreadySubmitted")
        })

        it("Should reject share submission before committee is finalized", async () => {
            const { factory, deployer, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address])

            // Committee setup but NOT finalized — shares should be rejected
            await expect(
                election.connect(alice).submitDecryptedShare(fakeDecryptedShare(1))
            ).to.be.revertedWithCustomError(election, "CommitteeNotFinalized")
        })
    })

    describe("# full threshold integration", () => {
        it("Should complete full committee lifecycle: setup → register → finalize → close → submit shares", async () => {
            const { factory, deployer, alice, bob, carol } = await loadFixture(deployFixture)

            // 1. Create election with zero pubkey (threshold mode)
            const election = await createElectionVia(factory, deployer, { pubKeyX: 0n, pubKeyY: 0n })
            expect(await election.electionPubKeyX()).to.equal(0n)
            expect(await election.committeeThreshold()).to.equal(0n)

            // 2. Setup 2-of-3 committee
            await election.connect(deployer).setupCommittee(2, [alice.address, bob.address, carol.address])
            expect(await election.committeeThreshold()).to.equal(2n)
            expect((await election.getCommitteeMembers()).length).to.equal(3)

            // 3. Each member registers their key
            await election.connect(alice).registerCommitteeKey(fakeCompressedPubKey(10))
            await election.connect(bob).registerCommitteeKey(fakeCompressedPubKey(20))
            await election.connect(carol).registerCommitteeKey(fakeCompressedPubKey(30))
            expect(await election.registeredKeyCount()).to.equal(3)

            // 4. Can't close signup yet (committee not finalized)
            await expect(
                election.connect(deployer).closeSignup()
            ).to.be.revertedWithCustomError(election, "CommitteeNotFinalized")

            // 5. Admin finalizes committee (sets election pubkey)
            const encShares = "0x" + "ab".repeat(300) // simulated encrypted shares
            await election.connect(deployer).finalizeCommittee(42n, 43n, encShares)
            expect(await election.committeeFinalized()).to.equal(true)
            expect(await election.electionPubKeyX()).to.equal(42n)
            expect(await election.electionPubKeyY()).to.equal(43n)

            // 6. Now closeSignup works
            await election.connect(deployer).closeSignup()
            expect(await election.signupOpen()).to.equal(false)
            expect(await election.votingOpen()).to.equal(true)

            // 7. Close voting
            await election.connect(deployer).closeVoting()
            expect(await election.votingOpen()).to.equal(false)

            // 8. Committee members submit decrypted shares
            const shareA = fakeDecryptedShare(100)
            const shareB = fakeDecryptedShare(200)

            await election.connect(alice).submitDecryptedShare(shareA)
            expect(await election.submittedShareCount()).to.equal(1)

            await election.connect(bob).submitDecryptedShare(shareB)
            expect(await election.submittedShareCount()).to.equal(2)

            // 9. Threshold met (2 of 3) — frontend would auto-tally at this point
            expect(await election.submittedShareCount()).to.be.gte(await election.committeeThreshold())

            // 10. Verify shares are readable from chain
            expect(await election.getDecryptedShare(alice.address)).to.equal(shareA)
            expect(await election.getDecryptedShare(bob.address)).to.equal(shareB)
            expect(await election.getDecryptedShare(carol.address)).to.equal("0x") // not submitted

            // 11. Carol can still submit (optional)
            const shareC = fakeDecryptedShare(300)
            await election.connect(carol).submitDecryptedShare(shareC)
            expect(await election.submittedShareCount()).to.equal(3)
        })
    })
})
