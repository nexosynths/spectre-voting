/**
 * Proof-Only Relayer API Route
 *
 * Accepts voter-generated ZK proofs and submits them on-chain via a funded
 * server-side wallet. Voters don't need wallets or gas.
 *
 * Relayable actions: signUp, anonJoin, castVote
 * NOT relayed: admin actions (closeSignup, closeVoting, commitTallyResult, committee mgmt)
 *
 * Security:
 * - Pre-checks: nullifier not used, election exists, phase is correct
 * - Rate limiting: 10 relay calls per IP per election
 * - On-chain verifier rejects invalid proofs (contract-level security)
 * - Relayer wallet has NO on-chain role (not admin, can't decrypt votes)
 *
 * Note: Server-side snarkjs proof verification is disabled for performance.
 * The on-chain Groth16 verifier is the authoritative check — invalid proofs
 * will revert and waste gas but the relayer is testnet-funded. Enable
 * server-side verification in production if gas draining becomes a concern.
 */

import { NextRequest, NextResponse } from "next/server"
import { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, toUtf8String } from "ethers"
import { CONTRACTS, RPC_URL, FACTORY_ABI, SPECTRE_VOTING_ABI, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK } from "@/lib/contracts"

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, resets on cold start — fine for testnet)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number>()
const MAX_CALLS_PER_IP_PER_ELECTION = 10

function getRateLimitKey(ip: string, election: string): string {
    return `${ip}:${election.toLowerCase()}`
}

function checkRateLimit(ip: string, election: string): boolean {
    const key = getRateLimitKey(ip, election)
    const count = rateLimitMap.get(key) || 0
    if (count >= MAX_CALLS_PER_IP_PER_ELECTION) return false
    rateLimitMap.set(key, count + 1)
    return true
}

// ---------------------------------------------------------------------------
// Used invite code tracking (in-memory, resets on cold start)
// ---------------------------------------------------------------------------
const usedCodeHashes = new Map<string, Set<string>>() // electionAddr → set of used code hashes

function markCodeUsed(election: string, codeHash: string): void {
    const key = election.toLowerCase()
    if (!usedCodeHashes.has(key)) usedCodeHashes.set(key, new Set())
    usedCodeHashes.get(key)!.add(codeHash)
}

function unmarkCodeUsed(election: string, codeHash: string): void {
    const key = election.toLowerCase()
    usedCodeHashes.get(key)?.delete(codeHash)
}

function isCodeUsed(election: string, codeHash: string): boolean {
    return usedCodeHashes.get(election.toLowerCase())?.has(codeHash) ?? false
}

function usedCodeCount(election: string): number {
    return usedCodeHashes.get(election.toLowerCase())?.size ?? 0
}

// ---------------------------------------------------------------------------
// Election metadata cache (in-memory, avoids re-fetching events)
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
        // Paginate for Base 10k block limit
        let events: any[] = []
        for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
            const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
            const chunk = await factory.queryFilter(
                factory.filters.ElectionDeployed(electionAddress),
                from, to
            )
            events.push(...chunk)
            if (events.length > 0) break // found it, stop scanning
        }
        if (events.length === 0) return null
        const args = (events[0] as any).args
        if (!args.metadata || args.metadata === "0x" || args.metadata.length <= 2) return null
        const decoded = toUtf8String(args.metadata)
        const meta = JSON.parse(decoded)
        metadataCache.set(key, meta)
        return meta
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// Signup count helper (for cold-start rehydration)
// ---------------------------------------------------------------------------
async function getSignupCount(
    electionAddress: string,
    provider: JsonRpcProvider
): Promise<number> {
    try {
        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
        const currentBlock = await provider.getBlockNumber()
        // Paginate for Base 10k block limit
        let allEvents: any[] = []
        for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
            const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
            const chunk = await election.queryFilter(election.filters.VoterSignedUp(), from, to)
            allEvents.push(...chunk)
        }
        return allEvents.length
    } catch {
        return 0
    }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
    try {
        // Check relayer is configured
        const relayerKey = process.env.RELAYER_PRIVATE_KEY
        if (!relayerKey) {
            return NextResponse.json(
                { success: false, error: "Relayer not configured" },
                { status: 503 }
            )
        }

        const body = await request.json()
        const { action, electionAddress } = body

        // Validate required fields
        if (!action || !electionAddress) {
            return NextResponse.json(
                { success: false, error: "Missing action or electionAddress" },
                { status: 400 }
            )
        }

        if (!["signUp", "anonJoin", "castVote"].includes(action)) {
            return NextResponse.json(
                { success: false, error: `Invalid action: ${action}` },
                { status: 400 }
            )
        }

        // Rate limiting
        const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown"
        if (!checkRateLimit(ip, electionAddress)) {
            return NextResponse.json(
                { success: false, error: `Rate limit exceeded (max ${MAX_CALLS_PER_IP_PER_ELECTION} relay calls per election)` },
                { status: 429 }
            )
        }

        // Setup provider + relayer wallet
        const provider = new JsonRpcProvider(RPC_URL)
        const wallet = new Wallet(relayerKey, provider)

        // Verify election exists + check balance in parallel
        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const [isElection, balance] = await Promise.all([
            factory.isElection(electionAddress),
            provider.getBalance(wallet.address),
        ])

        if (!isElection) {
            return NextResponse.json(
                { success: false, error: "Invalid election address" },
                { status: 400 }
            )
        }

        if (balance < 100000000000000n) { // 0.0001 ETH minimum
            return NextResponse.json(
                { success: false, error: "Relayer wallet has insufficient funds" },
                { status: 503 }
            )
        }

        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, wallet)

        // Dispatch by action
        switch (action) {
            case "signUp":
                return await handleSignUp(election, body, provider)
            case "anonJoin":
                return await handleAnonJoin(election, body)
            case "castVote":
                return await handleCastVote(election, body)
            default:
                return NextResponse.json(
                    { success: false, error: "Unknown action" },
                    { status: 400 }
                )
        }
    } catch (err: any) {
        console.error("Relay error:", err)

        // Try to extract revert reason from contract error
        const reason = err?.reason || err?.message || "Transaction failed"
        return NextResponse.json(
            { success: false, error: reason },
            { status: 500 }
        )
    }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleSignUp(
    election: Contract,
    body: any,
    provider: JsonRpcProvider
): Promise<NextResponse> {
    const { identityCommitment, code, identifier } = body
    if (!identityCommitment) {
        return NextResponse.json(
            { success: false, error: "Missing identityCommitment" },
            { status: 400 }
        )
    }

    const electionAddress = await election.getAddress()

    // Pre-checks + metadata fetch in parallel
    const [signupOpen, selfSignupAllowed, meta] = await Promise.all([
        election.signupOpen(),
        election.selfSignupAllowed(),
        getElectionMetadata(electionAddress, provider),
    ])

    if (!signupOpen) {
        return NextResponse.json(
            { success: false, error: "Signup is not open for this election" },
            { status: 400 }
        )
    }
    if (!selfSignupAllowed) {
        return NextResponse.json(
            { success: false, error: "Self-signup is not allowed. Admin must register voters." },
            { status: 400 }
        )
    }

    // ── Invite code validation ──
    if (meta?.gateType === "invite-codes") {
        if (!code) {
            return NextResponse.json(
                { success: false, error: "Invite code required for this election" },
                { status: 400 }
            )
        }

        // Validate format: 8 lowercase hex chars
        const normalized = code.toLowerCase().trim()
        if (!/^[0-9a-f]{8}$/.test(normalized)) {
            return NextResponse.json(
                { success: false, error: "Invalid invite code format" },
                { status: 400 }
            )
        }

        const codeHashes: string[] = meta.inviteCodes?.codeHashes || []
        const codeHash = keccak256(toUtf8Bytes(normalized))

        // Check code is in the valid set
        if (!codeHashes.includes(codeHash)) {
            return NextResponse.json(
                { success: false, error: "Invalid invite code" },
                { status: 400 }
            )
        }

        // Check code hasn't been used
        if (isCodeUsed(electionAddress, codeHash)) {
            return NextResponse.json(
                { success: false, error: "This invite code has already been used" },
                { status: 400 }
            )
        }

        // Cold start fallback: if no codes tracked yet, count signups
        if (usedCodeCount(electionAddress) === 0) {
            const signupCount = await getSignupCount(electionAddress, provider)
            if (signupCount >= (meta.inviteCodes?.totalCodes || codeHashes.length)) {
                return NextResponse.json(
                    { success: false, error: "All invite codes have been used" },
                    { status: 400 }
                )
            }
        }

        // Mark code used BEFORE submitting tx (Node.js single-threaded — no race)
        markCodeUsed(electionAddress, codeHash)

        try {
            const tx = await election.signUp(identityCommitment)
            return NextResponse.json({ success: true, txHash: tx.hash })
        } catch (err) {
            // On tx failure: un-mark code to allow retry
            unmarkCodeUsed(electionAddress, codeHash)
            throw err
        }
    }

    // ── Allowlist validation ──
    if (meta?.gateType === "allowlist") {
        if (!identifier) {
            return NextResponse.json(
                { success: false, error: "Identifier required for this election" },
                { status: 400 }
            )
        }

        const normalized = identifier.toLowerCase().trim()
        if (!normalized) {
            return NextResponse.json(
                { success: false, error: "Identifier cannot be empty" },
                { status: 400 }
            )
        }

        const identifierHashes: string[] = meta.allowlist?.identifierHashes || []
        const idHash = keccak256(toUtf8Bytes(normalized))

        if (!identifierHashes.includes(idHash)) {
            return NextResponse.json(
                { success: false, error: "Not on the allowlist" },
                { status: 400 }
            )
        }

        if (isCodeUsed(electionAddress, idHash)) {
            return NextResponse.json(
                { success: false, error: "This identifier has already been used" },
                { status: 400 }
            )
        }

        // Cold start fallback
        if (usedCodeCount(electionAddress) === 0) {
            const signupCount = await getSignupCount(electionAddress, provider)
            if (signupCount >= (meta.allowlist?.totalEntries || identifierHashes.length)) {
                return NextResponse.json(
                    { success: false, error: "All allowlist entries have been used" },
                    { status: 400 }
                )
            }
        }

        markCodeUsed(electionAddress, idHash)

        try {
            const tx = await election.signUp(identityCommitment)
            return NextResponse.json({ success: true, txHash: tx.hash })
        } catch (err) {
            unmarkCodeUsed(electionAddress, idHash)
            throw err
        }
    }

    // Submit transaction (returns immediately, don't wait for confirmation)
    const tx = await election.signUp(identityCommitment)
    return NextResponse.json({ success: true, txHash: tx.hash })
}

async function handleAnonJoin(
    election: Contract,
    body: any
): Promise<NextResponse> {
    const { pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment } = body

    if (!pA || !pB || !pC || !signupMerkleRoot || !joinNullifier || !newCommitment) {
        return NextResponse.json(
            { success: false, error: "Missing proof fields for anonJoin" },
            { status: 400 }
        )
    }

    // Pre-checks in parallel
    const [votingOpen, nullifierUsed] = await Promise.all([
        election.votingOpen(),
        election.usedJoinNullifiers(joinNullifier),
    ])

    if (!votingOpen) {
        return NextResponse.json(
            { success: false, error: "Voting is not open for this election" },
            { status: 400 }
        )
    }
    if (nullifierUsed) {
        return NextResponse.json(
            { success: false, error: "Join nullifier already used (you may have already joined)" },
            { status: 400 }
        )
    }

    // Submit transaction — on-chain verifier will reject invalid proofs
    const tx = await election.anonJoin(pA, pB, pC, signupMerkleRoot, joinNullifier, newCommitment)
    return NextResponse.json({ success: true, txHash: tx.hash })
}

async function handleCastVote(
    election: Contract,
    body: any
): Promise<NextResponse> {
    const { pA, pB, pC, merkleTreeRoot, nullifierHash, voteCommitment, encryptedBlob } = body

    if (!pA || !pB || !pC || !merkleTreeRoot || !nullifierHash || !voteCommitment || !encryptedBlob) {
        return NextResponse.json(
            { success: false, error: "Missing proof fields for castVote" },
            { status: 400 }
        )
    }

    // Pre-checks in parallel
    const [votingOpen, nullifierUsed] = await Promise.all([
        election.votingOpen(),
        election.usedNullifiers(nullifierHash),
    ])

    if (!votingOpen) {
        return NextResponse.json(
            { success: false, error: "Voting is not open for this election" },
            { status: 400 }
        )
    }
    if (nullifierUsed) {
        return NextResponse.json(
            { success: false, error: "Vote nullifier already used (you may have already voted)" },
            { status: 400 }
        )
    }

    // Submit transaction — on-chain verifier will reject invalid proofs
    const tx = await election.castVote(pA, pB, pC, merkleTreeRoot, nullifierHash, voteCommitment, encryptedBlob)
    return NextResponse.json({ success: true, txHash: tx.hash })
}
