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
 * itself (through the public RPC, not the relay) and compares the event with what
 * it sent. For ballots that means the versioned nullifier, the vote commitment and
 * the sealed ballot bytes: the proof doesn't cover the ciphertext, so a relay could
 * submit a voter's proof with different contents, which would void the ballot.
 *
 * Privacy of the checks: they fetch every event of a kind in a small block range
 * and match locally, rather than asking the RPC for one transaction or nullifier,
 * so the RPC provider doesn't learn which ballot belongs to this browser. The relay
 * itself still sees this browser's IP address on every request.
 */

import { JsonRpcProvider, Contract, type EventLog } from "ethers"
import { SPECTRE_VOTING_ABI, RPC_URL } from "@/lib/contracts"
import { queryInChunks } from "@/lib/chain"
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
    return { relayerAddress: data.relayerAddress as string, gatedElections: data.gatedElections === true }
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

const POLL_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * A block to start looking from, taken before a relayed action is sent. A few blocks
 * of slack cover load-balanced RPC backends that are slightly behind each other.
 */
export async function blockBeforeRelay(): Promise<number> {
    const n = await new JsonRpcProvider(RPC_URL).getBlockNumber()
    return Math.max(0, n - 5)
}

/** Poll every `eventName` event of the election from `fromBlock` on until `match` returns a result. */
async function pollElectionEvents<T>(
    electionAddress: string,
    eventName: "VoterSignedUp" | "AnonJoined" | "VoteCast",
    fromBlock: number,
    timeoutMs: number,
    match: (event: EventLog) => T | null,
): Promise<T | null> {
    const provider = new JsonRpcProvider(RPC_URL)
    const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
    const stopAt = Date.now() + timeoutMs
    for (;;) {
        try {
            const latest = await provider.getBlockNumber()
            const events = await queryInChunks(election, (election.filters as any)[eventName](), fromBlock, latest)
            for (const event of events) {
                const result = match(event)
                if (result !== null) return result
            }
        } catch {
            // Transient RPC error: keep polling until the timeout
        }
        if (Date.now() >= stopAt) return null
        await sleep(POLL_INTERVAL_MS)
    }
}

export type SignupCheck = { status: "confirmed"; weight: bigint } | { status: "missing" }

/** Wait for this identity's registration to appear on-chain; returns the weight it was registered with. */
export async function confirmSignup(
    electionAddress: string,
    identityCommitment: string,
    fromBlock: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SignupCheck> {
    const weight = await pollElectionEvents(electionAddress, "VoterSignedUp", fromBlock, timeoutMs, event =>
        event.args.identityCommitment.toString() === identityCommitment ? BigInt(event.args.weight) : null)
    return weight === null ? { status: "missing" } : { status: "confirmed", weight }
}

export type LandedCheck = { status: "confirmed" } | { status: "altered" } | { status: "missing" }

/** Wait for this join (by join nullifier) and check it added the voting commitment that was sent. */
export async function confirmJoin(
    electionAddress: string,
    sent: { joinNullifier: string; newCommitment: string },
    fromBlock: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LandedCheck> {
    const result = await pollElectionEvents(electionAddress, "AnonJoined", fromBlock, timeoutMs, event => {
        if (event.args.joinNullifier.toString() !== sent.joinNullifier) return null
        return event.args.newCommitment.toString() === sent.newCommitment ? "confirmed" as const : "altered" as const
    })
    return { status: result ?? "missing" }
}

/**
 * Wait for this ballot (by versioned nullifier) and check that the on-chain vote
 * commitment and sealed ballot bytes are exactly what this browser sent.
 */
export async function confirmBallot(
    electionAddress: string,
    sent: { versionedNullifier: string; voteCommitment: string; encryptedBlobHex: string },
    fromBlock: number,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LandedCheck> {
    const blob = sent.encryptedBlobHex.toLowerCase()
    const result = await pollElectionEvents(electionAddress, "VoteCast", fromBlock, timeoutMs, event => {
        if (event.args.versionedNullifier.toString() !== sent.versionedNullifier) return null
        const same = event.args.voteCommitment.toString() === sent.voteCommitment &&
            String(event.args.encryptedBlob).toLowerCase() === blob
        return same ? "confirmed" as const : "altered" as const
    })
    return { status: result ?? "missing" }
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
