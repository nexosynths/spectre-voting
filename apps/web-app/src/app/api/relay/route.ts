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
import { JsonRpcProvider, Wallet, Contract } from "ethers"
import { CONTRACTS, SEPOLIA_RPC, FACTORY_ABI, SPECTRE_VOTING_ABI } from "@/lib/contracts"

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
        const provider = new JsonRpcProvider(SEPOLIA_RPC)
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
                return await handleSignUp(election, body)
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
    body: any
): Promise<NextResponse> {
    const { identityCommitment } = body
    if (!identityCommitment) {
        return NextResponse.json(
            { success: false, error: "Missing identityCommitment" },
            { status: 400 }
        )
    }

    // Pre-checks in parallel
    const [signupOpen, selfSignupAllowed] = await Promise.all([
        election.signupOpen(),
        election.selfSignupAllowed(),
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
