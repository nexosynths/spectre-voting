/**
 * Relayer Client Module
 *
 * Browser-side functions that call the /api/relay endpoint to submit voter
 * transactions without a wallet or gas. The relay's wallet pays gas; voters
 * generate ZK proofs in the browser.
 *
 * Joins and ballots always go through the relay, in every election mode, so a
 * voter's own wallet never appears on the transactions that carry their ballot.
 *
 * Checking what landed: after each relayed action, the client reads the chain
 * itself (through the public RPC, not the relay) and compares what's there with
 * what it sent. For ballots that means the versioned nullifier, the commitment and
 * the sealed bytes: the proof doesn't cover the sealed bytes, so a relay could
 * submit a voter's proof with different contents, which would void the ballot.
 *
 * Privacy of the checks: each check scans every event of a kind for the whole
 * election and matches locally, starting after a random delay, so the RPC provider
 * isn't told which record this browser cares about. It still sees this browser's IP
 * address and when it checks, so in an election with few ballots it could guess
 * which ballot was just checked. The relay sees the IP address of every request.
 */

import { JsonRpcProvider, keccak256 } from "ethers"
import { RPC_URL } from "@/lib/contracts"
import { fetchBallots, fetchSignups } from "@/lib/chain"
import type { SpectreProof } from "@/lib/proof"
import type { AnonJoinProof } from "@/lib/anonJoinProof"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelayResponse {
    success: boolean
    txHash?: string
    weight?: string
    error?: string
}

export interface SignupResult {
    txHash: string
    weight: bigint
}

export interface RelayInfo {
    relayerAddress: string
    /** False if the relay has no GATE_KEY_SECRET, so it can't register voters in gated elections */
    gatedElections: boolean
    /** Fingerprint of the relay's gate-key secret, recorded in gated elections' metadata */
    gateKeyFingerprint: string | null
    /** Whether the relay's RPC can read historical balances (needed for token gates) */
    tokenGates: boolean
}

export class RelayError extends Error {
    public status: number
    constructor(message: string, status: number) {
        super(message)
        this.name = "RelayError"
        this.status = status
    }
}

// ---------------------------------------------------------------------------
// Core relay function (shared POST logic)
// ---------------------------------------------------------------------------

async function callRelay(body: Record<string, any>): Promise<RelayResponse & { txHash: string }> {
    const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    let data: RelayResponse
    try {
        data = await res.json()
    } catch {
        throw new RelayError(`Relay request failed (HTTP ${res.status})`, res.status)
    }
    if (!data.success || !data.txHash) {
        throw new RelayError(data.error || "Relay request failed", res.status)
    }
    return data as RelayResponse & { txHash: string }
}

// ---------------------------------------------------------------------------
// Relay actions
// ---------------------------------------------------------------------------

/**
 * The relay's public address, and whether it can serve gated elections. Gated elections
 * name it as their registrar so that only the relay (after checking eligibility) or the
 * admin can register voters.
 */
export async function getRelayInfo(): Promise<RelayInfo> {
    const res = await fetch("/api/relay", { method: "GET" })
    const data = await res.json().catch(() => ({}))
    if (!data.success || !data.relayerAddress) {
        throw new RelayError(data.error || "Relay is not available", res.status)
    }
    return {
        relayerAddress: data.relayerAddress as string,
        gatedElections: data.gatedElections === true,
        gateKeyFingerprint: typeof data.gateKeyFingerprint === "string" ? data.gateKeyFingerprint : null,
        tokenGates: data.tokenGates === true,
    }
}

export async function getRelayerAddress(): Promise<string> {
    return (await getRelayInfo()).relayerAddress
}

export interface SignupGateData {
    code?: string
    identifier?: string
    voterAddress?: string
    walletSignature?: string
    email?: string
    emailToken?: string
    githubToken?: string
    githubId?: string
}

/**
 * Relay a voter signup (Phase 1).
 * Gasless open elections: the relay calls signUp(). Gated elections: the relay checks
 * the gate and registers the voter as the election's registrar.
 * @returns Transaction hash and the weight the relay asked for (confirm it on-chain)
 */
export async function relaySignUp(
    electionAddress: string,
    identityCommitment: bigint | string,
    gate: SignupGateData = {},
): Promise<SignupResult> {
    const body: Record<string, any> = {
        action: "signUp",
        electionAddress,
        identityCommitment: identityCommitment.toString(),
    }
    if (gate.code) body.code = gate.code.trim()
    if (gate.identifier) body.identifier = gate.identifier.trim()
    if (gate.voterAddress) body.voterAddress = gate.voterAddress
    if (gate.walletSignature) body.walletSignature = gate.walletSignature
    if (gate.email) body.email = gate.email.trim()
    if (gate.emailToken) body.emailToken = gate.emailToken
    if (gate.githubToken) body.githubToken = gate.githubToken
    if (gate.githubId) body.githubId = gate.githubId

    const data = await callRelay(body)
    return { txHash: data.txHash, weight: data.weight ? BigInt(data.weight) : 1n }
}

/** Relay an anonymous join (Phase 2, step 1). Returns the transaction hash. */
export async function relayAnonJoin(electionAddress: string, proof: AnonJoinProof): Promise<string> {
    const data = await callRelay({
        action: "anonJoin",
        electionAddress,
        pA: proof.pA,
        pB: proof.pB,
        pC: proof.pC,
        signupMerkleRoot: proof.signupMerkleRoot,
        joinNullifier: proof.joinNullifier,
        newCommitment: proof.newCommitment,
    })
    return data.txHash
}

/** Relay a ballot (Phase 2, step 2): the vote proof plus the sealed ballot (hex). Returns the transaction hash. */
export async function relayCastVote(electionAddress: string, proof: SpectreProof, encryptedBlobHex: string): Promise<string> {
    const data = await callRelay({
        action: "castVote",
        electionAddress,
        pA: proof.pA,
        pB: proof.pB,
        pC: proof.pC,
        merkleTreeRoot: proof.merkleRoot,
        baseNullifier: proof.baseNullifier,
        versionedNullifier: proof.versionedNullifier,
        voteCommitment: proof.voteCommitment,
        encryptedBlob: encryptedBlobHex,
    })
    return data.txHash
}

// ---------------------------------------------------------------------------
// Checking what landed on-chain
// ---------------------------------------------------------------------------

/**
 * Call `probe` until it returns a value or `timeoutMs` passes. The first call waits a
 * random delay, so the RPC provider can't line up the check with the submission.
 */
export async function pollUntil<T>(
    probe: () => Promise<T | null>,
    { minDelayMs = 3_000, maxDelayMs = 10_000, intervalMs = 5_000, timeoutMs = 180_000 } = {},
): Promise<T | null> {
    const stopAt = Date.now() + timeoutMs
    await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs))
    for (;;) {
        try {
            const result = await probe()
            if (result !== null) return result
        } catch {
            // Transient RPC error: keep trying until the timeout
        }
        if (Date.now() >= stopAt) return null
        await sleep(intervalMs)
    }
}

/** Wait for this identity's registration to appear on-chain; returns the weight it was registered with. */
export async function waitForRegistration(
    electionAddress: string,
    deployBlock: number,
    identityCommitment: bigint,
): Promise<bigint | null> {
    const provider = new JsonRpcProvider(RPC_URL)
    return pollUntil(async () => {
        const mine = (await fetchSignups(electionAddress, provider, deployBlock)).filter(s => s.identityCommitment === identityCommitment)
        return mine.length > 0 ? mine[mine.length - 1].weight : null
    })
}

/** A ballot this browser handed to the relay, kept until the browser has seen it on-chain. */
export interface SentBallot {
    versionedNullifier: string
    voteCommitment: string
    /** keccak256 of the sealed ballot bytes */
    blobHash: string
    /** When it was handed to the relay (ms) */
    sentAt: number
}

export type BallotStatus = "confirmed" | "altered" | "not-found"

export function sealedBallotHash(encryptedBlobHex: string): string {
    return keccak256(encryptedBlobHex.toLowerCase())
}

/**
 * Compare ballots this browser sent with what's on-chain, in one scan of every ballot
 * in the election. "altered" means a ballot with the same versioned nullifier landed
 * with a different commitment or different sealed bytes.
 */
export async function checkSentBallots(
    electionAddress: string,
    deployBlock: number,
    sent: SentBallot[],
): Promise<Record<string, BallotStatus>> {
    const provider = new JsonRpcProvider(RPC_URL)
    const latest = await provider.getBlockNumber()
    const onChain = await fetchBallots(electionAddress, provider, deployBlock, latest)
    const byNullifier = new Map(onChain.map(b => [b.versionedNullifier, b]))
    const statuses: Record<string, BallotStatus> = {}
    for (const ballot of sent) {
        const found = byNullifier.get(ballot.versionedNullifier)
        if (!found) statuses[ballot.versionedNullifier] = "not-found"
        else if (found.voteCommitment === ballot.voteCommitment && sealedBallotHash(found.encryptedBlob) === ballot.blobHash) {
            statuses[ballot.versionedNullifier] = "confirmed"
        } else statuses[ballot.versionedNullifier] = "altered"
    }
    return statuses
}

// ---------------------------------------------------------------------------
// IP-timing decorrelation
// ---------------------------------------------------------------------------

/**
 * Random delay between anonJoin and castVote. It makes the two requests harder to
 * match for an outside observer of the chain. It doesn't hide anything from the relay
 * operator, which sees both requests come from the same IP address.
 *
 * @param minMs - Minimum delay (default 5000ms = 5s)
 * @param maxMs - Maximum delay (default 30000ms = 30s)
 */
export function randomTimingDelay(
    minMs: number = 5_000,
    maxMs: number = 30_000
): Promise<void> {
    const delay = minMs + Math.random() * (maxMs - minMs)
    return sleep(delay)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
