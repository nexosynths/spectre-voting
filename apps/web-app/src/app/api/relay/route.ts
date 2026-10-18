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
 *   The relay sees the caller's IP but the on-chain sender is always the relay.
 * - Open elections (selfSignupAllowed = true): the relay calls signUp() for anyone.
 * - Gated elections (invite codes, allowlist, email domain, GitHub org, token):
 *   the contract only accepts registrations from the admin or the registrar.
 *   This relay is the registrar. It checks eligibility, then calls
 *   registerVoter(commitment, weight, gateKey). The gate key is a keyed hash of
 *   the credential, and the contract accepts each gate key once, so a code,
 *   email, GitHub account or wallet can register only one identity.
 * - The relay operator is therefore trusted for eligibility in gated elections,
 *   and sees which credential registered which signup identity. It can't link
 *   that identity to a ballot: joins and votes go through the ZK re-key.
 */

import { NextRequest, NextResponse } from "next/server"
import { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, toUtf8String, verifyMessage, getAddress, ZeroAddress } from "ethers"
import { createHmac, timingSafeEqual } from "crypto"
import { CONTRACTS, RPC_URL, FACTORY_ABI, SPECTRE_VOTING_ABI, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK, FACTORY_CONFIGURED } from "@/lib/contracts"
import { tokenGateMessage } from "@/lib/gate"

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const MAX_BALLOT_BYTES = 4096

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
// Election metadata cache
// ---------------------------------------------------------------------------
const metadataCache = new Map<string, Record<string, any>>()

async function getElectionMetadata(
    electionAddress: string,
    provider: JsonRpcProvider
): Promise<Record<string, any> | null> {
    const key = electionAddress.toLowerCase()
    if (metadataCache.has(key)) return metadataCache.get(key)!

    try {
        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const currentBlock = await provider.getBlockNumber()
        let events: any[] = []
        for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
            const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
            const chunk = await factory.queryFilter(factory.filters.ElectionDeployed(electionAddress), from, to)
            events.push(...chunk)
            if (events.length > 0) break
        }
        if (events.length === 0) return null
        const args = (events[0] as any).args
        if (!args.metadata || args.metadata === "0x" || args.metadata.length <= 2) return null
        const meta = JSON.parse(toUtf8String(args.metadata))
        metadataCache.set(key, meta)
        return meta
    } catch {
        return null
    }
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

/** Secret for gate keys. Keeps credentials (emails, wallets) from being guessable on-chain. */
function gateSecret(key: string): string {
    return process.env.GATE_KEY_SECRET || keccak256(toUtf8Bytes(`spectre-gate-key-v1:${key}`))
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

// ---------------------------------------------------------------------------
// GET: the relay's public address (used as the registrar for gated elections)
// ---------------------------------------------------------------------------

export async function GET() {
    const key = relayerKey()
    if (!key) return fail("Relayer not configured", 503)
    return NextResponse.json({ success: true, relayerAddress: new Wallet(key).address })
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

        const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown"
        if (!checkRateLimit(ip, electionAddress)) {
            return fail(`Rate limit exceeded (max ${MAX_CALLS_PER_IP_PER_ELECTION} relay calls per election)`, 429)
        }

        const provider = new JsonRpcProvider(RPC_URL)
        const wallet = new Wallet(key, provider)

        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const [isElection, balance] = await Promise.all([
            factory.isElection(electionAddress),
            provider.getBalance(wallet.address),
        ])
        if (!isElection) return fail("Invalid election address")
        if (balance < 100000000000000n) return fail("Relayer wallet has insufficient funds", 503) // 0.0001 ETH

        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, wallet)

        switch (action) {
            case "signUp":
                return await handleSignUp(election, getAddress(electionAddress), body, provider, wallet.address, key)
            case "anonJoin":
                return await handleAnonJoin(election, body)
            case "castVote":
                return await handleCastVote(election, body)
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
    electionAddress: string,
    body: any,
    provider: JsonRpcProvider,
    relayerAddress: string,
    key: string,
): Promise<NextResponse> {
    const commitment = parseCommitment(body.identityCommitment)
    if (commitment === null) return fail("Missing or invalid identityCommitment")

    const [signupOpen, selfSignupAllowed, registrar, meta] = await Promise.all([
        election.signupOpen(),
        election.selfSignupAllowed(),
        election.registrar(),
        getElectionMetadata(electionAddress, provider),
    ])

    if (!signupOpen) return fail("Signup is not open for this election")

    // Open election: anyone may sign up; the relay only pays gas.
    if (selfSignupAllowed) {
        const tx = await election.signUp(commitment)
        return NextResponse.json({ success: true, txHash: tx.hash, weight: "1" })
    }

    // Gated election: only the registrar (this relay) or the admin can register.
    if (!registrar || registrar === ZeroAddress || registrar.toLowerCase() !== relayerAddress.toLowerCase()) {
        return fail("The organizer registers voters directly for this election.")
    }

    const gateType: string = meta?.gateType || ""
    let check: GateCheck
    switch (gateType) {
        case "invite-codes": check = checkInviteCode(meta!, body); break
        case "allowlist": check = checkAllowlist(meta!, body); break
        case "email-domain": check = checkEmail(meta!, body, electionAddress); break
        case "github-org": check = checkGithub(body, electionAddress); break
        case "token-gate": check = await checkToken(meta!, body, electionAddress, commitment, provider); break
        default:
            return fail("This election has no signup gate the relay can check.")
    }
    if (!check.ok) return check.response

    const gateKey = computeGateKey(gateSecret(key), electionAddress, gateType, check.value)
    if (await election.usedGateKeys(gateKey)) return fail(check.usedMessage)
    if (!claimGateKey(gateKey)) return fail("This signup is already being processed. Wait a minute and refresh.", 409)

    try {
        const tx = await election.registerVoter(commitment, check.weight, gateKey)
        return NextResponse.json({ success: true, txHash: tx.hash, weight: check.weight.toString() })
    } catch (err) {
        releaseGateKey(gateKey)
        throw err
    }
}

function checkInviteCode(meta: Record<string, any>, body: any): GateCheck {
    const code = typeof body.code === "string" ? body.code.toLowerCase().trim() : ""
    if (!code) return { ok: false, response: fail("Invite code required for this election") }
    if (!/^[0-9a-f]{8}$/.test(code)) return { ok: false, response: fail("Invalid invite code format") }
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

    const emailLower = String(email).toLowerCase().trim()
    const expected = createHmac("sha256", hmacSecret).update(emailLower + "|" + electionAddress.toLowerCase()).digest("hex")
    if (!safeEqualHex(String(emailToken), expected)) return { ok: false, response: fail("Invalid email verification token") }

    const allowedDomains: string[] = (meta.emailDomain?.domains || []).map((d: string) => d.toLowerCase().trim())
    const domain = emailLower.split("@")[1]
    if (!domain || !allowedDomains.includes(domain)) return { ok: false, response: fail(`Email domain @${domain} is not allowed`) }
    return { ok: true, value: emailLower, weight: 1n, usedMessage: "This email has already been used to sign up" }
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
    electionAddress: string,
    commitment: bigint,
    provider: JsonRpcProvider,
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

    let weight = 1n
    try {
        const tokenContract = new Contract(tokenGate.tokenAddress, ["function balanceOf(address) view returns (uint256)"], provider)
        const balance: bigint = await tokenContract.balanceOf(voterAddress)

        if (tokenGate.tokenType === "erc721") {
            if (balance === 0n) return { ok: false, response: fail("You do not hold the required NFT") }
            if (tokenGate.weighted) weight = balance > 255n ? 255n : balance
        } else {
            const decimals = tokenGate.tokenDecimals || 18
            const minRaw = BigInt(Math.floor(Number(tokenGate.minBalance || "1") * (10 ** decimals)))
            if (balance < minRaw) {
                return { ok: false, response: fail(`Insufficient token balance. Required: ${tokenGate.minBalance} ${tokenGate.tokenSymbol || "tokens"}`) }
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
    } catch {
        return { ok: false, response: fail("Failed to verify token balance", 500) }
    }

    return { ok: true, value: String(voterAddress).toLowerCase(), weight, usedMessage: "This wallet has already been used to sign up" }
}

// ---------------------------------------------------------------------------
// anonJoin / castVote
// ---------------------------------------------------------------------------

async function handleAnonJoin(election: Contract, body: any): Promise<NextResponse> {
    const { pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment } = body
    if (!pA || !pB || !pC || !signupMerkleRoot || !joinNullifier || !newCommitment) {
        return fail("Missing proof fields for anonJoin")
    }

    const [votingOpen, nullifierUsed] = await Promise.all([
        election.votingOpen(),
        election.usedJoinNullifiers(joinNullifier),
    ])
    if (!votingOpen) return fail("Voting is not open for this election")
    if (nullifierUsed) return fail("Join nullifier already used (you may have already joined)")

    // Gas estimation fails on an invalid proof, so a bad proof costs the relay nothing.
    const tx = await election.anonJoin(pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment)
    return NextResponse.json({ success: true, txHash: tx.hash })
}

async function handleCastVote(election: Contract, body: any): Promise<NextResponse> {
    const { pA, pB, pC, merkleTreeRoot, baseNullifier, versionedNullifier, voteCommitment, encryptedBlob } = body
    if (!pA || !pB || !pC || !merkleTreeRoot || !baseNullifier || !versionedNullifier || !voteCommitment || !encryptedBlob) {
        return fail("Missing proof fields for castVote")
    }
    if (typeof encryptedBlob !== "string" || !/^0x[0-9a-fA-F]*$/.test(encryptedBlob) || (encryptedBlob.length - 2) / 2 > MAX_BALLOT_BYTES) {
        return fail("Invalid or oversized ballot")
    }

    const [votingOpen, nullifierUsed] = await Promise.all([
        election.votingOpen(),
        election.usedNullifiers(versionedNullifier),
    ])
    if (!votingOpen) return fail("Voting is not open for this election")
    if (nullifierUsed) return fail("This vote version already submitted")

    const tx = await election.castVote(pA, pB, pC, merkleTreeRoot, baseNullifier, versionedNullifier, voteCommitment, encryptedBlob)
    return NextResponse.json({ success: true, txHash: tx.hash })
}
