import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers"
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
const DEFAULT_NUM_OPTIONS = 2n
const CREATION_FEE = ethers.parseEther("0.001")
const ONE_WEEK = 7 * 24 * 3600
const NO_GATE = ethers.ZeroHash

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

// Helper: a timestamp `offset` seconds after the latest block
async function fromNow(offset: number): Promise<number> {
    return (await time.latest()) + offset
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

        // carol plays the registrar (the relay) in gated elections
        return {
            factory, semaphore, voteVerifier, joinVerifier,
            semaphoreAddress, voteVerifierAddress, joinVerifierAddress,
            deployer, alice, bob, carol
        }
    }

    async function votingContractFactory() {
        return ethers.getContractFactory("SpectreVoting", {
            libraries: { PoseidonT3: _poseidonT3Address }
        })
    }

    // A contract object carrying SpectreVoting's ABI, for matching custom errors that
    // bubble up through the factory's `new SpectreVoting(...)`
    async function votingInterface() {
        return (await votingContractFactory()).attach(ethers.ZeroAddress)
    }

    // Helper: create an election via factory and return the contract instance
    async function createElectionVia(
        factory: any,
        admin: any,
        opts: {
            proposalId?: bigint,
            signupDeadline?: number,
            votingDeadline?: number,
            numOptions?: bigint,
            selfSignupAllowed?: boolean,
            registrar?: string,
            metadata?: string
        } = {}
    ) {
        const proposalId = opts.proposalId ?? PROPOSAL_ID
        const signupDeadline = opts.signupDeadline ?? 0
        const votingDeadline = opts.votingDeadline ?? await fromNow(ONE_WEEK)
        const numOptions = opts.numOptions ?? DEFAULT_NUM_OPTIONS
        const selfSignupAllowed = opts.selfSignupAllowed ?? true
        const registrar = opts.registrar ?? ethers.ZeroAddress
        const metadata = opts.metadata ? ethers.toUtf8Bytes(opts.metadata) : "0x"

        await factory.connect(admin).createElection(
            proposalId,
            signupDeadline,
            votingDeadline,
            numOptions,
            selfSignupAllowed,
            registrar,
            metadata,
            { value: CREATION_FEE }
        )

        const electionAddr = await factory.elections((await factory.electionCount()) - 1n)
        return (await votingContractFactory()).attach(electionAddr) as any
    }

    // Helper: default createElection arguments (open election, voting ends in a week)
    async function defaultArgs(proposalId: bigint = PROPOSAL_ID, numOptions: bigint = DEFAULT_NUM_OPTIONS) {
        return [proposalId, 0, await fromNow(ONE_WEEK), numOptions, true, ethers.ZeroAddress, "0x"] as const
    }

    // Helper: admin (or registrar) registers a voter with weight 1 and no gate key
    async function register(election: any, signer: any, identity: Identity, weight: bigint = 1n, gateKey: string = NO_GATE) {
        return election.connect(signer).registerVoter(identity.commitment, weight, gateKey)
    }

    // Helper: move past the voting deadline and close voting
    async function endVoting(election: any, caller: any) {
        const deadline: bigint = await election.votingDeadline()
        if (BigInt(await time.latest()) <= deadline) {
            await time.increaseTo(deadline + 1n)
        }
        return election.connect(caller).closeVoting()
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

            await factory.connect(alice).createElection(...(await defaultArgs()), { value: CREATION_FEE })

            expect(await factory.electionCount()).to.equal(1)
            expect(await ethers.provider.getBalance(await factory.getAddress())).to.equal(CREATION_FEE)
        })

        it("Should revert with insufficient fee", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await expect(
                factory.connect(alice).createElection(...(await defaultArgs()), { value: 0 })
            ).to.be.revertedWith("Insufficient fee")
        })

        it("Should refund overpayment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const overpay = ethers.parseEther("0.01")

            const balBefore = await ethers.provider.getBalance(alice.address)
            const tx = await factory.connect(alice).createElection(...(await defaultArgs()), { value: overpay })
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
            await factory.connect(alice).createElection(...(await defaultArgs(1n)), { value: CREATION_FEE })
            await factory.connect(alice).createElection(...(await defaultArgs(2n)), { value: CREATION_FEE })

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

            await factory.connect(alice).createElection(...(await defaultArgs()), { value: CREATION_FEE })

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
            expect(await election.registrar()).to.equal(ethers.ZeroAddress)
            expect(await election.VERSION()).to.equal(9n)
            expect(await election.MAX_WEIGHT()).to.equal(255n)
            // Phase 1: signup open, voting closed
            expect(await election.signupOpen()).to.equal(true)
            expect(await election.votingOpen()).to.equal(false)
        })

        it("Should support gated mode (selfSignupAllowed = false) with a registrar", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            expect(await election.selfSignupAllowed()).to.equal(false)
            expect(await election.registrar()).to.equal(carol.address)
            expect(await election.signupOpen()).to.equal(true)
        })

        it("Should emit RegistrarChanged from the new election when a registrar is set", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const votingDeadline = await fromNow(ONE_WEEK)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, 0, votingDeadline, DEFAULT_NUM_OPTIONS, false, carol.address, "0x",
                { value: CREATION_FEE }
            )
            const receipt = await tx.wait()
            const iface = (await votingContractFactory()).interface
            const changed = receipt!.logs
                .map((log: any) => { try { return iface.parseLog(log) } catch { return null } })
                .filter((p: any) => p?.name === "RegistrarChanged")
            expect(changed.length).to.equal(1)
            expect(changed[0]!.args.previousRegistrar).to.equal(ethers.ZeroAddress)
            expect(changed[0]!.args.newRegistrar).to.equal(carol.address)
        })

        it("Should reject numOptions < 2", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, 0, await fromNow(ONE_WEEK), 1, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidNumOptions")
        })

        it("Should allow multiple elections from different admins", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(...(await defaultArgs(1n, 2n)), { value: CREATION_FEE })
            await factory.connect(bob).createElection(...(await defaultArgs(2n, 4n)), { value: CREATION_FEE })
            await factory.connect(alice).createElection(...(await defaultArgs(3n, 3n)), { value: CREATION_FEE })

            expect(await factory.electionCount()).to.equal(3)

            const SpectreVoting = await votingContractFactory()

            const e1 = SpectreVoting.attach(await factory.elections(0)) as any
            const e2 = SpectreVoting.attach(await factory.elections(1)) as any
            const e3 = SpectreVoting.attach(await factory.elections(2)) as any

            expect(await e1.admin()).to.equal(alice.address)
            expect(await e2.admin()).to.equal(bob.address)
            expect(await e3.admin()).to.equal(alice.address)

            expect(await e1.numOptions()).to.equal(2n)
            expect(await e2.numOptions()).to.equal(4n)
            expect(await e3.numOptions()).to.equal(3n)
        })
    })

    describe("# deadline and option validation", () => {
        it("Should reject a zero voting deadline", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, 0, 0, DEFAULT_NUM_OPTIONS, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidDeadlines")
        })

        it("Should reject a voting deadline in the past", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()
            const past = await fromNow(0) // the creation block is later than this

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, 0, past, DEFAULT_NUM_OPTIONS, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidDeadlines")
        })

        it("Should reject a signup deadline at or after the voting deadline", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()
            const votingDeadline = await fromNow(3600)

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, votingDeadline, votingDeadline, DEFAULT_NUM_OPTIONS, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidDeadlines")

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, votingDeadline + 60, votingDeadline, DEFAULT_NUM_OPTIONS, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidDeadlines")
        })

        it("Should reject a non-zero signup deadline in the past", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, await fromNow(0), await fromNow(ONE_WEEK), DEFAULT_NUM_OPTIONS, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidDeadlines")
        })

        it("Should reject numOptions > 255", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const sv = await votingInterface()

            await expect(
                factory.connect(alice).createElection(
                    PROPOSAL_ID, 0, await fromNow(ONE_WEEK), 256, true, ethers.ZeroAddress, "0x",
                    { value: CREATION_FEE }
                )
            ).to.be.revertedWithCustomError(sv, "InvalidNumOptions")
        })

        it("Should accept a valid signup deadline before the voting deadline", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const signupDeadline = await fromNow(3600)
            const votingDeadline = await fromNow(7200)

            const election = await createElectionVia(factory, alice, { signupDeadline, votingDeadline })
            expect(await election.signupDeadline()).to.equal(BigInt(signupDeadline))
            expect(await election.votingDeadline()).to.equal(BigInt(votingDeadline))
        })
    })

    describe("# getElections", () => {
        it("Should return paginated election list", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            for (let i = 0; i < 5; i++) {
                await factory.connect(alice).createElection(...(await defaultArgs(BigInt(i + 1))), { value: CREATION_FEE })
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
        it("Should allow anyone to sign up during signup phase (weight 1)", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter = new Identity("signup-voter")

            // Bob (non-admin) can sign up
            await expect(election.connect(bob).signUp(voter.commitment))
                .to.emit(election, "VoterSignedUp")
                .withArgs(await election.signupGroupId(), voter.commitment, 1n)
        })

        it("Should allow admin to register voters during signup", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            const voter = new Identity("admin-reg-voter")

            await expect(register(election, alice, voter))
                .to.emit(election, "VoterSignedUp")
                .withArgs(await election.signupGroupId(), voter.commitment, 1n)
        })

        it("Should reject registerVoter from a non-admin, non-registrar", async () => {
            const { factory, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("sneaky-voter")

            await expect(
                register(election, bob, voter)
            ).to.be.revertedWithCustomError(election, "NotAuthorized")
        })

        it("Should reject zero identity commitment", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await expect(
                election.connect(alice).registerVoter(0, 1, NO_GATE)
            ).to.be.revertedWithCustomError(election, "InvalidCommitment")

            await expect(
                election.connect(bob).signUp(0)
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
            await expect(register(election, alice, voter))
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

        it("Should emit one VoterSignedUp per voter from registerVoters", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false })

            const voters = [new Identity("bulk-1"), new Identity("bulk-2"), new Identity("bulk-3")]
            const tx = await election.connect(alice).registerVoters(voters.map(v => v.commitment))
            const receipt = await tx.wait()

            const signupGroupId = await election.signupGroupId()
            const events = receipt!.logs
                .map((log: any) => { try { return election.interface.parseLog(log) } catch { return null } })
                .filter((p: any) => p?.name === "VoterSignedUp")

            expect(events.length).to.equal(3)
            events.forEach((e: any, i: number) => {
                expect(e.args.signupGroupId).to.equal(signupGroupId)
                expect(e.args.identityCommitment).to.equal(voters[i].commitment)
                expect(e.args.weight).to.equal(1n)
            })
        })

        it("Should reject registerVoters from a non-admin (including the registrar)", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            await expect(
                election.connect(carol).registerVoters([new Identity("bulk-x").commitment])
            ).to.be.revertedWithCustomError(election, "NotAdmin")
        })
    })

    describe("# registrar and gate keys", () => {
        it("Should let the registrar register a voter with a weight and gate key", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("registrar-voter")
            const gateKey = ethers.id("invite-code:abcd1234")

            await expect(register(election, carol, voter, 7n, gateKey))
                .to.emit(election, "VoterSignedUp")
                .withArgs(await election.signupGroupId(), voter.commitment, 7n)

            expect(await election.usedGateKeys(gateKey)).to.equal(true)
        })

        it("Should store the weighted leaf Poseidon(commitment, weight) in the signup group", async () => {
            const { factory, semaphore, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("leaf-check")
            await register(election, carol, voter, 5n, ethers.id("leaf-check"))

            const group = new Group()
            group.addMember(poseidon2([voter.commitment, 5n]))
            expect(await semaphore.getMerkleTreeRoot(await election.signupGroupId())).to.equal(group.root)
        })

        it("Should let the admin call registerVoter with a weight", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("admin-weighted")
            await expect(register(election, alice, voter, 2n, ethers.id("admin-weighted")))
                .to.emit(election, "VoterSignedUp")
                .withArgs(await election.signupGroupId(), voter.commitment, 2n)
        })

        it("Should reject weight 0 and weight 256", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("bad-weight")
            await expect(register(election, carol, voter, 0n))
                .to.be.revertedWithCustomError(election, "InvalidWeight")
            await expect(register(election, carol, voter, 256n))
                .to.be.revertedWithCustomError(election, "InvalidWeight")

            // The bounds themselves are fine
            await register(election, carol, voter, 255n, ethers.id("weight-255"))
            await register(election, carol, new Identity("min-weight"), 1n, ethers.id("weight-1"))
        })

        it("Should reject a reused gate key but allow a zero gate key to repeat", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const gateKey = ethers.id("email:someone@example.org")
            await register(election, carol, new Identity("gate-1"), 1n, gateKey)

            await expect(register(election, carol, new Identity("gate-2"), 1n, gateKey))
                .to.be.revertedWithCustomError(election, "GateKeyAlreadyUsed")

            // The admin is bound by the same gate key
            await expect(register(election, alice, new Identity("gate-3"), 1n, gateKey))
                .to.be.revertedWithCustomError(election, "GateKeyAlreadyUsed")

            // The registrar must always name a gate key
            await expect(register(election, carol, new Identity("nogate-registrar"), 1n, NO_GATE))
                .to.be.revertedWithCustomError(election, "InvalidGateKey")

            // The admin may register without one, and repeats are allowed (manual registration)
            await register(election, alice, new Identity("nogate-1"), 1n, NO_GATE)
            await register(election, alice, new Identity("nogate-2"), 1n, NO_GATE)
            expect(await election.usedGateKeys(NO_GATE)).to.equal(false)
        })

        it("Should reject registrar registration after signup closes", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            await election.connect(alice).closeSignup()

            await expect(register(election, carol, new Identity("too-late"), 1n, ethers.id("too-late")))
                .to.be.revertedWithCustomError(election, "SignupNotOpen")
        })

        it("Should make setRegistrar admin-only and emit RegistrarChanged", async () => {
            const { factory, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            await expect(election.connect(bob).setRegistrar(bob.address))
                .to.be.revertedWithCustomError(election, "NotAdmin")
            await expect(election.connect(carol).setRegistrar(bob.address))
                .to.be.revertedWithCustomError(election, "NotAdmin")

            await expect(election.connect(alice).setRegistrar(bob.address))
                .to.emit(election, "RegistrarChanged")
                .withArgs(carol.address, bob.address)
            expect(await election.registrar()).to.equal(bob.address)

            // The old registrar loses access; the new one has it
            await expect(register(election, carol, new Identity("old-registrar")))
                .to.be.revertedWithCustomError(election, "NotAuthorized")
            await register(election, bob, new Identity("new-registrar"), 1n, ethers.id("new-registrar"))

            // Clearing the registrar leaves only the admin
            await expect(election.connect(alice).setRegistrar(ethers.ZeroAddress))
                .to.emit(election, "RegistrarChanged")
                .withArgs(bob.address, ethers.ZeroAddress)
            await expect(register(election, bob, new Identity("cleared")))
                .to.be.revertedWithCustomError(election, "NotAuthorized")
        })

        it("Should gate signup: self-signup reverts while registrar registration works", async () => {
            const { factory, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const voter = new Identity("gated-flow")
            await expect(election.connect(bob).signUp(voter.commitment))
                .to.be.revertedWithCustomError(election, "SelfSignupNotAllowed")
            // Even the registrar can't use the open path
            await expect(election.connect(carol).signUp(voter.commitment))
                .to.be.revertedWithCustomError(election, "SelfSignupNotAllowed")

            await expect(register(election, carol, voter, 1n, ethers.id("allowlist:voter@example.org")))
                .to.emit(election, "VoterSignedUp")
                .withArgs(await election.signupGroupId(), voter.commitment, 1n)
        })

        it("Should complete a weighted flow: register (weight 3) → closeSignup → anonJoin → castVote", async () => {
            const { factory, alice, bob, carol } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice, { selfSignupAllowed: false, registrar: carol.address })

            const WEIGHT = 3n
            const signupId = new Identity("weighted-signup")
            const fillerId = new Identity("weighted-filler")
            await register(election, carol, signupId, WEIGHT, ethers.id("token:0x01"))
            await register(election, carol, fillerId, 1n, ethers.id("token:0x02"))

            const signupGroup = new Group()
            signupGroup.addMember(poseidon2([signupId.commitment, WEIGHT]))
            signupGroup.addMember(poseidon2([fillerId.commitment, 1n]))

            await election.connect(alice).closeSignup()

            const votingId = new Identity("weighted-voting")
            const joinProof = await generateAnonJoinProof(signupId, votingId, signupGroup, PROPOSAL_ID, WEIGHT)
            // The re-keyed leaf carries the weight
            expect(BigInt(joinProof.newCommitment)).to.equal(poseidon2([votingId.commitment, WEIGHT]))

            await election.connect(bob).anonJoin(
                joinProof.pA, joinProof.pB, joinProof.pC,
                joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
            )

            const votingGroup = new Group()
            votingGroup.addMember(poseidon2([votingId.commitment, WEIGHT]))

            const voteProof = await generateSpectreProof(
                votingId, votingGroup, PROPOSAL_ID, 1n, 4242n, DEFAULT_NUM_OPTIONS, WEIGHT, 0n
            )

            const tx = await election.connect(bob).castVote(
                voteProof.pA, voteProof.pB, voteProof.pC,
                voteProof.merkleRoot, voteProof.baseNullifier, voteProof.versionedNullifier, voteProof.voteCommitment,
                "0xbeef"
            )
            await expect(tx).to.emit(election, "VoteCast")
            expect(await election.voteCount()).to.equal(1)
            expect(await election.uniqueVoterCount()).to.equal(1)
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

            const signupDeadline = await fromNow(3600)
            const election = await createElectionVia(factory, alice, { signupDeadline })

            // Bob can't close before deadline
            await expect(
                election.connect(bob).closeSignup()
            ).to.be.revertedWithCustomError(election, "NotAdmin")

            // Fast forward past signup deadline
            await time.increaseTo(signupDeadline + 1)

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
            await register(election, alice, voter1)
            await register(election, alice, filler)

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
            await register(election, alice, voter1)
            await register(election, alice, filler)

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
            await register(election, alice, signupId)
            await register(election, alice, fillerId)

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
            await register(election, alice, signup1)
            await register(election, alice, signup2)

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

    describe("# vote overwriting", () => {
        // Helper to set up a single voter ready to cast votes
        async function setupVoterForOverwrite(factory: any, alice: any, bob: any) {
            const election = await createElectionVia(factory, alice)
            const signup = new Identity("overwrite-signup")
            await register(election, alice, signup)
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
            await register(election, alice, signup1)
            await register(election, alice, signup2)
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
            await register(election, alice, signup)
            await register(election, alice, filler)

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
            await register(election, alice, signup)
            await register(election, alice, filler)

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

            const votingDeadline = await fromNow(7200) // 2 hours

            const election = await createElectionVia(factory, alice, { votingDeadline })

            // Signup + close signup
            const signup = new Identity("deadline-signup")
            const filler = new Identity("deadline-filler")
            await register(election, alice, signup)
            await register(election, alice, filler)

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
            await time.increaseTo(votingDeadline + 1)

            // Should fail
            await expect(
                election.connect(bob).castVote(
                    voteProof.pA, voteProof.pB, voteProof.pC,
                    voteProof.merkleRoot, voteProof.baseNullifier, voteProof.versionedNullifier, voteProof.voteCommitment,
                    "0xdead"
                )
            ).to.be.revertedWithCustomError(election, "VotingDeadlinePassed")
        })

        it("Should reject closeVoting before the deadline, even from the admin", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const votingDeadline = await fromNow(3600)
            const election = await createElectionVia(factory, alice, { votingDeadline })

            await election.connect(alice).closeSignup()

            await expect(
                election.connect(alice).closeVoting()
            ).to.be.revertedWithCustomError(election, "VotingNotEnded")
            await expect(
                election.connect(bob).closeVoting()
            ).to.be.revertedWithCustomError(election, "VotingNotEnded")

            // Exactly at the deadline voting is still open
            await time.setNextBlockTimestamp(votingDeadline)
            await expect(
                election.connect(alice).closeVoting()
            ).to.be.revertedWithCustomError(election, "VotingNotEnded")
            expect(await election.votingOpen()).to.equal(true)
        })

        it("Should allow anyone to close voting after deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const votingDeadline = await fromNow(3600)
            const election = await createElectionVia(factory, alice, { votingDeadline })

            // Close signup first
            await election.connect(alice).closeSignup()

            // Fast forward past deadline
            await time.increaseTo(votingDeadline + 1)

            // Now bob CAN close
            await expect(election.connect(bob).closeVoting())
                .to.emit(election, "VotingClosed")
                .withArgs(PROPOSAL_ID, 0n)
            expect(await election.votingOpen()).to.equal(false)

            // And it can't be closed twice
            await expect(
                election.connect(alice).closeVoting()
            ).to.be.revertedWithCustomError(election, "VotingNotOpen")
        })

        it("Should reject closeVoting while signup is still open", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const votingDeadline = await fromNow(3600)
            const election = await createElectionVia(factory, alice, { votingDeadline })

            await time.increaseTo(votingDeadline + 1)
            await expect(
                election.connect(alice).closeVoting()
            ).to.be.revertedWithCustomError(election, "VotingNotOpen")
        })
    })

    describe("# signup deadline", () => {
        it("Should reject signups after signup deadline", async () => {
            const { factory, alice, bob } = await loadFixture(deployFixture)

            const signupDeadline = await fromNow(3600)

            const election = await createElectionVia(factory, alice, { signupDeadline })

            // Fast forward past signup deadline
            await time.increaseTo(signupDeadline + 1)

            const voter = new Identity("late-signup")
            await expect(
                election.connect(bob).signUp(voter.commitment)
            ).to.be.revertedWithCustomError(election, "SignupDeadlinePassed")
        })
    })

    describe("# metadata", () => {
        it("Should emit metadata, deadlines and registrar in ElectionDeployed", async () => {
            const { factory, alice, carol } = await loadFixture(deployFixture)
            const meta = JSON.stringify({ title: "Budget Vote", labels: ["Yes", "No"] })
            const metadataBytes = ethers.toUtf8Bytes(meta)
            const signupDeadline = await fromNow(3600)
            const votingDeadline = await fromNow(ONE_WEEK)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, signupDeadline, votingDeadline, DEFAULT_NUM_OPTIONS, false, carol.address, metadataBytes,
                { value: CREATION_FEE }
            )

            const receipt = await tx.wait()
            const iface = factory.interface
            let found = false
            for (const log of receipt!.logs) {
                let parsed: any = null
                try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }) } catch { /* skip non-factory logs */ }
                if (parsed?.name === "ElectionDeployed") {
                    found = true
                    const obj = JSON.parse(ethers.toUtf8String(parsed.args.metadata))
                    expect(obj.title).to.equal("Budget Vote")
                    expect(obj.labels).to.deep.equal(["Yes", "No"])
                    expect(parsed.args.admin).to.equal(alice.address)
                    expect(parsed.args.proposalId).to.equal(PROPOSAL_ID)
                    expect(parsed.args.signupDeadline).to.equal(BigInt(signupDeadline))
                    expect(parsed.args.votingDeadline).to.equal(BigInt(votingDeadline))
                    expect(parsed.args.numOptions).to.equal(DEFAULT_NUM_OPTIONS)
                    expect(parsed.args.selfSignupAllowed).to.equal(false)
                    expect(parsed.args.registrar).to.equal(carol.address)
                }
            }
            expect(found).to.equal(true)
        })

        it("Should work with empty metadata", async () => {
            const { factory, alice } = await loadFixture(deployFixture)

            await factory.connect(alice).createElection(...(await defaultArgs()), { value: CREATION_FEE })

            expect(await factory.electionCount()).to.equal(1)
        })

        it("Should handle large metadata", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const meta = JSON.stringify({
                title: "Large metadata",
                labels: ["Yes", "No", "Abstain"],
                gateType: "allowlist",
                allowlist: {
                    totalEntries: 50,
                    identifierHashes: Array.from({ length: 50 }, (_, i) => ethers.id(`voter-${i}@example.org`)),
                },
            })
            const metadataBytes = ethers.toUtf8Bytes(meta)

            const tx = await factory.connect(alice).createElection(
                PROPOSAL_ID, 0, await fromNow(ONE_WEEK), 3n, false, ethers.ZeroAddress, metadataBytes,
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
            await endVoting(election, alice)

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
            await endVoting(election, bob)

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

        it("Should reject commitment while signup is still open", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await expect(
                election.connect(alice).commitTallyResult([1n, 1n], 2n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "SignupStillOpen")
        })

        it("Should reject double commitment", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice)

            await election.connect(alice).closeSignup()
            await endVoting(election, alice)

            await election.connect(alice).commitTallyResult([1n, 1n], 2n, 0n, 0n)

            await expect(
                election.connect(alice).commitTallyResult([2n, 2n], 4n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "TallyAlreadyCommitted")
        })

        it("Should reject wrong option count length", async () => {
            const { factory, alice } = await loadFixture(deployFixture)
            const election = await createElectionVia(factory, alice) // numOptions = 2

            await election.connect(alice).closeSignup()
            await endVoting(election, alice)

            await expect(
                election.connect(alice).commitTallyResult([1n, 1n, 1n], 3n, 0n, 0n)
            ).to.be.revertedWithCustomError(election, "InvalidOptionCount")
        })
    })
})
