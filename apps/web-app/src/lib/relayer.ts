/**
 * Relayer Client Module
 *
 * Browser-side functions that call the /api/relay endpoint to submit
 * voter transactions without requiring a wallet or gas. The relayer
 * server wallet pays gas; voters just generate ZK proofs in the browser.
 *
 * Anti-censorship: after every relayed vote, the client independently
 * verifies the VoteCast event on-chain via public RPC (not the relayer).
 *
 * Usage:
 *   const txHash = await relaySignUp(electionAddr, commitment)
 *   await waitForRelayTx(txHash)
 *
 *   const txHash2 = await relayAnonJoin(electionAddr, joinProof)
 *   await waitForRelayTx(txHash2)
 *
 *   const txHash3 = await relayCastVote(electionAddr, voteProof, encryptedBlob)
 *   await waitForRelayTx(txHash3)
 *   const confirmed = await verifyVoteOnChain(electionAddr, nullifierHash, txHash3)
 */

import { JsonRpcProvider, Contract } from "ethers"
import { SPECTRE_VOTING_ABI, RPC_URL, EXPLORER_URL } from "@/lib/contracts"
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

async function callRelay(body: Record<string, any>): Promise<string> {
    const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })

    const data: RelayResponse = await res.json()

    if (!data.success || !data.txHash) {
        throw new RelayError(
            data.error || "Relay request failed",
            res.status
        )
    }

    return data.txHash
}

// ---------------------------------------------------------------------------
// Relay actions
// ---------------------------------------------------------------------------

/**
 * Relay a voter signup (Phase 1).
 * No proof needed — just the identity commitment.
 * @returns Transaction hash
 */
export async function relaySignUp(
    electionAddress: string,
    identityCommitment: bigint | string,
    code?: string,
    identifier?: string,
    voterAddress?: string,
    email?: string,
    emailToken?: string,
    githubToken?: string,
    githubId?: string,
): Promise<SignupResult> {
    const body: Record<string, any> = {
        action: "signUp",
        electionAddress,
        identityCommitment: identityCommitment.toString(),
    }
    if (code) body.code = code.toLowerCase().trim()
    if (identifier) body.identifier = identifier.trim()
    if (voterAddress) body.voterAddress = voterAddress
    if (email) body.email = email.toLowerCase().trim()
    if (emailToken) body.emailToken = emailToken
    if (githubToken) body.githubToken = githubToken
    if (githubId) body.githubId = githubId

    const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    const data: RelayResponse = await res.json()
    if (!data.success || !data.txHash) {
        throw new RelayError(data.error || "Relay request failed", res.status)
    }
    return {
        txHash: data.txHash,
        weight: data.weight ? BigInt(data.weight) : 1n,
    }
}

/**
 * Relay an anonymous join (Phase 2, step 1).
 * Submits the AnonJoin ZK proof via relayer.
 * @returns Transaction hash
 */
export async function relayAnonJoin(
    electionAddress: string,
    proof: AnonJoinProof
): Promise<string> {
    return callRelay({
        action: "anonJoin",
        electionAddress,
        pA: proof.pA,
        pB: proof.pB,
        pC: proof.pC,
        signupMerkleRoot: proof.signupMerkleRoot,
        joinNullifier: proof.joinNullifier,
        newCommitment: proof.newCommitment,
    })
}

/**
 * Relay a vote cast (Phase 2, step 2).
 * Submits the SpectreVote ZK proof + encrypted ballot via relayer.
 * @returns Transaction hash
 */
export async function relayCastVote(
    electionAddress: string,
    proof: SpectreProof,
    encryptedBlob: Uint8Array | string
): Promise<string> {
    // Convert Uint8Array to hex string for JSON serialization
    const blobHex = typeof encryptedBlob === "string"
        ? encryptedBlob
        : "0x" + Array.from(encryptedBlob).map(b => b.toString(16).padStart(2, "0")).join("")

    return callRelay({
        action: "castVote",
        electionAddress,
        pA: proof.pA,
        pB: proof.pB,
        pC: proof.pC,
        merkleTreeRoot: proof.merkleRoot,
        baseNullifier: proof.baseNullifier,
        versionedNullifier: proof.versionedNullifier,
        voteCommitment: proof.voteCommitment,
        encryptedBlob: blobHex,
    })
}

// ---------------------------------------------------------------------------
// Transaction monitoring
// ---------------------------------------------------------------------------

/**
 * Wait for a relayed transaction to be confirmed on-chain.
 * Polls the public Sepolia RPC (not the relayer) until the tx is mined.
 *
 * @param txHash - Transaction hash from the relay response
 * @param timeoutMs - Max wait time (default 120s)
 * @returns The block number the tx was included in
 * @throws if timeout or tx reverts
 */
export async function waitForRelayTx(
    txHash: string,
    timeoutMs: number = 120_000
): Promise<number> {
    const provider = new JsonRpcProvider(RPC_URL)
    const start = Date.now()
    const pollInterval = 3_000 // 3s between polls

    while (Date.now() - start < timeoutMs) {
        const receipt = await provider.getTransactionReceipt(txHash)
        if (receipt) {
            if (receipt.status === 0) {
                throw new RelayError("Transaction reverted on-chain", 500)
            }
            return receipt.blockNumber
        }
        await sleep(pollInterval)
    }

    throw new RelayError(
        `Transaction not confirmed after ${Math.round(timeoutMs / 1000)}s — check explorer: ${EXPLORER_URL}/tx/${txHash}`,
        408
    )
}

// ---------------------------------------------------------------------------
// Anti-censorship verification
// ---------------------------------------------------------------------------

/**
 * Independently verify that a VoteCast event with the voter's baseNullifier
 * was emitted on-chain. This is the anti-censorship check — the client
 * queries the chain directly via public RPC, not through the relayer.
 *
 * If the relayer claimed success but the event isn't found, the relayer
 * may be censoring votes. The voter should fall back to direct wallet submission.
 *
 * @param electionAddress - The election contract address
 * @param baseNullifier - The voter's base nullifier (from the ZK proof)
 * @param txHash - The transaction hash returned by the relayer
 * @returns true if the VoteCast event was found and matches
 */
export async function verifyVoteOnChain(
    electionAddress: string,
    baseNullifier: string,
    txHash: string
): Promise<boolean> {
    try {
        const provider = new JsonRpcProvider(RPC_URL)
        const receipt = await provider.getTransactionReceipt(txHash)

        if (!receipt || receipt.status === 0) {
            return false
        }

        // Parse logs from the receipt to find VoteCast event
        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
        const iface = election.interface

        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                })
                if (
                    parsed &&
                    parsed.name === "VoteCast" &&
                    parsed.args.baseNullifier.toString() === baseNullifier
                ) {
                    return true
                }
            } catch {
                // Not a matching log, skip
            }
        }

        return false
    } catch {
        return false
    }
}

/**
 * Independently verify that an AnonJoined event was emitted on-chain
 * for the voter's join nullifier.
 *
 * @param electionAddress - The election contract address
 * @param joinNullifier - The voter's join nullifier (from the AnonJoin proof)
 * @param txHash - The transaction hash returned by the relayer
 * @returns true if the AnonJoined event was found and matches
 */
export async function verifyJoinOnChain(
    electionAddress: string,
    joinNullifier: string,
    txHash: string
): Promise<boolean> {
    try {
        const provider = new JsonRpcProvider(RPC_URL)
        const receipt = await provider.getTransactionReceipt(txHash)

        if (!receipt || receipt.status === 0) {
            return false
        }

        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
        const iface = election.interface

        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                })
                if (
                    parsed &&
                    parsed.name === "AnonJoined" &&
                    parsed.args.joinNullifier.toString() === joinNullifier
                ) {
                    return true
                }
            } catch {
                // Not a matching log, skip
            }
        }

        return false
    } catch {
        return false
    }
}

/**
 * Independently verify that a VoterSignedUp event was emitted for the
 * voter's identity commitment.
 *
 * @param electionAddress - The election contract address
 * @param identityCommitment - The voter's identity commitment
 * @param txHash - The transaction hash returned by the relayer
 * @returns true if the signup event was found
 */
export async function verifySignupOnChain(
    electionAddress: string,
    identityCommitment: string,
    txHash: string
): Promise<boolean> {
    try {
        const provider = new JsonRpcProvider(RPC_URL)
        const receipt = await provider.getTransactionReceipt(txHash)

        if (!receipt || receipt.status === 0) {
            return false
        }

        // VoterSignedUp is emitted by the election contract
        // It contains the signupGroupId and identityCommitment
        const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
        const iface = election.interface

        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                })
                if (
                    parsed &&
                    parsed.name === "VoterSignedUp" &&
                    parsed.args.identityCommitment.toString() === identityCommitment
                ) {
                    return true
                }
            } catch {
                // Not a matching log, skip
            }
        }

        return false
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// IP-timing decorrelation
// ---------------------------------------------------------------------------

/**
 * Random delay between anonJoin and castVote to decorrelate transport-layer
 * timing. Without this, the relayer can trivially link the two calls by
 * IP + timestamp proximity (they come from the same browser session).
 *
 * @param minMs - Minimum delay (default 5000ms = 5s)
 * @param maxMs - Maximum delay (default 30000ms = 30s)
 * @returns A promise that resolves after the random delay
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

/**
 * Block explorer link for a transaction hash.
 */
export function explorerTxUrl(txHash: string): string {
    return `${EXPLORER_URL}/tx/${txHash}`
}
