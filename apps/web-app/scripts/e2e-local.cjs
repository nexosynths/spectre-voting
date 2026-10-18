// End-to-end check of the v9 trust model against a local hardhat chain, using the real
// relay route, contracts, ZK circuits and ballot sealing (with a mock drand key so ballots
// can be opened offline):
//   - gated signup goes through the relay as registrar, one registration per credential
//   - joins and ballots are submitted by the relay, never a voter wallet
//   - nobody can close voting before the deadline; anyone can after it
//   - anyone can open the time-locked ballots and recount; the committed tally is checked
//
// Usage (from the repo root, after `yarn`):
//   1. cd apps/contracts && npx hardhat node
//   2. npx hardhat run scripts/deploy-factory.ts --network localhost   (note the factory and Semaphore addresses)
//   3. Make sure apps/circuits/build/ has the circuit files (copy from apps/web-app/public/circuits/)
//   4. node apps/web-app/scripts/e2e-local.cjs <factory> <semaphore>
const path = require("path")
const fs = require("fs")
const os = require("os")
const Module = require("module")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "../../..")
const WEB = ROOT + "/apps/web-app/src"
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "spectre-e2e-"))
const ts = require(require.resolve("typescript", { paths: [ROOT] }))
const [FACTORY, SEMAPHORE] = process.argv.slice(2)
if (!FACTORY || !SEMAPHORE) throw new Error("usage: node e2e-local.cjs <factory> <semaphore>")

// ── Transpile the real web-app modules, swapping in local chain config ──
const compile = (rel, outName) => {
    const src = fs.readFileSync(path.join(WEB, rel), "utf8")
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText
    fs.writeFileSync(path.join(OUT, outName), js)
}
compile("app/api/relay/route.ts", "route.js")
compile("lib/contracts.ts", "contracts.real.js")
compile("lib/gate.ts", "gate.js")
compile("lib/ballot.ts", "ballot.js")
compile("lib/tally.ts", "tally.js")
fs.writeFileSync(path.join(OUT, "contracts.js"), `const real = require("./contracts.real.js")
module.exports = { ...real, CONTRACTS: { FACTORY: "${FACTORY}", SEMAPHORE: "${SEMAPHORE}" }, FACTORY_CONFIGURED: true, RPC_URL: "http://127.0.0.1:8545", FACTORY_DEPLOY_BLOCK: 0 }`)
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
    if (request.startsWith("@/lib/")) return path.join(OUT, request.slice("@/lib/".length) + ".js")
    try {
        return origResolve.call(this, request, parent, ...rest)
    } catch (err) {
        return require.resolve(request, { paths: [ROOT, ROOT + "/apps/web-app"] })
    }
}

const { ethers } = require("ethers")
const { Identity, Group } = require("@semaphore-protocol/core")
const { poseidon2 } = require("poseidon-lite")
const { groth16 } = require("snarkjs")
const { bls12_381 } = require(require.resolve("@noble/curves/bls12-381", { paths: [ROOT + "/node_modules/tlock-js", ROOT] }))
const { sha256 } = require(require.resolve("@noble/hashes/sha256", { paths: [ROOT + "/node_modules/tlock-js", ROOT] }))

// Hardhat default accounts
const KEYS = {
    deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    admin: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    attacker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    relayer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
}
process.env.RELAYER_PRIVATE_KEY = KEYS.relayer
delete process.env.GATE_KEY_SECRET

const route = require(path.join(OUT, "route.js"))
const contractsMod = require(path.join(OUT, "contracts.js"))
const ballot = require(path.join(OUT, "ballot.js"))
const tally = require(path.join(OUT, "tally.js"))

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 })
const admin = new ethers.Wallet(KEYS.admin, provider)
const attacker = new ethers.Wallet(KEYS.attacker, provider)
const relayerAddress = new ethers.Wallet(KEYS.relayer).address
const factory = new ethers.Contract(FACTORY, contractsMod.FACTORY_ABI, admin)
const SEM_ABI = contractsMod.SEMAPHORE_ABI

const CIRC = ROOT + "/apps/circuits/build"
const MAX_DEPTH = 20

async function relay(body) {
    const req = new Request("http://localhost/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
        body: JSON.stringify(body),
    })
    const res = await route.POST(req)
    return { status: res.status, json: await res.json() }
}

async function mined(hash) {
    const receipt = await provider.waitForTransaction(hash)
    assert.strictEqual(receipt.status, 1, "tx reverted")
    return receipt
}

async function expectRevert(promise, errorName) {
    try { await promise } catch (err) {
        const data = err?.data || err?.info?.error?.data
        const iface = new ethers.Interface(contractsMod.SPECTRE_VOTING_ABI)
        let name = err?.revert?.name
        if (!name && typeof data === "string") { try { name = iface.parseError(data)?.name } catch {} }
        if (!name && err?.message?.includes(errorName)) name = errorName
        assert.strictEqual(name, errorName, `expected ${errorName}, got ${name || err.message}`)
        return
    }
    throw new Error(`expected revert ${errorName}`)
}

async function groupMembers(groupId) {
    const sem = new ethers.Contract(SEMAPHORE, SEM_ABI, provider)
    const singles = await sem.queryFilter(sem.filters.MemberAdded(groupId), 0, "latest")
    const bulks = await sem.queryFilter(sem.filters.MembersAdded(groupId), 0, "latest")
    const members = []
    for (const e of singles) members.push({ i: Number(e.args.index), c: e.args.identityCommitment })
    for (const e of bulks) e.args.identityCommitments.forEach((c, k) => members.push({ i: Number(e.args.startIndex) + k, c }))
    members.sort((a, b) => a.i - b.i)
    const group = new Group()
    for (const m of members) group.addMember(m.c)
    return group
}

function proofParts(proof) {
    return {
        pA: [proof.pi_a[0], proof.pi_a[1]],
        pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
        pC: [proof.pi_c[0], proof.pi_c[1]],
    }
}

async function joinProof(signupId, votingId, group, electionId, weight = 1n) {
    const mp = group.generateMerkleProof(group.indexOf(poseidon2([signupId.commitment, weight])))
    const siblings = mp.siblings.map(String); while (siblings.length < MAX_DEPTH) siblings.push("0")
    const { proof, publicSignals } = await groth16.fullProve({
        secret: signupId.secretScalar.toString(), newSecret: votingId.secretScalar.toString(), weight: weight.toString(),
        merkleProofLength: mp.siblings.length, merkleProofIndex: mp.index, merkleProofSiblings: siblings, electionId: electionId.toString(),
    }, `${CIRC}/AnonJoin_js/AnonJoin.wasm`, `${CIRC}/AnonJoin.zkey`)
    return { ...proofParts(proof), signupMerkleRoot: publicSignals[0], joinNullifier: publicSignals[1], newCommitment: publicSignals[2] }
}

async function voteProof(votingId, group, proposalId, vote, rand, numOptions, weight = 1n, version = 0n) {
    const mp = group.generateMerkleProof(group.indexOf(poseidon2([votingId.commitment, weight])))
    const siblings = mp.siblings.map(String); while (siblings.length < MAX_DEPTH) siblings.push("0")
    const { proof, publicSignals } = await groth16.fullProve({
        secret: votingId.secretScalar.toString(), weight: weight.toString(), merkleProofLength: mp.siblings.length,
        merkleProofIndex: mp.index, merkleProofSiblings: siblings, proposalId: proposalId.toString(), vote: vote.toString(),
        voteRandomness: rand.toString(), numOptions: numOptions.toString(), version: version.toString(),
    }, `${CIRC}/SpectreVote_js/SpectreVote.wasm`, `${CIRC}/SpectreVote.zkey`)
    return { ...proofParts(proof), merkleTreeRoot: publicSignals[0], baseNullifier: publicSignals[1], versionedNullifier: publicSignals[2], voteCommitment: publicSignals[3] }
}

// Mock drand chain (our own BLS key, RFC 9380 G1 signatures) so ballots can be opened offline
const drandSk = bls12_381.utils.randomPrivateKey()
const mockChain = { ...ballot.QUICKNET, public_key: Buffer.from(bls12_381.getPublicKeyForShortSignatures(drandSk)).toString("hex"), hash: "bb".repeat(32), genesis_time: Math.floor(Date.now() / 1000) - 86400 }
function beaconFor(round) {
    const msg = new Uint8Array(8); new DataView(msg.buffer).setBigUint64(0, BigInt(round))
    const sig = bls12_381.signShortSignature(sha256(msg), drandSk)
    const bytes = sig instanceof Uint8Array ? sig : sig.toRawBytes(true)
    return { round, randomness: Buffer.from(sha256(bytes)).toString("hex"), signature: Buffer.from(bytes).toString("hex") }
}

async function createElection({ selfSignup, registrar, meta, numOptions = 3, votingIn = 600 }) {
    const now = (await provider.getBlock("latest")).timestamp
    const fee = await factory.creationFee()
    const tx = await factory.createElection(BigInt(now), 0, now + votingIn, numOptions, selfSignup, registrar, ethers.toUtf8Bytes(JSON.stringify(meta)), { value: fee })
    const receipt = await tx.wait()
    const parsed = receipt.logs.map(l => { try { return factory.interface.parseLog(l) } catch { return null } }).find(p => p?.name === "ElectionDeployed")
    return { address: parsed.args.election, deadline: now + votingIn }
}

;(async () => {
    const realNow = Date.now
    const results = []
    const ok = (name) => { results.push(name); console.log("  ✓", name) }

    // GET: relay advertises its registrar address
    const get = await (await route.GET()).json()
    assert.strictEqual(get.relayerAddress, relayerAddress); ok("GET returns the relay's address")

    const codes = ["a1b2c3d4", "0f0f0f0f"]
    const invite = await createElection({
        selfSignup: false, registrar: relayerAddress,
        meta: { title: "Invite", labels: ["A", "B", "C"], gateType: "invite-codes", gaslessEnabled: true, inviteCodes: { totalCodes: 2, codeHashes: codes.map(c => ethers.keccak256(ethers.toUtf8Bytes(c))) } },
    })
    const inviteC = new ethers.Contract(invite.address, contractsMod.SPECTRE_VOTING_ABI, admin)
    const open = await createElection({ selfSignup: true, registrar: ethers.ZeroAddress, meta: { title: "Open", labels: ["Y", "N"], gaslessEnabled: true }, numOptions: 2 })
    const adminOnly = await createElection({ selfSignup: false, registrar: ethers.ZeroAddress, meta: { title: "Admin only", labels: ["Y", "N"] }, numOptions: 2 })

    const voterA = new Identity(), voterB = new Identity(), intruder = new Identity()

    // invite-code gate enforced by the contract, checked by the relay
    let r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString() })
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /Invite code required/); ok("signup without a code is refused")
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: "zzzz" })
    assert.match(r.json.error, /format/); ok("malformed code is refused")
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: "deadbeef" })
    assert.match(r.json.error, /Invalid invite code/); ok("unknown code is refused")
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: codes[0] })
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json))
    const regReceipt = await mined(r.json.txHash)
    const regEvent = regReceipt.logs.map(l => { try { return inviteC.interface.parseLog(l) } catch { return null } }).find(p => p?.name === "VoterSignedUp")
    assert.strictEqual(regEvent.args.identityCommitment, voterA.commitment); assert.strictEqual(regEvent.args.weight, 1n)
    assert.strictEqual(regReceipt.from.toLowerCase(), relayerAddress.toLowerCase())
    ok("valid code registers the voter through registerVoter (sent by the relay)")
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: intruder.commitment.toString(), code: codes[0] })
    assert.match(r.json.error, /already been used/); ok("a used code is refused (on-chain gate key)")
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterB.commitment.toString(), code: codes[1].toUpperCase() })
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash); ok("second code registers voter B (case-insensitive)")

    await expectRevert(inviteC.connect(attacker).signUp(intruder.commitment), "SelfSignupNotAllowed"); ok("direct signUp() bypass reverts")
    await expectRevert(inviteC.connect(attacker).registerVoter(intruder.commitment, 1, ethers.id("x")), "NotAuthorized"); ok("direct registerVoter() by a stranger reverts")

    r = await relay({ action: "signUp", electionAddress: adminOnly.address, identityCommitment: intruder.commitment.toString() })
    assert.match(r.json.error, /organizer registers voters directly/); ok("relay refuses elections where it isn't the registrar")
    r = await relay({ action: "signUp", electionAddress: open.address, identityCommitment: intruder.commitment.toString() })
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash); ok("open election: relay calls signUp()")

    // Close signup, then join + vote through the relay
    await (await inviteC.closeSignup()).wait()
    const proposalId = await inviteC.proposalId()
    const signupGroup = await groupMembers(await inviteC.signupGroupId())
    const votingA = new Identity(), votingB = new Identity()
    for (const [signupId, votingId] of [[voterA, votingA], [voterB, votingB]]) {
        const jp = await joinProof(signupId, votingId, signupGroup, proposalId)
        r = await relay({ action: "anonJoin", electionAddress: invite.address, ...jp })
        assert.strictEqual(r.json.success, true, JSON.stringify(r.json))
        const rc = await mined(r.json.txHash)
        assert.strictEqual(rc.from.toLowerCase(), relayerAddress.toLowerCase())
    }
    ok("anonJoin relayed for both voters (sender is the relay)")

    const votingGroup = await groupMembers(await inviteC.votingGroupId())
    const cast = async (votingId, vote, version, payloadVote = vote) => {
        const rand = 123456789n + BigInt(version) + BigInt(vote) * 1000n
        const vp = await voteProof(votingId, votingGroup, proposalId, BigInt(vote), rand, 3n, 1n, BigInt(version))
        const sealed = await ballot.sealBallot(ballot.encodeVotePayload(BigInt(payloadVote), 1n, rand), invite.deadline, mockChain)
        r = await relay({ action: "castVote", electionAddress: invite.address, ...vp, encryptedBlob: ethers.hexlify(sealed) })
        assert.strictEqual(r.json.success, true, JSON.stringify(r.json))
        const rc = await mined(r.json.txHash)
        assert.strictEqual(rc.from.toLowerCase(), relayerAddress.toLowerCase())
        return vp
    }
    await cast(votingA, 2, 0)
    await cast(votingB, 0, 0)
    await cast(votingA, 1, 1)                    // A changes their vote
    await cast(votingB, 0, 1, 2)                 // B's latest ballot doesn't match its commitment → invalid
    ok("four sealed ballots relayed (sender is the relay)")

    const vpBig = await voteProof(votingA, votingGroup, proposalId, 0n, 5n, 3n, 1n, 2n)
    r = await relay({ action: "castVote", electionAddress: invite.address, ...vpBig, encryptedBlob: "0x" + "ab".repeat(5000) })
    assert.match(r.json.error, /oversized/); ok("oversized ballot refused")

    // Sealed ballots can't be opened before the deadline
    await assert.rejects(tally.countBallots([{ baseNullifier: "1", voteCommitment: "1", encryptedBlob: "0x00" }], 3, invite.deadline, { chain: mockChain, fetchBeacon: async (n) => beaconFor(n) }), /sealed until/)
    ok("ballots can't be opened before the deadline")

    // nobody can close voting early, including the admin
    await expectRevert(inviteC.closeVoting(), "VotingNotEnded"); ok("admin can't close voting before the deadline")
    await provider.send("evm_increaseTime", [700]); await provider.send("evm_mine", [])
    await (await inviteC.connect(attacker).closeVoting()).wait(); ok("anyone can close voting after the deadline")

    // public recount from on-chain events, checked against the committed tally
    const events = await inviteC.queryFilter(inviteC.filters.VoteCast(), 0, "latest")
    const records = events.map(e => ({ baseNullifier: e.args.baseNullifier.toString(), voteCommitment: e.args.voteCommitment.toString(), encryptedBlob: e.args.encryptedBlob }))
    Date.now = () => realNow() + 2 * 3600 * 1000 // wall clock lags the fast-forwarded chain
    const result = await tally.countBallots(records, 3, invite.deadline, { chain: mockChain, fetchBeacon: async (n) => beaconFor(n) })
    Date.now = realNow
    assert.deepStrictEqual(result.optionCounts, [0, 1, 0])
    assert.strictEqual(result.totalValid, 1); assert.strictEqual(result.totalInvalid, 1); assert.strictEqual(result.duplicatesRemoved, 2)
    ok("recount: last ballot per voter counts; a ballot that doesn't match its commitment is invalid")

    const hash = tally.tallyCommitment(result.optionCounts, result.totalValid, result.totalInvalid)
    await (await inviteC.commitTallyResult(result.optionCounts, result.totalValid, result.totalInvalid, hash)).wait()
    const onChain = {
        poseidonCommitment: (await inviteC.tallyPoseidonCommitment()).toString(),
        totalValid: Number(await inviteC.tallyTotalValid()), totalInvalid: Number(await inviteC.tallyTotalInvalid()),
        optionCounts: (await inviteC.getTallyOptionCounts()).map(Number),
    }
    assert.strictEqual(tally.commitmentMatches(onChain, result), true)
    assert.strictEqual(tally.commitmentMatches({ ...onChain, optionCounts: [1, 0, 0] }, result), false)
    ok("committed tally matches the recount; a doctored one doesn't")

    console.log(`\nE2E PASSED (${results.length} checks)`)
    process.exit(0)
})().catch((err) => { console.error("E2E FAILED:", err); process.exit(1) })
