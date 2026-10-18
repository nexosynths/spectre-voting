/**
 * Public recount: anyone can open the time-locked ballots after they unseal,
 * check each one against its on-chain vote commitment, and count.
 */

import { Contract, JsonRpcProvider } from "ethers"
import { poseidon2, poseidon3 } from "poseidon-lite"
import { openBallots, decodeVotePayload, hexToBytes, type BeaconFetcher } from "@/lib/ballot"
import { fetchBallots, type BallotRecord } from "@/lib/chain"
import { SPECTRE_VOTING_ABI } from "@/lib/contracts"
import type { ChainInfo } from "tlock-js"

export type { BallotRecord } from "@/lib/chain"

export interface CountedBallot {
    baseNullifier: string
    vote: bigint
    weight: bigint
    /** The voter's own submission count, from the sealed payload (-1 if it didn't open) */
    version: number
    commitmentValid: boolean
    problem?: string
}

export interface TallyResult {
    optionCounts: number[]
    /** Sum of the weights counted */
    totalValid: number
    /** Voters with no valid ballot */
    totalInvalid: number
    /** Submissions that didn't count because the same voter has another one that does (or none valid) */
    duplicatesRemoved: number
    /** Submissions that didn't open or didn't match their on-chain commitment */
    invalidSubmissions: number
    /** Distinct voters (base nullifiers) */
    voters: number
    /** The ballot that counted for each voter, or that voter's last invalid one */
    ballots: CountedBallot[]
}

type CountOptions = { chain?: ChainInfo; fetchBeacon?: BeaconFetcher; now?: number }

function isCountable(ballot: CountedBallot, numOptions: number): boolean {
    return ballot.commitmentValid && ballot.vote >= 0n && ballot.vote < BigInt(numOptions) && ballot.weight >= 1n
}

/**
 * Open and count ballots. Records must be in chain order. For each voter (base
 * nullifier), the valid ballot (it opens and matches its commitment) with the highest
 * version in its sealed payload counts; between equal versions, the later one in chain
 * order. So a ballot that doesn't open (for example, one whose contents were replaced on
 * the way to the chain) doesn't cancel an earlier valid one, and an older ballot posted
 * late can't override a newer one.
 */
export async function countBallots(
    records: BallotRecord[],
    numOptions: number,
    votingDeadline: number,
    options: CountOptions = {},
): Promise<TallyResult> {
    const opened = records.length > 0
        ? await openBallots(records.map(r => hexToBytes(r.encryptedBlob)), votingDeadline, options)
        : []

    const counted: CountedBallot[] = records.map((record, i) => {
        const result = opened[i]
        if (!result.ok) {
            return { baseNullifier: record.baseNullifier, vote: -1n, weight: 0n, version: -1, commitmentValid: false, problem: result.reason }
        }
        try {
            const { vote, weight, version, voteRandomness } = decodeVotePayload(result.payload)
            const commitmentValid = poseidon3([vote, weight, voteRandomness]).toString() === record.voteCommitment
            return {
                baseNullifier: record.baseNullifier,
                vote,
                weight,
                version,
                commitmentValid,
                problem: commitmentValid ? undefined : "Ballot doesn't match its on-chain commitment",
            }
        } catch (err) {
            return {
                baseNullifier: record.baseNullifier, vote: -1n, weight: 0n, version: -1, commitmentValid: false,
                problem: err instanceof Error ? err.message : "Malformed ballot",
            }
        }
    })

    const byVoter = new Map<string, { counts: CountedBallot | null; lastInvalid: CountedBallot | null }>()
    let invalidSubmissions = 0
    for (const ballot of counted) {
        const entry = byVoter.get(ballot.baseNullifier) ?? { counts: null, lastInvalid: null }
        if (isCountable(ballot, numOptions)) {
            // Vote changes: a higher version replaces a lower one; equal versions, the later one
            if (!entry.counts || ballot.version >= entry.counts.version) entry.counts = ballot
        } else {
            entry.lastInvalid = ballot
            invalidSubmissions++
        }
        byVoter.set(ballot.baseNullifier, entry)
    }

    const optionCounts = new Array(numOptions).fill(0)
    const ballots: CountedBallot[] = []
    let totalInvalid = 0
    for (const { counts, lastInvalid } of byVoter.values()) {
        if (counts) {
            optionCounts[Number(counts.vote)] += Number(counts.weight)
            ballots.push(counts)
        } else {
            totalInvalid++
            ballots.push(lastInvalid!)
        }
    }
    const totalValid = optionCounts.reduce((a: number, b: number) => a + b, 0)

    return {
        optionCounts,
        totalValid,
        totalInvalid,
        duplicatesRemoved: records.length - byVoter.size,
        invalidSubmissions,
        voters: byVoter.size,
        ballots,
    }
}

export interface RecountResult extends TallyResult {
    /** Block the ballots were read at */
    blockNumber: number
    /** Whether the chain's finalized block is past the deadline (null if the RPC can't say) */
    finalized: boolean | null
}

/**
 * Recount an election from the chain. Reads every ballot up to one pinned block after
 * the voting deadline (the finalized block, once it's past the deadline) and refuses to
 * count unless the number found equals the contract's voteCount(), so a lagging or
 * incomplete RPC can't produce a short count.
 */
export async function recountElection(
    electionAddress: string,
    provider: JsonRpcProvider,
    election: { numOptions: number; votingDeadline: number; deployBlock: number },
    options: CountOptions = {},
): Promise<RecountResult> {
    const latest = await provider.getBlock("latest")
    if (!latest) throw new Error("Couldn't read the latest block. Try again.")
    if (latest.timestamp <= election.votingDeadline) {
        throw new Error("The chain hasn't reached the voting deadline yet.")
    }

    let finalizedBlock: { number: number; timestamp: number } | null = null
    let finalized: boolean | null = null
    try {
        finalizedBlock = await provider.getBlock("finalized")
        finalized = !!finalizedBlock && finalizedBlock.timestamp > election.votingDeadline
    } catch {
        finalized = null
    }

    // No ballot can be added after the deadline, so any block past it holds the final set,
    // and voteCount() is the same at every such block. Read the logs up to the finalized
    // block when it's past the deadline (so a reorg can't change them), otherwise up to the
    // latest block; read voteCount() at the latest block, which every node can serve.
    const blockNumber = finalized && finalizedBlock ? finalizedBlock.number : latest.number
    const contract = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
    const expected = Number(await contract.voteCount({ blockTag: latest.number }))
    const records = await fetchBallots(electionAddress, provider, election.deployBlock, blockNumber)
    if (records.length !== expected) {
        throw new Error(
            `Found ${records.length} ballot(s), but the contract recorded ${expected} by block ${blockNumber}. ` +
            "The RPC may be behind or incomplete. Nothing was counted; try again in a minute.",
        )
    }

    const result = await countBallots(records, election.numOptions, election.votingDeadline, options)
    return { ...result, blockNumber, finalized }
}

/** Poseidon hash chain stored by commitTallyResult: h = P(valid, invalid); h = P(h, count_i). */
export function tallyCommitment(optionCounts: number[], totalValid: number, totalInvalid: number): bigint {
    let hash = poseidon2([BigInt(totalValid), BigInt(totalInvalid)])
    for (const count of optionCounts) hash = poseidon2([hash, BigInt(count)])
    return hash
}

/** Does an on-chain committed tally match a recount? */
export function commitmentMatches(
    committed: { poseidonCommitment: string; totalValid: number; totalInvalid: number; optionCounts: number[] },
    recount: TallyResult,
): boolean {
    if (committed.totalValid !== recount.totalValid || committed.totalInvalid !== recount.totalInvalid) return false
    if (committed.optionCounts.length !== recount.optionCounts.length) return false
    if (committed.optionCounts.some((c, i) => c !== recount.optionCounts[i])) return false
    return tallyCommitment(recount.optionCounts, recount.totalValid, recount.totalInvalid).toString() === committed.poseidonCommitment
}
