// End-to-end check of the v9 trust model against a local hardhat chain, using the real
// relay route, contracts, ZK circuits, ballot sealing, recount and voter-side checks
// (with a mock drand key so ballots can be opened offline):
//   - gated signup goes through the relay as registrar, one registration per credential,
//     with 128-bit invite codes, normalized email aliases and token balances at a snapshot
//   - the relay needs a stable GATE_KEY_SECRET for gated elections and pays for open-election
//     signups only when the organizer chose gasless; concurrent sends don't collide
//   - registration caps (maxVoters) hold; voting opens on its own after the signup deadline
//   - joins and ballots are submitted by the relay, never a voter wallet
//   - a ballot whose contents were replaced on the way is detected by the voter's check and
//     doesn't cancel the voter's earlier valid ballot
//   - nobody can close voting before the deadline; anyone can after it
//   - the recount refuses an incomplete set of ballots and an unverified beacon, and the
//     committed tally is checked against it
//
// Usage (from the repo root, after `yarn`):
//   1. cd apps/contracts && npx hardhat node
//   2. npx hardhat run scripts/deploy-factory.ts --network localhost   (note the factory and Semaphore addresses)
//      npx hardhat compile   (the token-gate check uses contracts/test/MockToken.sol)
//   3. Make sure apps/circuits/build/ has the circuit files (copy from apps/web-app/public/circuits/)
//   4. node apps/web-app/scripts/e2e-local.cjs <factory> <semaphore>
const path = require("path")
const fs = require("fs")
const os = require("os")
const crypto = require("crypto")
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
for (const m of ["gate", "ballot", "tally", "chain", "server", "relayer"]) compile(`lib/${m}.ts`, `${m}.js`)
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
    holder: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    receiver: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
}
const EMAIL_SECRET = "e2e-email-hmac-secret"
process.env.RELAYER_PRIVATE_KEY = KEYS.relayer
process.env.EMAIL_HMAC_SECRET = EMAIL_SECRET
delete process.env.GATE_KEY_SECRET
delete process.env.RELAY_RPC_URL

const route = require(path.join(OUT, "route.js"))
const contractsMod = require(path.join(OUT, "contracts.js"))
const gate = require(path.join(OUT, "gate.js"))
const ballot = require(path.join(OUT, "ballot.js"))
const tally = require(path.join(OUT, "tally.js"))
const client = require(path.join(OUT, "relayer.js"))

const RPC = "http://127.0.0.1:8545"
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 })
const admin = new ethers.Wallet(KEYS.admin, provider)
const attacker = new ethers.Wallet(KEYS.attacker, provider)
const holder = new ethers.Wallet(KEYS.holder, provider)
const receiver = new ethers.Wallet(KEYS.receiver, provider)
const relayerAddress = new ethers.Wallet(KEYS.relayer).address
const factory = new ethers.Contract(FACTORY, contractsMod.FACTORY_ABI, admin)
const SEM_ABI = contractsMod.SEMAPHORE_ABI

const CIRC = ROOT + "/apps/circuits/build"
const MAX_DEPTH = 20

async function relay(body, ip = "10.0.0.1") {
    const req = new Request("http://localhost/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
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
function mockDrand() {
    const sk = bls12_381.utils.randomPrivateKey()
    const chain = { ...ballot.QUICKNET, public_key: Buffer.from(bls12_381.getPublicKeyForShortSignatures(sk)).toString("hex"), hash: "bb".repeat(32), genesis_time: Math.floor(Date.now() / 1000) - 86400 }
    const beaconFor = (round) => {
        const msg = new Uint8Array(8); new DataView(msg.buffer).setBigUint64(0, BigInt(round))
        const sig = bls12_381.signShortSignature(sha256(msg), sk)
        const bytes = sig instanceof Uint8Array ? sig : sig.toRawBytes(true)
        return { round, randomness: Buffer.from(sha256(bytes)).toString("hex"), signature: Buffer.from(bytes).toString("hex") }
    }
    return { chain, beaconFor }
}
const drand = mockDrand()
const otherDrand = mockDrand() // a key the pinned chain doesn't trust

async function chainNow() { return (await provider.getBlock("latest")).timestamp }

// Jump the chain's clock, then wait out the relay provider's short response cache
async function travelTo(timestamp) {
    await provider.send("evm_setNextBlockTimestamp", [timestamp]); await provider.send("evm_mine", [])
    await new Promise(resolve => setTimeout(resolve, 400))
}

async function createElection({ selfSignup, registrar, meta, numOptions = 3, signupIn = 600, votingIn = 1200, maxVoters = 50, maxWeight = 1 }) {
    const now = await chainNow()
    const fee = await factory.creationFee()
    const config = {
        proposalId: BigInt(now) + BigInt(Math.floor(Math.random() * 1e6)), signupDeadline: now + signupIn, votingDeadline: now + votingIn,
        numOptions, maxVoters, maxWeight, selfSignupAllowed: selfSignup, registrar,
    }
    const tx = await factory.createElection(config, ethers.toUtf8Bytes(JSON.stringify(meta)), { value: fee })
    const receipt = await tx.wait()
    const parsed = receipt.logs.map(l => { try { return factory.interface.parseLog(l) } catch { return null } }).find(p => p?.name === "ElectionDeployed")
    return {
        address: parsed.args.election, signupDeadline: now + signupIn, deadline: now + votingIn,
        c: new ethers.Contract(parsed.args.election, contractsMod.SPECTRE_VOTING_ABI, admin),
    }
}

const emailToken = (email, election) => crypto.createHmac("sha256", EMAIL_SECRET).update(email + "|" + election.toLowerCase()).digest("hex")
const code128 = () => crypto.randomBytes(16).toString("hex")

;(async () => {
    const results = []
    const ok = (name) => { results.push(name); console.log("  ✓", name) }

    // ── Pure checks: beacon verification against real drand quicknet beacons ──
    const real = [
        { round: 1000, randomness: "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd", signature: "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39" },
        { round: 5000000, randomness: "4c6c26dc9b7f65728845b67eb8d3c4a5f0f6c5f582de936df22bea654e68d4a9", signature: "a597f735255263bf239b481d8065e0ef91eed416290da51e3ee6f128a9be29b4429525552c32fbbdb0dee406743a863b" },
    ]
    for (const b of real) assert.strictEqual(ballot.verifyBeacon(b, b.round), true)
    assert.strictEqual(ballot.verifyBeacon({ ...real[0], round: 1001 }, 1001), false)
    assert.strictEqual(ballot.verifyBeacon({ ...real[0], signature: real[1].signature, randomness: real[1].randomness }, 1000), false)
    ok("real quicknet beacons verify against the pinned key; wrong round or signature doesn't")

    const d0 = 1_800_000_000
    assert.ok(ballot.unsealTime(d0) >= d0 + ballot.SEAL_DELAY_SECONDS && ballot.unsealTime(d0) <= d0 + ballot.SEAL_DELAY_SECONDS + 3)
    ok(`ballots are sealed to the first round ${ballot.SEAL_DELAY_SECONDS / 60} minutes after the deadline`)

    assert.strictEqual(gate.normalizeEmail(" Alice+votes@Corp.Example "), "alice@corp.example")
    assert.strictEqual(gate.normalizeEmail("a.l.i.c.e+x@googlemail.com"), "alice@gmail.com")
    assert.strictEqual(gate.normalizeEmail("first.last@corp.example"), "first.last@corp.example")
    assert.strictEqual(gate.normalizeEmail("+tag@corp.example"), null)
    ok("email addresses normalize (+tags dropped; Gmail dots ignored; other dots kept)")

    // ── Relay configuration ──
    let info = await (await route.GET()).json()
    assert.strictEqual(info.relayerAddress, relayerAddress); assert.strictEqual(info.gatedElections, false)
    const codes = [code128(), code128(), code128()]
    const invite = await createElection({
        selfSignup: false, registrar: relayerAddress, maxVoters: codes.length,
        meta: { title: "Invite", labels: ["A", "B", "C"], gateType: "invite-codes", gaslessEnabled: true, inviteCodes: { totalCodes: codes.length, codeHashes: codes.map(c => ethers.keccak256(ethers.toUtf8Bytes(c))) } },
    })
    const voterA = new Identity(), voterB = new Identity(), voterC = new Identity(), intruder = new Identity()
    let r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: codes[0] })
    assert.strictEqual(r.status, 503); assert.match(r.json.error, /GATE_KEY_SECRET/)
    process.env.GATE_KEY_SECRET = "e2e-gate-key-secret-0123456789abcdef"
    info = await (await route.GET()).json()
    assert.strictEqual(info.gatedElections, true)
    ok("without a stable GATE_KEY_SECRET the relay refuses gated signups and says so in GET")

    // ── Invite codes: 128-bit, one registration each ──
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString() })
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /Invite code required/)
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: "a1b2c3d4" })
    assert.match(r.json.error, /format/)
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: code128() })
    assert.match(r.json.error, /Invalid invite code/)
    ok("missing, old 8-character and unknown codes are refused")

    let from = await client.blockBeforeRelay()
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterA.commitment.toString(), code: codes[0] }, "10.0.0.1")
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json))
    const regReceipt = await mined(r.json.txHash)
    assert.strictEqual(regReceipt.from.toLowerCase(), relayerAddress.toLowerCase())
    const signupCheck = await client.confirmSignup(invite.address, voterA.commitment.toString(), from, 10_000)
    assert.deepStrictEqual(signupCheck, { status: "confirmed", weight: 1n })
    ok("a valid code registers the voter (sent by the relay); the voter's check reads it back from the chain")

    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: intruder.commitment.toString(), code: codes[0] })
    assert.match(r.json.error, /already been used/)
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterB.commitment.toString(), code: gate.formatInviteCode(codes[1]).toUpperCase() }, "10.0.0.2")
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    r = await relay({ action: "signUp", electionAddress: invite.address, identityCommitment: voterC.commitment.toString(), code: codes[2] }, "10.0.0.3")
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    ok("a used code is refused; codes pasted with dashes or capitals work")

    await expectRevert(invite.c.connect(attacker).signUp(intruder.commitment), "SelfSignupNotAllowed")
    await expectRevert(invite.c.connect(attacker).registerVoter(intruder.commitment, 1, ethers.id("x")), "NotAuthorized")
    ok("direct signUp() and registerVoter() bypasses revert")

    // ── Other election types ──
    const adminOnly = await createElection({ selfSignup: false, registrar: ethers.ZeroAddress, meta: { title: "Admin only", labels: ["Y", "N"] }, numOptions: 2 })
    r = await relay({ action: "signUp", electionAddress: adminOnly.address, identityCommitment: intruder.commitment.toString() })
    assert.match(r.json.error, /organizer registers voters directly/)
    ok("relay refuses elections where it isn't the registrar")

    const walletOpen = await createElection({ selfSignup: true, registrar: ethers.ZeroAddress, meta: { title: "Open, wallets", labels: ["Y", "N"] }, numOptions: 2 })
    r = await relay({ action: "signUp", electionAddress: walletOpen.address, identityCommitment: intruder.commitment.toString() })
    assert.strictEqual(r.status, 403); assert.match(r.json.error, /own wallets/)
    ok("relay doesn't pay for signups in open elections that didn't choose gasless")

    const gaslessOpen = await createElection({ selfSignup: true, registrar: ethers.ZeroAddress, meta: { title: "Open, gasless", labels: ["Y", "N"], gaslessEnabled: true }, numOptions: 2 })
    const [s1, s2] = await Promise.all([
        relay({ action: "signUp", electionAddress: gaslessOpen.address, identityCommitment: new Identity().commitment.toString() }, "10.1.0.1"),
        relay({ action: "signUp", electionAddress: gaslessOpen.address, identityCommitment: new Identity().commitment.toString() }, "10.1.0.2"),
    ])
    assert.strictEqual(s1.json.success, true, JSON.stringify(s1.json)); assert.strictEqual(s2.json.success, true, JSON.stringify(s2.json))
    const [rc1, rc2] = await Promise.all([mined(s1.json.txHash), mined(s2.json.txHash)])
    assert.notStrictEqual((await provider.getTransaction(rc1.hash)).nonce, (await provider.getTransaction(rc2.hash)).nonce)
    ok("gasless open election: two simultaneous signups both land (one nonce each)")

    const allow = await createElection({
        selfSignup: false, registrar: relayerAddress, maxVoters: 1,
        meta: { title: "Allowlist", labels: ["Y", "N"], gateType: "allowlist", gaslessEnabled: true, allowlist: { totalEntries: 2, identifierHashes: ["ann@example.org", "ben@example.org"].map(i => ethers.keccak256(ethers.toUtf8Bytes(i))) } },
        numOptions: 2,
    })
    r = await relay({ action: "signUp", electionAddress: allow.address, identityCommitment: new Identity().commitment.toString(), identifier: "Ann@example.org" })
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    r = await relay({ action: "signUp", electionAddress: allow.address, identityCommitment: new Identity().commitment.toString(), identifier: "ben@example.org" })
    assert.match(r.json.error, /maximum number of voters/)
    await expectRevert(allow.c.registerVoter(new Identity().commitment, 1, ethers.ZeroHash), "TooManyVoters")
    ok("maxVoters caps registrations, through the relay and for the admin")

    // ── Email domain: aliases of one inbox share one registration ──
    const mail = await createElection({
        selfSignup: false, registrar: relayerAddress,
        meta: { title: "Email", labels: ["Y", "N"], gateType: "email-domain", gaslessEnabled: true, emailDomain: { domains: ["corp.example"] } }, numOptions: 2,
    })
    r = await relay({ action: "signUp", electionAddress: mail.address, identityCommitment: new Identity().commitment.toString(), email: "Alice+one@corp.example", emailToken: emailToken("alice@corp.example", mail.address) })
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    r = await relay({ action: "signUp", electionAddress: mail.address, identityCommitment: new Identity().commitment.toString(), email: "alice+two@corp.example", emailToken: emailToken("alice@corp.example", mail.address) })
    assert.match(r.json.error, /already been used/)
    r = await relay({ action: "signUp", electionAddress: mail.address, identityCommitment: new Identity().commitment.toString(), email: "bob+x@corp.example", emailToken: emailToken("bob+x@corp.example", mail.address) })
    assert.match(r.json.error, /Invalid email verification token/)
    ok("email gate: +tag aliases of one address register once; tokens must be for the normalized address")

    // ── Token gate: balances count at the snapshot block ──
    const tokenArtifact = JSON.parse(fs.readFileSync(ROOT + "/apps/contracts/artifacts/contracts/test/MockToken.sol/MockToken.json", "utf8"))
    const token = await new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, admin).deploy()
    await token.waitForDeployment()
    await (await token.mint(holder.address, ethers.parseEther("100"))).wait()
    const snapshotBlock = await provider.getBlockNumber()
    const tokenElection = await createElection({
        selfSignup: false, registrar: relayerAddress,
        meta: { title: "Token", labels: ["Y", "N"], gateType: "token-gate", gaslessEnabled: false, tokenGate: { snapshotBlock, tokenAddress: (await token.getAddress()).toLowerCase(), tokenType: "erc20", minBalance: "50", tokenSymbol: "MOCK", tokenDecimals: 18, weighted: false } },
        numOptions: 2,
    })
    await (await token.connect(holder).transfer(receiver.address, ethers.parseEther("100"))).wait() // after the snapshot
    const tokenSignup = async (wallet) => {
        const id = new Identity()
        const sig = await wallet.signMessage(gate.tokenGateMessage(tokenElection.address, id.commitment.toString(), wallet.address))
        return relay({ action: "signUp", electionAddress: tokenElection.address, identityCommitment: id.commitment.toString(), voterAddress: wallet.address, walletSignature: sig })
    }
    r = await tokenSignup(receiver)
    assert.match(r.json.error, /less than 50 MOCK at the snapshot/)
    r = await tokenSignup(holder)
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    r = await tokenSignup(holder)
    assert.match(r.json.error, /already been used/)
    ok("token gate: tokens moved after the snapshot don't qualify the new wallet; each wallet registers once")

    // ── Voting opens on its own after the signup deadline ──
    const proposalId = await invite.c.proposalId()
    const signupGroup = await groupMembers(await invite.c.signupGroupId())
    const votingA = new Identity(), votingB = new Identity(), votingC = new Identity()
    const jpA = await joinProof(voterA, votingA, signupGroup, proposalId)
    r = await relay({ action: "anonJoin", electionAddress: invite.address, ...jpA }, "10.0.0.1")
    assert.match(r.json.error, /hasn't started yet/)
    await travelTo(invite.signupDeadline + 1)
    assert.strictEqual(await invite.c.signupOpen(), true) // nobody closed it
    from = await client.blockBeforeRelay()
    r = await relay({ action: "anonJoin", electionAddress: invite.address, ...jpA }, "10.0.0.1")
    assert.strictEqual(r.json.success, true, JSON.stringify(r.json))
    const joinReceipt = await mined(r.json.txHash)
    assert.strictEqual(joinReceipt.from.toLowerCase(), relayerAddress.toLowerCase())
    assert.ok(joinReceipt.logs.some(l => { try { return invite.c.interface.parseLog(l)?.name === "SignupClosed" } catch { return false } }))
    assert.deepStrictEqual(await client.confirmJoin(invite.address, jpA, from, 10_000), { status: "confirmed" })
    ok("joining before the signup deadline is refused; the first join after it opens voting with no closeSignup")

    for (const [signupId, votingId, ip] of [[voterB, votingB, "10.0.0.2"], [voterC, votingC, "10.0.0.3"]]) {
        const jp = await joinProof(signupId, votingId, signupGroup, proposalId)
        r = await relay({ action: "anonJoin", electionAddress: invite.address, ...jp }, ip)
        assert.strictEqual(r.json.success, true, JSON.stringify(r.json)); await mined(r.json.txHash)
    }
    ok("anonJoin relayed for the other voters")

    // ── Ballots ──
    const votingGroup = await groupMembers(await invite.c.votingGroupId())
    const seal = (vote, rand) => ballot.sealBallot(ballot.encodeVotePayload(BigInt(vote), 1n, rand), invite.deadline, drand.chain)
    const prepare = async (votingId, vote, version, payloadVote = vote) => {
        const rand = 123456789n + BigInt(version) + BigInt(vote) * 1000n
        const vp = await voteProof(votingId, votingGroup, proposalId, BigInt(vote), rand, 3n, 1n, BigInt(version))
        return { vp, blobHex: ethers.hexlify(await seal(payloadVote, rand)) }
    }
    const castViaRelay = async ({ vp, blobHex }, ip) => {
        const start = await client.blockBeforeRelay()
        const res = await relay({ action: "castVote", electionAddress: invite.address, ...vp, encryptedBlob: blobHex }, ip)
        assert.strictEqual(res.json.success, true, JSON.stringify(res.json))
        const rc = await mined(res.json.txHash)
        assert.strictEqual(rc.from.toLowerCase(), relayerAddress.toLowerCase())
        return client.confirmBallot(invite.address, { versionedNullifier: vp.versionedNullifier, voteCommitment: vp.voteCommitment, encryptedBlobHex: blobHex }, start, 10_000)
    }
    // A substitute relay that submits the voter's proof with other contents
    const castSubstituted = async ({ vp, blobHex }) => {
        const start = await client.blockBeforeRelay()
        const junk = "0x" + "00".repeat(600)
        await (await invite.c.connect(attacker).castVote(vp.pA, vp.pB, vp.pC, vp.merkleTreeRoot, vp.baseNullifier, vp.versionedNullifier, vp.voteCommitment, junk)).wait()
        return client.confirmBallot(invite.address, { versionedNullifier: vp.versionedNullifier, voteCommitment: vp.voteCommitment, encryptedBlobHex: blobHex }, start, 10_000)
    }

    assert.deepStrictEqual(await castViaRelay(await prepare(votingA, 2, 0), "10.0.0.1"), { status: "confirmed" })
    assert.deepStrictEqual(await castViaRelay(await prepare(votingB, 0, 0), "10.0.0.2"), { status: "confirmed" })
    ok("ballots relayed; each voter's check finds their exact ballot on-chain")

    const aV1 = await prepare(votingA, 1, 1)
    assert.deepStrictEqual(await castSubstituted(aV1), { status: "altered" })
    r = await relay({ action: "castVote", electionAddress: invite.address, ...aV1.vp, encryptedBlob: aV1.blobHex }, "10.0.0.1")
    assert.strictEqual(r.status, 409)
    assert.deepStrictEqual(await castViaRelay(await prepare(votingA, 1, 2), "10.0.0.1"), { status: "confirmed" })
    ok("a ballot submitted with replaced contents is detected as altered; the voter re-votes with the next version")

    assert.deepStrictEqual(await castViaRelay(await prepare(votingB, 0, 1, 2), "10.0.0.2"), { status: "confirmed" }) // payload doesn't match its commitment
    assert.deepStrictEqual(await castSubstituted(await prepare(votingC, 2, 0)), { status: "altered" })            // C's only ballot is voided
    const big = await prepare(votingC, 1, 1)
    r = await relay({ action: "castVote", electionAddress: invite.address, ...big.vp, encryptedBlob: "0x" + "ab".repeat(1025) }, "10.0.0.3")
    assert.match(r.json.error, /oversized/)
    await expectRevert(invite.c.connect(attacker).castVote(big.vp.pA, big.vp.pB, big.vp.pC, big.vp.merkleTreeRoot, big.vp.baseNullifier, big.vp.versionedNullifier, big.vp.voteCommitment, "0x" + "ab".repeat(1025)), "BallotTooLarge")
    ok("ballots over 1 KB are refused by the relay and by the contract")

    // ── Counting ──
    const deployBlock = Number(await invite.c.deployBlock())
    // The local chain's clock runs ahead of the wall clock (we fast-forward it), so the count
    // also sets the wall clock that tlock-js checks before decrypting.
    const count = async (p, opts = {}) => {
        const realNow = Date.now
        if (opts.now) Date.now = () => opts.now
        try {
            return await tally.recountElection(invite.address, p, { numOptions: 3, votingDeadline: invite.deadline, deployBlock }, { chain: drand.chain, fetchBeacon: async (n) => drand.beaconFor(n), ...opts })
        } finally {
            Date.now = realNow
        }
    }
    await assert.rejects(count(provider), /hasn't reached the voting deadline/)
    await expectRevert(invite.c.closeVoting(), "VotingNotEnded")
    ok("nobody can count or close voting before the deadline, including the admin")

    await travelTo(invite.deadline + 1)
    await assert.rejects(count(provider, { now: (invite.deadline + 60) * 1000 }), /sealed until/)
    ok("after the deadline, ballots stay sealed until the delay has passed")

    await (await invite.c.connect(attacker).closeVoting()).wait()
    ok("anyone can close voting after the deadline")

    const unsealed = (invite.deadline + ballot.SEAL_DELAY_SECONDS + 10) * 1000
    class LossyProvider extends ethers.JsonRpcProvider {
        async getLogs(filter) { const logs = await super.getLogs(filter); return logs.slice(0, -1) }
    }
    await assert.rejects(count(new LossyProvider(RPC, undefined, { cacheTimeout: -1 }), { now: unsealed }), /Found 5 ballot\(s\), but the contract recorded 6/)
    ok("recount refuses when the RPC returns fewer ballots than the contract recorded")

    await assert.rejects(count(provider, { now: unsealed, fetchBeacon: async (n) => otherDrand.beaconFor(n) }), /didn't verify/)
    ok("recount refuses a beacon that doesn't verify, instead of marking every ballot invalid")

    const result = await count(provider, { now: unsealed })
    assert.deepStrictEqual(result.optionCounts, [1, 1, 0])
    assert.strictEqual(result.totalValid, 2); assert.strictEqual(result.totalInvalid, 1)
    assert.strictEqual(result.voters, 3); assert.strictEqual(result.invalidSubmissions, 3); assert.strictEqual(result.duplicatesRemoved, 3)
    ok("recount: each voter's latest valid ballot counts; replaced or mismatched ballots don't cancel an earlier valid one")

    const hash = tally.tallyCommitment(result.optionCounts, result.totalValid, result.totalInvalid)
    await (await invite.c.commitTallyResult(result.optionCounts, result.totalValid, result.totalInvalid, hash)).wait()
    const onChain = {
        poseidonCommitment: (await invite.c.tallyPoseidonCommitment()).toString(),
        totalValid: Number(await invite.c.tallyTotalValid()), totalInvalid: Number(await invite.c.tallyTotalInvalid()),
        optionCounts: (await invite.c.getTallyOptionCounts()).map(Number),
    }
    assert.strictEqual(tally.commitmentMatches(onChain, result), true)
    assert.strictEqual(tally.commitmentMatches({ ...onChain, optionCounts: [2, 0, 0] }, result), false)
    ok("committed tally matches the recount; a doctored one doesn't")

    console.log(`\nE2E PASSED (${results.length} checks)`)
    process.exit(0)
})().catch((err) => { console.error("E2E FAILED:", err); process.exit(1) })
