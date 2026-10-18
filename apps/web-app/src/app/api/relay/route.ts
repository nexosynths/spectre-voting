/**
 * Relayer API Route
 *
 * Submits voter transactions from a funded server wallet so voters need no
 * wallet or gas, and so that no voter's own wallet ever appears on a join or a
 * ballot transaction.
 *
 * Actions: signUp, anonJoin, castVote. Admin actions are never relayed.
 *
 * Roles and trust:
 * - anonJoin and castVote are relayed for every election (wallet mode included).
 *   The on-chain sender is always the relay.
 * - Open elections (selfSignupAllowed = true): the relay calls signUp() only if the
 *   organizer chose gasless signup; otherwise voters sign up from their own wallets.
 * - Gated elections (invite codes, allowlist, email domain, GitHub org, token):
 *   the contract only accepts registrations from the admin or the registrar.
 *   This relay is the registrar. It checks eligibility, then calls
 *   registerVoter(commitment, weight, gateKey). The gate key is a keyed hash of
 *   the credential (GATE_KEY_SECRET), and the contract accepts each gate key once,
 *   so a code, email, GitHub account or wallet can register only one identity.
 * - The relay operator is trusted for eligibility in gated elections. It also sees
 *   each request's IP address: at signup (with the credential, in gated elections),
 *   at join and at vote. Ballots become readable by anyone after they unseal, so the
 *   operator could link an IP address, and a gated signup's credential, to a vote.
 *   Nothing on-chain links them.
 * - The relay could submit a voter's proof with different ballot contents (the proof
 *   doesn't cover the ciphertext). That voids the ballot rather than changing it;
 *   voters' clients compare what landed on-chain with what they sent.
 */

import { NextRequest, NextResponse } from "next/server"
import { Wallet, Contract, NonceManager, keccak256, toUtf8Bytes, verifyMessage, getAddress, ZeroAddress, type ContractTransactionResponse } from "ethers"
import { createHmac, timingSafeEqual } from "crypto"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, FACTORY_CONFIGURED } from "@/lib/contracts"
import { tokenGateMessage, normalizeEmail, emailDomain, normalizeInviteCode, INVITE_CODE_PATTERN } from "@/lib/gate"
import { serverProvider, cachedElectionMetadata, clientIp } from "@/lib/server"

// Always evaluate at request time (the GET handler reads env vars and must not be prerendered)
export const dynamic = "force-dynamic"

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const MAX_BALLOT_BYTES = 1024 // same cap as SpectreVoting.MAX_BALLOT_BYTES
const MIN_GATE_SECRET_LENGTH = 32

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per serverless instance)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number>()
const MAX_CALLS_PER_IP_PER_ELECTION = 16 // 1 signup + 1 anonJoin + up to 6 castVotes + buffer

function checkRateLimit(ip: string, election: string): boolean {
    const key = `${ip}:${election.toLowerCase()}`
    const count = rateLimitMap.get(key) || 0
    if (count >= MAX_CALLS_PER_IP_PER_ELECTION) return false
    rateLimitMap.set(key, count + 1)
    return true
}

// ---------------------------------------------------------------------------
// In-flight gate keys: stops the same credential being submitted twice while a
// registration is pending. The contract's usedGateKeys is the source of truth.
// ---------------------------------------------------------------------------
const inFlightGateKeys = new Map<string, number>() // gateKey → expiry (ms)
const IN_FLIGHT_MS = 120_000

function claimGateKey(gateKey: string): boolean {
    const now = Date.now()
    const expiry = inFlightGateKeys.get(gateKey)
    if (expiry && expiry > now) return false
    inFlightGateKeys.set(gateKey, now + IN_FLIGHT_MS)
    return true
}

function releaseGateKey(gateKey: string): void {
    inFlightGateKeys.delete(gateKey)
}

// ---------------------------------------------------------------------------
// Relay signer: one per server instance. Transactions go out one at a time through a
// nonce manager; after any failure the nonce is re-read from the chain, and nonce
// conflicts (e.g. with another instance) are retried.
// ---------------------------------------------------------------------------
let relaySigner: { key: string; wallet: Wallet; signer: NonceManager } | null = null

function getRelaySigner(key: string) {
    if (!relaySigner || relaySigner.key !== key) {
        const wallet = new Wallet(key, serverProvider())
        relaySigner = { key, wallet, signer: new NonceManager(wallet) }
    }
    return relaySigner
}

let sendQueue: Promise<unknown> = Promise.resolve()

function isNonceConflict(err: any): boolean {
    const text = `${err?.code ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`
    return /NONCE_EXPIRED|REPLACEMENT_UNDERPRICED|nonce too low|nonce has already been used|replacement transaction underpriced/i.test(text)
}

/** Send one transaction at a time; retry up to twice on a nonce conflict. */
function sendSerialized(signer: NonceManager, send: () => Promise<ContractTransactionResponse>): Promise<ContractTransactionResponse> {
    const run = sendQueue.then(async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await send()
            } catch (err) {
                // The nonce manager may have counted a nonce that was never used
                signer.reset()
                if (attempt < 2 && isNonceConflict(err)) continue
                throw err
            }
        }
    })
    sendQueue = run.catch(() => undefined)
    return run
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string, status = 400): NextResponse {
    return NextResponse.json({ success: false, error }, { status })
}

function relayerKey(): string | null {
    return process.env.RELAYER_PRIVATE_KEY || null
}

/**
 * Secret for gate keys. Keeps credentials (emails, wallets) from being guessable on-chain,
 * and must stay the same for the life of every election: if it changed, a credential
 * already used would map to a new gate key and could register again.
 */
function gateSecret(): string | null {
    const secret = process.env.GATE_KEY_SECRET
    return secret && secret.length >= MIN_GATE_SECRET_LENGTH ? secret : null
}

function computeGateKey(secret: string, election: string, gateType: string, value: string): string {
    return keccak256(toUtf8Bytes(`${secret}|${election.toLowerCase()}|${gateType}|${value}`))
}

function safeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(String(a), "utf8")
    const bb = Buffer.from(String(b), "utf8")
    return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function parseCommitment(raw: unknown): bigint | null {
    try {
        const value = BigInt(String(raw))
        return value > 0n && value < SNARK_FIELD ? value : null
    } catch {
        return null
    }
}

/** Voting is open on-chain, or opens on the next join/vote because signup has ended. */
async function votingIsOpen(election: Contract): Promise<{ open: boolean; reason?: string }> {
    const [signupOpen, votingOpen, signupDeadline, votingDeadline, block] = await Promise.all([
        election.signupOpen(), election.votingOpen(), election.signupDeadline(), election.votingDeadline(),
        serverProvider().getBlock("latest"),
    ])
    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000))
    if (now > votingDeadline) return { open: false, reason: "Voting has ended for this election" }
    if (votingOpen || (signupOpen && now > signupDeadline)) return { open: true }
    return { open: false, reason: "Voting hasn't started yet; signup is still open" }
}

// ---------------------------------------------------------------------------
// GET: the relay's public address (used as the registrar for gated elections)
// ---------------------------------------------------------------------------

export async function GET() {
    const key = relayerKey()
    if (!key) return fail("Relayer not configured", 503)
    return NextResponse.json({
        success: true,
        relayerAddress: new Wallet(key).address,
        // Gated elections need a stable gate-key secret; the app won't create them without it
        gatedElections: gateSecret() !== null,
    })
}

// ---------------------------------------------------------------------------
// POST: relay an action
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
    try {
        const key = relayerKey()
        if (!key) return fail("Relayer not configured", 503)
        if (!FACTORY_CONFIGURED) return fail("This deployment isn't configured with contract addresses yet", 503)

        const body = await request.json()
        const { action, electionAddress } = body

        if (!action || !electionAddress) return fail("Missing action or electionAddress")
        if (!["signUp", "anonJoin", "castVote"].includes(action)) return fail(`Invalid action: ${action}`)
        if (typeof electionAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(electionAddress)) return fail("Invalid election address")

        if (!checkRateLimit(clientIp(request.headers), electionAddress)) {
            return fail(`Rate limit exceeded (max ${MAX_CALLS_PER_IP_PER_ELECTION} relay calls per election)`, 429)
        }

        const provider = serverProvider()
        const { wallet, signer } = getRelaySigner(key)

        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const [isElection, balance] = await Promise.all([
            factory.isElection(electionAddress),
            provider.getBalance(wallet.address),
        ])
        if (!isElection) return fail("Invalid election address")
        if (balance < 100000000000000n) return fail("Relayer wallet has insufficient funds", 503) // 0.0001 ETH

        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)

        switch (action) {
            case "signUp":
                return await handleSignUp(election, signer, getAddress(electionAddress), body, wallet.address)
            case "anonJoin":
                return await handleAnonJoin(election, signer, body)
            case "castVote":
                return await handleCastVote(election, signer, body)
            default:
                return fail("Unknown action")
        }
    } catch (err: any) {
        console.error("Relay error:", err)
        const reason = err?.reason || err?.shortMessage || err?.message || "Transaction failed"
        return fail(reason, 500)
    }
}

// ---------------------------------------------------------------------------
// signUp
// ---------------------------------------------------------------------------

type GateCheck = { ok: true; value: string; weight: bigint; usedMessage: string } | { ok: false; response: NextResponse }

async function handleSignUp(
    election: Contract,
    signer: NonceManager,
    electionAddress: string,
    body: any,
    relayerAddress: string,
): Promise<NextResponse> {
    const commitment = parseCommitment(body.identityCommitment)
    if (commitment === null) return fail("Missing or invalid identityCommitment")

    const [signupOpen, signupDeadline, selfSignupAllowed, registrar, registrationCount, maxVoters, maxWeight, block, meta] = await Promise.all([
        election.signupOpen(),
        election.signupDeadline(),
        election.selfSignupAllowed(),
        election.registrar(),
        election.registrationCount(),
        election.maxVoters(),
        election.maxWeight(),
        serverProvider().getBlock("latest"),
        cachedElectionMetadata(electionAddress),
    ])

    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000))
    if (!signupOpen || now > signupDeadline) return fail("Signup is closed for this election")
    if (registrationCount >= maxVoters) return fail("This election has reached its maximum number of voters")

    // Open election: the relay pays for signups only if the organizer chose gasless signup.
    if (selfSignupAllowed) {
        if (meta?.gaslessEnabled !== true) {
            return fail("This election signs voters up from their own wallets. Connect a wallet to sign up.", 403)
        }
        const tx = await sendSerialized(signer, () => election.signUp(commitment))
        return NextResponse.json({ success: true, txHash: tx.hash, weight: "1" })
    }

    // Gated election: only the registrar (this relay) or the admin can register.
    if (!registrar || registrar === ZeroAddress || registrar.toLowerCase() !== relayerAddress.toLowerCase()) {
        return fail("The organizer registers voters directly for this election.")
    }
    const secret = gateSecret()
    if (!secret) return fail("This relay isn't set up for gated elections (GATE_KEY_SECRET is missing).", 503)

    const gateType: string = meta?.gateType || ""
    let check: GateCheck
    switch (gateType) {
        case "invite-codes": check = checkInviteCode(meta!, body); break
        case "allowlist": check = checkAllowlist(meta!, body); break
        case "email-domain": check = checkEmail(meta!, body, electionAddress); break
        case "github-org": check = checkGithub(body, electionAddress); break
        case "token-gate": check = await checkToken(meta!, body, election, electionAddress, commitment); break
        default:
            return fail("This election has no signup gate the relay can check.")
    }
    if (!check.ok) return check.response

    const weight = check.weight > maxWeight ? maxWeight : check.weight
    const gateKey = computeGateKey(secret, electionAddress, gateType, check.value)
    if (await election.usedGateKeys(gateKey)) return fail(check.usedMessage)
    if (!claimGateKey(gateKey)) return fail("This signup is already being processed. Wait a minute and refresh.", 409)

    try {
        const tx = await sendSerialized(signer, () => election.registerVoter(commitment, weight, gateKey))
        return NextResponse.json({ success: true, txHash: tx.hash, weight: weight.toString() })
    } catch (err) {
        releaseGateKey(gateKey)
        throw err
    }
}

function checkInviteCode(meta: Record<string, any>, body: any): GateCheck {
    const code = typeof body.code === "string" ? normalizeInviteCode(body.code) : ""
    if (!code) return { ok: false, response: fail("Invite code required for this election") }
    if (!INVITE_CODE_PATTERN.test(code)) return { ok: false, response: fail("Invalid invite code format") }
    const codeHashes: string[] = meta.inviteCodes?.codeHashes || []
    if (!codeHashes.includes(keccak256(toUtf8Bytes(code)))) return { ok: false, response: fail("Invalid invite code") }
    return { ok: true, value: code, weight: 1n, usedMessage: "This invite code has already been used" }
}

function checkAllowlist(meta: Record<string, any>, body: any): GateCheck {
    const identifier = typeof body.identifier === "string" ? body.identifier.toLowerCase().trim() : ""
    if (!identifier) return { ok: false, response: fail("Identifier required for this election") }
    const identifierHashes: string[] = meta.allowlist?.identifierHashes || []
    if (!identifierHashes.includes(keccak256(toUtf8Bytes(identifier)))) return { ok: false, response: fail("Not on the allowlist") }
    return { ok: true, value: identifier, weight: 1n, usedMessage: "This identifier has already been used" }
}

function checkEmail(meta: Record<string, any>, body: any, electionAddress: string): GateCheck {
    const { emailToken, email } = body
    if (!emailToken || !email) return { ok: false, response: fail("Email verification required for this election") }
    const hmacSecret = process.env.EMAIL_HMAC_SECRET
    if (!hmacSecret) return { ok: false, response: fail("Email verification not configured", 503) }

    // Aliases of one inbox (a+1@, a+2@ ...) normalize to the same address, so they share a gate key
    const normalized = normalizeEmail(String(email))
    if (!normalized) return { ok: false, response: fail("Invalid email address") }
    const expected = createHmac("sha256", hmacSecret).update(normalized + "|" + electionAddress.toLowerCase()).digest("hex")
    if (!safeEqualHex(String(emailToken), expected)) return { ok: false, response: fail("Invalid email verification token") }

    const allowedDomains: string[] = (meta.emailDomain?.domains || []).map((d: string) => d.toLowerCase().trim())
    const domain = emailDomain(String(email))
    if (!domain || !allowedDomains.includes(domain)) return { ok: false, response: fail(`Email domain @${domain} is not allowed`) }
    return { ok: true, value: normalized, weight: 1n, usedMessage: "This email has already been used to sign up" }
}

function checkGithub(body: any, electionAddress: string): GateCheck {
    const { githubToken, githubId } = body
    if (!githubToken || !githubId) return { ok: false, response: fail("GitHub verification required for this election") }
    const hmacSecret = process.env.GITHUB_HMAC_SECRET
    if (!hmacSecret) return { ok: false, response: fail("GitHub verification not configured", 503) }

    const expected = createHmac("sha256", hmacSecret).update(String(githubId) + "|" + electionAddress.toLowerCase()).digest("hex")
    if (!safeEqualHex(String(githubToken), expected)) return { ok: false, response: fail("Invalid GitHub verification token") }
    return { ok: true, value: String(githubId), weight: 1n, usedMessage: "This GitHub account has already been used to sign up" }
}

async function checkToken(
    meta: Record<string, any>,
    body: any,
    election: Contract,
    electionAddress: string,
    commitment: bigint,
): Promise<GateCheck> {
    const { voterAddress, walletSignature } = body
    if (!voterAddress || !/^0x[0-9a-fA-F]{40}$/.test(voterAddress)) {
        return { ok: false, response: fail("Wallet address required for token-gated election") }
    }
    if (!walletSignature || typeof walletSignature !== "string") {
        return { ok: false, response: fail("Wallet signature required to prove you hold the tokens") }
    }

    // Prove the caller controls the wallet whose balance is being counted.
    let signer: string
    try {
        signer = verifyMessage(tokenGateMessage(electionAddress, commitment.toString(), voterAddress), walletSignature)
    } catch {
        return { ok: false, response: fail("Invalid wallet signature") }
    }
    if (signer.toLowerCase() !== String(voterAddress).toLowerCase()) {
        return { ok: false, response: fail("Wallet signature doesn't match the wallet address") }
    }

    const tokenGate = meta.tokenGate
    if (!tokenGate?.tokenAddress) return { ok: false, response: fail("Invalid token gate configuration") }

    // Balances are read at a snapshot block taken when the election was created, so tokens
    // passed from wallet to wallet after that can't register again.
    const snapshotBlock = Number(tokenGate.snapshotBlock)
    const deployBlock = Number(await election.deployBlock())
    if (!Number.isInteger(snapshotBlock) || snapshotBlock <= 0 || snapshotBlock > deployBlock) {
        return { ok: false, response: fail("This token-gated election has no valid snapshot block") }
    }

    let balance: bigint
    try {
        const tokenContract = new Contract(tokenGate.tokenAddress, ["function balanceOf(address) view returns (uint256)"], serverProvider())
        balance = await tokenContract.balanceOf(voterAddress, { blockTag: snapshotBlock })
    } catch {
        return { ok: false, response: fail("The relay couldn't read token balances at the snapshot block (it needs an archive RPC).", 503) }
    }

    let weight = 1n
    if (tokenGate.tokenType === "erc721") {
        if (balance === 0n) return { ok: false, response: fail("This wallet didn't hold the required NFT at the snapshot") }
        if (tokenGate.weighted) weight = balance > 255n ? 255n : balance
    } else {
        const decimals = tokenGate.tokenDecimals || 18
        const minRaw = BigInt(Math.floor(Number(tokenGate.minBalance || "1") * (10 ** decimals)))
        if (balance < minRaw) {
            return { ok: false, response: fail(`This wallet held less than ${tokenGate.minBalance} ${tokenGate.tokenSymbol || "tokens"} at the snapshot`) }
        }
        if (tokenGate.weighted && tokenGate.voteThreshold) {
            const thresholdRaw = BigInt(Math.floor(Number(tokenGate.voteThreshold) * (10 ** decimals)))
            if (thresholdRaw > 0n) {
                weight = balance / thresholdRaw
                if (weight > 255n) weight = 255n
                if (weight < 1n) weight = 1n
            }
        }
    }

    return { ok: true, value: String(voterAddress).toLowerCase(), weight, usedMessage: "This wallet has already been used to sign up" }
}

// ---------------------------------------------------------------------------
// anonJoin / castVote
// ---------------------------------------------------------------------------

async function handleAnonJoin(election: Contract, signer: NonceManager, body: any): Promise<NextResponse> {
    const { pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment } = body
    if (!pA || !pB || !pC || !signupMerkleRoot || !joinNullifier || !newCommitment) {
        return fail("Missing proof fields for anonJoin")
    }

    const [status, nullifierUsed] = await Promise.all([
        votingIsOpen(election),
        election.usedJoinNullifiers(joinNullifier),
    ])
    if (!status.open) return fail(status.reason || "Voting is not open for this election")
    if (nullifierUsed) return fail("Join nullifier already used (you may have already joined)")

    // Gas estimation fails on an invalid proof, so a bad proof costs the relay nothing.
    // The first join after the signup deadline also opens voting on-chain.
    const tx = await sendSerialized(signer, () => election.anonJoin(pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment))
    return NextResponse.json({ success: true, txHash: tx.hash })
}

async function handleCastVote(election: Contract, signer: NonceManager, body: any): Promise<NextResponse> {
    const { pA, pB, pC, merkleTreeRoot, baseNullifier, versionedNullifier, voteCommitment, encryptedBlob } = body
    if (!pA || !pB || !pC || !merkleTreeRoot || !baseNullifier || !versionedNullifier || !voteCommitment || !encryptedBlob) {
        return fail("Missing proof fields for castVote")
    }
    if (typeof encryptedBlob !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(encryptedBlob) || (encryptedBlob.length - 2) / 2 > MAX_BALLOT_BYTES) {
        return fail("Invalid or oversized ballot")
    }

    const [status, nullifierUsed] = await Promise.all([
        votingIsOpen(election),
        election.usedNullifiers(versionedNullifier),
    ])
    if (!status.open) return fail(status.reason || "Voting is not open for this election")
    if (nullifierUsed) return fail("This vote version already submitted", 409)

    const tx = await sendSerialized(signer, () =>
        election.castVote(pA, pB, pC, merkleTreeRoot, baseNullifier, versionedNullifier, voteCommitment, encryptedBlob))
    return NextResponse.json({ success: true, txHash: tx.hash })
}
